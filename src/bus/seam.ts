// The review and event seam: the runner spawns the coordinator-installed coordination-kit CLI with
// the running Node binary and reads one typed JSON result line from it. A failed spawn, a missing
// or unreadable result, a nonzero exit, a timeout or an abort claims no delivery. The CLI owns the
// per-slot receipt and dedupe; the runner keeps no slot receipt and never reads brief content.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { writeJsonDurable } from "@andornaut/coordination-kit/build/shared";

import { COORDINATOR_CLI_RANGE, satisfies } from "./pin.ts";
import { zonedParts } from "./time.ts";

/** The CLI path under the coordinator root; `npm ci` there replaces it in place. */
export const COORDINATOR_CLI = join(
  "node_modules",
  "@andornaut",
  "coordination-kit",
  "dist",
  "cli.js",
);
/** Each spawn's deadline, under the 60 s observer pass. */
export const SEAM_TIMEOUT_MS = 45_000;
/** The runner log prefix of a deferred review, on its own line and on stderr. */
export const DEFERRED_PREFIX = "bus: review deferred: ";
/** Reason tokens the seam defines; any other token is treated as a deferral. */
export const KNOWN_REASONS: ReadonlySet<string> = new Set([
  "route-unavailable",
  "recipient-unavailable",
  "recipient-busy",
  "question-pending",
  "held",
  "receipt-ambiguous",
  "already-delivered",
  "nothing-due",
  "no-events",
  "cli-error",
]);
/** Reasons the runner itself reports without a CLI result. */
export const CLI_UNAVAILABLE = "cli-unavailable";
export const CLI_VERSION = "cli-version";

const MAX_STDOUT = 1024 * 1024;
const STDERR_TAIL = 2000;
const SHA256 = /^[a-f0-9]{64}$/u;
const TOKEN = /^[a-z][a-z0-9-]*$/u;

export interface CliIdentity {
  readonly version: string;
  readonly distSha256: string;
}

export type SeamStatus = "delivered" | "deferred" | "skipped";

/** A typed result, or a runner-side deferral (`cli` absent) for a missing or out-of-range CLI. */
export interface SeamResult {
  readonly claimed: true;
  readonly status: SeamStatus;
  readonly reason: string | null;
  readonly detail: string;
  readonly cli?: CliIdentity;
  /** An ingest result's counts, each present only when the CLI reported it. */
  readonly counts?: Readonly<Partial<Record<IngestCount, number>>>;
}

/**
 * The counts an events-ingest result may carry: lines ingested, quarantined, COMPLETE reports
 * formed, lines committed (`delivered`) and `held` (1 while a torn tail is pending).
 */
export const INGEST_COUNTS = ["completed", "delivered", "held", "ingested", "quarantined"] as const;
export type IngestCount = (typeof INGEST_COUNTS)[number];

/** No delivery claimed: the spawn, its exit or its result was unusable. */
export interface SeamUnclaimed {
  readonly claimed: false;
  readonly why: string;
}

export type SeamOutcome = SeamResult | SeamUnclaimed;

/**
 * The slot start the seam passes as `--slot` and expects echoed: ISO 8601 minute start in
 * `timezone`, with its offset, such as `2026-11-18T16:30:00-05:00`.
 */
