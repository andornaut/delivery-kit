// CLEANUP (added 2026-11-03): remove with src/migrate/ at convergence (see tree.ts), or move the
// interface to the bus runner if status adopts it first.
//
// The resident runner's startup record, var/games/<g>/bus/runner.json, as migrate --remove-legacy
// reads it. The bus runner owns writing it; this module only reads and checks it, so the record's
// shape is the interface between the two.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { readJsonIfExists } from "../durable.ts";
import type { GameLayout } from "../layout.ts";

export const RUNNER_RECORD_FILE = "runner.json";

export interface RunnerRecord {
  readonly schema: 1;
  readonly pid: number;
  /** ISO 8601 UTC start time. */
  readonly startedAt: string;
  /** Loaded package version. */
  readonly version: string;
  /** realpath of the loaded dist/cli.js. */
  readonly cliPath: string;
  /** sha256 of the loaded dist/cli.js. */
  readonly cliSha256: string;
  /** Lockfile integrity of node_modules/@andornaut/delivery-kit, when installed from a lockfile. */
  readonly integrity?: string;
}

export interface ProcessProbe {
  /** True when `pid` exists (EPERM counts as existing). */
  alive(pid: number): boolean;
  /** The process's argv, or undefined when it cannot be read. */
  argv(pid: number): readonly string[] | undefined;
  /** realpath of `path`, or undefined when it does not resolve. */
  realpath(path: string): string | undefined;
}

export const PACKAGE_NAME = "@andornaut/delivery-kit";

export const procProbe: ProcessProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  argv(pid) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      return undefined;
    }
  },
  realpath(path) {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  },
};

function isRecord(value: unknown): value is RunnerRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schema === 1 &&
    Number.isInteger(record.pid) &&
    (record.pid as number) > 1 &&
    typeof record.startedAt === "string" &&
    typeof record.version === "string" &&
    typeof record.cliPath === "string" &&
    typeof record.cliSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(record.cliSha256) &&
    (record.integrity === undefined || typeof record.integrity === "string")
  );
}

export type RunnerCheck =
  | { readonly ok: true; readonly record: RunnerRecord }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether the game's resident runner is running from the game's own node_modules: runner.json is
 * valid, its pid is alive, its argv loads the recorded dist/cli.js, and that file is the one in
 * <repo>/node_modules/@andornaut/delivery-kit.
 */
export function runnerFromNodeModules(probe: ProcessProbe, game: GameLayout): RunnerCheck {
  const path = join(game.busDir, RUNNER_RECORD_FILE);
  let value: unknown;
  try {
    value = readJsonIfExists(path);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (value === undefined) {
    return { ok: false, reason: `${path}: no runner record` };
  }
  if (!isRecord(value)) {
    return { ok: false, reason: `${path}: not a version 1 runner record` };
  }
  const packageDir = probe.realpath(join(game.repo, "node_modules", PACKAGE_NAME));
  if (packageDir === undefined) {
    return { ok: false, reason: `${game.id}: ${PACKAGE_NAME} is not installed in node_modules` };
  }
  if (value.cliPath !== join(packageDir, "dist", "cli.js")) {
    return {
      ok: false,
      reason: `${game.id}: runner loaded ${value.cliPath}, not the node_modules copy`,
    };
  }
  if (!probe.alive(value.pid)) {
    return { ok: false, reason: `${game.id}: runner pid ${value.pid} is not running` };
  }
  const argv = probe.argv(value.pid);
  if (argv === undefined) {
    return { ok: false, reason: `${game.id}: cannot read the argv of pid ${value.pid}` };
  }
  if (!argv.some((arg) => probe.realpath(arg) === value.cliPath)) {
    return { ok: false, reason: `${game.id}: pid ${value.pid} is not running ${value.cliPath}` };
  }
  return { ok: true, record: value };
}
