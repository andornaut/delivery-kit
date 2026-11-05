// The status probe's lock test on files that must not be created. lock.ts opens them read-only,
// so probing never needs write access.
import { holdLock, LockBusy, LockMissing } from "../lock.ts";

/** True when another holder has the lock; never creates the file, and a missing file is free. */
export function lockHeld(path: string): boolean {
  try {
    holdLock(path, { nonBlocking: true, readOnly: true }).release();
    return false;
  } catch (error) {
    if (error instanceof LockMissing) {
      return false;
    }
    if (error instanceof LockBusy) {
      return true;
    }
    throw error;
  }
}
