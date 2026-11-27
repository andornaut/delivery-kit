// The resident runner for one game: singleton locks, identity, the serialized scheduled and
// requested departure loop, the 60 s observer, the 1800 s resource sampler and the
// in-runner CI watches. Events are appended to bus/events.jsonl (state/eventlog.ts); scheduled
// reviews and event ingest go through the coordinator CLI seam (seam/coordinator.ts). No timer
// outlives the process.
import { realpathSync } from "node:fs";
import { dirname } from "node:path";

import { holdLock, LockBusy, type LockHandle } from "@andornaut/coordination-kit/build/shared";

import { COORDINATION_KIT_BUNDLED, VERSION } from "../compatibility.ts";
import { ensureDir } from "../lib/files.ts";
import { recordIdentity } from "../state/identity.ts";
import { legacyOutboxIssue } from "../state/paths.ts";
import {
  installedIdentity,
  loadedIdentity,
  type PinIdentity,
  pinMismatch,
  recordPin,
} from "../state/pin.ts";
import type { BusContext } from "./context.ts";
import { departureLoop } from "./departure/loop.ts";
import { observer } from "./observation/observer.ts";
import { sampleResources } from "./observation/resources.ts";
import { CiTasks } from "./post-push/ci-tasks.ts";
import { bindDeliveryRunner, settleDeliveryRunner, unbindDeliveryRunner } from "./session.ts";

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
  /** Recheck app-mode authority before claiming a request or admitting a scheduled slot. */
  readonly authorizeDeparture?: () => void;
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
    const loaded = loadedIdentity(context.game.repo, VERSION, cliPath);
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
    tasks.resume(context);
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
      await departureLoop(context, guard, options.authorizeDeparture, signal);
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
