// One scheduled or requested trunk-based departure under departure.lock; docs/runner.md "Departures" lists its steps.
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

import { holdLockAsync } from "@andornaut/coordination-kit/build/shared";

import { runGate, treeFingerprint } from "../gate/gate.ts";
import { assertNotInterrupted, git, Interrupted } from "../lib/exec.ts";
import { ensureDir, readText, readTrimmed, writeLines } from "../lib/files.ts";
import { latestScheduledSlot, stamp } from "../lib/time.ts";
import { errorMessage } from "../lib/values.ts";
import type { BlockedStage } from "../state/events.ts";
import { type BusPaths, gateFailedFile } from "../state/paths.ts";
import { resumeStoppedCi } from "./ci.ts";
import { type BusContext, loadOk } from "./context.ts";
import {
  deployNeeded,
  deployPendingExists,
  readPending,
  removeWorktree,
  retryDeploy,
  skipDeploy,
  stageDeploy,
} from "./deploy.ts";
import { type RequestStore, validateRequest } from "./requests.ts";
import {
  beginDeliveryWork,
  endDeliveryWork,
  updateDeliveryWork,
  withDeliveryRunner,
} from "./session.ts";
import { changedPaths, DOCS_PREFIX, docsOnly, mainHead, remoteMain, skipReason } from "./trunk.ts";

export function requestStore(context: BusContext): RequestStore {
  return {
    exec: context.exec,
    main: context.config.git.main,
    paths: context.paths,
    repo: context.game.repo,
  };
}

/** One deduplicated report per departure slot. */
export function reportScheduledTick(context: BusContext, slot: number, detail: string): void {
  if (!context.config.reports.scheduledTicks) {
    return;
  }
  context.events.emit(
    "scheduled-status",
    String(slot),
    `${stamp(context.config.schedule.timezone, slot)} scheduled slot: ${detail}`,
  );
}

/** The departure files the observer's slot report reads: their text, undefined when unreadable. */
export interface SlotState {
  readonly activeDeparture: string | undefined;
  readonly deployPending: string | undefined;
}

export function readSlotState(paths: BusPaths): SlotState {
  return {
    activeDeparture: readText(paths.activeDeparture),
    deployPending: readText(paths.deployPending),
  };
}

