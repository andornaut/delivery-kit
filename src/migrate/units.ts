// CLEANUP (added 2026-11-03): remove with src/migrate/ at convergence (see tree.ts).
//
// The old 0.x trees, what each one copies, and the conditions under which it may be copied.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { lockHeld } from "../bus/locks.ts";
import { type GameLayout, type Layout } from "../layout.ts";
import type { Entry, EntryKind, Exclude } from "./tree.ts";

export interface Unit {
  /** A game ID, or "game-dev" for the monitor state. */
  readonly id: string;
  /** The old tree, for example <game>/.claude/bus. */
  readonly source: string;
  readonly target: string;
  readonly staging: string;
  readonly marker: string;
  readonly exclude: Exclude;
  /** Runner logs in preference order; the first present one moves to runner.log. */
  readonly logCandidates: readonly string[];
  /**
   * Locks, relative to `source`, taken with `flock -n` and held for the whole migration. A busy
   * runner.lock or loop.lock means a 0.x runner is running.
   */
  readonly locks: readonly string[];
  readonly bus: boolean;
}

export const RUNNER_LOG = "runner.log";

// The 0.9.x bus locks: queue, one-off requests, monitor delivery and events.
const BUS_LOCKS = [
  "bus-queue.lock",
  "requests/requests.lock",
  "unblock/unblock.lock",
  "unblock/monitor.lock",
  "events/state.lock",
  "events/dispatch.lock",
] as const;
export const RUNNER_LOCKS = ["runner.lock", "loop.lock"] as const;

/** Top-level names that are legacy scripts or script backups, never state. */
const SCRIPT_PATTERN = /\.(sh|py)(\..+)?$/;
const BUS_CONFIG_PATTERN = /^bus\.conf(\..+)?$/;
/** 0.x rollback snapshots kept beside the bus state. */
const BUS_SNAPSHOT_PATTERN = /^delivery-kit-rollback-/;
/** The npm cache is rebuilt by the 1.x gate in var/games/<g>/bus/npm-cache. */
const CACHE_DIRECTORIES = new Set(["npm-cache"]);

function isPyCache(path: string, kind: EntryKind): boolean {
  return kind === "dir" && (path === "__pycache__" || path.endsWith("/__pycache__"));
}

export const excludeBusEntry: Exclude = (path, kind) => {
  if (isPyCache(path, kind)) {
    return true;
  }
  if (path.includes("/")) {
    return false;
  }
  if (kind === "dir") {
    return BUS_SNAPSHOT_PATTERN.test(path) || CACHE_DIRECTORIES.has(path);
  }
  return SCRIPT_PATTERN.test(path) || BUS_CONFIG_PATTERN.test(path);
};

/** The monitor tree keeps a 0.x kit snapshot in delivery-kit/. */
export const excludeMonitorEntry: Exclude = (path, kind) => {
  if (isPyCache(path, kind)) {
    return true;
  }
  if (path.includes("/")) {
    return false;
  }
  return kind === "dir" ? path === "delivery-kit" : SCRIPT_PATTERN.test(path);
};

export function legacyBusDir(game: GameLayout): string {
  return join(game.repo, ".claude", "bus");
}

export function legacyMonitorDir(layout: Layout): string {
  return join(layout.root, ".claude", "monitor", "codex");
}

export function gameUnit(game: GameLayout): Unit {
  return {
    bus: true,
    exclude: excludeBusEntry,
    id: game.id,
    locks: [...RUNNER_LOCKS, ...BUS_LOCKS],
    logCandidates: [RUNNER_LOG, "codex-bus.log"],
    marker: game.migratedFile,
    source: legacyBusDir(game),
    staging: join(game.stateDir, ".bus.staging"),
    target: game.busDir,
  };
}

export function monitorUnit(layout: Layout): Unit {
  return {
    bus: false,
    exclude: excludeMonitorEntry,
    id: "game-dev",
    locks: ["monitor.lock", "unblock.lock"],
    logCandidates: [],
    marker: join(layout.varDir, "game-dev.migrated.json"),
    source: legacyMonitorDir(layout),
    staging: join(layout.varDir, ".game-dev.staging"),
    target: layout.monitorDir,
  };
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function nonEmptyFile(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

// Tech's 0.x admission and ready records beside the queue.
const ADMISSION_PATTERN = /^[^/]+-(queued|ready)\.json$/;

/**
 * 1.x delivers local main and has no queue, so the 0.x queue must be empty: no queued branch,
 * admitted record or ready record. Each entry is listed for Tech to land or drop first.
 */
export function queueBlockers(unit: Unit, entries: readonly Entry[]): string[] {
  const problems: string[] = [];
  let queue = "";
  try {
    queue = readFileSync(join(unit.source, "bus-queue"), "utf8");
  } catch {
    // No queue file is an empty queue.
  }
  for (const branch of new Set(queue.split("\n").filter((line) => line.trim() !== ""))) {
    problems.push(`bus-queue: ${branch} is queued; 1.x delivers local main and has no queue`);
  }
  for (const entry of entries) {
    const match = entry.kind === "file" ? ADMISSION_PATTERN.exec(entry.path) : null;
    if (match !== null) {
      const kind = match[1] === "queued" ? "admitted" : "ready";
      problems.push(`${entry.path}: ${kind} 0.x queue entry; land it on main or drop it first`);
    }
  }
  return problems;
}

/**
 * Reasons the unit cannot be migrated now. The caller holds `unit.locks` first, so nothing can
 * start a departure, request or delivery while these are read.
 */
export function blockers(unit: Unit, entries: readonly Entry[]): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "file" && /^ci\/[^/]+\.lock$/.test(entry.path)) {
      if (lockHeld(join(unit.source, entry.path))) {
        problems.push(`${entry.path} is held: a CI watch is running`);
      }
    }
    if (/(^|\/)claude-spool\/[^/]+\.claimed$/.test(entry.path)) {
      problems.push(`${entry.path}: a spool entry is claimed but not delivered`);
    }
  }
  if (!unit.bus) {
    return problems;
  }
  if (nonEmptyFile(join(unit.source, "active-departure"))) {
    problems.push("active-departure is not empty: a departure is in progress");
  }
  problems.push(...queueBlockers(unit, entries));
  if (exists(join(unit.source, "deploy-pending"))) {
    problems.push("deploy-pending exists: it names a worktree under the old bus");
  }
  for (const entry of entries) {
    if (entry.kind !== "file" || !/^requests\/[^/]+\.json$/.test(entry.path)) {
      continue;
    }
    let state: unknown;
    try {
      state = (
        JSON.parse(readFileSync(join(unit.source, entry.path), "utf8")) as { state?: unknown }
      ).state;
    } catch {
      problems.push(`${entry.path}: unreadable request record`);
      continue;
    }
    if (state === "started") {
      problems.push(`${entry.path}: request is started`);
    }
    if (state === "pending") {
      problems.push(`${entry.path}: request is pending with 0.x queue entries`);
    }
  }
  return problems;
}