export function slotIso(timezone: string, slot: number): string {
  const p = zonedParts(timezone, slot);
  const minute = String(p.minute).padStart(2, "0");
  const second = String(p.second).padStart(2, "0");
  const local = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    p.minute,
    p.second,
  );
  const offset = Math.round((local - slot * 1000) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${minute}:${second}${sign}${hours}:${minutes}`;
}

/** One log line: control characters, including newlines, become spaces. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
}

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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The single JSON object stdout holds, or why it is not one. */
function resultLine(stdout: string): Record<string, unknown> | string {
  const text = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (text.trim() === "") {
    return "no result on stdout";
  }
  if (text.includes("\n")) {
    return "stdout holds more than one line";
  }
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : "the result is not a JSON object";
  } catch {
    return "the result is not JSON";
  }
}

function identity(value: unknown): CliIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { distSha256, version } = value;
  return typeof version === "string" &&
    version !== "" &&
    typeof distSha256 === "string" &&
    SHA256.test(distSha256)
    ? { distSha256, version }
    : undefined;
}

/** The expected fields of a review-deliver or events-ingest result. */
type Expected =
  | { readonly kind: "review-deliver"; readonly game: string; readonly slot: string }
  | { readonly kind: "events-ingest"; readonly game: string };

/** Validate one result; an unknown reason token turns any status into a deferral. */
export function parseResult(expected: Expected, stdout: string): SeamOutcome {
  const value = resultLine(stdout);
  if (typeof value === "string") {
    return { claimed: false, why: value };
  }
  const mismatch = (field: string): SeamUnclaimed => ({
    claimed: false,
    why: `malformed result: ${field}`,
  });
  if (value.schema !== 1) {
    return mismatch("schema is not 1");
  }
  if (value.kind !== expected.kind) {
    return mismatch(`kind is not ${expected.kind}`);
  }
  if (value.game !== expected.game) {
    return mismatch("game differs");
  }
  if (expected.kind === "review-deliver" && value.slot !== expected.slot) {
    return mismatch("slot differs");
  }
  const { detail, reason, status } = value;
  if (status !== "delivered" && status !== "deferred" && status !== "skipped") {
    return mismatch("status");
  }
  if (reason !== null && (typeof reason !== "string" || !TOKEN.test(reason))) {
    return mismatch("reason");
  }
  if (status !== "delivered" && reason === null) {
    return mismatch("reason is null for a result that is not delivered");
  }
  if (typeof detail !== "string") {
    return mismatch("detail");
  }
  const cli = identity(value.cli);
  if (cli === undefined) {
    return mismatch("cli");
  }
  const counts: Partial<Record<IngestCount, number>> = {};
  if (expected.kind === "events-ingest") {
    for (const name of INGEST_COUNTS) {
      const field = value[name];
      if (field === undefined) {
        continue;
      }
      if (!Number.isSafeInteger(field) || (field as number) < 0) {
        return mismatch(name);
      }
      counts[name] = field as number;
    }
  }
  const known = reason === null || KNOWN_REASONS.has(reason);
  return {
    claimed: true,
    cli,
    detail: oneLine(detail),
    reason,
    status: known ? status : "deferred",
    ...(Object.keys(counts).length === 0 ? {} : { counts }),
  };
}

/** The `--version --json` identity, or why it is unusable. */
export function parseVersion(stdout: string): CliIdentity | string {
  const value = resultLine(stdout);
  if (typeof value === "string") {
    return value;
  }
  if (value.schema !== 1) {
    return "malformed result: schema is not 1";
  }
  return identity(value) ?? "malformed result: version or distSha256";
}

/** bus/seam.json: the last CLI identity a seam result carried and when this runner saw it. */
export interface SeamRecord {
  readonly schema: 1;
  readonly version: string;
  readonly distSha256: string;
  readonly seenAt: string;
}

/** The read-only `coordinator_cli` status field. */
export interface CoordinatorCliReport {
  readonly version: string | null;
  readonly distSha256: string | null;
  readonly seenAt: string | null;
  readonly supported: boolean | null;
}

export function coordinatorCliReport(seamFile: string): CoordinatorCliReport {
  try {
    const value = JSON.parse(readFileSync(seamFile, "utf8")) as unknown;
    const cli = isRecord(value) && value.schema === 1 ? identity(value) : undefined;
    if (cli !== undefined && isRecord(value) && typeof value.seenAt === "string") {
      return {
        ...cli,
        seenAt: value.seenAt,
        supported: satisfies(COORDINATOR_CLI_RANGE, cli.version),
      };
    }
  } catch {
    // Absent or unreadable: nothing seen.
  }
  return { distSha256: null, seenAt: null, supported: null, version: null };
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

export interface CoordinatorOptions {
  /** The coordinator root, passed as `--root` and used as the working directory. */
  readonly root: string;
  readonly game: string;
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

/** The seam over the coordinator-installed CLI. */
export class CoordinatorCli implements Coordinator {
  readonly #options: CoordinatorOptions;
  readonly #cliPath: string;
  readonly #stop = new AbortController();
  readonly #running = new Set<Promise<unknown>>();
  #identity: (CliIdentity & { readonly supported: boolean }) | undefined;
  #written: { readonly key: string; readonly at: number } | undefined;
  #probing: Promise<unknown> | undefined;
  #ingesting = false;
  #ingestAgain = false;
  #lastIngestLine: string | undefined;

  constructor(options: CoordinatorOptions) {
    this.#options = options;
    this.#cliPath = join(options.root, COORDINATOR_CLI);
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
    const supported = satisfies(COORDINATOR_CLI_RANGE, cli.version);
    const previous = this.#identity;
    if (previous?.version !== cli.version || previous.distSha256 !== cli.distSha256) {
      this.#identity = { ...cli, supported };
      const range = supported
        ? `, inside ${COORDINATOR_CLI_RANGE}`
        : ` is outside ${COORDINATOR_CLI_RANGE}; reviews and event delivery defer`;
      this.#options.log(`bus: coordinator CLI ${describeIdentity(cli)}${range}`);
    }
    // One durable write per identity change, then at most one a minute for seenAt.
    const now = this.#options.now();
    const key = `${cli.version}:${cli.distSha256}`;
    if (this.#written?.key !== key || now - this.#written.at >= 60) {
      const record: SeamRecord = {
        distSha256: cli.distSha256,
        schema: 1,
        seenAt: new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z"),
        version: cli.version,
      };
      try {
        writeJsonDurable(this.#options.seamFile, record, { mode: 0o644 });
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
      detail: `coordinator CLI ${cli.version} is outside ${COORDINATOR_CLI_RANGE}`,
      reason: CLI_VERSION,
      status: "deferred",
    };
  }

  /** The result of one spawn, with the identity noted and the range applied. */
  async #call(
    args: readonly string[],
    expected: Expected,
    signal?: AbortSignal,
  ): Promise<SeamOutcome> {
    // The startup probe settles first, so the first call already knows the CLI identity.
    await this.#probing;
    // A CLI last seen out of range is probed again before it is asked to deliver anything.
    if (this.#identity?.supported === false) {
      const probed = await this.#probe(signal);
      if (probed !== true) {
        return probed;
      }
    }
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
    const result = parseResult(expected, spawned.stdout);
    if (!result.claimed || result.cli === undefined) {
      return result;
    }
    return this.#note(result.cli) ? result : this.#outOfRange(result.cli);
  }

  /** true when the CLI is in range; otherwise the deferral or failure to report. */
  async #probe(signal?: AbortSignal): Promise<true | SeamOutcome> {
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
    return this.#note(cli) ? true : this.#outOfRange(cli);
  }

  review(slot: number, signal?: AbortSignal): Promise<SeamOutcome> {
    const iso = slotIso(this.#options.timezone, slot);
    const { game } = this.#options;
    return this.#call(
      ["review", "deliver", "--game", game, "--slot", iso],
      { game, kind: "review-deliver", slot: iso },
      signal,
    );
  }

  async probe(signal?: AbortSignal): Promise<CliIdentity | undefined> {
    const probing = this.#probe(signal);
    this.#probing = probing;
    const probed = await probing;
    this.#probing = undefined;
    if (probed === true) {
      const identity = this.#identity;
      return identity === undefined
        ? undefined
        : { distSha256: identity.distSha256, version: identity.version };
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
    let line: string | undefined;
    if (!outcome.claimed) {
      line = `bus: event ingest failed: ${outcome.why}; no delivery claimed`;
    } else if (outcome.status === "deferred") {
      line = `bus: event ingest deferred: ${outcome.reason ?? "unknown"}: ${outcome.detail}`;
    }
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
        const outcome = await this.#call(["events", "ingest", "--game", this.#options.game], {
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
