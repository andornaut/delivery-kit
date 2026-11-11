// The resident runner for one game: singleton locks, identity, the
// serialized scheduled and requested departure loop, the 60 s observer, the 1800 s resource
// sampler and the in-runner CI watches. No timer outlives the process.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { unfinishedCi, watchCi } from "../ci.ts";
import {
  beginDeliveryWork,
  bindDeliveryRunner,
  deliveryRunnerReady,
  deployAfterCi,
  endDeliveryWork,
  settleDeliveryRunner,
  unbindDeliveryRunner,
  updateDeliveryWork,
} from "../deploy.ts";
import { holdLock, LockBusy, type LockHandle } from "../lock.ts";
import { DEFERRED_PREFIX, deliverScheduledWake } from "../review/wake.ts";
import type { BusContext } from "./context.ts";
import { depart, reportScheduledTick, requestStore, slotDetail } from "./departure.ts";
import { loadedIdentity, pinGuard, recordPin } from "./pin.ts";
import { claimRequest, finishRequest, recoverRequests } from "./requests.ts";
import { sampleResources } from "./resources.ts";
import { ensureDir, readTrimmed, truncate, writeLines } from "./state.ts";
import { recordIdentity } from "./status.ts";
import { currentMinuteSlot, minuteSlots, untilNext } from "./time.ts";

declare const __DK_VERSION__: string;
const LOADED_VERSION = typeof __DK_VERSION__ === "string" ? __DK_VERSION__ : "0.0.0-source";

/** In-runner CI watches, at most one per SHA. Aborted watches resume in the next runner. */
class CiTasks {
  readonly #running = new Map<string, Promise<unknown>>();
  readonly #activities = new Map<string, string | undefined>();
  readonly #signal: AbortSignal;

  constructor(signal: AbortSignal) {
    this.#signal = signal;
  }

