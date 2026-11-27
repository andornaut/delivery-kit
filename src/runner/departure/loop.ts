import { ensureDir, truncate, writeLines } from "../../lib/files.ts";
import { untilNext } from "../../lib/time.ts";
import type { BusContext } from "../context.ts";
import { beginDeliveryWork, endDeliveryWork } from "../session.ts";
import { depart } from "./depart.ts";
import {
  claimRequest,
  finishRequest,
  hasPendingRequest,
  recoverRequests,
  requestStore,
} from "./requests.ts";

/**
 * Where the departure loop stands against the next scheduled slot: `early` before it, `due` within
 * its first minute, `missed` once that minute has passed. A missed slot is never replayed.
 */
export function scheduledStep(now: number, next: number): "due" | "early" | "missed" {
  if (now < next) {
    return "early";
  }
  return now - next >= 60 ? "missed" : "due";
}

/** Serialized scheduled and requested departures until `signal` aborts. */
export async function departureLoop(
  context: BusContext,
  beforeDeparture: () => void,
  authorizeDeparture: (() => void) | undefined,
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
  let lastDenial: string | undefined;
  const authorized = (): boolean => {
    try {
      authorizeDeparture?.();
      lastDenial = undefined;
      return true;
    } catch (error) {
      const detail = String(error);
      if (detail !== lastDenial) {
        context.log(`bus: departure blocked by app operator authorization: ${detail}`);
        lastDenial = detail;
      }
      return false;
    }
  };
  truncate(paths.activeDeparture);
  try {
    await recoverRequests(store);
    let next = context.clock.now() + untilNext(timezone, departures, context.clock.now());
    while (!signal.aborted) {
      let now = context.clock.now();
      const step = scheduledStep(now, next);
      if (step === "early") {
        const admission =
          hasPendingRequest(context.paths) && authorized()
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
      if (step === "missed") {
        next = now + untilNext(timezone, departures, now);
        continue;
      }
      if (authorized()) {
        writeLines(paths.activeDeparture, String(now));
        beforeDeparture();
        // eslint-disable-next-line no-await-in-loop
        await depart(context, { signal });
        truncate(paths.activeDeparture);
      }
      now = context.clock.now();
      next = now + untilNext(timezone, departures, now);
    }
  } finally {
    truncate(paths.activeDeparture);
  }
}
