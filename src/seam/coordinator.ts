// The review and event seam: the runner spawns the coordinator-installed coordination-kit CLI with
// the running Node binary and reads one typed JSON result line from it. A failed spawn, a missing
// or unreadable result, a nonzero exit, a timeout or an abort claims no delivery. The CLI owns the
// per-slot receipt and dedupe; the runner keeps no slot receipt and never reads brief content.
import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

import { APP_COORDINATOR_CLI_RANGE, COORDINATOR_CLI_RANGE, satisfies } from "../compatibility.ts";
import { isFile } from "../lib/files.ts";
import { type CliIdentity, writeSeamRecord } from "../state/seam.ts";
import {
  CLI_UNAVAILABLE,
  CLI_VERSION,
  type Expected,
  ingestLine,
  oneLine,
  parseResult,
  parseVersion,
  type SeamOutcome,
  type SeamResult,
  slotIso,
} from "./result.ts";

/** The CLI path under the coordinator root; `npm ci` there replaces it in place. */
export const COORDINATOR_CLI = join(
  "node_modules",
  "@andornaut",
  "coordination-kit",
  "dist",
  "cli.js",
);
/** Each spawn's deadline, under the 60 s observer pass. */
const SEAM_TIMEOUT_MS = 45_000;
const MAX_STDOUT = 1024 * 1024;
const STDERR_TAIL = 2000;

type Spawned =
  | { readonly kind: "missing" }
  | { readonly kind: "exited"; readonly code: number; readonly stdout: string; stderr: string }
  | { readonly kind: "failed"; readonly why: string };

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group has already exited.
  }
}

