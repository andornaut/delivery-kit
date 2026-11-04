// Implementation adapters map abstract CLI operations to command lines. DK_IMPL selects one.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { bashImplementation } from "./bash-adapter.ts";
import { nodeImplementation } from "./node-adapter.ts";
import { KIT_ROOT, type Workspace } from "./workspace.ts";

export interface Result {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface Command {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /**
   * A log file the command writes instead of stdout (the 1.0 runner's runner.log). A resident
   * started from it replays the file's new content as stdout and stderr data.
   */
  logFile?: string;
}

export interface Implementation {
  readonly name: "bash" | "node";
  /** True when runnable; otherwise the reason its cases are skipped. */
  readonly available: true | string;
  /** `--help` or `help` without any configuration or state. */
  help(ws: Workspace, word: string): Command;
  /** A command with the game's configuration and state context. */
  command(ws: Workspace, words: string[]): Command;
  /** A command line without configuration or state context. */
  bare(ws: Workspace, words: string[]): Command;
  /**
   * Make new work available to the next departure. 0.9 queues the branches; 1.0 is trunk-based,
   * so local main moves to the scripted commit (an empty list leaves nothing new).
   */
  offer(ws: Workspace, branches: string[]): void;
  checkConfig(ws: Workspace): Command;
  status(ws: Workspace): Command;
  resourceReport(ws: Workspace): Command;
  request(ws: Workspace, id: string): Command;
  monitorSnapshot(ws: Workspace, args: string[]): Command;
  monitorAck(ws: Workspace, args: string[]): Command;
  run(ws: Workspace): Command;
  /** The Claude channel consumer (stdio MCP server). */
  channel(ws: Workspace, args: string[]): Command;
}

// CLEANUP (added 2026-11-04): remove once both games run delivery-kit 1.x and have completed one clean departure cycle.
// The bash implementation, DK_IMPL selection and the bash clock pause in startRunner; Node becomes
// the only implementation.
export const IMPL_NAME = (process.env.DK_IMPL ?? "bash") as "bash" | "node";
if (IMPL_NAME !== "bash" && IMPL_NAME !== "node")
  throw new Error(`DK_IMPL must be bash or node, not ${IMPL_NAME}`);
export const impl: Implementation = IMPL_NAME === "bash" ? bashImplementation : nodeImplementation;
export const NODE_CLI = join(KIT_ROOT, "dist", "cli.js");
export const nodeBuilt = existsSync(NODE_CLI);

export function execute(
  command: Command,
  options: { input?: string; timeoutMs?: number } = {},
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.argv[0]!, command.argv.slice(1), {
      cwd: command.cwd,
      env: command.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    // A command that should exit gets a generous ceiling; only a hung command reaches it.
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      Math.max(options.timeoutMs ?? 0, WAIT_CEILING_MS),
    );
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    // A command may exit before reading its input.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

/** Run an operation on the selected implementation. */
export function cli(
  ws: Workspace,
  words: string[],
  options?: { input?: string; timeoutMs?: number },
): Promise<Result> {
  return execute(impl.command(ws, words), options);
}

export interface Resident {
  readonly child: ChildProcessWithoutNullStreams;
  readonly done: Promise<Result>;
  /** Poll until the predicate holds; throws with the runner output on timeout. */
  until(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** SIGTERM the runner's process group, then SIGKILL stragglers. */
  stop(): Promise<Result>;
  /** Signal only the group leader, leaving detached children (CI watchers, flushers) running. */
  terminateLeader(): Promise<Result>;
  /** Output captured so far. */
  output(): { stdout: string; stderr: string };
}

/** Start a long-running command (the resident runner or the channel consumer) in its own group. */
export function start(command: Command): Resident {
  const child = spawn(command.argv[0]!, command.argv.slice(1), {
    cwd: command.cwd,
    env: command.env,
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  // Replay only what this run appends: an earlier run's log already belongs to that run.
  let offset = command.logFile && existsSync(command.logFile) ? statSync(command.logFile).size : 0;
  const tail = () => {
    if (!command.logFile || !existsSync(command.logFile)) return;
    const content = readFileSync(command.logFile);
    if (content.length > offset) {
      // 1.0 writes one log where 0.9 split stdout and stderr; cases see it on both streams.
      child.stdout.emit("data", content.subarray(offset));
      child.stderr.emit("data", content.subarray(offset));
      offset = content.length;
    }
  };
  const tailer = command.logFile ? setInterval(tail, 50) : undefined;
  const done = new Promise<Result>((resolve) =>
    child.on("close", (code, signal) => {
      if (tailer) clearInterval(tailer);
      tail();
      resolve({ code, signal, stdout, stderr });
    }),
  );
  let finished = false;
  void done.then(() => (finished = true));
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      // Group already gone.
    }
  };
  return {
    child,
    done,
    async until(predicate, timeoutMs = WAIT_CEILING_MS) {
      const deadline = Date.now() + Math.max(timeoutMs, WAIT_CEILING_MS);
      while (!predicate()) {
        if (finished || Date.now() > deadline) {
          throw new Error(
            `${finished ? "resident exited" : "timed out"} before condition\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    output: () => ({ stdout, stderr }),
    async terminateLeader() {
      // `exit`, not `close`: surviving children may still hold the output pipes.
      const exited = new Promise<Result>((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr })),
      );
      child.kill("SIGTERM");
      return exited;
    },
    async stop() {
      signalGroup("SIGTERM");
      const timer = setTimeout(() => signalGroup("SIGKILL"), 5_000);
      const result = await done;
      clearTimeout(timer);
      // Detached reporters share the group; never leave them running after a case.
      signalGroup("SIGKILL");
      return result;
    },
  };
}

/**
 * Start the resident runner. On Bash the virtual clock is paused until the runner holds its
 * lock and its loops have reached their first wait, then resumed at its speed: a slow start
 * under host load cannot move virtual time past the slot a case is aiming at. The 1.0 runner
 * reads its clock file once at startup, so its clock is not paused.
 */
export function startRunner(ws: Workspace): Resident {
  const speed = impl.name === "bash" && ws.pauseAtStart ? ws.pauseClock() : undefined;
  const sleepers = ws.sleepers();
  const resident = start(impl.run(ws));
  if (speed === undefined) return resident;
  let resumed = false;
  const resume = () => {
    if (!resumed) ws.resumeClock(speed);
    resumed = true;
  };
  const ready = (async () => {
    const deadline = Date.now() + READY_CEILING_MS;
    // Ready: the identity record (written under the runner lock), the loop's pid file (written
    // under the loop lock, just before its first clock read), and the reporter and notifier at
    // their first fake `sleep`. A short settle lets the loop finish that first read.
    const hadPid = ws.exists("codex-bus.pid") ? ws.read("codex-bus.pid") : undefined;
    while (
      Date.now() < deadline &&
      !(
        ws.exists("runner.identity.json") &&
        ws.exists("codex-bus.pid") &&
        ws.read("codex-bus.pid") !== hadPid &&
        ws.sleepers() >= sleepers + 2
      )
    ) {
      if (resident.child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 300));
    resume();
  })();
  return {
    ...resident,
    child: resident.child,
    done: resident.done,
    async until(predicate, timeoutMs) {
      await ready;
      return resident.until(predicate, timeoutMs);
    },
    async stop() {
      resume();
      return resident.stop();
    },
    async terminateLeader() {
      resume();
      return resident.terminateLeader();
    },
  };
}

/** The real-time ceiling for a runner to reach its first wait while the clock is paused. */
const READY_CEILING_MS = 120_000;

/** The least real time any condition wait allows; virtual-time conditions usually end sooner. */
export const WAIT_CEILING_MS = 120_000;
