// CLEANUP (added 2026-11-03): the 0.x singleton guard. Remove once every game has completed a
// clean 1.x cycle and no process references the old bus path (the plan's convergence step).
// Until then a 1.x runner also takes flock -n on the 0.x runner.lock and loop.lock, which are
// different files from the 1.x ones, so a 0.x and a 1.x runner never run together.
import { join } from "node:path";

import type { GameLayout } from "../layout.ts";
import type { LockHandle } from "../lock.ts";
import { holdExistingLock } from "./locks.ts";

/** The 0.x bus directory of a game: `<game>/.claude/bus`. */
export function legacyBusDir(game: GameLayout): string {
  return join(game.repo, ".claude", "bus");
}

export const LEGACY_LOCKS = ["runner.lock", "loop.lock"] as const;

/** Hold every existing 0.x singleton lock; throws LockBusy when a 0.x runner holds one. */
export function holdLegacyLocks(directory: string): LockHandle[] {
  const held: LockHandle[] = [];
  try {
    for (const name of LEGACY_LOCKS) {
      const lock = holdExistingLock(join(directory, name));
      if (lock !== undefined) {
        held.push(lock);
      }
    }
  } catch (error) {
    for (const lock of held) {
      lock.release();
    }
    throw error;
  }
  return held;
}
