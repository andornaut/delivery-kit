// The resident runner for one game: singleton locks, identity, the serialized scheduled and
// requested departure loop, the 60 s observer (observer.ts), the 1800 s resource sampler and the
// in-runner CI watches. Events are appended to bus/events.jsonl (state/eventlog.ts); scheduled
// reviews and event ingest go through the coordinator CLI seam (seam/coordinator.ts). No timer
// outlives the process.
import { realpathSync } from "node:fs";
import { dirname } from "node:path";

import { holdLock, LockBusy, type LockHandle } from "@andornaut/coordination-kit/build/shared";

import { COORDINATION_KIT_BUNDLED, VERSION } from "../compatibility.ts";
import { ensureDir, truncate, writeLines } from "../lib/files.ts";
import { untilNext } from "../lib/time.ts";
import { recordIdentity } from "../state/identity.ts";
import { legacyOutboxIssue } from "../state/paths.ts";
import {
  installedIdentity,
  loadedIdentity,
  type PinIdentity,
  pinMismatch,
  recordPin,
} from "../state/pin.ts";
import { unfinishedCi, watchCi } from "./ci.ts";
import type { BusContext } from "./context.ts";
import { depart, requestStore } from "./departure.ts";
import { deployAfterCi } from "./deploy.ts";
import { observer } from "./observer.ts";
import { claimRequest, finishRequest, hasPendingRequest, recoverRequests } from "./requests.ts";
import { sampleResources } from "./resources.ts";
import {
  beginDeliveryWork,
  bindDeliveryRunner,
  endDeliveryWork,
  settleDeliveryRunner,
  unbindDeliveryRunner,
  updateDeliveryWork,
} from "./session.ts";

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

/** Serialized scheduled and requested departures until `signal` aborts. */
async function departureLoop(
  context: BusContext,
  beforeDeparture: () => void,
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
        const admission = hasPendingRequest(context.paths)
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
            beforeDeparture();
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
      beforeDeparture();
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

/** Compare the loaded package with the installed one; log each mismatch, report each new one. */
function pinGuard(context: BusContext, loaded: PinIdentity): () => void {
  let reported: string | undefined;
  return () => {
    const mismatch = pinMismatch(loaded, installedIdentity(context.game.repo));
    if (mismatch === undefined) {
      return;
    }
    context.log(mismatch.logLine);
    if (reported !== mismatch.key) {
      reported = mismatch.key;
      context.events.emit("pin-mismatch", mismatch.key, mismatch.detail);
    }
  };
}

export class RunnerRefused extends Error {}

interface RunnerOptions {
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

/** Hold the singleton locks, record identity and pin, then run until aborted. */
export async function runRunner(
  options: RunnerOptions,
  makeContext: (startCi: (sha: string) => void) => BusContext,
): Promise<void> {
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  const tasks = new CiTasks(signal);
  const context: BusContext = makeContext((sha) => tasks.start(context, sha));
  const legacy = legacyOutboxIssue(context.paths);
  if (legacy !== undefined) {
    throw new RunnerRefused(legacy.detail);
  }
  ensureDir(context.paths.dir);
  const locks = holdSingleton(context);
  let failed = false;
  try {
    // Before any append: torn-tail repair and dedupe rebuild.
    context.events.open();
    const cliPath = options.cliPath ?? realpathSync(process.argv[1] ?? "");
    const toolRoot = dirname(dirname(cliPath));
    const loaded = loadedIdentity(VERSION, cliPath, context.game.repo);
    let runnerToken: string | undefined;
    try {
      const identity = recordIdentity(context.paths, {
        cliSha256: loaded.cliSha256,
        config: context.game.configFile,
        coordinationKitVersion: COORDINATION_KIT_BUNDLED,
        pid: process.pid,
        sourceCommit: loaded.sourceCommit,
        toolRoot,
        version: VERSION,
      });
      runnerToken = typeof identity.token === "string" ? identity.token : undefined;
    } catch (error) {
      context.log(
        `bus: runner identity record unavailable; status reports it unattested (${String(error)})`,
      );
    }
    bindDeliveryRunner(context, runnerToken);
    recordPin(
      context.paths.runnerJson,
      { cliPath, pid: process.pid, startedAt: context.clock.now() },
      loaded,
    );
    const guard = pinGuard(context, loaded);
    for (const sha of unfinishedCi(context.paths)) {
      tasks.start(context, sha);
    }
    // The seam never delays startup or a departure: the probe logs the CLI identity early, and
    // runner.started carries it once the probe settles.
    signal.addEventListener("abort", () => context.coordinator.stop(), { once: true });
    const startedKey = runnerToken ?? `${process.pid}:${context.clock.now()}`;
    const background = [
      context.coordinator.probe(signal).then((cli) =>
        context.events.started(startedKey, {
          cliSha256: loaded.cliSha256,
          coordinationKitVersion: cli?.version ?? null,
          deliveryKitVersion: VERSION,
          distSha256: cli?.distSha256 ?? null,
          token: runnerToken ?? null,
        }),
      ),
      sampleResources(context, signal),
      observer(context, signal, () => tasks.refresh(context)),
    ];
    let backgroundFailure: PromiseRejectedResult | undefined;
    try {
      await departureLoop(context, guard, signal);
    } finally {
      stop.abort();
      context.coordinator.stop();
      const drained = await Promise.allSettled([
        ...background,
        tasks.drain(),
        context.coordinator.drain(),
      ]);
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
