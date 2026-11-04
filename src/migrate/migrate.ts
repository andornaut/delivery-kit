// CLEANUP (added 2026-11-03): remove with src/migrate/ at convergence (see tree.ts).
//
// delivery-kit migrate: copy 0.x state into var/, build var/registry.json and make the old trees
// read-only. Every precondition and the registry derivation are evaluated before the first write,
// and a dry run stops there, writing nothing.
import { lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { holdExistingLock } from "../bus/locks.ts";
import { fsyncDirectory, readJsonIfExists, writeDurable, writeJsonDurable } from "../durable.ts";
import { gameLayout, type Layout } from "../layout.ts";
import { holdLock, LockBusy, type LockHandle } from "../lock.ts";
import { type Harness, type Registry, validateRegistry } from "../registry/schema.ts";
import { createRegistry, readRegistry } from "../registry/store.ts";
import { isMarker, type MigrationMarker } from "./marker.ts";
import { buildRegistry, type BuiltRegistry, type RegistrySources } from "./registryBuild.ts";
import {
  LEGACY_PATHS,
  planLegacyRemoval,
  type PlannedRemoval,
  removePlanned,
} from "./removeLegacy.ts";
import { copyRoute, describeRoute, planRoute, type RoutePlan } from "./route.ts";
import { type ProcessProbe, runnerFromNodeModules } from "./runnerRecord.ts";
import {
  copyEntries,
  type Entry,
  type Exclude,
  hashFile,
  removeOwnedTree,
  removeWriteBits,
  scanTree,
  totalBytes,
  treeDigest,
} from "./tree.ts";
import {
  blockers,
  gameUnit,
  legacyBusDir,
  monitorUnit,
  RUNNER_LOCKS,
  RUNNER_LOG,
  techRecords,
  type Unit,
} from "./units.ts";

export interface Reporter {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

export interface MigrateOptions {
  readonly dryRun: boolean;
  /** Migrate one game's bus only. Without it: every game, the monitor state and the registry. */
  readonly game?: string;
  /** The active harness, required when the 0.x records disagree. */
  readonly harness?: Harness;
  readonly home: string;
  readonly now?: () => Date;
  /** Read the 0.x registry files. Called only when var/registry.json is absent. */
  readonly readSources: () => RegistrySources;
}

export const PROVENANCE_FILE = "registry-provenance.json";

type Plan =
  | { readonly kind: "done"; readonly unit: Unit; readonly marker: MigrationMarker }
  | {
      readonly kind: "copy";
      readonly unit: Unit;
      readonly entries: readonly Entry[];
      readonly excluded: readonly string[];
      readonly log:
        { readonly from: string; readonly sha256: string; readonly size: number } | undefined;
      readonly rootMode: number;
    };

class Stop extends Error {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function recordingExclude(base: Exclude, extra: string | undefined, excluded: string[]): Exclude {
  return (path, kind) => {
    if (path === extra) {
      return true;
    }
    const skip = base(path, kind);
    if (skip) {
      excluded.push(kind === "dir" ? `${path}/` : path);
    }
    return skip;
  };
}

function planUnit(unit: Unit, problems: string[]): Plan | undefined {
  const label = `${unit.id}: `;
  let rootMode: number;
  try {
    const stats = statSync(unit.source);
    if (!stats.isDirectory()) {
      problems.push(`${label}${unit.source} is not a directory`);
      return undefined;
    }
    rootMode = stats.mode & 0o7777;
  } catch {
    problems.push(`${label}${unit.source} does not exist`);
    return undefined;
  }
  const markerValue = readJsonIfExists(unit.marker);
  if (markerValue !== undefined) {
    if (!isMarker(markerValue) || markerValue.source !== unit.source) {
      problems.push(`${label}${unit.marker} does not describe ${unit.source}`);
      return undefined;
    }
    if (!exists(unit.target)) {
      problems.push(`${label}${unit.marker} exists but ${unit.target} does not`);
      return undefined;
    }
    const digest = treeDigest(
      scanTree(recordingExclude(unit.exclude, markerValue.log?.from, []), unit.source),
    );
    if (digest !== markerValue.sourceDigest) {
      problems.push(
        `${label}${unit.source} changed since it was migrated; inspect before migrating again`,
      );
      return undefined;
    }
    return { kind: "done", marker: markerValue, unit };
  }
  if (exists(unit.target)) {
    problems.push(
      `${label}${unit.target} exists without ${unit.marker}; inspect it before migrating`,
    );
    return undefined;
  }
  const excluded: string[] = [];
  const all = scanTree(recordingExclude(unit.exclude, undefined, excluded), unit.source);
  const logEntry = unit.logCandidates
    .map((name) => all.find((entry) => entry.path === name && entry.kind === "file"))
    .find((entry) => entry !== undefined);
  problems.push(...blockers(unit, all).map((problem) => `${label}${problem}`));
  return {
    entries: all,
    excluded,
    kind: "copy",
    log:
      logEntry === undefined
        ? undefined
        : { from: logEntry.path, sha256: logEntry.digest, size: logEntry.size },
    rootMode,
    unit,
  };
}

function holdUnitLocks(held: LockHandle[], unit: Unit, problems: string[]): void {
  for (const lock of unit.locks) {
    const path = join(unit.source, lock);
    try {
      const handle = holdExistingLock(path);
      if (handle !== undefined) {
        held.push(handle);
      }
    } catch (error) {
      if (error instanceof LockBusy) {
        const runner = (RUNNER_LOCKS as readonly string[]).includes(lock);
        problems.push(`${unit.id}: ${lock} is held${runner ? ": a 0.x runner is running" : ""}`);
      } else {
        problems.push(`${unit.id}: ${message(error)}`);
      }
    }
  }
}

function copyUnit(plan: Extract<Plan, { kind: "copy" }>, now: Date): MigrationMarker {
  const { entries, log, unit } = plan;
  mkdirSync(dirname(unit.staging), { mode: 0o700, recursive: true });
  removeOwnedTree(unit.staging);
  const rename = (path: string): string => (path === log?.from ? RUNNER_LOG : path);
  copyEntries(unit.source, rename, plan.rootMode, entries, unit.staging);
  const expected = entries
    .map((entry) => ({ ...entry, path: rename(entry.path) }))
    .sort((left, right) => (left.path < right.path ? -1 : Number(left.path > right.path)));
  const actual = scanTree(() => false, unit.staging);
  const differs =
    actual.length !== expected.length ||
    actual.some((entry, index) => {
      const want = expected[index];
      return (
        want === undefined ||
        entry.path !== want.path ||
        entry.kind !== want.kind ||
        entry.digest !== want.digest ||
        entry.mode !== want.mode ||
        (entry.kind === "file" && entry.size !== want.size)
      );
    });
  if (differs) {
    throw new Stop(
      `${unit.id}: the staged copy does not match ${unit.source}; staging kept at ${unit.staging}`,
    );
  }
  if (log !== undefined && hashFile(join(unit.source, log.from)) !== log.sha256) {
    throw new Stop(`${unit.id}: ${log.from} changed during the copy`);
  }
  renameSync(unit.staging, unit.target);
  fsyncDirectory(dirname(unit.target));
  const copied = entries.filter((entry) => entry.path !== log?.from);
  const marker: MigrationMarker = {
    bytes: totalBytes(entries),
    entries: entries.length,
    excluded: plan.excluded,
    log: log === undefined ? null : { from: log.from, sha256: log.sha256, to: RUNNER_LOG },
    migratedAt: now.toISOString(),
    schema: 1,
    source: unit.source,
    sourceDigest: treeDigest(copied),
    target: unit.target,
    targetDigest: treeDigest(actual),
    unit: unit.id,
  };
  writeJsonDurable(unit.marker, marker);
  return marker;
}

/** Complete the move of the runner log: the source copy goes only once the target holds it. */
function finishLog(unit: Unit, marker: MigrationMarker): string | undefined {
  if (marker.log === null) {
    return undefined;
  }
  const source = join(unit.source, marker.log.from);
  if (!exists(source)) {
    return undefined;
  }
  if (hashFile(source) !== marker.log.sha256) {
    return `${unit.id}: ${source} was written after migration and is kept`;
  }
  if (hashFile(join(unit.target, marker.log.to)) !== marker.log.sha256) {
    throw new Stop(`${unit.id}: ${join(unit.target, marker.log.to)} does not hold the moved log`);
  }
  unlinkSync(source);
  fsyncDirectory(unit.source);
  return undefined;
}

/** Never overwrite var/handoffs/: a byte-identical file is skipped, a differing one stops. */
function checkCheckpoints(
  layout: Layout,
  built: BuiltRegistry,
  notes: string[],
  problems: string[],
): void {
  for (const copy of built.checkpoints) {
    const target = resolve(layout.root, copy.to);
    if (!exists(target)) {
      continue;
    }
    let same: boolean;
    try {
      same = readFileSync(target).equals(readFileSync(copy.from));
    } catch {
      same = false;
    }
    if (same) {
      notes.push(`checkpoint ${copy.to} already holds ${copy.from}; not copied again`);
    } else {
      problems.push(`checkpoint ${copy.to} exists with different content from ${copy.from}`);
    }
  }
}

function copyCheckpoints(layout: Layout, built: BuiltRegistry): void {
  for (const copy of built.checkpoints) {
    let data: Buffer;
    try {
      data = readFileSync(copy.from);
    } catch {
      continue;
    }
    const target = resolve(layout.root, copy.to);
    const current = exists(target) ? readFileSync(target) : undefined;
    if (current !== undefined) {
      if (!current.equals(data)) {
        throw new Stop(`${target} exists with different content from ${copy.from}`);
      }
      continue;
    }
    mkdirSync(dirname(target), { mode: 0o700, recursive: true });
    writeDurable(target, data);
  }
}

function describe(plan: Plan): string {
  if (plan.kind === "done") {
    return `${plan.unit.id}: already migrated at ${plan.marker.migratedAt} (source digest matches)\n`;
  }
  const lines = [
    `${plan.unit.id}: copy ${plan.unit.source} -> ${plan.unit.target}`,
    `  ${plan.entries.length} entries, ${totalBytes(plan.entries)} bytes`,
    `  excluded: ${plan.excluded.length === 0 ? "none" : plan.excluded.join(", ")}`,
    `  runner log: ${plan.log === undefined ? "none" : `${plan.log.from} -> ${RUNNER_LOG} (moved)`}`,
  ];
  if (plan.unit.bus) {
    const records = techRecords(plan.entries);
    lines.push(
      `  Tech-owned records, copied, not acted on: ${records.length === 0 ? "none" : records.join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function prepareRegistry(
  layout: Layout,
  options: MigrateOptions,
  notes: string[],
  problems: string[],
): BuiltRegistry | undefined {
  if (options.game !== undefined) {
    return undefined;
  }
  if (exists(layout.registryFile)) {
    notes.push(`${layout.registryFile} exists; not rebuilt`);
    return undefined;
  }
  try {
    const built = buildRegistry(layout, options.home, options.harness, options.readSources());
    validateRegistry(layout.config, {
      ...built.registry,
      revision: 1,
      updatedAt: (options.now?.() ?? new Date()).toISOString(),
    });
    checkCheckpoints(layout, built, notes, problems);
    return built;
  } catch (error) {
    problems.push(`registry: ${message(error)}`);
    return undefined;
  }
}

/** The roles the route maps through: the registry being built, else the existing one. */
function registryRoles(
  layout: Layout,
  built: BuiltRegistry | undefined,
  problems: string[],
): Registry["roles"] | undefined {
  if (built !== undefined) {
    return built.registry.roles;
  }
  if (!exists(layout.registryFile)) {
    return undefined;
  }
  try {
    return readRegistry(layout).roles;
  } catch (error) {
    problems.push(`route: ${message(error)}`);
    return undefined;
  }
}

/** Run the migration. Returns 0 on success or a completed dry run, 1 when it stops. */
export function runMigration(reporter: Reporter, layout: Layout, options: MigrateOptions): number {
  const now = options.now ?? ((): Date => new Date());
  const games = options.game === undefined ? Object.keys(layout.config.games) : [options.game];
  const units = games.map((game) => gameUnit(gameLayout(layout, game)));
  if (options.game === undefined) {
    units.push(monitorUnit(layout));
  }
  const problems: string[] = [];
  const notes: string[] = [];
  const held: LockHandle[] = [];
  let registryLock: LockHandle | undefined;
  try {
    if (!options.dryRun) {
      mkdirSync(layout.varDir, { mode: 0o700, recursive: true });
      try {
        registryLock = holdLock(layout.registryLock, { nonBlocking: true });
      } catch (error) {
        problems.push(`registry: ${message(error)}`);
      }
    }
    for (const unit of units) {
      if (exists(unit.source)) {
        holdUnitLocks(held, unit, problems);
      }
    }
    const plans = units
      .map((unit) => planUnit(unit, problems))
      .filter((plan): plan is Plan => plan !== undefined);
    const built = prepareRegistry(layout, options, notes, problems);
    const route: RoutePlan | undefined =
      options.game === undefined
        ? planRoute(layout, registryRoles(layout, built, problems), notes, problems)
        : undefined;
    reporter.out(plans.map(describe).join(""));
    if (route !== undefined) {
      reporter.out(describeRoute(route));
    }
    if (built !== undefined) {
      reporter.out(
        `registry: build ${layout.registryFile} (harness ${built.registry.harness}, ${
          Object.keys(built.registry.roles).length
        } roles, ${built.checkpoints.length} checkpoints)\n`,
      );
      for (const line of [...built.conflicts, ...built.skipped]) {
        reporter.out(`  ${line}\n`);
      }
    }
    for (const note of notes) {
      reporter.out(`note: ${note}\n`);
    }
    if (problems.length > 0) {
      reporter.err(problems.map((problem) => `delivery-kit: migrate: ${problem}\n`).join(""));
      return 1;
    }
    if (options.dryRun) {
      reporter.out("dry run: nothing written\n");
      return 0;
    }
    const markers: [Unit, MigrationMarker][] = plans.map((plan) => [
      plan.unit,
      plan.kind === "done" ? plan.marker : copyUnit(plan, now()),
    ]);
    for (const [unit, marker] of markers) {
      const kept = finishLog(unit, marker);
      if (kept !== undefined) {
        reporter.out(`note: ${kept}\n`);
      }
    }
    if (route?.kind === "copy") {
      copyRoute(now(), route);
    }
    if (built !== undefined) {
      copyCheckpoints(layout, built);
      const registry = createRegistry(layout, built.registry, {
        now,
        ...(registryLock === undefined ? {} : { held: registryLock }),
      });
      writeJsonDurable(join(layout.varDir, PROVENANCE_FILE), {
        conflicts: built.conflicts,
        fields: built.provenance,
        generatedAt: registry.updatedAt,
        revision: registry.revision,
        schema: 1,
        skipped: built.skipped,
      });
      reporter.out(`registry: wrote revision ${registry.revision}\n`);
    }
    for (const [unit] of markers) {
      const changed = removeWriteBits(unit.source);
      reporter.out(`${unit.id}: ${unit.source} is read-only (${changed} entries changed)\n`);
    }
    if (route !== undefined) {
      removeWriteBits(route.source);
      reporter.out(`route: ${route.source} is read-only\n`);
    }
    return 0;
  } catch (error) {
    reporter.err(`delivery-kit: migrate: ${message(error)}\n`);
    return 1;
  } finally {
    registryLock?.release();
    for (const handle of held) {
      handle.release();
    }
  }
}

/**
 * migrate --remove-legacy: delete the listed 0.x scripts once every game is migrated and its
 * resident runner runs from the game's node_modules. Every path is printed before any deletion.
 */
export function runRemoveLegacy(
  reporter: Reporter,
  layout: Layout,
  probe: ProcessProbe,
  dryRun: boolean,
): number {
  const problems: string[] = [];
  const plans: [string, PlannedRemoval[]][] = [];
  for (const game of Object.keys(layout.config.games)) {
    const entry = gameLayout(layout, game);
    if (!isMarker(readJsonIfExists(entry.migratedFile))) {
      problems.push(`${game}: not migrated (${entry.migratedFile} is missing)`);
    }
    const runner = runnerFromNodeModules(probe, entry);
    if (!runner.ok) {
      problems.push(runner.reason);
    }
    const paths = Object.hasOwn(LEGACY_PATHS, game) ? LEGACY_PATHS[game] : undefined;
    const plan = paths === undefined ? [] : planLegacyRemoval(paths, entry);
    for (const removal of plan.filter((candidate) => candidate.action === "wrong-kind")) {
      problems.push(`${removal.path} is not a ${removal.kind}; nothing deleted`);
    }
    plans.push([legacyBusDir(entry), plan]);
  }
  for (const [, plan] of plans) {
    for (const removal of plan) {
      reporter.out(`${removal.action === "delete" ? "delete" : removal.action}: ${removal.path}\n`);
    }
  }
  if (problems.length > 0) {
    reporter.err(problems.map((problem) => `delivery-kit: migrate: ${problem}\n`).join(""));
    return 1;
  }
  if (dryRun) {
    reporter.out("dry run: nothing deleted\n");
    return 0;
  }
  const removed = plans.reduce((sum, [directory, plan]) => sum + removePlanned(directory, plan), 0);
  reporter.out(`removed ${removed} legacy paths\n`);
  return 0;
}
