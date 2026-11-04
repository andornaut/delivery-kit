// The bus state layout under var/games/<g>/bus/. Kept files keep their 0.9.x names.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeDurable } from "../durable.ts";

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
  readonly eventsDir: string;
  readonly gateLogsDir: string;
  readonly identity: string;
  readonly runnerJson: string;
  readonly resourcesLog: string;
  readonly runnerLog: string;
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
    eventsDir: at("events"),
    gateFailedDir: at("gate-failed"),
    gateLogsDir: at("gate-logs"),
    identity: at("runner.identity.json"),
    lastDeploy: at("last-deploy"),
    lastDeploySha: at("last-deploy.sha"),
    lastDeploySkippedSha: at("last-deploy-skipped.sha"),
    lastPush: at("last-push"),
    lastPushSha: at("last-push.sha"),
    loopLock: at("loop.lock"),
    requestsDir: at("requests"),
    requestsLock: join(dir, "requests", "requests.lock"),
    resourcesLog: at("resources.log"),
    runnerJson: at("runner.json"),
    runnerLock: at("runner.lock"),
    runnerLog: at("runner.log"),
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

/** The 0.9.x record encoding: sorted keys, ", " and ": " separators and ASCII escapes. */
export function pyDumps(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(pyDumps).join(", ")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${asciiJson(key)}: ${pyDumps(item)}`).join(", ")}}`;
  }
  return asciiJson(value);
}

function asciiJson(value: unknown): string {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return (JSON.stringify(value) ?? "null").replace(
    /[\u0080-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
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
