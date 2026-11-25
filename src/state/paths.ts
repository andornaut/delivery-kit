// The bus state layout under var/games/<g>/bus/. File names and encodings are persisted game
// state.
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeDurable } from "@andornaut/coordination-kit/build/shared";

import { CURSOR_FILE, EVENTS_FILE } from "./events.ts";

export interface BusPaths {
  readonly dir: string;
  readonly loopLock: string;
  readonly runnerLock: string;
  /** Serializes scheduled and requested departures: gate, push and deploy staging. */
  readonly departureLock: string;
  /** One file per main SHA whose gate failed; that SHA is never gated again. */
  readonly gateFailedDir: string;
  readonly activeDeparture: string;
  readonly busPid: string;
  readonly lastPush: string;
  readonly lastPushSha: string;
  readonly lastDeploy: string;
  readonly lastDeploySha: string;
  readonly lastDeploySkippedSha: string;
  readonly deployPending: string;
  readonly deployDir: string;
  readonly ciDir: string;
  readonly requestsDir: string;
  readonly requestsLock: string;
  /** The runner event log; the runner is its only writer. */
  readonly eventsLog: string;
  /** The ingest cursor, written only by `coordination-kit events ingest`. */
  readonly eventsCursor: string;
  /** The unmigrated 6.0 event outbox. Its presence blocks startup. */
  readonly legacyOutbox: string;
  /** The last SHA the runner saw complete: the base of the next deploy event's work range. */
  readonly lastCompleteSha: string;
  readonly gateLogsDir: string;
  readonly identity: string;
  readonly runnerJson: string;
  /** The last coordinator CLI identity a seam result carried; see seam.ts. */
  readonly seam: string;
  readonly resourcesLog: string;
  readonly runnerLog: string;
  /** The stdout and stderr of a runner `runner start` spawned without a unit. */
  readonly runnerOut: string;
}

export function busPaths(dir: string): BusPaths {
  const at = (name: string): string => join(dir, name);
  return {
    activeDeparture: at("active-departure"),
    busPid: at("codex-bus.pid"),
    ciDir: at("ci"),
    departureLock: at("departure.lock"),
    deployDir: at("deploy"),
    deployPending: at("deploy-pending"),
    dir,
    eventsCursor: at(CURSOR_FILE),
    eventsLog: at(EVENTS_FILE),
    gateFailedDir: at("gate-failed"),
    gateLogsDir: at("gate-logs"),
    identity: at("runner.identity.json"),
    lastCompleteSha: at("last-complete.sha"),
    lastDeploy: at("last-deploy"),
    lastDeploySha: at("last-deploy.sha"),
    lastDeploySkippedSha: at("last-deploy-skipped.sha"),
    lastPush: at("last-push"),
    lastPushSha: at("last-push.sha"),
    legacyOutbox: at("events"),
    loopLock: at("loop.lock"),
    requestsDir: at("requests"),
    requestsLock: join(dir, "requests", "requests.lock"),
    resourcesLog: at("resources.log"),
    runnerJson: at("runner.json"),
    runnerLock: at("runner.lock"),
    runnerLog: at("runner.log"),
    runnerOut: at("runner.out"),
    seam: at("seam.json"),
  };
}

/** Check the old outbox path without following symlinks or reading its contents. */
export function legacyOutboxIssue(paths: BusPaths):
  | {
      readonly blocker: "events_legacy_outbox" | "events_legacy_outbox_unreadable";
      readonly detail: string;
    }
  | undefined {
  try {
    if (lstatSync(paths.legacyOutbox, { throwIfNoEntry: false }) === undefined) {
      return undefined;
    }
  } catch (error) {
    return {
      blocker: "events_legacy_outbox_unreadable",
      detail: `cannot check the legacy event outbox at ${paths.legacyOutbox} (${String(error)})`,
    };
  }
  return {
    blocker: "events_legacy_outbox",
    detail:
      `legacy event outbox at ${paths.legacyOutbox}. Run Delivery Kit 6.1.2 with Coordination Kit ` +
      ">=2.0.1 <3.0.0 to import and drain it before starting this version",
  };
}

export function gateFailedFile(paths: BusPaths, sha: string): string {
  return join(paths.gateFailedDir, sha);
}

export function ciStatusFile(paths: BusPaths, sha: string): string {
  return join(paths.ciDir, `${sha}.status`);
}

/** File text, or undefined when it cannot be read. */
export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Trimmed file text, or undefined when unreadable. */
export function readTrimmed(path: string): string | undefined {
  return readText(path)?.trim();
}

/** True when the file has content (`[ -s file ]`). */
export function nonEmpty(path: string): boolean {
  const text = readText(path);
  return text !== undefined && text.length > 0;
}

/** Durable small state file; `lines` are written newline-terminated. */
export function writeLines(path: string, ...lines: readonly string[]): void {
  writeDurable(path, lines.map((line) => `${line}\n`).join(""), { mode: 0o644 });
}

/** Durably empty a file (`: >file`). */
export function truncate(path: string): void {
  writeDurable(path, "", { mode: 0o644 });
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
