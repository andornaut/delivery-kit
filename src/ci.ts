// Exact-commit CI monitoring, run as an in-runner task. A replacement runner
// resumes every watch whose ci/<sha>.status is still running, keeping the original deadline.
// A watch that timed out or lost GitHub authentication is restarted by the next departure.
import { appendFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import { SHA_PATTERN } from "./adapters/shared/ids.ts";
import type { BusContext } from "./bus/context.ts";
import { ciStatusFile, ensureDir, readTrimmed, writeLines } from "./bus/state.ts";
import { writeDurable } from "./durable.ts";
import { holdLock, LockBusy } from "./lock.ts";

export type CiResult = "busy" | "failure" | "success" | "timeout" | "unauthenticated";

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

export type CheckSource = (context: BusContext, sha: string) => Promise<CheckRun[]>;

const PASSING = new Set(["neutral", "skipped", "success"]);

function isoNow(context: BusContext): string {
  return new Date(context.clock.now() * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

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
export const githubChecks: CheckSource = async (context, sha) => {
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
function encodeRows(rows: ReturnType<typeof latestRuns>, required: ReadonlySet<string>): string {
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
export interface RequiredState {
  readonly missing: readonly string[];
  readonly incomplete: readonly string[];
  readonly failed: readonly string[];
}

export function requiredState(
  rows: ReturnType<typeof latestRuns>,
  required: ReadonlySet<string>,
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
export function timeoutDetail(state: RequiredState): string {
  return `required checks with no run: ${listed(state.missing)}; still incomplete: ${listed(state.incomplete)}`;
}

/**
 * The result the required checks decide, from the latest run of each name: failure once a
 * required run completed without passing, success once every required run completed and passed,
 * otherwise undefined (keep polling). Runs of other names never decide it.
 */
export function requiredDecision(
  rows: ReturnType<typeof latestRuns>,
  required: ReadonlySet<string>,
): "failure" | "success" | undefined {
  const decisive = rows.filter((row) => required.has(row.name));
  if (decisive.some((row) => row.status === "completed" && !PASSING.has(row.conclusion ?? ""))) {
    return "failure";
  }
  const passed = new Set(
    decisive
      .filter((row) => row.status === "completed" && PASSING.has(row.conclusion ?? ""))
      .map((row) => row.name),
  );
  return [...required].every((name) => passed.has(name)) ? "success" : undefined;
}

interface PollResult {
  readonly result: CiResult;
  readonly state: RequiredState;
}

export interface WatchOptions {
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
  const say = (line: string): void => appendFileSync(logFile, `${isoNow(context)} ${line}\n`);
  const required = new Set(ci.requiredNames);
  let last: string | undefined;
  let state = requiredState([], required);
  while (context.clock.now() < deadline && options.signal?.aborted !== true) {
    try {
      // Sequential polling is the mechanism.
      // eslint-disable-next-line no-await-in-loop
      const rows = latestRuns(await (options.checks ?? githubChecks)(context, sha));
      const encoded = encodeRows(rows, required);
      if (encoded !== last) {
        say(encoded);
        writeDurable(join(context.paths.ciDir, `${sha}.json`), `${encoded}\n`, { mode: 0o644 });
        last = encoded;
      }
      state = requiredState(rows, required);
      const decision = requiredDecision(rows, required);
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
  say(`CI monitor timed out; ${timeoutDetail(state)}`);
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
      `CI monitoring pending/running for pushed ${sha}; completion not confirmed; deployment tracked separately.`,
    );
    const { result, state } = await poll(context, sha, options, deadlineFor(context, sha));
    if (result === "busy") {
      return result;
    }
    writeLines(ciStatusFile(context.paths, sha), result);
    if (result === "success") {
      context.events.emit(
        "ci_success",
        sha,
        `CI success for ${sha}; deployment completion is tracked separately.`,
      );
    } else if (result === "failure") {
      context.events.emit(
        "ci_failure",
        sha,
        [
          `CI FAILED for pushed ${sha}: required runs failed: ${listed(state.failed)}; monitor`,
          "stopped on red; deployment state tracked separately; inspect checks and merge a fix on",
          "main. No automatic CI rerun.",
        ].join(" "),
      );
    } else if (result === "unauthenticated") {
      context.events.emit(
        "ci_auth_failed",
        sha,
        [
          `CI status unknown for pushed ${sha}: GitHub authentication failed; completion not`,
          "confirmed. Restore the gh login on the runner host; the next departure resumes the",
          "watch, and a pending deployment runs once CI passes.",
        ].join(" "),
      );
    } else {
      context.events.emit(
        "ci_timeout",
        sha,
        [
          `CI status unknown for pushed ${sha}: the watch timed out after`,
          `${String(context.config.ci.timeoutSeconds)} seconds (${timeoutDetail(state)});`,
          "completion not confirmed. The next departure resumes the watch, and a pending",
          "deployment runs once CI passes.",
        ].join(" "),
      );
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
export function unfinishedCi(context: BusContext): string[] {
  const shas = new Set<string>();
  try {
    for (const name of readdirSync(context.paths.ciDir).sort()) {
      if (
        name.endsWith(".status") &&
        ["pending", "running"].includes(readTrimmed(join(context.paths.ciDir, name)) ?? "")
      ) {
        shas.add(name.slice(0, -".status".length));
      }
    }
  } catch (error) {
    // No ci/ directory yet; any other failure is not "nothing to resume".
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const pushed = readTrimmed(context.paths.lastPushSha);
  if (
    pushed !== undefined &&
    SHA_PATTERN.test(pushed) &&
    readTrimmed(ciStatusFile(context.paths, pushed)) === undefined
  ) {
    shas.add(pushed);
  }
  return [...shas];
}
