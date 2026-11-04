// CLEANUP (added 2026-11-03): remove with src/migrate/ at convergence (see tree.ts).
//
// The only paths migrate --remove-legacy deletes. Each entry names its expected kind; a path of
// another kind stops the removal before anything is deleted. Paths not listed are never deleted.
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { fsyncDirectory } from "../durable.ts";
import type { GameLayout } from "../layout.ts";
import { legacyBusDir } from "./units.ts";

export type LegacyKind = "file" | "symlink";

export interface LegacyPath {
  readonly name: string;
  readonly kind: LegacyKind;
}

const BUS_SCRIPTS = [
  "batch.sh",
  "bus-common.sh",
  "bus.sh",
  "ci-watch.sh",
  "departure.sh",
  "merge.sh",
  "post-push.sh",
  "resource-check.sh",
  "resource-report.sh",
  "scheduled-once.sh",
] as const;

/** Per game, the legacy entries in <game>/.claude/bus. */
export const LEGACY_PATHS: Readonly<Record<string, readonly LegacyPath[]>> = {
  "archies-dog-walks": [
    ...BUS_SCRIPTS.map((name) => ({ kind: "file" as const, name })),
    { kind: "file", name: "runner.sh" },
  ],
  "chibis-way-home": [
    ...BUS_SCRIPTS.map((name) => ({ kind: "symlink" as const, name })),
    { kind: "symlink", name: "event.py" },
    { kind: "symlink", name: "unblock.py" },
    { kind: "file", name: "runner.before-monitor-041.sh" },
  ],
};

export interface PlannedRemoval {
  readonly path: string;
  readonly kind: LegacyKind;
  /** "delete", "absent" (already gone) or a problem that stops the removal. */
  readonly action: "delete" | "absent" | "wrong-kind";
}

function kindAt(path: string): LegacyKind | "other" | undefined {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      return "symlink";
    }
    return stats.isFile() ? "file" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function planLegacyRemoval(
  paths: readonly LegacyPath[],
  game: GameLayout,
): PlannedRemoval[] {
  const directory = legacyBusDir(game);
  return paths.map(({ kind, name }) => {
    const path = join(directory, name);
    const actual = kindAt(path);
    let action: PlannedRemoval["action"] = "delete";
    if (actual === undefined) {
      action = "absent";
    } else if (actual !== kind) {
      action = "wrong-kind";
    }
    return { action, kind, path };
  });
}

/**
 * Unlink the planned paths. The old bus directory is read-only after migration, so owner write
 * access is restored on that one directory for the unlinks and its previous mode put back.
 */
export function removePlanned(directory: string, plan: readonly PlannedRemoval[]): number {
  const targets = plan.filter((entry) => entry.action === "delete");
  if (targets.length === 0) {
    return 0;
  }
  const mode = lstatSync(directory).mode & 0o7777;
  chmodSync(directory, mode | 0o200);
  try {
    for (const entry of targets) {
      unlinkSync(entry.path);
    }
    fsyncDirectory(directory);
  } finally {
    chmodSync(directory, mode);
  }
  return targets.length;
}
