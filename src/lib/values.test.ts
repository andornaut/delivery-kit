import { describe, expect, it } from "vitest";

import { errorMessage, isoSeconds, isRecord } from "./values.ts";

describe("values", () => {
  it("recognizes a plain object", () => {
    expect(isRecord({})).toBe(true);
    for (const value of [null, [], "x", 1, undefined]) {
      expect(isRecord(value)).toBe(false);
    }
  });

  it("reads an error's message or the value as text", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });

  it("formats epoch milliseconds as ISO 8601 UTC to the second", () => {
    expect(isoSeconds(Date.UTC(2026, 10, 4, 3, 20, 0, 999))).toBe("2026-11-04T03:20:00Z");
  });
});
