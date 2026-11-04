// Lock probes and guards on files that must not be created: the status probe and the 0.x
// runner guard. The descriptor is opened read-only, so a read-only legacy tree still locks.
// The flock(1) mechanism is the one lock.ts uses; see there for why the lock outlives flock.
import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";

import { LockBusy, type LockHandle } from "../lock.ts";

const CONFLICT_EXIT = 75;

function openExisting(path: string): number | undefined {
  try {
    return openSync(path, constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Take a non-blocking exclusive lock on an existing file. Returns undefined when the file does
 * not exist, and throws LockBusy when another open file description holds it.
 */
export function holdExistingLock(path: string): LockHandle | undefined {
  const fd = openExisting(path);
  if (fd === undefined) {
    return undefined;
  }
  const result = spawnSync("flock", ["-x", "-n", "-E", String(CONFLICT_EXIT), "3"], {
    stdio: ["ignore", "ignore", "pipe", fd],
  });
  if (result.status !== 0) {
    closeSync(fd);
    if (result.status === CONFLICT_EXIT) {
      throw new LockBusy(path);
    }
    throw new Error(`${path}: flock failed (${result.error?.message ?? String(result.status)})`);
  }
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

/** status.py lock_held: true when another holder has the lock; never creates the file. */
export function lockHeld(path: string): boolean {
  try {
    holdExistingLock(path)?.release();
    return false;
  } catch (error) {
    if (error instanceof LockBusy) {
      return true;
    }
    throw error;
  }
}
