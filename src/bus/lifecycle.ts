// `runner stop` and `runner start`: stop a game's runner once it is idle and drained, and start a
// single instance, through its systemd user unit when one is installed, otherwise by signal or a
// detached spawn. Both read only the read-only status report and bus/runner.json; neither touches
// the delivery control record or any coordination-kit state. Every process, systemctl and clock
// interaction is an injected seam.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type BusPaths } from "./state.ts";
import { statusReport } from "./status.ts";

/** Default `runner stop --timeout`, in seconds. */
export const STOP_TIMEOUT_SECONDS = 900;
/** How long `runner start` waits for the runner to hold its locks and record runner.json. */
export const START_WAIT_SECONDS = 30;
/** How long a stop waits for the process to exit; the unit kills a stop that takes longer. */
export const EXIT_WAIT_SECONDS = 150;
const POLL_MS = 1000;

export type StopMethod = "systemd" | "signal" | "none";
export type StartMethod = "systemd" | "spawn";

/** The summary each status poll needs; statusReport provides it. */
export interface RunnerStatus {
  readonly runner_lock_held: boolean;
  readonly loop_lock_held: boolean;
  readonly identity_status: string;
  readonly identity: Record<string, unknown> | null;
  readonly idle: boolean;
  readonly drained: boolean;
  readonly coordinator_cli: unknown;
}

