// Lock probes on files that must not be created: the status probe and the migration's old-tree
// locks. lock.ts opens these read-only, so a read-only legacy tree still locks.
import { holdLock, LockBusy, type LockHandle, LockMissing } from "../lock.ts";

/**
 * Take a non-blocking exclusive lock on an existing file. Returns undefined when the file does
 * not exist, and throws LockBusy when another open file description holds it.
 */
export function holdExistingLock(path: string): LockHandle | undefined {
  try {
    return holdLock(path, { nonBlocking: true, readOnly: true });
  } catch (error) {
    if (error instanceof LockMissing) {
      return undefined;
    }
    throw error;
  }
}

/** True when another holder has the lock; never creates the file. */
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
