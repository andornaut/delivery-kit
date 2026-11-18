import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COORDINATION_KIT, COORDINATION_KIT_RANGE, coordinationKitPin, satisfies } from "./pin.ts";

function repoWith(manifest: Record<string, unknown> | string | null): string {
  const repo = mkdtempSync(join(tmpdir(), "delivery-kit-pin-"));
  if (manifest !== null) {
    const installed = join(repo, "node_modules", COORDINATION_KIT);
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, "package.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    );
  }
  return repo;
}

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

describe("coordinationKitPin", () => {
  it("declares the supported range once and accepts an installed release inside it", () => {
    expect(COORDINATION_KIT_RANGE).toBe(">=1.0.0 <2.0.0");
    expect(coordinationKitPin(repoWith({ name: COORDINATION_KIT, version: "1.4.2" }))).toEqual({
      installed: "1.4.2",
      reason: null,
      status: "supported",
      supported: COORDINATION_KIT_RANGE,
    });
  });

  it("fails closed for a missing, unreadable, foreign or out-of-range package", () => {
    for (const manifest of [null, "{", { name: "other", version: "1.4.2" }]) {
      expect(coordinationKitPin(repoWith(manifest))).toMatchObject({
        installed: null,
        reason: expect.stringContaining("is not installed") as unknown,
        status: "unsupported",
      });
    }
    expect(coordinationKitPin(repoWith({ name: COORDINATION_KIT, version: "2.0.0" }))).toEqual({
      installed: "2.0.0",
      reason: `${COORDINATION_KIT} 2.0.0 is outside the supported range ${COORDINATION_KIT_RANGE}`,
      status: "unsupported",
      supported: COORDINATION_KIT_RANGE,
    });
  });
});
