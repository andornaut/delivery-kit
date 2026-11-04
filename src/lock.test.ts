import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { holdLock, holdLockAsync, LockBusy, lockIsFree, LockMissing, withLock } from "./lock.ts";

// CLEANUP (added 2026-11-03): the Python holder covers 0.9.x interoperation; remove it with the
// Python mechanisms once every game runs 1.x.
const HOLDERS = {
  bash: ["bash", "-c", 'exec 9>>"$1"; flock 9; echo held; exec sleep 60', "holder"],
  python: [
    "python3",
    "-c",
    [
      "import fcntl, sys, time",
      "f = open(sys.argv[1], 'a')",
      "fcntl.flock(f, fcntl.LOCK_EX)",
      "print('held', flush=True)",
      "time.sleep(60)",
    ].join("\n"),
  ],
} as const;

const PROBES = {
  bash: (path: string) => spawnSync("flock", ["-n", "-E", "3", path, "true"]).status,
  python: (path: string) =>
    spawnSync("python3", [
      "-c",
      [
        "import fcntl, sys",
        "f = open(sys.argv[1], 'a')",
        "try:",
        "    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)",
        "except BlockingIOError:",
        "    sys.exit(3)",
      ].join("\n"),
      path,
    ]).status,
};

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
});

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lock-")), "bus-queue.lock");
}

function startHolder(kind: keyof typeof HOLDERS, path: string): Promise<ChildProcess> {
  const [command, ...args] = HOLDERS[kind];
  const child = spawn(command, [...args, path], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.once("data", () => resolve(child));
    child.once("exit", (code) => reject(new Error(`${kind} holder exited with ${String(code)}`)));
  });
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
    } else {
      child.once("exit", () => resolve());
    }
  });
}

describe.each(["bash", "python"] as const)("interoperation with a %s flock holder", (kind) => {
  it("is excluded while the external holder runs and acquires once it exits", async () => {
    const path = lockPath();
    const holder = await startHolder(kind, path);
    expect(() => holdLock(path, { nonBlocking: true })).toThrow(LockBusy);
    expect(lockIsFree(path)).toBe(false);
    holder.kill("SIGKILL");
    await exited(holder);
    holdLock(path, { nonBlocking: true }).release();
  });

  it("excludes the external probe while held and releases it on release", () => {
    const path = lockPath();
    const lock = holdLock(path);
    expect(PROBES[kind](path)).toBe(3);
    lock.release();
    expect(PROBES[kind](path)).toBe(0);
  });
});

describe("read-only locks", () => {
  it("locks a read-only file in a read-only directory and excludes other holders", async () => {
    const path = lockPath();
    writeFileSync(path, "");
    chmodSync(path, 0o444);
    chmodSync(join(path, ".."), 0o555);
    try {
      const lock = holdLock(path, { nonBlocking: true, readOnly: true });
      expect(PROBES.bash(path)).toBe(3);
      expect(() => holdLock(path, { nonBlocking: true, readOnly: true })).toThrow(LockBusy);
      lock.release();
      // A 0.x holder in a read-only tree can only open the file for reading too.
      const holder = spawn(
        "bash",
        ["-c", 'exec 9<"$1"; flock 9; echo held; exec sleep 60', "x", path],
        {
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      children.push(holder);
      await new Promise((resolve) => {
        holder.stdout.once("data", resolve);
      });
      expect(() => holdLock(path, { nonBlocking: true, readOnly: true })).toThrow(LockBusy);
    } finally {
      chmodSync(join(path, ".."), 0o755);
    }
  });

  it("fails with LockMissing and creates nothing when the file is absent", () => {
    const path = lockPath();
    expect(() => holdLock(path, { readOnly: true })).toThrow(LockMissing);
    expect(existsSync(path)).toBe(false);
  });
});

describe("lock helpers", () => {
  it("times out a blocking wait with LockBusy", async () => {
    const path = lockPath();
    await startHolder("bash", path);
    const started = Date.now();
    expect(() => holdLock(path, { timeoutSeconds: 1 })).toThrow(LockBusy);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("waits asynchronously until the holder exits", async () => {
    const path = lockPath();
    const holder = await startHolder("bash", path);
    const pending = holdLockAsync(path);
    setTimeout(() => holder.kill("SIGKILL"), 200);
    const lock = await pending;
    expect(lockIsFree(path)).toBe(false);
    lock.release();
    expect(lockIsFree(path)).toBe(true);
  });

  it("is not inherited by spawned children", async () => {
    const path = lockPath();
    const lock = holdLock(path);
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    children.push(child);
    lock.release();
    expect(PROBES.bash(path)).toBe(0);
    child.kill("SIGKILL");
    await exited(child);
  });

  it("holds a withLock section through a returned promise and releases after errors", async () => {
    const path = lockPath();
    let release = (): void => undefined;
    const section = withLock(
      path,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    expect(PROBES.bash(path)).toBe(3);
    release();
    await section;
    expect(PROBES.bash(path)).toBe(0);
    expect(() =>
      withLock(path, () => {
        throw new Error("failed");
      }),
    ).toThrow("failed");
    expect(PROBES.bash(path)).toBe(0);
  });
});
