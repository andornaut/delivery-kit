import { describe, expect, it } from "vitest";

import { satisfiesRange } from "./version-range.ts";

describe("satisfiesRange", () => {
  it.each([
    [">=20.9.0", "20.9.0", true],
    [">=20.9.0", "20.8.9", false],
    [">= 14.6", "14.6.0", true],
    [">20", "20.99.0", false],
    [">20", "21.0.0", true],
    ["<=20.1", "20.1.9", true],
    ["<=20.1", "20.2.0", false],
    ["^18.17.0 || ^20.3.0 || >=21.0.0", "20.2.0", false],
    ["^18.17.0 || ^20.3.0 || >=21.0.0", "18.20.1", true],
    ["^18.17.0 || ^20.3.0 || >=21.0.0", "24.11.1", true],
    ["^0.2.3", "0.3.0", false],
    ["^0.0.3", "0.0.4", false],
    ["~1.2.3", "1.2.9", true],
    ["~1.2.3", "1.3.0", false],
    ["~1", "1.9.0", true],
    ["1.x", "2.0.0", false],
    ["20", "20.5.1", true],
    ["=20.5.1", "20.5.2", false],
    ["*", "0.0.1", true],
    ["", "24.0.0", true],
    [">=10 <12", "12.0.0", false],
    [">=10 <12", "11.9.9", true],
    ["18 - 20.1", "20.1.5", true],
    ["18 - 20.1", "20.2.0", false],
  ])("matches %s against %s as %s", (range, version, expected) => {
    expect(satisfiesRange(range, version)).toBe(expected);
  });

  it("is unknown for a range or version it cannot read", () => {
    expect(satisfiesRange("latest", "24.0.0")).toBeUndefined();
    expect(satisfiesRange(">=1.0.0-beta", "24.0.0")).toBeUndefined();
    expect(satisfiesRange(">=20", "24.0.0-rc.1")).toBeUndefined();
    // One readable alternative that matches is enough.
    expect(satisfiesRange("latest || >=20", "24.0.0")).toBe(true);
    expect(satisfiesRange("latest || >=30", "24.0.0")).toBeUndefined();
  });
});
