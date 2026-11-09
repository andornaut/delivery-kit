// One scheduled or requested trunk-based departure under departure.lock; README "Departures" lists its steps.
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

import { resumeStoppedCi } from "../ci.ts";
import {
  beginDeliveryWork,
  deployNeeded,
  deployPendingExists,
  endDeliveryWork,
  readPending,
  removeWorktree,
  retryDeploy,
  stageDeploy,
  updateDeliveryWork,
  withDeliveryRunner,
} from "../deploy.ts";
import { runGate, treeFingerprint } from "../gate.ts";
import { holdLockAsync } from "../lock.ts";
import { type BusContext, loadOk } from "./context.ts";
import { assertNotInterrupted, git, Interrupted } from "./exec.ts";
import { type RequestStore, validateRequest } from "./requests.ts";
import { ensureDir, gateFailedFile, nonEmpty, readTrimmed, writeLines } from "./state.ts";
import { latestScheduledSlot, stamp } from "./time.ts";
import { mainHead, remoteMain, skipReason } from "./trunk.ts";

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

/** The observer's detail for a departure slot. */
export function slotDetail(context: BusContext): string {
  const { paths } = context;
  if (nonEmpty(paths.activeDeparture)) {
    return [
      "a departure is still checking or finishing; this observer starts no new push or deployment;",
      "attempt outcomes are reported separately.",
    ].join(" ");
  }
  if (nonEmpty(paths.deployPending)) {
    return "deployment is pending; its retry and outcome are reported separately.";
  }
  return "no departure is currently active; main departs when it has a new commit.";
}

interface Attempt {
  readonly activity: string;
  sha?: string;
  readonly key: string;
  readonly when: string;
  readonly slot: number;
  readonly requestId?: string;
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
  stage: string,
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
export async function depart(
  context: BusContext,
  requestId?: string,
  admission?: string,
): Promise<number> {
  return withDeliveryRunner(context, () => departAdmitted(context, requestId, admission));
}

async function departAdmitted(
  context: BusContext,
  requestId?: string,
  admission?: string,
): Promise<number> {
  const lock = await holdLockAsync(context.paths.departureLock);
  let activity = admission;
  try {
    activity ??= beginDeliveryWork(context, "checking", null);
    if (activity === undefined) {
      context.log("bus: departure held: delivery is paused or control is unavailable");
      return 1;
    }
    const now = context.clock.now();
    const { departures, timezone } = context.config.schedule;
    const attempt: Attempt = {
      activity,
      key: requestId === undefined ? String(now) : `request-${requestId}`,
      slot: latestScheduledSlot(timezone, departures, now),
      when: stamp(timezone, now),
      ...(requestId === undefined ? {} : { requestId }),
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

async function departLocked(context: BusContext, attempt: Attempt): Promise<number> {
  const { config, paths } = context;
  const scheduled = attempt.requestId === undefined;
  if (
    attempt.requestId !== undefined &&
    !(await validateRequest(requestStore(context), attempt.requestId))
  ) {
    context.log(
      `${attempt.when} bus: request ${attempt.requestId} rejected: main moved since the request`,
    );
    return 1;
  }
  // A watch that timed out or lost authentication resumes, so a pending deployment can follow.
  resumeStoppedCi(context, [readPending(context)?.sha, readTrimmed(paths.lastPushSha)]);
  if (deployPendingExists(context)) {
    // A failed retry is reported and kept; it does not hold back a newer main.
    await retryDeploy(context);
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
  if (!loadOk(context)) {
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
  return gateAndPush(context, attempt, head, remote);
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

async function gateAndPush(
  context: BusContext,
  attempt: Attempt,
  head: string,
  remote: string | undefined,
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
  const before = await treeFingerprint(context, work);
  const outcome = await runGate(context, { departure: short, logs, sha: head, work }, async () =>
    (await treeFingerprint(context, work)) === before
      ? undefined
      : "gate discarded: Git status or reported-file fingerprints changed during checks",
  );
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
    await removeWorktree(context, work);
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
    await stageDeploy(context, { sha: head, work }, await deployNeeded(context, remote, head));
  } catch (error) {
    rethrowInterrupted(error);
    // Never leave a pushed SHA undeployed without a report.
    updateDeliveryWork(context, attempt.activity, "failed", head);
    const cause = error instanceof Error ? error.message : String(error);
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
