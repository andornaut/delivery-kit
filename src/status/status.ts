// The read-only singleton, idle and drain report. The report never reads /proc: the singleton
// test is a non-blocking flock on the same lock files.
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { coordinationKitReport } from "../compatibility.ts";
import { fileSha256, readText, readTrimmed } from "../lib/files.ts";
import { ControlInvalid, ControlMissing, readDeliveryControl } from "../state/control.ts";
import { eventLogReport } from "../state/eventlog.ts";
import { readIdentity } from "../state/identity.ts";
import { type BusPaths, ciStatusFile, legacyOutboxIssue } from "../state/paths.ts";
import { coordinatorCliReport } from "../state/seam.ts";
import { observerAdoption } from "./adoption.ts";
import { lockHeld } from "./locks.ts";
import { type ProvenanceReport, provenanceReport } from "./provenance.ts";

/** The directory's names ending in `suffix`; [] when it does not exist, null when unreadable. */
function jsonFiles(directory: string, suffix: string): string[] | null {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(suffix))
      .sort();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
}

function parse(text: string | undefined): unknown {
  if (text === undefined) {
    throw new Error("unreadable");
  }
  return JSON.parse(text) as unknown;
}

/**
 * Whether the configuration file still matches what the running runner loaded at startup:
 * `loaded`, `changed` (the runner keeps the loaded copy until it restarts) or `unknown`.
 */
function configStatus(identity: Record<string, unknown>): "changed" | "loaded" | "unknown" {
  const { config, config_sha256: loaded } = identity;
  if (typeof config !== "string" || typeof loaded !== "string") {
    return "unknown";
  }
  const onDisk = fileSha256(config);
  if (onDisk === null) {
    return "unknown";
  }
  return onDisk === loaded ? "loaded" : "changed";
}

interface StatusReport {
  readonly provenance: ProvenanceReport;
  readonly [key: string]: unknown;
}

type ControlRecord = ReturnType<typeof readDeliveryControl>;
type MismatchReason =
  | "control_missing"
  | "control_invalid"
  | "observation_missing"
  | "observation_invalid"
  | "observation_unattested"
  | "desired_enabled_observed_stopped";

interface ControlReport {
  readonly desired: ControlRecord["desired"] | null;
  readonly desired_state: "enabled" | "paused" | "unknown";
  readonly desired_status: "valid" | "missing" | "invalid";
  readonly draining: boolean;
  readonly migration_required: boolean;
  readonly mismatch: boolean | null;
  readonly mismatch_reason: MismatchReason | null;
  readonly observed: ControlRecord["observed"];
  readonly observed_status: "current" | "stale" | "unattested" | "missing" | "invalid";
}

/** Compare persisted intent with an observation attested by the singleton's identity token. */
function controlReport(
  attestation: {
    readonly identity: Record<string, unknown> | null;
    readonly identityStatus: string;
    readonly loopHeld: boolean;
    readonly running: boolean;
  },
  paths: BusPaths,
): ControlReport {
  const { identity, identityStatus, loopHeld, running } = attestation;
  let control: ControlRecord;
  try {
    control = readDeliveryControl({ dir: paths.dir });
  } catch (error) {
    if (!(error instanceof ControlMissing) && !(error instanceof ControlInvalid)) {
      throw error;
    }
    const missing = error instanceof ControlMissing;
    return {
      desired: null,
      desired_state: "unknown",
      desired_status: missing ? "missing" : "invalid",
      draining: false,
      migration_required: true,
      mismatch: null,
      mismatch_reason: missing ? "control_missing" : "control_invalid",
      observed: null,
      observed_status: missing ? (running ? "unattested" : "missing") : "invalid",
    };
  }
  const { desired, observed } = control;
  const common = {
    desired,
    desired_state: desired.state,
    desired_status: "valid",
    migration_required: false,
    observed,
  } as const;
  if (observed === null) {
    return {
      ...common,
      draining: false,
      mismatch: null,
      mismatch_reason: running ? "observation_unattested" : "observation_missing",
      observed_status: running ? "unattested" : "missing",
    };
  }
  const token = identity?.token;
  const matches = typeof token === "string" && token !== "" && observed.runnerToken === token;
  // A stopped observation remains provable after shutdown, while idle and active observations
  // require a current singleton. The lock's retained token binds the shutdown to that identity.
  const stopped =
    !running &&
    !loopHeld &&
    observed.state === "stopped" &&
    matches &&
    token === readTrimmed(paths.runnerLock);
  const live = running && loopHeld && identityStatus === "current" && matches;
  if (!live && !stopped) {
    return {
      ...common,
      draining: false,
      mismatch: null,
      mismatch_reason: "observation_unattested",
      observed_status:
        running && loopHeld && identityStatus === "current" && !matches ? "stale" : "unattested",
    };
  }
  const active =
    Object.keys(control.activities).length > 0 ||
    observed.state === "checking" ||
    observed.state === "deploying";
  const mismatch = desired.state === "enabled" && observed.state === "stopped";
  return {
    ...common,
    draining: desired.state === "paused" && active,
    mismatch,
    mismatch_reason: mismatch ? "desired_enabled_observed_stopped" : null,
    observed_status: "current",
  };
}

