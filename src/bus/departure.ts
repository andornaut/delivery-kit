// One scheduled or requested departure. A nonempty queue is one gated
// push and deployment; queue reads and consumption happen under bus-queue.lock.
import { deployPendingExists, retryDeploy } from "../deploy.ts";
import { holdLockAsync } from "../lock.ts";
import { runBatch } from "./batch.ts";
import { type BusContext, loadOk } from "./context.ts";
import { gitOk } from "./exec.ts";
import { readQueue } from "./queue.ts";
import { ciGreenOrUnknown, ciNotRed } from "./repair.ts";
import { loadRequest, type RequestRecord, type RequestStore, validateRequest } from "./requests.ts";
import { nonEmpty, readTrimmed, truncate } from "./state.ts";
import { latestScheduledSlot, stamp } from "./time.ts";

export function requestStore(context: BusContext): RequestStore {
  return { exec: context.exec, paths: context.paths, repo: context.game.repo };
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
  if (readQueue(paths.queue).length > 0) {
    return "queued work is waiting for the scheduled loop; attempt outcomes are reported separately.";
  }
  if (nonEmpty(paths.deployPending)) {
    return "deployment is pending; its retry and outcome are reported separately.";
  }
  return "queue empty; no departure is currently active.";
}

async function underQueueLock<T>(context: BusContext, fn: () => Promise<T>): Promise<T> {
  const lock = await holdLockAsync(context.paths.queueLock);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/** depart: 0 when the departure completed or had nothing waiting, otherwise 1. */
export async function depart(context: BusContext, requestId?: string): Promise<number> {
  const { config, paths } = context;
  const timezone = config.schedule.timezone;
  const attemptTime = context.clock.now();
  const attempt = requestId === undefined ? String(attemptTime) : `request-${requestId}`;
  const pushBefore = readTrimmed(paths.lastPushSha) ?? "";
  const when = stamp(timezone, attemptTime);
  const slot = latestScheduledSlot(timezone, config.schedule.departures, attemptTime);
  const store = requestStore(context);
  let branches: string[] = [];
  const blocked = (stage: string, message: string): number => {
    if (branches.length > 0) {
      const current = readTrimmed(paths.lastPushSha) ?? "";
      const truth =
        current === pushBefore
          ? "no successful new push recorded; no candidate deployment started"
          : `pushed ${current}; deployment state tracked separately`;
      context.events.emit(
        `blocked-${stage}`,
        attempt,
        `${when} blocked at ${stage}: ${message}; ${truth}; operator fix or next scheduled retry required.`,
      );
    }
    return 1;
  };
  const fetched = (): Promise<boolean> =>
    gitOk(context.exec, context.game.repo, ["fetch", "-q", config.git.remote]);

  const first = await underQueueLock(context, async () => {
    if (requestId !== undefined && !(await validateRequest(store, requestId))) {
      return 1;
    }
    branches = readQueue(paths.queue);
    if (requestId !== undefined) {
      context.events.emit(
        "attempt",
        attempt,
        [
          `${when} user-authorized one-off request ${requestId}: ${branches.join(" ")};`,
          "push not started; deployment not started.",
        ].join(" "),
      );
    } else if (branches.length > 0) {
      reportScheduledTick(
        context,
        slot,
        "queued work is being checked; attempt and outcome reports follow separately.",
      );
      context.events.emit(
        "attempt",
        attempt,
        `${when} scheduled attempt: ${branches.join(" ")}; push not started; deployment not started.`,
      );
    } else if (nonEmpty(paths.deployPending)) {
      reportScheduledTick(
        context,
        slot,
        "deployment retry is being checked; its outcome is reported separately.",
      );
    } else {
      reportScheduledTick(context, slot, "queue empty; no new batch is queued.");
    }
    if (!(await fetched())) {
      return blocked("fetch", "remote fetch failed");
    }
    if (!(await ciNotRed(context, branches))) {
      return blocked("CI", "previous CI red or repair approval invalid");
    }
    return 0;
  });
  if (first !== 0) {
    return first;
  }
  if (deployPendingExists(context)) {
    if (!(await ciGreenOrUnknown(context))) {
      context.log("bus: repair approval cannot retry a previous pending deployment");
      return blocked("deployment", "repair cannot retry previous deployment");
    }
    if (!(await retryDeploy(context))) {
      return blocked("deployment", "previous deployment retry failed; retained assets");
    }
  }
  if (!loadOk(context)) {
    const limit = config.resources.loadLimit;
    context.log(`${when} bus: load at or above ${limit}; queue retained`);
    return blocked("load", `load at or above ${limit}; queue retained`);
  }
  let request: RequestRecord | undefined;
  const second = await underQueueLock(context, async () => {
    if (requestId !== undefined && !(await validateRequest(store, requestId))) {
      return 1;
    }
    branches = readQueue(paths.queue);
    if (!(await fetched())) {
      return blocked("fetch", "remote fetch failed");
    }
    if (!(await ciNotRed(context, branches))) {
      return blocked("CI", "previous CI red or repair approval invalid");
    }
    if (requestId !== undefined) {
      if (!(await validateRequest(store, requestId))) {
        return 1;
      }
      // Pin integration inputs while validation and queue consumption share this lock.
      request = loadRequest(paths, requestId);
    }
    truncate(paths.queue);
    return 0;
  });
  if (second !== 0) {
    return second;
  }
  if (branches.length === 0) {
    context.log(`${when} bus: nothing waiting`);
    return 0;
  }
  context.log(`${when} bus departs with: ${branches.join(" ")}`);
  const prefixed: BusContext = { ...context, log: (line) => context.log(`${when}  ${line}`) };
  const pushed = await runBatch(prefixed, {
    attempt,
    branches,
    ...(request === undefined ? {} : { request }),
  });
  if (!pushed) {
    blocked("batch", "integration or full gate failed; inspect retained batch and requeue a fix");
    return 1;
  }
  return 0;
}