/** Spawn the CLI in its own process group; a timeout or an abort kills the whole group. */
function runCli(
  options: { readonly cliPath: string; readonly root: string; readonly timeoutMs: number },
  args: readonly string[],
  signal: AbortSignal,
): Promise<Spawned> {
  if (signal.aborted) {
    return Promise.resolve({ kind: "failed", why: "aborted" });
  }
  if (!isFile(options.cliPath)) {
    return Promise.resolve({ kind: "missing" });
  }
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [options.cliPath, "--root", options.root, ...args], {
        cwd: options.root,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ kind: "failed", why: `spawn failed: ${String(error)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let ended: string | undefined;
    const end = (why: string): void => {
      ended ??= why;
      killGroup(child);
    };
    const timer = setTimeout(
      () => end(`timed out after ${options.timeoutMs} ms`),
      options.timeoutMs,
    );
    const onAbort = (): void => end("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT) {
        end(`stdout exceeded ${MAX_STDOUT} bytes`);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    const settle = (result: Spawned): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    // A child that never started emits no close event.
    child.once("error", (error) => {
      end(`spawn failed: ${error.message}`);
      if (child.pid === undefined) {
        settle({ kind: "failed", why: `spawn failed: ${error.message}` });
      }
    });
    child.once("close", (code, killed) => {
      if (ended !== undefined) {
        settle({ kind: "failed", why: ended });
      } else if (code === null) {
        settle({ kind: "failed", why: `killed by ${killed ?? "a signal"}` });
      } else {
        settle({ code, kind: "exited", stderr, stdout });
      }
    });
  });
}

/** What the runner needs from the seam; the observer and the event log call it. */
export interface Coordinator {
  /** Deliver one due review slot. */
  review(slot: number, signal?: AbortSignal): Promise<SeamOutcome>;
  /** Request an event ingest: at most one runs, and a request during one runs one more after it. */
  ingest(): void;
  /**
   * Read the CLI identity with `--version --json` for an early log line and `runner.started`;
   * undefined when it is unavailable.
   */
  probe(signal?: AbortSignal): Promise<CliIdentity | undefined>;
  /** Kill every running child's process group. */
  stop(): void;
  /** Settle every running child and queued ingest. */
  drain(): Promise<void>;
}

interface CoordinatorOptions {
  /** The coordinator root, passed as `--root` and used as the working directory. */
  readonly root: string;
  readonly game: string;
  readonly appMode?: boolean;
  /** The coordinator `config.json` timezone the wake slots are selected in. */
  readonly timezone: string;
  /** bus/seam.json. */
  readonly seamFile: string;
  readonly log: (line: string) => void;
  /** Epoch seconds. */
  readonly now: () => number;
  readonly timeoutMs?: number;
}

function describeIdentity(cli: CliIdentity): string {
  return `${cli.version} (dist sha256 ${cli.distSha256})`;
}

/** Re-probe an executable replaced by an in-place package install. */
function cliFileKey(path: string): string | undefined {
  try {
    const info = statSync(path, { bigint: true });
    return info.isFile()
      ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
      : undefined;
  } catch {
    return undefined;
  }
}

/** The seam over the coordinator-installed CLI. */
export class CoordinatorCli implements Coordinator {
  readonly #options: CoordinatorOptions;
  readonly #cliPath: string;
  readonly #range: string;
  readonly #stop = new AbortController();
  readonly #running = new Set<Promise<unknown>>();
  #identity: (CliIdentity & { readonly supported: boolean }) | undefined;
  #probedFile: string | undefined;
  #written: { readonly key: string; readonly at: number } | undefined;
  #probing: Promise<CliIdentity | SeamOutcome> | undefined;
  #ingesting = false;
  #ingestAgain = false;
  #lastIngestLine: string | undefined;

  constructor(options: CoordinatorOptions) {
    this.#options = options;
    this.#cliPath = join(options.root, COORDINATOR_CLI);
    this.#range = options.appMode === true ? APP_COORDINATOR_CLI_RANGE : COORDINATOR_CLI_RANGE;
  }

  #spawn(args: readonly string[], signal?: AbortSignal): Promise<Spawned> {
    const combined =
      signal === undefined ? this.#stop.signal : AbortSignal.any([this.#stop.signal, signal]);
    const run = runCli(
      {
        cliPath: this.#cliPath,
        root: this.#options.root,
        timeoutMs: this.#options.timeoutMs ?? SEAM_TIMEOUT_MS,
      },
      args,
      combined,
    );
    this.#running.add(run);
    void run.finally(() => this.#running.delete(run));
    return run;
  }

  /** Record a CLI identity: log it when it changes and keep bus/seam.json current. */
  #note(cli: CliIdentity): boolean {
    const supported = satisfies(this.#range, cli.version);
    const previous = this.#identity;
    if (previous?.version !== cli.version || previous.distSha256 !== cli.distSha256) {
      this.#identity = { ...cli, supported };
      const range = supported
        ? `, inside ${this.#range}`
        : ` is outside ${this.#range}; reviews and event delivery defer`;
      this.#options.log(`bus: coordinator CLI ${describeIdentity(cli)}${range}`);
    }
    // One durable write per identity change, then at most one a minute for seenAt.
    const now = this.#options.now();
    const key = `${cli.version}:${cli.distSha256}`;
    if (this.#written?.key !== key || now - this.#written.at >= 60) {
      try {
        writeSeamRecord(this.#options.seamFile, now, cli);
        this.#written = { at: now, key };
      } catch (error) {
        this.#options.log(`bus: ${this.#options.seamFile} not written (${String(error)})`);
      }
    }
    return supported;
  }

  #unavailable(): SeamResult {
    return {
      claimed: true,
      detail: `${this.#cliPath} is missing`,
      reason: CLI_UNAVAILABLE,
      status: "deferred",
    };
  }

  #outOfRange(cli: CliIdentity): SeamResult {
    return {
      claimed: true,
      detail: `coordinator CLI ${cli.version} is outside ${this.#range}`,
      reason: CLI_VERSION,
      status: "deferred",
    };
  }

  /** The result of one spawn, with the identity noted and the range applied. */
  async #call(expected: Expected, signal?: AbortSignal): Promise<SeamOutcome> {
    // The startup probe settles first, so the first call already knows the CLI identity.
    await this.#probing;
    if (this.#stop.signal.aborted || signal?.aborted === true) {
      return { claimed: false, why: "aborted" };
    }
    const file = cliFileKey(this.#cliPath);
    const prior = this.#identity;
    // App workspaces keep their existing fresh probe. For legacy workspaces, reuse a successful
    // probe while the executable is unchanged and its last seen version is supported.
    let identity: CliIdentity;
    if (
      this.#options.appMode === true ||
      prior?.supported !== true ||
      file === undefined ||
      file !== this.#probedFile
    ) {
      const probed = await this.#probe(signal);
      if ("claimed" in probed) {
        return probed;
      }
      identity = probed;
    } else {
      identity = prior;
    }
    const app = satisfies(APP_COORDINATOR_CLI_RANGE, identity.version);
    const flag = app ? "--app" : "--game";
    const args =
      expected.kind === "review-deliver"
        ? ["review", "deliver", flag, expected.game, "--slot", expected.slot]
        : ["events", "ingest", flag, expected.game];
    const spawned = await this.#spawn(args, signal);
    if (spawned.kind === "missing") {
      return this.#unavailable();
    }
    if (spawned.kind === "failed") {
      return { claimed: false, why: spawned.why };
    }
    if (spawned.code !== 0) {
      const stderr = oneLine(spawned.stderr);
      return {
        claimed: false,
        why: `exit ${spawned.code}${stderr === "" ? "" : `: ${stderr}`}`,
      };
    }
    const result = parseResult(expected, app ? "appId" : "game", spawned.stdout);
    if (!result.claimed || result.cli === undefined) {
      return result;
    }
    return this.#note(result.cli) ? result : this.#outOfRange(result.cli);
  }

  /** A supported CLI identity, or a deferral or failure to report. */
  async #probe(signal?: AbortSignal): Promise<CliIdentity | SeamOutcome> {
    const file = cliFileKey(this.#cliPath);
    this.#probedFile = undefined;
    const spawned = await this.#spawn(["--version", "--json"], signal);
    if (spawned.kind === "missing") {
      return this.#unavailable();
    }
    if (spawned.kind === "failed") {
      return { claimed: false, why: `version probe ${spawned.why}` };
    }
    const cli = spawned.code === 0 ? parseVersion(spawned.stdout) : `exit ${spawned.code}`;
    if (typeof cli === "string") {
      return { claimed: false, why: `version probe: ${cli}` };
    }
    if (file !== cliFileKey(this.#cliPath)) {
      return { claimed: false, why: "coordinator CLI changed during version probe" };
    }
    if (!this.#note(cli)) {
      return this.#outOfRange(cli);
    }
    this.#probedFile = file;
    return cli;
  }

  review(slot: number, signal?: AbortSignal): Promise<SeamOutcome> {
    const iso = slotIso(this.#options.timezone, slot);
    const { game } = this.#options;
    return this.#call({ game, kind: "review-deliver", slot: iso }, signal);
  }

  async probe(signal?: AbortSignal): Promise<CliIdentity | undefined> {
    const probing = this.#probe(signal);
    this.#probing = probing;
    const probed = await probing;
    this.#probing = undefined;
    if (!("claimed" in probed)) {
      return probed;
    }
    if (probed.claimed) {
      this.#options.log(`bus: coordinator CLI: ${probed.detail}; reviews and event delivery defer`);
    } else {
      this.#options.log(`bus: coordinator CLI unavailable (${probed.why})`);
    }
    return undefined;
  }

  /** Log an ingest outcome that needs attention, once until the outcome changes. */
  #logIngest(outcome: SeamOutcome): void {
    const line = ingestLine(outcome);
    if (line !== undefined && line !== this.#lastIngestLine) {
      this.#options.log(line);
    }
    this.#lastIngestLine = line;
  }

  async #ingestLoop(): Promise<void> {
    this.#ingesting = true;
    try {
      do {
        this.#ingestAgain = false;
        // Each ingest follows the previous one; a request meanwhile runs exactly one more.
        // eslint-disable-next-line no-await-in-loop
        const outcome = await this.#call({
          game: this.#options.game,
          kind: "events-ingest",
        });
        this.#logIngest(outcome);
      } while (this.#ingestAgain && !this.#stop.signal.aborted);
    } catch (error) {
      this.#options.log(`bus: event ingest failed: ${String(error)}; no delivery claimed`);
    } finally {
      this.#ingesting = false;
    }
  }

  ingest(): void {
    if (this.#stop.signal.aborted) {
      return;
    }
    if (this.#ingesting) {
      this.#ingestAgain = true;
      return;
    }
    const loop = this.#ingestLoop();
    this.#running.add(loop);
    void loop.finally(() => this.#running.delete(loop));
  }

  stop(): void {
    this.#stop.abort();
  }

  async drain(): Promise<void> {
    while (this.#running.size > 0) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.allSettled([...this.#running]);
    }
  }
}
