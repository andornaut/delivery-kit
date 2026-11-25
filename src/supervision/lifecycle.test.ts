import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { busPaths } from "../state/paths.ts";
import {
  EXIT_WAIT_SECONDS,
  type Lifecycle,
  type RunnerStatus,
  START_WAIT_SECONDS,
  StartRefused,
  startRunner,
  stopRunner,
  type Target,
  unitFile,
} from "./lifecycle.ts";

const GAME = "archies-dog-walks";
const PID = 4242;
const CLI = {
  distSha256: "a".repeat(64),
  seenAt: "2026-11-19T12:00:00Z",
  supported: true,
  version: "3.0.0",
};

const STOPPED: RunnerStatus = {
  coordinator_cli: CLI,
  drained: true,
  identity: null,
  identity_status: "stale",
  idle: true,
  loop_lock_held: false,
  runner_lock_held: false,
};

function runningStatus(fields: Partial<RunnerStatus> = {}): RunnerStatus {
  return {
    coordinator_cli: CLI,
    drained: true,
    identity: { pid: PID, token: "t" },
    identity_status: "current",
    idle: true,
    loop_lock_held: true,
    runner_lock_held: true,
    ...fields,
  };
}

interface Fake extends Lifecycle {
  current: RunnerStatus;
  readonly calls: string[];
  /** Seconds of fake time elapsed. */
  elapsed(): number;
}

/** A fake lifecycle: `script` decides each status reading from the calls so far. */
function fake(
  options: {
    readonly status?: (fake: Fake) => RunnerStatus;
    readonly files?: readonly string[];
    readonly unitActive?: boolean;
    readonly spawnedPid?: number;
    readonly onKill?: (fake: Fake) => void;
    readonly onSystemctl?: (fake: Fake, args: readonly string[]) => void;
    readonly exited?: boolean;
  } = {},
): Fake {
  let now = 1_800_000_000_000;
  const start = now;
  const files = new Set(options.files ?? []);
  const lifecycle: Fake = {
    calls: [],
    current: STOPPED,
    elapsed: () => (now - start) / 1000,
    fileExists: (path) => files.has(path),
    kill(pid, signal) {
      lifecycle.calls.push(`kill ${pid} ${signal}`);
      options.onKill?.(lifecycle);
    },
    now: () => now,
    sleep(milliseconds) {
      now += milliseconds;
      return Promise.resolve();
    },
    spawnRunner(spec) {
      lifecycle.calls.push(`spawn ${spec.node} ${spec.cliPath} ${spec.game} ${spec.cwd}`);
      return { exited: () => options.exited ?? false, pid: options.spawnedPid ?? PID };
    },
    status: () => (options.status === undefined ? lifecycle.current : options.status(lifecycle)),
    systemctl(args) {
      lifecycle.calls.push(`systemctl ${args.join(" ")}`);
      options.onSystemctl?.(lifecycle, args);
      if (args[0] === "is-active") {
        return { status: options.unitActive === true ? 0 : 3 };
      }
      return { status: 0 };
    },
  };
  return lifecycle;
}

function target(pid: number | null = PID): Target & { home: string } {
  const base = mkdtempSync(join(tmpdir(), "lifecycle-"));
  const paths = busPaths(base);
  if (pid !== null) {
    writeFileSync(paths.runnerJson, JSON.stringify({ pid, schema: 1 }));
  }
  return { game: GAME, home: base, paths, unitFile: unitFile(base, GAME) };
}

