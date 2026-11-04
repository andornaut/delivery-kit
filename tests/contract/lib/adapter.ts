// Implementation adapters map abstract CLI operations to command lines. DK_IMPL selects one.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

export const IMPL_NAME = (process.env.DK_IMPL ?? "bash") as "bash" | "node";
if (IMPL_NAME !== "bash" && IMPL_NAME !== "node") throw new Error(`DK_IMPL must be bash or node, not ${IMPL_NAME}`);
export const impl: Implementation = IMPL_NAME === "bash" ? bashImplementation : nodeImplementation;
export const NODE_CLI = join(KIT_ROOT, "dist", "cli.js");
export const nodeBuilt = existsSync(NODE_CLI);

export function execute(command: Command, options: { input?: string; timeoutMs?: number } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.argv[0]!, command.argv.slice(1), { cwd: command.cwd, env: command.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 20_000);
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
export function cli(ws: Workspace, words: string[], options?: { input?: string; timeoutMs?: number }): Promise<Result> {
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
  const done = new Promise<Result>((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr })),
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
    async until(predicate, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
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

export function startRunner(ws: Workspace): Resident {
  return start(impl.run(ws));
}
