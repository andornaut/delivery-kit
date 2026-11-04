// Runner self-attested identity and a read-only singleton, idle and drain report.
// Only the runner writes its identity, while it holds runner.lock. The report never reads
// /proc: the singleton test is a non-blocking flock on the same lock files.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { writeDurable } from "../durable.ts";
import { lockHeld } from "./locks.ts";
import { type BusPaths, ciStatusFile, readText, readTrimmed, sortKeys } from "./state.ts";

export interface IdentityInput {
  readonly pid: number;
  readonly version: string;
  readonly sourceCommit: string | null;
  readonly config: string;
  readonly toolRoot: string;
  /** Epoch nanoseconds; injectable for tests. */
  readonly startedNs?: bigint;
}

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

/** Write runner.identity.json, then bind its token into runner.lock. */
export function recordIdentity(paths: BusPaths, input: IdentityInput): Record<string, unknown> {
  const started = input.startedNs ?? nowNs();
  const token = `${input.pid}:${started}:${randomUUID()}`;
  const startedAt = new Date(Number(started / 1_000_000n)).toISOString().replace(/\.\d{3}Z$/, "Z");
  const identity = {
    config: input.config,
    pid: input.pid,
    source_commit: input.sourceCommit,
    started_at: startedAt,
    started_ns: "__STARTED_NS__",
    state_dir: paths.dir,
    token,
    tool_root: input.toolRoot,
    version: input.version,
  };
  // started_ns exceeds the exact integer range of a double, so it is spliced in as text.
  const text = JSON.stringify(sortKeys(identity), null, 2).replace(
    '"__STARTED_NS__"',
    String(started),
  );
  writeDurable(paths.identity, `${text}\n`, { mode: 0o644 });
  // O_TRUNC keeps the lock inode; an older runner truncates this token on open.
  const fd = openSync(paths.runnerLock, constants.O_WRONLY | constants.O_TRUNC);
  try {
    writeSync(fd, `${token}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { ...identity, started_ns: started };
}

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
 * The identity file parsed with started_ns kept exact: null when it does not exist, "unreadable"
 * when it exists but cannot be read or is not a JSON object.
 */
function readIdentity(paths: BusPaths): Record<string, unknown> | "unreadable" | null {
  if (!existsSync(paths.identity)) {
    return null;
  }
  try {
    const text = readText(paths.identity);
    const value = parse(text?.replace(/"started_ns":\s*(\d+)/, '"started_ns": "$1"'));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return "unreadable";
    }
    const identity = value as Record<string, unknown>;
    if (typeof identity.started_ns === "string") {
      identity.started_ns = BigInt(identity.started_ns);
    }
    return identity;
  } catch {
    return "unreadable";
  }
}

export interface StatusReport {
  readonly [key: string]: unknown;
}

/** The status report. The last push needs a CI record, because every 1.x game watches CI. */
export function statusReport(paths: BusPaths): StatusReport {
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
  const reporters: string[] = [];
  const events = jsonFiles(paths.eventsDir, ".json");
  if (events === null) {
    // Its dispatch lock cannot be probed either.
    reporters.push("events_dir_unreadable");
  } else if (lockHeld(join(paths.eventsDir, "dispatch.lock"))) {
    reporters.push("event_flush_running");
  }
  let unsent = 0;
  for (const name of events ?? []) {
    let event: unknown;
    try {
      event = parse(readText(join(paths.eventsDir, name)));
    } catch {
      reporters.push(`event_unreadable:${name.slice(0, -".json".length)}`);
      continue;
    }
    if (typeof event === "object" && event !== null && !Array.isArray(event)) {
      const { sent, suppressed } = event as { sent?: unknown; suppressed?: unknown };
      if (!sent && !suppressed) {
        unsent += 1;
      }
    }
  }
  if (unsent > 0) {
    reporters.push(`unsent_events:${unsent}`);
  }
  const gateFailed = jsonFiles(paths.gateFailedDir, "");
  if (gateFailed === null) {
    blockers.push("gate_failed_dir_unreadable");
  }
  return {
    drained: blockers.length === 0 && reporters.length === 0,
    gate_failed: gateFailed ?? [],
    identity,
    identity_status: identityStatus,
    idle: blockers.length === 0,
    idle_blockers: blockers,
    loop_lock_held: lockHeld(paths.loopLock),
    reporter_blockers: reporters,
    runner_lock_held: running,
    status: running ? "running" : "not running",
  };
}
