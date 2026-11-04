// One scheduled or requested trunk-based departure under departure.lock; README "Departures" lists its steps.
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

import { resumeStoppedCi } from "../ci.ts";
import {
  deployNeeded,
  deployPendingExists,
  readPending,
  removeWorktree,
  retryDeploy,
  stageDeploy,
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

function blocked(context: BusContext, attempt: Attempt, stage: string, message: string): number {
  context.log(`${attempt.when} bus: blocked at ${stage}: ${message}`);
  context.events.emit(
    `blocked-${stage}`,
    attempt.key,
    `${attempt.when} blocked at ${stage}: ${message}; operator fix or a new merge on main required.`,
  );
  return 1;
}

/** 0 when the departure pushed or had nothing new, otherwise 1. */
export async function depart(context: BusContext, requestId?: string): Promise<number> {
  const lock = await holdLockAsync(context.paths.departureLock);
  try {
    const now = context.clock.now();
    const { departures, timezone } = context.config.schedule;
    const attempt: Attempt = {
      key: requestId === undefined ? String(now) : `request-${requestId}`,
      slot: latestScheduledSlot(timezone, departures, now),
      when: stamp(timezone, now),
      ...(requestId === undefined ? {} : { requestId }),
    };
    try {
      return await departLocked(context, attempt);
    } catch (error) {
      if (error instanceof Interrupted) {
        // Stopped by the runner's own shutdown: nothing failed, so nothing is recorded or
        // reported. A later departure starts this HEAD again.
        context.log(`${attempt.when} bus: departure stopped by shutdown (${error.message})`);
        return 1;
      }
      throw error;
    }
  } finally {
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
    );
  }
  let remote: string | undefined;
  try {
    remote = await remoteMain(context.exec, context.game.repo, config.git.remote, config.git.main);
  } catch (error) {
    rethrowInterrupted(error);
    return blocked(context, attempt, "fetch", `the remote main is unreadable (${String(error)})`);
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
    [
      `non-fast-forward: the remote main${remote === undefined ? "" : ` ${remote}`} is not in local main ${head};`,
      "nothing pushed; Tech merges the remote main into local main",
    ].join(" "),
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
          "is written, so the next departure gates it again",
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
      `the gate failed for main ${head}; main stays unpushed and this SHA is not gated again; merge a fix on main`,
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
    context.log(
      `bus: deployment staging failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  context.startCi(head);
  return 0;
}
