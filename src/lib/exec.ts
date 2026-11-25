// Child processes for the bus. Only git, docker, gh and the game's own Wrangler (run by this
// Node binary from the game's node_modules) may be spawned; locks spawn flock in lock.ts.
import { spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";

export interface ExecSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Append stdout and stderr to this file instead of capturing them. */
  readonly logFile?: string;
  readonly timeoutMs?: number;
}

export interface ExecResult {
  /** Exit status, or null when the process was killed or could not start. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The signal that ended the process, when one did. */
  readonly signal?: NodeJS.Signals | null;
}

export type Exec = (spec: ExecSpec) => Promise<ExecResult>;

export const WRANGLER_ENTRY = "node_modules/wrangler/bin/wrangler.js";
const ALLOWED = new Set(["docker", "gh", "git"]);

class ExecRefused extends Error {
  constructor(command: string) {
    super(`refusing to spawn ${command}: not an allowed bus child process`);
    this.name = "ExecRefused";
  }
}

function allowed(spec: ExecSpec): boolean {
  if (ALLOWED.has(spec.command)) {
    return true;
  }
  return spec.command === process.execPath && spec.args[0] === WRANGLER_ENTRY;
}

export const spawnExec: Exec = (spec) => {
  if (!allowed(spec)) {
    return Promise.reject(new ExecRefused(spec.command));
  }
  const logFd =
    spec.logFile === undefined
      ? undefined
      : openSync(spec.logFile, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
  const output = logFd ?? "pipe";
  return new Promise((resolve) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      stdio: ["ignore", output, output],
      // A timeout kills with SIGKILL, so SIGTERM and SIGINT always mean an outside stop.
      ...(spec.timeoutMs === undefined ? {} : { killSignal: "SIGKILL", timeout: spec.timeoutMs }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    let settled = false;
    const finish = (
      status: number | null,
      extra = "",
      signal: NodeJS.Signals | null = null,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (logFd !== undefined) {
        closeSync(logFd);
      }
      resolve({
        signal,
        status,
        stderr: Buffer.concat(stderr).toString("utf8") + extra,
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    };
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (status, signal) => finish(status, "", signal));
  });
};

/**
 * A child ended by SIGTERM or SIGINT was stopped from outside, by the runner's own shutdown
 * (the signal reaches the whole process group). It is not a failure of what it was doing.
 */
export function interrupted(result: ExecResult): boolean {
  return result.signal === "SIGTERM" || result.signal === "SIGINT";
}

export class Interrupted extends Error {
  constructor(what: string) {
    super(`${what} was stopped by a shutdown signal`);
    this.name = "Interrupted";
  }
}

/** Throw Interrupted when `result` was stopped by a shutdown signal. */
export function assertNotInterrupted(what: string, result: ExecResult): ExecResult {
  if (interrupted(result)) {
    throw new Interrupted(what);
  }
  return result;
}

/** Run git and return trimmed stdout, or throw with its diagnostic. */
export async function git(exec: Exec, cwd: string, args: readonly string[]): Promise<string> {
  const result = assertNotInterrupted(
    `git ${args[0] ?? ""}`,
    await exec({ args: ["-C", cwd, ...args], command: "git" }),
  );
  if (result.status !== 0) {
    throw new GitError(args, result);
  }
  return result.stdout.trim();
}

class GitError extends Error {
  readonly result: ExecResult;

  constructor(args: readonly string[], result: ExecResult) {
    const detail = result.stderr.trim() || `exit ${String(result.status)}`;
    super(`git ${args.join(" ")} failed: ${detail}`);
    this.name = "GitError";
    this.result = result;
  }
}

/** Run git and report only success. */
export async function gitOk(exec: Exec, cwd: string, args: readonly string[]): Promise<boolean> {
  return (await exec({ args: ["-C", cwd, ...args], command: "git" })).status === 0;
}
