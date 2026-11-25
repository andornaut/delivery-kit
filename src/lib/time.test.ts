import { describe, expect, it } from "vitest";

import {
  currentMinuteSlot,
  latestScheduledSlot,
  minuteSlots,
  untilMinuteAfter,
  untilNext,
} from "./time.ts";

const TZ = "America/Toronto";
// 2026-11-04 03:00:00 UTC is 22:00:00 EST on 2026-11-03.
const TEN_PM = Date.UTC(2026, 10, 4, 3, 0, 0) / 1000;

describe("schedule arithmetic", () => {
  it("counts seconds to the next departure minute and wraps the hour", () => {
    expect(untilNext(TZ, ["00"], TEN_PM)).toBe(3600);
    expect(untilNext(TZ, ["10"], TEN_PM)).toBe(600);
    expect(untilNext(TZ, ["10", "40"], TEN_PM + 15 * 60 + 30)).toBe(24 * 60 + 30);
    expect(untilNext(TZ, ["10"], TEN_PM + 15 * 60)).toBe(55 * 60);
  });

  it("finds the latest scheduled slot at or before now", () => {
    expect(latestScheduledSlot(TZ, ["00"], TEN_PM)).toBe(TEN_PM);
    expect(latestScheduledSlot(TZ, ["10"], TEN_PM + 5 * 60)).toBe(TEN_PM - 50 * 60);
    expect(latestScheduledSlot(TZ, ["00", "30"], TEN_PM + 45 * 60)).toBe(TEN_PM + 30 * 60);
  });

  it("selects whole-minute slots and never replays a missed review minute", () => {
    expect(minuteSlots(TZ, [0, 1], TEN_PM - 1, TEN_PM + 90)).toEqual([TEN_PM, TEN_PM + 60]);
    expect(currentMinuteSlot(TZ, [20], TEN_PM, TEN_PM + 20 * 60 + 5)).toBe(TEN_PM + 20 * 60);
    expect(currentMinuteSlot(TZ, [20], TEN_PM + 20 * 60, TEN_PM + 20 * 60 + 30)).toBeUndefined();
    expect(currentMinuteSlot(TZ, [19], TEN_PM, TEN_PM + 20 * 60 + 5)).toBeUndefined();
  });

  it("wakes at the minute after a reading, at once when that minute has begun", () => {
    expect(untilMinuteAfter(TEN_PM, TEN_PM)).toBe(60);
    expect(untilMinuteAfter(TEN_PM + 30, TEN_PM + 45)).toBe(15);
    expect(untilMinuteAfter(TEN_PM + 30, TEN_PM + 60)).toBe(0);
    expect(untilMinuteAfter(TEN_PM + 30, TEN_PM + 150)).toBe(0);
    // A clock stepped back waits no longer than one minute.
    expect(untilMinuteAfter(TEN_PM + 3600, TEN_PM)).toBe(60);
  });
});
