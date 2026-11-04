// CLEANUP (added 2026-11-03): remove with src/migrate/ at convergence (see tree.ts).
//
// Old-tree locks are opened read-only and never created: the migration makes those trees
// read-only, and flock(2) works on a read-only descriptor, so the same probe holds before and
// after. It is the same lock 0.9.x takes with `exec 5>file; flock 5` or fcntl.flock.
import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";

import { LockBusy, LockError } from "../lock.ts";

export interface HeldLock {
  readonly path: string;
  release(): void;
}

const CONFLICT_EXIT = 75;

/**
 * Take `path` with `flock -n` on a read-only descriptor. Returns undefined when the lock file does
 * not exist (no 0.9.x process can be holding it); throws LockBusy when another process holds it.
 */
export function holdExistingLock(path: string): HeldLock | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new LockError(path, `cannot open (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  const result = spawnSync("flock", ["-x", "-n", "-E", String(CONFLICT_EXIT), "3"], {
    stdio: ["ignore", "ignore", "pipe", fd],
  });
  if (result.error === undefined && result.status === 0) {
    let open = true;
    return {
      path,
      release(): void {
        if (open) {
          open = false;
          closeSync(fd);
        }
      },
    };
  }
  closeSync(fd);
  if (result.status === CONFLICT_EXIT) {
    throw new LockBusy(path);
  }
  const detail = result.error?.message ?? result.stderr.toString("utf8").trim();
  throw new LockError(path, `flock failed (${detail || `status ${String(result.status)}`})`);
}

/** True when nobody holds `path` (or it does not exist). Takes and releases it. */
export function existingLockIsFree(path: string): boolean {
  try {
    holdExistingLock(path)?.release();
    return true;
  } catch (error) {
    if (error instanceof LockBusy) {
      return false;
    }
    throw error;
  }
}