  start(context: BusContext, sha: string): void {
    if (this.#running.has(sha) || this.#signal.aborted) {
      return;
    }
    // startCi is called only for a recorded push or a persisted unfinished CI watch.
    this.#activities.set(sha, beginDeliveryWork(context, "checking", sha, true));
    // The deployment of a pushed SHA runs once its CI passes.
    const task = watchCi(context, sha, { signal: this.#signal })
      .then(async (result) => {
        const activity = this.#activities.get(sha);
        if (result === "success") {
          await deployAfterCi(context, sha);
        } else if (result !== "busy" && activity !== undefined) {
          updateDeliveryWork(context, activity, "failed", sha);
        }
      })
      .catch((error: unknown) => {
        const activity = this.#activities.get(sha);
        if (activity !== undefined && !this.#signal.aborted) {
          updateDeliveryWork(context, activity, "failed", sha);
        }
        context.log(`bus: CI watch ${sha} failed: ${String(error)}`);
      })
      .finally(() => {
        const activity = this.#activities.get(sha);
        if (activity !== undefined) {
          endDeliveryWork(context, activity);
        }
        this.#running.delete(sha);
        this.#activities.delete(sha);
      });
    this.#running.set(sha, task);
  }

  /** Attach observations after an operator explicitly initializes missing control. */
  refresh(context: BusContext): void {
    for (const [sha, activity] of this.#activities) {
      if (activity === undefined) {
        this.#activities.set(sha, beginDeliveryWork(context, "checking", sha, true));
      }
    }
  }

  async drain(): Promise<void> {
    await Promise.all(this.#running.values());
  }
}

/** One observer pass: scheduled reviews, scheduled-slot reports and an event flush. */
async function observe(
  context: BusContext,
  after: number,
  now: number,
  signal?: AbortSignal,
): Promise<void> {
  const { config, layout } = context;
  const wake = currentMinuteSlot(layout.config.timezone, layout.config.wakeMinutes, after, now);
  if (wake !== undefined) {
    try {
      // "" means this runner does not dispatch the slot; a deferral is its own line.
      const outcome = await deliverScheduledWake(layout, context.game, wake, signal);
      if (outcome.startsWith(DEFERRED_PREFIX)) {
        context.log(outcome);
        process.stderr.write(`${outcome}\n`);
      } else if (outcome !== "") {
        context.log(`bus: scheduled review ${wake}: ${outcome}`);
      }
    } catch (error) {
      context.log(
        `bus: scheduled review ${wake} unavailable (${String(error)}); no delivery claimed`,
      );
    }
  }
  if (config.reports.scheduledTicks) {
    const minutes = config.schedule.departures.map((departure) => Number.parseInt(departure, 10));
    for (const slot of minuteSlots(config.schedule.timezone, minutes, after, now)) {
      reportScheduledTick(context, slot, slotDetail(context));
    }
  }
  context.events.flush();
}

async function observer(context: BusContext, signal: AbortSignal, tasks: CiTasks): Promise<void> {
  let previous = context.clock.now();
  while (!signal.aborted) {
    deliveryRunnerReady(context);
    tasks.refresh(context);
    const now = context.clock.now();
    // The observer is sequential by design.
    // eslint-disable-next-line no-await-in-loop
    await observe(context, previous, now, signal).catch((error: unknown) =>
      context.log(`bus: observer: ${String(error)}`),
    );
    previous = now;
    // eslint-disable-next-line no-await-in-loop
    await context.clock.sleep(60, signal);
  }
}

export interface LoopHooks {
  /** Called before every departure; the pin guard. */
  readonly beforeDeparture?: () => void;
}

function pendingRequest(context: BusContext): boolean {
  try {
    return readdirSync(context.paths.requestsDir).some((name) => {
      if (!name.endsWith(".json")) {
        return false;
      }
      const record = JSON.parse(readFileSync(join(context.paths.requestsDir, name), "utf8")) as {
        state?: string;
      };
      return record.state === "pending";
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Serialized scheduled and requested departures until `signal` aborts. */
async function departureLoop(
  context: BusContext,
  hooks: LoopHooks,
  signal: AbortSignal,
): Promise<void> {
  const { config, paths } = context;
  const { departures, timezone } = config.schedule;
  const store = requestStore(context);
  ensureDir(paths.dir);
  writeLines(paths.busPid, String(process.pid));
  context.log(
    `bus: scheduled ${departures.join(" ")} (${timezone}), deployment route ${config.deploy.mode}`,
  );
  truncate(paths.activeDeparture);
  try {
    await recoverRequests(store);
    let next = context.clock.now() + untilNext(timezone, departures, context.clock.now());
    while (!signal.aborted) {
      let now = context.clock.now();
      if (now < next) {
        const admission = pendingRequest(context)
          ? beginDeliveryWork(context, "checking", null)
          : undefined;
        let request: string | undefined;
        try {
          // Reserve before claiming: a pause cannot consume a pending receipt.
          // eslint-disable-next-line no-await-in-loop
          request = admission === undefined ? undefined : await claimRequest(store);
        } finally {
          if (request === undefined && admission !== undefined) {
            endDeliveryWork(context, admission);
          }
        }
        if (request !== undefined) {
          try {
            writeLines(paths.activeDeparture, String(now));
            hooks.beforeDeparture?.();
            // eslint-disable-next-line no-await-in-loop
            const result = await depart(context, { admission, requestId: request, signal });
            // eslint-disable-next-line no-await-in-loop
            await finishRequest(store, request, result);
          } finally {
            if (admission !== undefined) {
              endDeliveryWork(context, admission);
            }
            truncate(paths.activeDeparture);
          }
          now = context.clock.now();
          if (now >= next) {
            next = now + untilNext(timezone, departures, now);
          }
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await context.clock.sleep(Math.min(next - now, 5), signal);
        continue;
      }
      // An active operation may cross deadlines. Never replay a missed scheduled slot.
      if (now - next >= 60) {
        next = now + untilNext(timezone, departures, now);
        continue;
      }
      writeLines(paths.activeDeparture, String(now));
      hooks.beforeDeparture?.();
      // eslint-disable-next-line no-await-in-loop
      await depart(context, { signal });
      truncate(paths.activeDeparture);
      now = context.clock.now();
      next = now + untilNext(timezone, departures, now);
    }
  } finally {
    truncate(paths.activeDeparture);
  }
}

export class RunnerRefused extends Error {}

export interface RunnerOptions {
  /** The loaded bundle, for the pin guard; defaults to the running script. */
  readonly cliPath?: string;
  readonly signal: AbortSignal;
}

function holdSingleton(context: BusContext): LockHandle[] {
  const held: LockHandle[] = [];
  const take = (path: string, message: string): void => {
    try {
      held.push(holdLock(path, { nonBlocking: true }));
    } catch (error) {
      if (error instanceof LockBusy) {
        throw new RunnerRefused(message);
      }
      throw error;
    }
  };
  try {
    // Opened without truncation, so a refused duplicate start leaves the holder's token intact.
    take(context.paths.runnerLock, "a runner is already active");
    take(context.paths.loopLock, "another scheduled loop is already running");
  } catch (error) {
    for (const lock of held) {
      lock.release();
    }
    throw error;
  }
  return held;
}

function sourceCommit(toolRoot: string): string | null {
  return readTrimmed(join(toolRoot, "SOURCE_COMMIT")) ?? null;
}

/** Hold the singleton locks, record identity and pin, then run until aborted. */
export async function runRunner(
  options: RunnerOptions,
  makeContext: (startCi: (sha: string) => void) => BusContext,
): Promise<void> {
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  const tasks = new CiTasks(signal);
  const context: BusContext = makeContext((sha) => tasks.start(context, sha));
  ensureDir(context.paths.dir);
  const locks = holdSingleton(context);
  let failed = false;
  try {
    const cliPath = options.cliPath ?? realpathSync(process.argv[1] ?? "");
    const toolRoot = dirname(dirname(cliPath));
    let runnerToken: string | undefined;
    try {
      const identity = recordIdentity(context.paths, {
        config: context.game.configFile,
        pid: process.pid,
        sourceCommit: sourceCommit(toolRoot),
        toolRoot,
        version: LOADED_VERSION,
      });
      runnerToken = typeof identity.token === "string" ? identity.token : undefined;
    } catch (error) {
      context.log(
        `bus: runner identity record unavailable; status reports it unattested (${String(error)})`,
      );
    }
    bindDeliveryRunner(context, runnerToken);
    const loaded = loadedIdentity(LOADED_VERSION, cliPath, context.game.repo);
    recordPin(context, loaded, cliPath);
    const guard = pinGuard(context, loaded);
    for (const sha of unfinishedCi(context)) {
      tasks.start(context, sha);
    }
    const background = [sampleResources(context, signal), observer(context, signal, tasks)];
    let backgroundFailure: PromiseRejectedResult | undefined;
    try {
      await departureLoop(context, { beforeDeparture: () => guard.check() }, signal);
    } finally {
      stop.abort();
      const drained = await Promise.allSettled([...background, tasks.drain()]);
      backgroundFailure = drained.find((result) => result.status === "rejected");
    }
    if (backgroundFailure !== undefined) {
      throw backgroundFailure.reason;
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    settleDeliveryRunner(context, failed ? "failed" : "stopped");
    unbindDeliveryRunner(context);
    for (const lock of locks.reverse()) {
      lock.release();
    }
  }
}
