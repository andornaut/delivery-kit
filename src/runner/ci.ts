// Exact-commit CI watch, run as an in-runner task. A replacement runner
// resumes every watch whose ci/<sha>.status is still running, keeping the original deadline.
// A watch that timed out or lost GitHub authentication is restarted by the next departure.
import { appendFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import {
  holdLock,
  LockBusy,
  SHA_PATTERN,
  writeDurable,
} from "@andornaut/coordination-kit/build/shared";

import { ensureDir, readTrimmed, writeLines } from "../lib/files.ts";
import { isoSeconds } from "../lib/values.ts";
import { unfinishedCiWatches } from "../state/ci.ts";
import { type BusPaths, ciStatusFile } from "../state/paths.ts";
import type { BusContext } from "./context.ts";

type CiResult = "busy" | "failure" | "success" | "timeout" | "unauthenticated";

/** Watch results the next departure restarts: the checks may still finish or become readable. */
const RESUMABLE: ReadonlySet<string> = new Set(["timeout", "unauthenticated"]);

/** GitHub refused the check-run query for lack of authentication. */
export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

/** `gh` exits 4 when a command needs authentication. */
const GH_AUTH_REQUIRED = 4;

export interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

type CheckSource = (context: BusContext, sha: string) => Promise<CheckRun[]>;

const PASSING = new Set(["neutral", "skipped", "success"]);

function onPath(command: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((directory) => {
    try {
      return directory !== "" && statSync(join(directory, command)).isFile();
    } catch {
      return false;
    }
  });
}

/** Check runs from the existing gh login, or the public API when gh is not installed. */
const githubChecks: CheckSource = async (context, sha) => {
  const path = `repos/${context.config.git.github}/commits/${sha}/check-runs?per_page=100`;
  if (onPath("gh")) {
    const result = await context.exec({
      args: ["api", path, "--jq", ".check_runs | map({id,name,status,conclusion})"],
      command: "gh",
      timeoutMs: 25_000,
    });
    if (result.status === GH_AUTH_REQUIRED || /HTTP 401/.test(result.stderr)) {
      throw new GitHubAuthError("the GitHub CLI is not authenticated; check gh auth status");
    }
    if (result.status !== 0) {
      throw new Error(`GitHub CLI metadata query failed (exit ${String(result.status)})`);
    }
    return JSON.parse(result.stdout) as CheckRun[];
  }
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "delivery-kit" },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401) {
    throw new GitHubAuthError("the GitHub API refused the request as unauthenticated (401)");
  }
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`);
  }
  return ((await response.json()) as { check_runs?: CheckRun[] }).check_runs ?? [];
};

/** The latest run per name (a rerun supersedes an older check), sorted by name. */
export function latestRuns(
  runs: readonly CheckRun[],
): { name: string; status: string; conclusion: string | null }[] {
  const latest = new Map<string, CheckRun>();
  for (const run of runs) {
    const previous = latest.get(run.name);
    if (previous === undefined || run.id > previous.id) {
      latest.set(run.name, run);
    }
  }
  return [...latest.values()]
    .map(({ conclusion, name, status }) => ({ conclusion, name, status }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The ci/<sha>.json rows: every latest run, each marked whether it is a required check. */
function encodeRows(required: ReadonlySet<string>, rows: ReturnType<typeof latestRuns>): string {
  return `[${rows
    .map((row) =>
      [
        `{"conclusion": ${JSON.stringify(row.conclusion)},`,
        `"name": ${JSON.stringify(row.name)},`,
        `"required": ${String(required.has(row.name))},`,
        `"status": ${JSON.stringify(row.status)}}`,
      ].join(" "),
    )
    .join(", ")}]`;
}

/** The required checks by state: no run yet, a run not completed, a completed run that failed. */
interface RequiredState {
  readonly missing: readonly string[];
  readonly incomplete: readonly string[];
  readonly failed: readonly string[];
}

export function requiredState(
  required: ReadonlySet<string>,
  rows: ReturnType<typeof latestRuns>,
): RequiredState {
  const byName = new Map(rows.map((row) => [row.name, row]));
  const missing: string[] = [];
  const incomplete: string[] = [];
  const failed: string[] = [];
  for (const name of [...required].sort()) {
    const row = byName.get(name);
    if (row === undefined) {
      missing.push(name);
    } else if (row.status !== "completed") {
      incomplete.push(`${name} (${row.status})`);
    } else if (!PASSING.has(row.conclusion ?? "")) {
      failed.push(`${name} (${row.conclusion ?? "no conclusion"})`);
    }
  }
  return { failed, incomplete, missing };
}

function listed(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

/** The timeout diagnosis: which required checks never ran and which are still running. */
function timeoutDetail(state: RequiredState): string {
  return `required checks with no run: ${listed(state.missing)}; still incomplete: ${listed(state.incomplete)}`;
}

/**
 * The result the required checks decide, from the latest run of each name: failure once a
 * required run completed without passing, success once every required run completed and passed,
 * otherwise undefined (keep polling). Runs of other names never decide it.
 */
export function requiredDecision(state: RequiredState): "failure" | "success" | undefined {
  if (state.failed.length > 0) {
    return "failure";
  }
  return state.missing.length === 0 && state.incomplete.length === 0 ? "success" : undefined;
}

/** The event detail for a finished watch of the pushed `sha`. */
export function ciOutcomeDetail(
  timeoutSeconds: number,
  sha: string,
  result: Exclude<CiResult, "busy">,
  state: RequiredState,
): string {
  switch (result) {
    case "success":
      return `CI success for ${sha}; deployment completion is tracked separately.`;
    case "failure":
      return [
        `CI FAILED for pushed ${sha}: required runs failed: ${listed(state.failed)}; watch`,
        "stopped on red; deployment state tracked separately; inspect checks and merge a fix on",
        "main. No automatic CI rerun.",
      ].join(" ");
    case "unauthenticated":
      return [
        `CI status unknown for pushed ${sha}: GitHub authentication failed; completion not`,
        "confirmed. Restore the gh login on the runner host; the next departure resumes the",
        "watch, and a pending deployment runs once CI passes.",
      ].join(" ");
    default:
      return [
        `CI status unknown for pushed ${sha}: the watch timed out after`,
        `${String(timeoutSeconds)} seconds (${timeoutDetail(state)});`,
        "completion not confirmed. The next departure resumes the watch, and a pending",
        "deployment runs once CI passes.",
      ].join(" ");
  }
}

interface PollResult {
  readonly result: CiResult;
  readonly state: RequiredState;
}

interface WatchOptions {
  readonly checks?: CheckSource;
  readonly signal?: AbortSignal;
}

function deadlineFor(context: BusContext, sha: string): number {
  const status = ciStatusFile(context.paths, sha);
  const timeout = context.config.ci.timeoutSeconds;
  if (readTrimmed(status) === "running") {
    // A resumed watch keeps the deadline of the watch that wrote "running".
    return Math.floor(statSync(status).mtimeMs / 1000) + timeout;
  }
  writeLines(status, "running");
  return context.clock.now() + timeout;
}

async function poll(
  context: BusContext,
  sha: string,
  options: WatchOptions,
  deadline: number,
): Promise<PollResult> {
  const { ci } = context.config;
  const logFile = join(context.paths.ciDir, `${sha}.log`);
  const say = (line: string): void =>
    appendFileSync(logFile, `${isoSeconds(context.clock.now() * 1000)} ${line}\n`);
  const required = new Set(ci.requiredNames);
  let last: string | undefined;
  let state = requiredState(required, []);
  while (context.clock.now() < deadline && options.signal?.aborted !== true) {
    try {
      // Sequential polling is the mechanism.
      // eslint-disable-next-line no-await-in-loop
      const rows = latestRuns(await (options.checks ?? githubChecks)(context, sha));
      const encoded = encodeRows(required, rows);
      if (encoded !== last) {
        say(encoded);
        writeDurable(join(context.paths.ciDir, `${sha}.json`), `${encoded}\n`, { mode: 0o644 });
        last = encoded;
      }
      state = requiredState(required, rows);
      const decision = requiredDecision(state);
      if (decision !== undefined) {
        return { result: decision, state };
      }
    } catch (error) {
      say(`${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`);
      if (error instanceof GitHubAuthError) {
        return { result: "unauthenticated", state };
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await context.clock.sleep(ci.pollSeconds, options.signal);
  }
  if (options.signal?.aborted === true) {
    return { result: "busy", state };
  }
  say(`CI watch timed out; ${timeoutDetail(state)}`);
  return { result: "timeout", state };
}

/**
 * Watch the checks of an exact pushed SHA until success, a failed check or the timeout. Returns
 * "busy" when another watcher holds ci/<sha>.lock or the runner is stopping.
 */
export async function watchCi(
  context: BusContext,
  sha: string,
  options: WatchOptions = {},
): Promise<CiResult> {
  ensureDir(context.paths.ciDir);
  let lock;
  try {
    lock = holdLock(join(context.paths.ciDir, `${sha}.lock`), { nonBlocking: true });
  } catch (error) {
    if (error instanceof LockBusy) {
      return "busy";
    }
    throw error;
  }
  try {
    context.events.emit(
      "ci_pending",
      sha,
      `CI watch pending/running for pushed ${sha}; completion not confirmed; deployment tracked separately.`,
    );
    const { result, state } = await poll(context, sha, options, deadlineFor(context, sha));
    if (result === "busy") {
      return result;
    }
    writeLines(ciStatusFile(context.paths, sha), result);
    const detail = ciOutcomeDetail(context.config.ci.timeoutSeconds, sha, result, state);
    if (result === "success") {
      context.events.emit("ci_success", sha, detail);
    } else if (result === "failure") {
      context.events.emit("ci_failure", sha, detail);
    } else if (result === "unauthenticated") {
      context.events.emit("ci_auth_failed", sha, detail);
    } else {
      context.events.emit("ci_timeout", sha, detail);
    }
    return result;
  } finally {
    lock.release();
  }
}

/** Restart the watch of each SHA whose last watch timed out or lost authentication. */
export function resumeStoppedCi(context: BusContext, shas: readonly (string | undefined)[]): void {
  for (const sha of new Set(shas)) {
    if (sha !== undefined && RESUMABLE.has(readTrimmed(ciStatusFile(context.paths, sha)) ?? "")) {
      context.log(`bus: resuming the CI watch of ${sha}`);
      context.startCi(sha);
    }
  }
}

/** SHAs whose watch must resume: every running status, plus a last push with no status yet. */
export function unfinishedCi(paths: BusPaths): string[] {
  const shas = new Set<string>();
  try {
    const names = readdirSync(paths.ciDir);
    for (const sha of unfinishedCiWatches((name) => readTrimmed(join(paths.ciDir, name)), names)) {
      shas.add(sha);
    }
  } catch (error) {
    // No ci/ directory yet; any other failure is not "nothing to resume".
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const pushed = readTrimmed(paths.lastPushSha);
  if (
    pushed !== undefined &&
    SHA_PATTERN.test(pushed) &&
    readTrimmed(ciStatusFile(paths, pushed)) === undefined
  ) {
    shas.add(pushed);
  }
  return [...shas];
}
