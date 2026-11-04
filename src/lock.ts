// Locks use flock(1) from util-linux on an open file description this process owns.
//
// The process opens the lock file and passes that descriptor to `flock FD` as its fd 3. flock(2)
// locks belong to the open file description, so the lock stays held after the flock child exits
// and is released when this process closes its descriptor or exits. That is the same lock Bash
// (`exec 9>file; flock 9`) and Python (`fcntl.flock`) take on the same file, so all three
// exclude each other. Node opens files close-on-exec, so spawned children never inherit a lock.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";

export interface LockOptions {
  /** Fail with LockBusy instead of waiting when another holder has the lock. */
  readonly nonBlocking?: boolean;
  /** Fail with LockBusy after waiting this many seconds. Ignored when nonBlocking. */
  readonly timeoutSeconds?: number;
}

export interface LockHandle {
  readonly path: string;
  /** Release the lock. Idempotent. */
  release(): void;
}

export class LockBusy extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`${path}: lock is held by another process`);
    this.name = "LockBusy";
    this.path = path;
  }
}

export class LockError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "LockError";
    this.path = path;
  }
}

// flock exits with this code when -n or -w fails, distinguishing contention from errors.
const CONFLICT_EXIT = 75;
const LOCK_FD = "3";

function flockArgs(options: LockOptions): string[] {
  const args = ["-x", "-E", String(CONFLICT_EXIT)];
  if (options.nonBlocking === true) {
    args.push("-n");
  } else if (options.timeoutSeconds !== undefined) {
    args.push("-w", String(options.timeoutSeconds));
  }
  args.push(LOCK_FD);
  return args;
}

function openLockFile(path: string): number {
  return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
}

function handle(path: string, fd: number): LockHandle {
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

function settle(path: string, fd: number, status: number | null, detail: string): LockHandle {
  if (status === 0) {
    return handle(path, fd);
  }
  closeSync(fd);
  if (status === CONFLICT_EXIT) {
    throw new LockBusy(path);
  }
  throw new LockError(path, `flock failed (${detail || `status ${String(status)}`})`);
}

/** Acquire an exclusive lock, blocking the event loop while waiting. */
export function holdLock(path: string, options: LockOptions = {}): LockHandle {
  const fd = openLockFile(path);
  const result = spawnSync("flock", flockArgs(options), {
    stdio: ["ignore", "ignore", "pipe", fd],
  });
  const detail = result.error?.message ?? result.stderr.toString("utf8").trim();
  return settle(path, fd, result.error === undefined ? result.status : null, detail);
}

/** Acquire an exclusive lock without blocking the event loop while waiting. */
export function holdLockAsync(path: string, options: LockOptions = {}): Promise<LockHandle> {
  const fd = openLockFile(path);
  return new Promise((resolve, reject) => {
    const child = spawn("flock", flockArgs(options), { stdio: ["ignore", "ignore", "pipe", fd] });
    const stderr: Buffer[] = [];
    let done = false;
    const finish = (status: number | null, detail: string): void => {
      if (done) {
        return;
      }
      done = true;
      try {
        resolve(settle(path, fd, status, detail));
      } catch (failure) {
        reject(failure as Error);
      }
    };
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (status) => finish(status, Buffer.concat(stderr).toString("utf8").trim()));
  });
}

/** True when no other process holds the lock. Takes and releases it, so it never waits. */
export function lockIsFree(path: string): boolean {
  try {
    holdLock(path, { nonBlocking: true }).release();
    return true;
  } catch (error) {
    if (error instanceof LockBusy) {
      return false;
    }
    throw error;
  }
}

/** Run `fn` while holding the lock. A returned promise keeps the lock until it settles. */
export function withLock<T>(path: string, fn: () => T, options: LockOptions = {}): T {
  const lock = holdLock(path, options);
  let result: T;
  try {
    result = fn();
  } catch (error) {
    lock.release();
    throw error;
  }
  if (result instanceof Promise) {
    return result.finally(() => lock.release()) as T;
  }
  lock.release();
  return result;
}
