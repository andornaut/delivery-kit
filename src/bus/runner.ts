// The resident runner for one game: singleton locks, identity, the
// serialized scheduled and requested departure loop, the 60 s observer, the 1800 s resource
// sampler and the in-runner CI watches. No timer outlives the process.
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { unfinishedCi, watchCi } from "../ci.ts";
import { deployAfterCi } from "../deploy.ts";
import { holdLock, LockBusy, type LockHandle } from "../lock.ts";
import { deliverScheduledWake } from "../monitor/wake.ts";
import type { BusContext } from "./context.ts";
import { depart, reportScheduledTick, requestStore, slotDetail } from "./departure.ts";
import { holdLegacyLocks, legacyBusDir } from "./legacy.ts";
import { loadedIdentity, pinGuard, recordPin } from "./pin.ts";
import { claimRequest, finishRequest, recoverRequests } from "./requests.ts";
import { sampleResources } from "./resources.ts";
import { ensureDir, readTrimmed, truncate, writeLines } from "./state.ts";
import { recordIdentity } from "./status.ts";
import { currentMinuteSlot, minuteSlots, untilNext } from "./time.ts";

declare const __DK_VERSION__: string;
export const LOADED_VERSION = typeof __DK_VERSION__ === "string" ? __DK_VERSION__ : "0.0.0-source";

/** In-runner CI watches, at most one per SHA. Aborted watches resume in the next runner. */
export class CiTasks {
  readonly #running = new Map<string, Promise<unknown>>();
  readonly #signal: AbortSignal;

  constructor(signal: AbortSignal) {
    this.#signal = signal;
  }

  start(context: BusContext, sha: string): void {
    if (this.#running.has(sha) || this.#signal.aborted) {
      return;
    }
    // The deployment of a pushed SHA runs once its CI passes.
    const task = watchCi(context, sha, { signal: this.#signal })
      .then((result) => (result === "success" ? deployAfterCi(context, sha) : undefined))
      .catch((error: unknown) => context.log(`bus: CI watch ${sha} failed: ${String(error)}`))
      .finally(() => this.#running.delete(sha));
    this.#running.set(sha, task);
  }

  async drain(): Promise<void> {
    await Promise.all(this.#running.values());
  }
}

/** One observer pass: monitor wakes, scheduled-slot reports and an event flush. */
export async function observe(context: BusContext, after: number, now: number): Promise<void> {
  const { config, layout } = context;
  const wake = currentMinuteSlot(layout.config.timezone, layout.config.wakeMinutes, after, now);
  if (wake !== undefined) {
    try {
      context.log(
        `bus: scheduled monitor ${wake}: ${await deliverScheduledWake(layout, context.game, wake)}`,
      );
    } catch (error) {
      context.log(
        `bus: scheduled monitor ${wake} unavailable (${String(error)}); no delivery claimed`,
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

async function observer(context: BusContext, signal: AbortSignal): Promise<void> {
  let previous = context.clock.now();
  while (!signal.aborted) {
    const now = context.clock.now();
    // The observer is sequential by design.
    // eslint-disable-next-line no-await-in-loop
    await observe(context, previous, now).catch((error: unknown) =>
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

/** Serialized scheduled and requested departures until `signal` aborts. */
export async function departureLoop(
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
        // eslint-disable-next-line no-await-in-loop
        const request = await claimRequest(store);
        if (request !== undefined) {
          writeLines(paths.activeDeparture, String(now));
          hooks.beforeDeparture?.();
          // eslint-disable-next-line no-await-in-loop
          const result = await depart(context, request);
          // eslint-disable-next-line no-await-in-loop
          await finishRequest(store, request, result);
          truncate(paths.activeDeparture);
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
      await depart(context);
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
  /** 0.x bus directory for the singleton guard; defaults to `<game>/.claude/bus`. */
  readonly legacyDir?: string;
  readonly signal: AbortSignal;
}

function holdSingleton(context: BusContext, options: RunnerOptions): LockHandle[] {
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
    take(context.paths.runnerLock, "bus: a runner is already active");
    const legacy = options.legacyDir ?? legacyBusDir(context.game);
    try {
      held.push(...holdLegacyLocks(legacy));
    } catch (error) {
      if (error instanceof LockBusy) {
        throw new RunnerRefused(`bus: a 0.x runner still holds ${error.path}`);
      }
      throw error;
    }
    take(context.paths.loopLock, "bus: another scheduled loop is already running");
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
  const tasks = new CiTasks(options.signal);
  const context: BusContext = makeContext((sha) => tasks.start(context, sha));
  ensureDir(context.paths.dir);
  const locks = holdSingleton(context, options);
  try {
    const cliPath = options.cliPath ?? realpathSync(process.argv[1] ?? "");
    const toolRoot = dirname(dirname(cliPath));
    try {
      recordIdentity(context.paths, {
        config: context.game.configFile,
        pid: process.pid,
        sourceCommit: sourceCommit(toolRoot),
        toolRoot,
        version: LOADED_VERSION,
      });
    } catch (error) {
      context.log(
        `bus: runner identity record unavailable; status reports it unattested (${String(error)})`,
      );
    }
    const loaded = loadedIdentity(LOADED_VERSION, cliPath, context.game.repo);
    recordPin(context, loaded, cliPath);
    const guard = pinGuard(context, loaded);
    for (const sha of unfinishedCi(context)) {
      tasks.start(context, sha);
    }
    const background = [
      sampleResources(context, options.signal),
      observer(context, options.signal),
    ];
    try {
      await departureLoop(context, { beforeDeparture: () => guard.check() }, options.signal);
    } finally {
      await Promise.all(background);
      await tasks.drain();
    }
  } finally {
    for (const lock of locks.reverse()) {
      lock.release();
    }
  }
}