export interface Lifecycle {
  /** The read-only status report. */
  readonly status: () => RunnerStatus;
  /** Run `systemctl --user ARGS`; the exit status. */
  readonly systemctl: (args: readonly string[]) => { readonly status: number | null };
  readonly fileExists: (path: string) => boolean;
  /** Send a signal to a process. */
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Start the runner detached; its PID, and a check for whether it has already exited. */
  readonly spawnRunner: (spec: SpawnSpec) => { readonly pid: number; exited(): boolean };
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface SpawnSpec {
  readonly node: string;
  readonly cliPath: string;
  readonly game: string;
  readonly cwd: string;
  readonly coordinatorRoot: string;
  /** bus/runner.out: the runner's stdout and stderr are appended here. */
  readonly output: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface Target {
  readonly game: string;
  readonly paths: BusPaths;
  /** The systemd user unit file for this game's runner. */
  readonly unitFile: string;
}

/** The unit name `runner unit` output is installed under. */
export function unitName(game: string): string {
  return `delivery-kit-${game}`;
}

/** ~/.config/systemd/user/delivery-kit-<game>.service. */
export function unitFile(home: string, game: string): string {
  return join(home, ".config", "systemd", "user", `${unitName(game)}.service`);
}

function running(report: RunnerStatus): boolean {
  return report.runner_lock_held || report.loop_lock_held;
}

/** The PID bus/runner.json records, or null when it is absent or unreadable. */
export function recordedPid(paths: BusPaths): number | null {
  try {
    const value = JSON.parse(readFileSync(paths.runnerJson, "utf8")) as { pid?: unknown };
    return Number.isSafeInteger(value.pid) && (value.pid as number) > 0
      ? (value.pid as number)
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether `pid` still holds the runner identity: runner.lock is held with the token
 * runner.identity.json records (identity_status `current`), and that identity names `pid`.
 */
function holdsIdentity(report: RunnerStatus, pid: number): boolean {
  return report.identity_status === "current" && report.identity?.pid === pid;
}

function unitActive(lifecycle: Lifecycle, target: Target): boolean {
  return (
    lifecycle.fileExists(target.unitFile) &&
    lifecycle.systemctl(["is-active", "--quiet", unitName(target.game)]).status === 0
  );
}

export interface StopResult {
  readonly schema: 1;
  readonly game: string;
  readonly pid: number | null;
  readonly method: StopMethod;
  readonly stopped: boolean;
  readonly locksFree: boolean;
}

/** Poll until both locks are free or the deadline passes; whether they are free. */
async function locksFreed(lifecycle: Lifecycle, deadline: number): Promise<boolean> {
  for (;;) {
    if (!running(lifecycle.status())) {
      return true;
    }
    if (lifecycle.now() >= deadline) {
      return false;
    }
    // eslint-disable-next-line no-await-in-loop
    await lifecycle.sleep(POLL_MS);
  }
}

/**
 * Wait until the runner is idle and drained, then stop it through its active unit or by SIGTERM
 * to the PID in runner.json, and wait for both locks to be free. On a timeout, or when the PID no
 * longer holds the runner identity, the runner is left untouched.
 */
export async function stopRunner(
  lifecycle: Lifecycle,
  target: Target,
  timeoutSeconds: number = STOP_TIMEOUT_SECONDS,
): Promise<StopResult> {
  const { game, paths } = target;
  const result = (fields: Omit<StopResult, "game" | "schema">): StopResult => ({
    game,
    schema: 1,
    ...fields,
  });
  const deadline = lifecycle.now() + timeoutSeconds * 1000;
  let report = lifecycle.status();
  while (running(report) && !report.drained) {
    if (lifecycle.now() >= deadline) {
      return result({ locksFree: false, method: "none", pid: recordedPid(paths), stopped: false });
    }
    // eslint-disable-next-line no-await-in-loop
    await lifecycle.sleep(POLL_MS);
    report = lifecycle.status();
  }
  const pid = recordedPid(paths);
  if (!running(report)) {
    return result({ locksFree: true, method: "none", pid: null, stopped: true });
  }
  let method: StopMethod;
  if (unitActive(lifecycle, target)) {
    method = "systemd";
    lifecycle.systemctl(["stop", unitName(game)]);
  } else {
    method = "signal";
    if (pid === null || !holdsIdentity(report, pid)) {
      return result({ locksFree: false, method, pid, stopped: false });
    }
    try {
      lifecycle.kill(pid, "SIGTERM");
    } catch {
      // It exited between the check and the signal; the lock check below decides.
    }
  }
  const freed = await locksFreed(lifecycle, lifecycle.now() + EXIT_WAIT_SECONDS * 1000);
  return result({ locksFree: freed, method, pid, stopped: freed });
}

export interface StartResult {
  readonly schema: 1;
  readonly game: string;
  readonly pid: number;
  readonly method: StartMethod;
  readonly status: {
    readonly running: boolean;
    readonly idle: boolean;
    readonly coordinator_cli: unknown;
  };
}

export class StartRefused extends Error {}

/**
 * Start one runner: refused while either lock is held. The unit when it is installed, otherwise a
 * detached spawn of the game's installed CLI. Resolves once the runner holds both locks with a
 * current identity that runner.json records, within START_WAIT_SECONDS.
 */
export async function startRunner(
  lifecycle: Lifecycle,
  target: Target & { readonly spawn: Omit<SpawnSpec, "output" | "game"> },
): Promise<StartResult> {
  const { game, paths } = target;
  if (running(lifecycle.status())) {
    throw new StartRefused(`a runner for ${game} is already running; nothing started`);
  }
  let method: StartMethod;
  let child: { readonly pid: number; exited(): boolean } | undefined;
  if (lifecycle.fileExists(target.unitFile)) {
    method = "systemd";
    const started = lifecycle.systemctl(["start", unitName(game)]);
    if (started.status !== 0) {
      throw new StartRefused(`systemctl --user start ${unitName(game)} failed`);
    }
  } else {
    method = "spawn";
    if (!lifecycle.fileExists(target.spawn.cliPath)) {
      throw new StartRefused(`${target.spawn.cliPath} is missing; run npm ci in the game checkout`);
    }
    child = lifecycle.spawnRunner({ ...target.spawn, game, output: paths.runnerOut });
  }
  const deadline = lifecycle.now() + START_WAIT_SECONDS * 1000;
  for (;;) {
    const report = lifecycle.status();
    const pid = recordedPid(paths);
    const up =
      report.runner_lock_held &&
      report.loop_lock_held &&
      pid !== null &&
      holdsIdentity(report, pid) &&
      (child === undefined || child.pid === pid);
    if (up) {
      return {
        game,
        method,
        pid,
        schema: 1,
        status: { coordinator_cli: report.coordinator_cli, idle: report.idle, running: true },
      };
    }
    if (child?.exited() === true) {
      throw new StartRefused(`the runner exited during startup; see ${paths.runnerOut}`);
    }
    if (lifecycle.now() >= deadline) {
      throw new StartRefused(
        `the runner did not come up within ${START_WAIT_SECONDS} s; see ${
          method === "spawn" ? paths.runnerOut : `journalctl --user -u ${unitName(game)}`
        }`,
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await lifecycle.sleep(POLL_MS);
  }
}

/** The production seams. */
export function systemLifecycle(paths: BusPaths, repo: string): Lifecycle {
  return {
    fileExists: existsSync,
    kill: (pid, signal) => process.kill(pid, signal),
    now: () => Date.now(),
    sleep: (milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
    spawnRunner(spec) {
      const output = openSync(spec.output, "a", 0o600);
      try {
        const child = spawn(spec.node, [spec.cliPath, "run", "--game", spec.game], {
          cwd: spec.cwd,
          detached: true,
          env: { ...spec.env, DELIVERY_KIT_ROOT: spec.coordinatorRoot },
          stdio: ["ignore", output, output],
        });
        let exited = false;
        child.once("exit", () => {
          exited = true;
        });
        child.once("error", () => {
          exited = true;
        });
        child.unref();
        return { exited: () => exited, pid: child.pid ?? -1 };
      } finally {
        closeSync(output);
      }
    },
    status: () => statusReport(paths, repo) as unknown as RunnerStatus,
    systemctl: (args) =>
      spawnSync("systemctl", ["--user", ...args], { stdio: "ignore", timeout: 300_000 }),
  };
}
