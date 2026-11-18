import { describe, expect, it } from "vitest";

import {
  COORDINATION_KIT_BUNDLED,
  COORDINATION_KIT_RANGE,
  coordinationKitReport,
  satisfies,
} from "./pin.ts";

describe("satisfies", () => {
  it("applies every comparator to plain releases only", () => {
    const range = ">=1.0.0 <2.0.0";
    expect(["1.0.0", "1.0.10", "1.9.0"].every((version) => satisfies(range, version))).toBe(true);
    for (const version of ["0.9.9", "2.0.0", "1.2.0-rc.1", "1.2.0+build", "v1.2.0", "01.2.0"]) {
      expect(satisfies(range, version)).toBe(false);
    }
    expect(satisfies("=1.2.3", "1.2.3")).toBe(true);
    expect(satisfies(">1.2.3 <=1.2.4", "1.2.4")).toBe(true);
    expect(() => satisfies("^1.0.0", "1.0.0")).toThrow("unsupported range comparator: ^1.0.0");
  });
});

describe("coordinationKitReport", () => {
  it("reports the bundled coordination-kit and the supported range, read-only", () => {
    expect(coordinationKitReport()).toEqual({
      bundled: COORDINATION_KIT_BUNDLED,
      supported: COORDINATION_KIT_RANGE,
    });
    // The unit configuration defines the embedded version as the build does.
    expect(COORDINATION_KIT_BUNDLED).toBe("0.0.0-test");
  });
});