/** The start epoch `active-departure` records, or undefined when it is not a whole number. */
function activeDepartureStart(text: string): number | undefined {
  const trimmed = text.trim();
  const value = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The observer's detail for the departure slot that starts at `slot`. The departure loop records
 * its start epoch in `active-departure`, so a departure that started at or after the slot is this
 * slot's own; only an earlier one is unfinished from before the slot.
 */
export function slotDetail(state: SlotState, slot: number): string {
  const { activeDeparture, deployPending } = state;
  if (activeDeparture !== undefined && activeDeparture.length > 0) {
    const started = activeDepartureStart(activeDeparture);
    if (started !== undefined && started >= slot) {
      return "this slot's departure is checking main; any attempt is reported separately.";
    }
    return [
      "a departure is still checking or finishing; this observer starts no new push or deployment;",
      "attempt outcomes are reported separately.",
    ].join(" ");
  }
  if (deployPending !== undefined && deployPending.length > 0) {
    return "deployment is pending; its retry and outcome are reported separately.";
  }
  return "no departure is currently active; main departs when it has a new commit.";
}

/** Seconds after its slot (a request: after it starts) that a departure re-checks a high load. */
export const LOAD_WAIT_SECONDS = 15 * 60;
/** Seconds between load re-checks while a departure waits. */
export const LOAD_RECHECK_SECONDS = 60;

interface Attempt {
  readonly activity: string;
  sha?: string;
  readonly key: string;
  readonly when: string;
  readonly slot: number;
  /** Epoch seconds after which a departure that still meets a high load is skipped. */
  readonly loadDeadline: number;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

interface DepartOptions {
  /** A claimed one-off request; omitted for a scheduled departure. */
  readonly requestId?: string | undefined;
  /** The delivery activity the caller already began. */
  readonly admission?: string | undefined;
  /** The runner's shutdown signal; it ends a load wait as an interruption. */
  readonly signal?: AbortSignal | undefined;
}

function rethrowInterrupted(error: unknown): void {
  if (error instanceof Interrupted) {
    throw error;
  }
}

/** What clears each block: the call site names it, so the report states its own remedy. */
const REMEDY = {
  fix: "a fix merged on main is required",
  merge: "Tech merges the remote main into local main",
  operator: "an operator fix is required",
  retry: "the next departure retries it",
} as const;

function blocked(
  context: BusContext,
  attempt: Attempt,
  stage: BlockedStage,
  message: string,
  remedy: string,
): number {
  context.log(`${attempt.when} bus: blocked at ${stage}: ${message}`);
  context.events.emit(
    `blocked-${stage}`,
    attempt.key,
    `${attempt.when} blocked at ${stage}: ${message}; ${remedy}.`,
  );
  return 1;
}

/** 0 when the departure pushed or had nothing new, otherwise 1. */
export async function depart(context: BusContext, options: DepartOptions = {}): Promise<number> {
  return withDeliveryRunner(context, () => departAdmitted(context, options));
}

async function departAdmitted(context: BusContext, options: DepartOptions): Promise<number> {
  const { requestId, signal } = options;
  const lock = await holdLockAsync(context.paths.departureLock);
  let activity = options.admission;
  try {
    activity ??= beginDeliveryWork(context, "checking", null);
    if (activity === undefined) {
      context.log("bus: departure held: delivery is paused or control is unavailable");
      return 1;
    }
    const now = context.clock.now();
    const { departures, timezone } = context.config.schedule;
    const slot = latestScheduledSlot(timezone, departures, now);
    const attempt: Attempt = {
      activity,
      key: requestId === undefined ? String(now) : `request-${requestId}`,
      // A scheduled departure's window opens at its slot; a request's opens when it starts.
      loadDeadline: (requestId === undefined ? slot : now) + LOAD_WAIT_SECONDS,
      slot,
      when: stamp(timezone, now),
      ...(requestId === undefined ? {} : { requestId }),
      ...(signal === undefined ? {} : { signal }),
    };
    try {
      const result = await departLocked(context, attempt);
      if (result !== 0) {
        // The exact SHA, if resolved, remains attached to this activity.
        updateDeliveryWork(context, activity, "failed", attempt.sha ?? null);
      }
      return result;
    } catch (error) {
      if (error instanceof Interrupted) {
        // Stopped by the runner's own shutdown: nothing failed, so nothing is recorded or
        // reported. A later departure starts this HEAD again.
        context.log(`${attempt.when} bus: departure stopped by shutdown (${error.message})`);
        return 1;
      }
      updateDeliveryWork(context, activity, "failed", attempt.sha ?? null);
      throw error;
    }
  } finally {
    if (activity !== undefined) {
      endDeliveryWork(context, activity);
    }
    lock.release();
  }
}

async function retryPendingDelivery(context: BusContext): Promise<void> {
  // A watch that timed out or lost authentication resumes, so a pending deployment can follow.
  resumeStoppedCi(context, [
    readPending(context.paths)?.sha,
    readTrimmed(context.paths.lastPushSha),
  ]);
  if (deployPendingExists(context.paths)) {
    // A failed retry is reported and kept; it does not hold back a newer main.
    await retryDeploy(context);
  }
}

async function departLocked(context: BusContext, attempt: Attempt): Promise<number> {
  const { config, paths } = context;
  const { requestId } = attempt;
  const scheduled = requestId === undefined;
  if (scheduled) {
    await retryPendingDelivery(context);
  }
  let head: string;
  try {
    head = await mainHead(context.exec, context.game.repo, config.git.main);
  } catch (error) {
    rethrowInterrupted(error);
    return blocked(
      context,
      attempt,
      "main",
      `local ${config.git.main} is unreadable (${String(error)})`,
      REMEDY.operator,
    );
  }
  if (requestId !== undefined) {
    // This same SHA is gated and pushed even if main advances during the retry below.
    if (!(await validateRequest(requestStore(context), requestId, head))) {
      context.log(
        `${attempt.when} bus: request ${requestId} rejected: main moved since the request`,
      );
      return 1;
    }
    await retryPendingDelivery(context);
  }
  let remote: string | undefined;
  // This serialized departure is the only writer of its attempt's resolved SHA.
  // eslint-disable-next-line require-atomic-updates
  attempt.sha = head;
  updateDeliveryWork(context, attempt.activity, "checking", head);
  try {
    remote = await remoteMain(context.exec, context.game.repo, config.git.remote, config.git.main);
  } catch (error) {
    rethrowInterrupted(error);
    return blocked(
      context,
      attempt,
      "fetch",
      `the remote main is unreadable (${String(error)})`,
      `${REMEDY.retry}; an operator fix is required if the remote stays unreadable`,
    );
  }
  const skip = remote === head ? "remote" : skipReason(paths, head);
  if (skip !== undefined) {
    const detail =
      skip === "gate-failed"
        ? `the gate already failed for main ${head}; waiting for a fix merged on main.`
        : "nothing new on main; no departure.";
    if (scheduled) {
      reportScheduledTick(context, attempt.slot, detail);
    }
    context.log(`${attempt.when} bus: ${detail}`);
    return 0;
  }
  if (scheduled) {
    reportScheduledTick(
      context,
      attempt.slot,
      `main ${head.slice(0, 12)} is being checked; outcome reports follow separately.`,
    );
  }
  context.events.emit(
    "attempt",
    attempt.key,
    `${attempt.when} ${
      scheduled ? "scheduled attempt" : `user-authorized one-off request ${attempt.requestId ?? ""}`
    }: main ${head}; push not started; deployment not started.`,
  );
  if (!(await waitForLoad(context, attempt))) {
    return blocked(
      context,
      attempt,
      "load",
      `load at or above ${config.resources.loadLimit}; main retained`,
      "this clears by itself: the next departure starts once the load is below the limit",
    );
  }
  if (remote !== undefined) {
    const ancestor = assertNotInterrupted(
      "git merge-base",
      await context.exec({
        args: ["-C", context.game.repo, "merge-base", "--is-ancestor", remote, head],
        command: "git",
      }),
    );
    // Status 1 means the remote main is known here and is not in local main; other failures
    // (an unknown remote commit) leave the decision to the push itself.
    if (ancestor.status === 1) {
      return nonFastForward(context, attempt, head, remote);
    }
  }
  const changed = await changedPaths(context.exec, context.game.repo, remote, head);
  // A pending deployment of an earlier push is superseded by a gated push of this range.
  if (docsOnly(changed) && !deployPendingExists(context.paths)) {
    return pushDocs(context, attempt, head);
  }
  return gateAndPush(context, attempt, head, changed);
}

/**
 * True once the one-minute load is below the limit, re-checked every LOAD_RECHECK_SECONDS until
 * the attempt's load deadline; false when it is still at or above the limit at the deadline.
 * The caller holds the departure and runner locks throughout, so nothing else departs meanwhile.
 */
async function waitForLoad(context: BusContext, attempt: Attempt): Promise<boolean> {
  const limit = context.config.resources.loadLimit;
  let announced = false;
  for (;;) {
    if (loadOk(context)) {
      return true;
    }
    const remaining = attempt.loadDeadline - context.clock.now();
    if (remaining <= 0) {
      return false;
    }
    if (!announced) {
      announced = true;
      context.log(
        `${attempt.when} bus: load at or above ${limit}; re-checking every ` +
          `${LOAD_RECHECK_SECONDS} seconds until ` +
          `${stamp(context.config.schedule.timezone, attempt.loadDeadline)}`,
      );
    }
    // Sequential re-checks are the mechanism.
    // eslint-disable-next-line no-await-in-loop
    await context.clock.sleep(Math.min(LOAD_RECHECK_SECONDS, remaining), attempt.signal);
    if (attempt.signal?.aborted === true) {
      throw new Interrupted("the load wait");
    }
  }
}

function nonFastForward(
  context: BusContext,
  attempt: Attempt,
  head: string,
  remote: string | undefined,
): number {
  return blocked(
    context,
    attempt,
    "push",
    `non-fast-forward: the remote main${remote === undefined ? "" : ` ${remote}`} is not in ` +
      `local main ${head}; nothing pushed`,
    REMEDY.merge,
  );
}

function recordPush(context: BusContext, sha: string): void {
  writeLines(context.paths.lastPush, String(context.clock.now()));
  writeLines(context.paths.lastPushSha, sha);
}

/** Push `head` to the remote main without force; undefined once pushed and recorded. */
async function pushHead(
  context: BusContext,
  attempt: Attempt,
  head: string,
): Promise<number | undefined> {
  const { config, game } = context;
  const push = assertNotInterrupted(
    "git push",
    await context.exec({
      args: [
        "-C",
        game.repo,
        "push",
        "--porcelain",
        config.git.remote,
        `${head}:refs/heads/${config.git.main}`,
      ],
      command: "git",
    }),
  );
  if (push.status !== 0) {
    const output = `${push.stdout}\n${push.stderr}`;
    if (/\[rejected\]|non-fast-forward|fetch first/.test(output)) {
      return nonFastForward(context, attempt, head, undefined);
    }
    return blocked(
      context,
      attempt,
      "push",
      `push of main ${head} failed: ${push.stderr.trim() || "no diagnostic"}`,
      `${REMEDY.retry}; an operator fix is required if the push keeps failing`,
    );
  }
  recordPush(context, head);
  return undefined;
}

/** A range that changes only DOCS_PREFIX paths: push the exact SHA without a gate; never deploy. */
async function pushDocs(context: BusContext, attempt: Attempt, head: string): Promise<number> {
  const { config } = context;
  const reason = `every changed path is under ${DOCS_PREFIX}`;
  context.log(`${attempt.when} bus departs with main ${head}; ${reason}: no gate, no deployment`);
  context.events.emit(
    "attempt-captured",
    attempt.key,
    `${attempt.when} captured main ${head} for a docs-only pinned push.`,
    head,
  );
  const failed = await pushHead(context, attempt, head);
  if (failed !== undefined) {
    return failed;
  }
  context.events.emit("gate_skipped", head, `Gate skipped for ${head}: ${reason}.`);
  context.events.emit(
    "push",
    head,
    [
      `${stamp(config.schedule.timezone, context.clock.now())} departed exact pushed SHA ${head}: main;`,
      "docs-only range, gate skipped; CI pending; no deployment.",
    ].join(" "),
  );
  context.log(`${attempt.when} bus: pushed ${head}`);
  skipDeploy(context, head, reason);
  context.startCi(head);
  return 0;
}

async function gateAndPush(
  context: BusContext,
  attempt: Attempt,
  head: string,
  changed: readonly string[] | undefined,
): Promise<number> {
  const { config, game, paths } = context;
  const short = head.slice(0, 12);
  const work = join(paths.dir, `gate-${head}`);
  // A worktree left by an interrupted departure is replaced.
  await removeWorktree(context, work);
  await git(context.exec, game.repo, ["worktree", "add", "-q", "--detach", work, head]);
  const gateDir = join(paths.gateLogsDir, `gate-${short}`);
  mkdirSync(gateDir, { recursive: true });
  const logs = mkdtempSync(join(gateDir, "attempt."));
  writeLines(join(logs, "commit.sha"), head);
  context.log(`${attempt.when} bus departs with main ${head}; gate logs: ${logs}`);
  const before = await treeFingerprint(context.exec, work);
  const unchanged = async (): Promise<string | undefined> =>
    (await treeFingerprint(context.exec, work)) === before
      ? undefined
      : "gate discarded: Git status or reported-file fingerprints changed during checks";
  const outcome = await runGate(context, unchanged, {
    departure: short,
    logs,
    onCaptured: (sha) =>
      context.events.emit(
        "attempt-captured",
        attempt.key,
        `${attempt.when} captured verified gate snapshot for main ${sha}.`,
        sha,
      ),
    sha: head,
    work,
  });
  if (!outcome.ok) {
    context.log(outcome.reason);
    if (outcome.failure === "infrastructure") {
      await removeWorktree(context, work);
      return blocked(
        context,
        attempt,
        "gate",
        `${outcome.reason}; main ${head} was not gated and stays unpushed; no gate-failed record ` +
          "is written",
        "the next departure gates it again",
      );
    }
    ensureDir(paths.gateFailedDir);
    writeLines(
      gateFailedFile(paths, head),
      attempt.when,
      outcome.stage,
      outcome.reason.split("\n")[0] ?? "",
    );
    await removeWorktree(context, work);
    return blocked(
      context,
      attempt,
      outcome.stage,
      `the gate failed for main ${head}; main stays unpushed and this SHA is not gated again`,
      REMEDY.fix,
    );
  }
  for (const line of outcome.output.split("\n").filter((row) => row !== "")) {
    context.log(`${attempt.when}  ${line}`);
  }
  writeLines(join(work, ".bus-built.sha"), head);
  // The gate outcome coordination-kit's COMPLETE needs; gate_skipped is the docs-only counterpart.
  context.events.emit("gate_passed", head, `Gate passed for ${head}.`);
  const failed = await pushHead(context, attempt, head);
  if (failed !== undefined) {
    await removeWorktree(context, work);
    return failed;
  }
  context.events.emit(
    "push",
    head,
    [
      `${stamp(config.schedule.timezone, context.clock.now())} departed exact pushed SHA ${head}: main;`,
      "full gate passed; CI pending; deployment pending.",
    ].join(" "),
  );
  context.log(`${attempt.when} bus: pushed ${head}`);
  try {
    await stageDeploy(
      context,
      { sha: head, work },
      deployNeeded(context.config.deploy.skipPattern, changed),
    );
  } catch (error) {
    rethrowInterrupted(error);
    // Never leave a pushed SHA undeployed without a report.
    updateDeliveryWork(context, attempt.activity, "failed", head);
    const cause = errorMessage(error);
    context.log(`bus: deployment staging failed: ${cause}`);
    context.events.emit(
      "deploy_failure",
      head,
      [
        `Deployment of pushed ${head} could not be staged (${cause}); nothing will deploy it.`,
        "An operator fix is required; then fix forward with a new merge on main.",
      ].join(" "),
    );
  }
  context.startCi(head);
  return 0;
}