/**
 * The status report, read only from bus/. The last push needs a CI record, because every 1.x game
 * watches CI.
 */
export function statusReport(paths: BusPaths, repo?: string): StatusReport {
  const running = lockHeld(paths.runnerLock);
  const read = readIdentity(paths);
  const identity = read === "unreadable" ? null : read;
  let identityStatus: string;
  if (read === "unreadable") {
    identityStatus = "unreadable";
  } else if (identity === null) {
    identityStatus = "absent";
  } else if (!running) {
    identityStatus = "stale";
  } else if (
    typeof identity.token === "string" &&
    identity.token !== "" &&
    identity.token === readTrimmed(paths.runnerLock)
  ) {
    identityStatus = "current";
  } else {
    identityStatus = "unattested";
  }
  const blockers: string[] = [];
  if (read === "unreadable") {
    blockers.push("identity_unreadable");
  }
  if (readTrimmed(paths.activeDeparture)) {
    blockers.push("active_departure");
  }
  if (readTrimmed(paths.deployPending)) {
    blockers.push("deploy_retry_pending");
  }
  const ci = jsonFiles(paths.ciDir, ".status");
  if (ci === null) {
    blockers.push("ci_dir_unreadable");
  }
  for (const name of ci ?? []) {
    if (["pending", "running"].includes(readTrimmed(join(paths.ciDir, name)) ?? "")) {
      blockers.push(`ci_watch:${name.slice(0, -".status".length)}`);
    }
  }
  const pushed = readTrimmed(paths.lastPushSha);
  if (pushed && readText(ciStatusFile(paths, pushed)) === undefined) {
    blockers.push(`ci_watch_unrecorded:${pushed}`);
  }
  const requests = jsonFiles(paths.requestsDir, ".json");
  if (requests === null) {
    blockers.push("requests_dir_unreadable");
  }
  for (const name of requests ?? []) {
    let value: unknown;
    try {
      value = (parse(readText(join(paths.requestsDir, name))) as { state?: unknown }).state;
    } catch {
      value = "unreadable";
    }
    if (value === "pending" || value === "started" || value === "unreadable") {
      blockers.push(`request_${value}:${name.slice(0, -".json".length)}`);
    }
  }
  const events = eventLogReport(paths);
  const reporters = [...events.blockers];
  const legacy = legacyOutboxIssue(paths);
  if (legacy !== undefined) {
    reporters.push(legacy.blocker);
  }
  const gateFailed = jsonFiles(paths.gateFailedDir, "");
  if (gateFailed === null) {
    blockers.push("gate_failed_dir_unreadable");
  }
  const config = identityStatus === "current" && identity !== null ? configStatus(identity) : null;
  const loopHeld = lockHeld(paths.loopLock);
  const token =
    identityStatus === "current" && typeof identity?.token === "string" ? identity.token : null;
  const adoption = observerAdoption(paths, token);
  return {
    config_status: config,
    control: controlReport({ identity, identityStatus, loopHeld, running }, paths),
    coordination_kit: coordinationKitReport(),
    coordinator_cli: coordinatorCliReport(paths.seam),
    drained: blockers.length === 0 && reporters.length === 0,
    events: events.report,
    gate_failed: gateFailed ?? [],
    identity,
    identity_status: identityStatus,
    idle: blockers.length === 0,
    idle_blockers: blockers,
    loop_lock_held: loopHeld,
    observer_adoption: adoption.status,
    observer_adoption_reason: adoption.reason,
    provenance: provenanceReport({ identity, identityStatus, loopHeld }, repo),
    reporter_blockers: reporters,
    runner_lock_held: running,
    status: running ? "running" : "not running",
  };
}
