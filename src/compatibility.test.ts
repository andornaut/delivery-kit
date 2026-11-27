import { describe, expect, it } from "vitest";

import {
  COORDINATION_KIT_BUNDLED,
  COORDINATION_KIT_RANGE,
  coordinationKitReport,
  COORDINATOR_CLI_RANGE,
  satisfies,
} from "./compatibility.ts";

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

describe("ranges", () => {
  it("accepts 3.x through 9.x coordinator CLIs and a 7.8 through 9.x bundle", () => {
    expect(COORDINATOR_CLI_RANGE).toBe(">=3.0.0 <10.0.0");
    expect(COORDINATION_KIT_RANGE).toBe(">=7.8.0 <10.0.0");
    for (const [version, cli, bundle] of [
      ["2.0.0", false, false],
      ["2.0.1", false, false],
      ["3.0.0", true, false],
      ["3.0.0-rc.1", false, false],
      ["4.0.2", true, false],
      ["4.99.0", true, false],
      ["5.0.0-rc.1", false, false],
      ["5.0.0", true, false],
      ["5.99.0", true, false],
      ["6.0.0-rc.1", false, false],
      ["6.0.0", true, false],
      ["6.99.0", true, false],
      ["7.0.0-rc.1", false, false],
      ["7.0.0", true, false],
      ["7.7.9", true, false],
      ["7.8.0", true, true],
      ["7.99.0", true, true],
      ["8.0.0-rc.1", false, false],
      ["8.0.0", true, true],
      ["9.0.0", true, true],
      ["9.0.0-rc.1", false, false],
      ["10.0.0", false, false],
    ] as const) {
      expect(satisfies(COORDINATOR_CLI_RANGE, version), version).toBe(cli);
      expect(satisfies(COORDINATION_KIT_RANGE, version), version).toBe(bundle);
    }
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