describe("runner stop", () => {
  it("exits with method none when no runner runs", async () => {
    const lifecycle = fake();
    expect(await stopRunner(lifecycle, target())).toEqual({
      game: GAME,
      locksFree: true,
      method: "none",
      pid: null,
      schema: 1,
      stopped: true,
    });
    expect(lifecycle.calls).toEqual([]);
  });

  it("waits until idle and drained, then signals the identity holder and waits for the locks", async () => {
    let polls = 0;
    const lifecycle = fake({
      onKill: (self) => {
        self.current = STOPPED;
      },
      status: (self) => {
        polls += 1;
        if (self.calls.length > 0) {
          return self.current;
        }
        // A departure and then undrained events keep it busy for the first polls.
        if (polls <= 2) {
          return runningStatus({ drained: false, idle: false });
        }
        if (polls <= 4) {
          return runningStatus({ drained: false });
        }
        return runningStatus();
      },
    });
    const result = await stopRunner(lifecycle, target());
    expect(result).toEqual({
      game: GAME,
      locksFree: true,
      method: "signal",
      pid: PID,
      schema: 1,
      stopped: true,
    });
    expect(lifecycle.calls).toEqual([`kill ${PID} SIGTERM`]);
    expect(polls).toBeGreaterThan(5);
  });

  it("stops through the active systemd unit when its file exists", async () => {
    const t = target();
    const lifecycle = fake({
      files: [t.unitFile],
      onSystemctl: (self, args) => {
        if (args[0] === "stop") {
          self.current = STOPPED;
        }
      },
      unitActive: true,
    });
    lifecycle.current = runningStatus();
    expect(t.unitFile).toBe(
      join(t.home, ".config", "systemd", "user", "delivery-kit-archies-dog-walks.service"),
    );
    expect(await stopRunner(lifecycle, t)).toMatchObject({
      locksFree: true,
      method: "systemd",
      stopped: true,
    });
    expect(lifecycle.calls).toEqual([
      "systemctl is-active --quiet delivery-kit-archies-dog-walks",
      "systemctl stop delivery-kit-archies-dog-walks",
    ]);
  });

  it("signals a manually launched runner when the installed unit is inactive", async () => {
    const t = target();
    const lifecycle = fake({
      files: [t.unitFile],
      onKill: (self) => {
        self.current = STOPPED;
      },
    });
    lifecycle.current = runningStatus();
    expect(await stopRunner(lifecycle, t)).toMatchObject({ method: "signal", stopped: true });
    expect(lifecycle.calls).toEqual([
      "systemctl is-active --quiet delivery-kit-archies-dog-walks",
      `kill ${PID} SIGTERM`,
    ]);
  });

  it("leaves a runner that never becomes idle and drained untouched at the timeout", async () => {
    const lifecycle = fake();
    lifecycle.current = runningStatus({ drained: false, idle: false });
    expect(await stopRunner(lifecycle, target(), 60)).toEqual({
      game: GAME,
      locksFree: false,
      method: "none",
      pid: PID,
      schema: 1,
      stopped: false,
    });
    expect(lifecycle.calls).toEqual([]);
    expect(lifecycle.elapsed()).toBe(60);
  });

  it("refuses to signal a PID that no longer holds the runner identity", async () => {
    // runner.json names a PID the current identity does not: it may have been recycled.
    for (const status of [
      runningStatus({ identity: { pid: 9999, token: "t" } }),
      runningStatus({ identity_status: "unattested" }),
    ]) {
      const lifecycle = fake();
      lifecycle.current = status;
      // eslint-disable-next-line no-await-in-loop
      expect(await stopRunner(lifecycle, target())).toMatchObject({
        locksFree: false,
        method: "signal",
        pid: PID,
        stopped: false,
      });
      expect(lifecycle.calls).toEqual([]);
    }
    const missing = fake();
    missing.current = runningStatus();
    expect(await stopRunner(missing, target(null))).toMatchObject({ pid: null, stopped: false });
    expect(missing.calls).toEqual([]);
  });

  it("reports a runner that does not exit after the signal", async () => {
    const lifecycle = fake();
    lifecycle.current = runningStatus();
    expect(await stopRunner(lifecycle, target())).toMatchObject({
      locksFree: false,
      method: "signal",
      stopped: false,
    });
    expect(lifecycle.elapsed()).toBe(EXIT_WAIT_SECONDS);
  });
});

function startTarget(t = target()) {
  return {
    ...t,
    spawn: {
      cliPath: "/game/node_modules/@andornaut/delivery-kit/dist/cli.js",
      coordinatorRoot: "/coordinator",
      cwd: "/game",
      env: {},
      node: "/usr/bin/node",
    },
  };
}

describe("runner start", () => {
  it("refuses while either lock is held and starts nothing", async () => {
    for (const status of [
      runningStatus(),
      { ...STOPPED, runner_lock_held: true },
      { ...STOPPED, loop_lock_held: true },
    ]) {
      const t = startTarget();
      const lifecycle = fake({ files: [t.spawn.cliPath, t.unitFile] });
      lifecycle.current = status;
      // eslint-disable-next-line no-await-in-loop
      await expect(startRunner(lifecycle, t)).rejects.toThrow(StartRefused);
      expect(lifecycle.calls).toEqual([]);
    }
  });

  it("spawns the installed CLI without a unit and reports the runner's PID", async () => {
    const t = startTarget(target(null));
    const lifecycle = fake({
      files: [t.spawn.cliPath],
      spawnedPid: PID,
      status: (self) => {
        if (self.calls.length === 0 || self.elapsed() < 3) {
          return STOPPED;
        }
        writeFileSync(t.paths.runnerJson, JSON.stringify({ pid: PID, schema: 1 }));
        return runningStatus({ idle: true });
      },
    });
    expect(await startRunner(lifecycle, t)).toEqual({
      game: GAME,
      method: "spawn",
      pid: PID,
      schema: 1,
      status: { coordinator_cli: CLI, idle: true, running: true },
    });
    expect(lifecycle.calls).toEqual([`spawn /usr/bin/node ${t.spawn.cliPath} ${GAME} /game`]);
  });

  it("starts the unit when its file exists", async () => {
    const t = startTarget();
    const lifecycle = fake({
      files: [t.unitFile, t.spawn.cliPath],
      onSystemctl: (self) => {
        self.current = runningStatus();
      },
    });
    expect(await startRunner(lifecycle, t)).toMatchObject({ method: "systemd", pid: PID });
    expect(lifecycle.calls).toEqual(["systemctl start delivery-kit-archies-dog-walks"]);
  });

  it("does not accept a stale runner.json from an earlier runner", async () => {
    // runner.json still names the previous PID; the spawned runner never records its own.
    const t = startTarget(target(1111));
    const lifecycle = fake({
      files: [t.spawn.cliPath],
      spawnedPid: PID,
      status: (self) =>
        self.calls.length === 0 ? STOPPED : runningStatus({ identity: { pid: 1111, token: "t" } }),
    });
    await expect(startRunner(lifecycle, t)).rejects.toThrow(
      `did not come up within ${START_WAIT_SECONDS} s`,
    );
    expect(lifecycle.elapsed()).toBe(START_WAIT_SECONDS);
  });

  it("fails promptly when the spawned runner exits, and without an installed CLI", async () => {
    const t = startTarget();
    const exited = fake({ exited: true, files: [t.spawn.cliPath] });
    await expect(startRunner(exited, t)).rejects.toThrow("exited during startup");
    expect(exited.elapsed()).toBe(0);
    const missing = fake();
    await expect(startRunner(missing, startTarget())).rejects.toThrow("is missing");
    expect(missing.calls).toEqual([]);
  });
});
