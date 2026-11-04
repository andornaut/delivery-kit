import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { testClock, testLoad, testOptions } from "./testOverrides.ts";

describe("DELIVERY_KIT_TEST_CLOCK", () => {
  it("is absent unless set", () => {
    expect(testClock({})).toBeUndefined();
  });

  it("reads epoch, offsets and scaled wall time, and shortens sleeps by the speed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clock-"));
    const file = join(dir, "clock.json");
    writeFileSync(file, JSON.stringify({ epoch: 1_000_000, realStartMs: Date.now(), speed: 600 }));
    const clock = testClock({ DELIVERY_KIT_TEST_CLOCK: file });
    expect(clock).toBeDefined();
    const start = clock?.now() ?? 0;
    expect(start - 1_000_000).toBeLessThan(5);
    appendFileSync(join(dir, "clock-offsets"), "3600\n");
    expect((clock?.now() ?? 0) - start).toBeGreaterThanOrEqual(3600);
    const real = Date.now();
    await clock?.sleep(60);
    expect(Date.now() - real).toBeLessThan(1000);
  });

  it("caps each real wait at maxRealSleep and ends a sleep when the offsets step past it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clock-"));
    const file = join(dir, "clock.json");
    writeFileSync(
      file,
      JSON.stringify({ epoch: 1_000_000, maxRealSleep: 0.05, realStartMs: Date.now(), speed: 1 }),
    );
    const clock = testClock({ DELIVERY_KIT_TEST_CLOCK: file });
    const started = Date.now();
    setTimeout(() => appendFileSync(join(dir, "clock-offsets"), "60\n"), 100);
    await clock?.sleep(60);
    expect(Date.now() - started).toBeLessThan(1000);
    expect((clock?.now() ?? 0) - 1_000_000).toBeGreaterThanOrEqual(60);
  });

  it("still sleeps the full virtual interval when nothing steps the clock", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "clock-")), "clock.json");
    writeFileSync(
      file,
      JSON.stringify({ epoch: 0, maxRealSleep: 0.02, realStartMs: Date.now(), speed: 1 }),
    );
    const clock = testClock({ DELIVERY_KIT_TEST_CLOCK: file });
    const started = Date.now();
    await clock?.sleep(0.2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it("sees a rewritten clock file on the next reading", () => {
    const file = join(mkdtempSync(join(tmpdir(), "clock-")), "clock.json");
    writeFileSync(file, JSON.stringify({ epoch: 100, realStartMs: Date.now(), speed: 1 }));
    const clock = testClock({ DELIVERY_KIT_TEST_CLOCK: file });
    writeFileSync(file, JSON.stringify({ epoch: 5000, realStartMs: Date.now(), speed: 1 }));
    expect(clock?.now()).toBeGreaterThanOrEqual(5000);
  });

  it("rejects a non-positive maxRealSleep", () => {
    const file = join(mkdtempSync(join(tmpdir(), "clock-")), "clock.json");
    writeFileSync(file, JSON.stringify({ epoch: 1, maxRealSleep: 0, realStartMs: 1, speed: 1 }));
    expect(() => testClock({ DELIVERY_KIT_TEST_CLOCK: file })).toThrow("maxRealSleep");
  });

  it("rejects a malformed clock file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "clock-")), "clock.json");
    writeFileSync(file, JSON.stringify({ epoch: 1, realStartMs: 1, speed: 0 }));
    expect(() => testClock({ DELIVERY_KIT_TEST_CLOCK: file })).toThrow("finite epoch");
  });
});

describe("DELIVERY_KIT_TEST_LOADAVG", () => {
  it("replaces the host load with a decimal number and rejects anything else", () => {
    expect(testLoad({})).toBeUndefined();
    expect(testLoad({ DELIVERY_KIT_TEST_LOADAVG: "30" })).toBe(30);
    expect(testOptions({ DELIVERY_KIT_TEST_LOADAVG: "0.5" }).loadAverage?.()).toBe(0.5);
    for (const value of ["-1", "abc", "1e3", "NaN"]) {
      expect(() => testLoad({ DELIVERY_KIT_TEST_LOADAVG: value })).toThrow("decimal number");
    }
  });
});
