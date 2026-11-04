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
