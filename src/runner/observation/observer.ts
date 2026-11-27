// The runner's per-minute observer: scheduled reviews through the coordinator CLI seam, a retry of
// a compaction-reserved slot, scheduled-slot reports and an event ingest request. It never
// replays a missed slot.
import { currentMinuteSlot, minuteSlots, untilMinuteAfter } from "../../lib/time.ts";
import { COMPACTION_RESERVED, DEFERRED_PREFIX, type SeamOutcome } from "../../seam/result.ts";
import type { BusContext } from "../context.ts";
import { deliveryRunnerReady } from "../session.ts";
import { readSlotState, reportScheduledTick, slotDetail } from "./scheduled-status.ts";

/**
 * The runner log line for a review outcome. A `nothing-due` skip is logged too, so a runner that
 * does not host the route still shows each call.
 */
export function reviewLine(
  wake: number,
  outcome: SeamOutcome,
): { readonly line: string; readonly stderr: boolean } {
  if (!outcome.claimed) {
    return {
      line: `bus: scheduled review ${wake} unavailable (${outcome.why}); no delivery claimed`,
      stderr: false,
    };
  }
  const detail = outcome.detail === "" ? "" : `: ${outcome.detail}`;
  switch (outcome.status) {
    case "delivered":
      return { line: `bus: scheduled review ${wake}: ${outcome.detail}`, stderr: false };
    case "deferred":
      return { line: `${DEFERRED_PREFIX}${outcome.reason ?? "unknown"}${detail}`, stderr: true };
    default:
      return {
        line: `bus: scheduled review ${wake}: skipped ${outcome.reason ?? "unknown"}${detail}`,
        stderr: false,
      };
  }
}

/**
 * Whether a review slot is retained for a later pass: only a confirmed compaction-reserved
 * deferral, which left no review result to reconcile.
 */
export function retriesLater(outcome: SeamOutcome): boolean {
  return outcome.claimed && outcome.status === "deferred" && outcome.reason === COMPACTION_RESERVED;
}

/** Review one slot, retaining it for a retry when the CLI reserved it. */
async function observeReview(
  context: BusContext,
  reservedSlots: Set<number>,
  signal: AbortSignal,
  slot: number,
): Promise<void> {
  let outcome: SeamOutcome;
  try {
    outcome = await context.coordinator.review(slot, signal);
  } catch (error) {
    outcome = { claimed: false, why: String(error) };
  }
  if (retriesLater(outcome)) {
    reservedSlots.add(slot);
  } else {
    reservedSlots.delete(slot);
  }
  const report = reviewLine(slot, outcome);
  context.log(report.line);
  if (report.stderr) {
    process.stderr.write(`${report.line}\n`);
  }
}

/** One observer pass: scheduled reviews, scheduled-slot reports and an event ingest. */
async function observe(
  context: BusContext,
  after: number,
  now: number,
  reservedSlots: Set<number>,
  signal: AbortSignal,
): Promise<void> {
  const { config, layout } = context;
  const wake = currentMinuteSlot(layout.config.timezone, layout.config.wakeMinutes, after, now);
  const retry = reservedSlots.values().next().value;
  if (wake !== undefined) {
    await observeReview(context, reservedSlots, signal, wake);
  }
  if (retry !== undefined && retry !== wake && !signal.aborted) {
    await observeReview(context, reservedSlots, signal, retry);
  }
  if (config.reports.scheduledTicks) {
    const minutes = config.schedule.departures.map((departure) => Number.parseInt(departure, 10));
    for (const slot of minuteSlots(config.schedule.timezone, minutes, after, now)) {
      reportScheduledTick(context, slot, slotDetail(readSlotState(context.paths), slot));
    }
  }
  context.events.ingest();
}

/**
 * One observer pass per minute, each after `beforePass`. Each wakeup is at the start of the minute
 * after the previous pass's reading, so a pass that runs past a minute boundary still observes
 * that minute.
 */
export async function observer(
  context: BusContext,
  signal: AbortSignal,
  beforePass: () => void,
): Promise<void> {
  const reservedSlots = new Set<number>();
  let previous = context.clock.now();
  while (!signal.aborted) {
    deliveryRunnerReady(context);
    beforePass();
    const now = context.clock.now();
    // The observer is sequential by design.
    // eslint-disable-next-line no-await-in-loop
    await observe(context, previous, now, reservedSlots, signal).catch((error: unknown) =>
      context.log(`bus: observer: ${String(error)}`),
    );
    previous = now;
    // eslint-disable-next-line no-await-in-loop
    await context.clock.sleep(untilMinuteAfter(now, context.clock.now()), signal);
  }
}
