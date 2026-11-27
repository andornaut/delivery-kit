import { readText } from "../../lib/files.ts";
import { stamp } from "../../lib/time.ts";
import type { BusPaths } from "../../state/paths.ts";
import type { BusContext } from "../context.ts";

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
interface SlotState {
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
