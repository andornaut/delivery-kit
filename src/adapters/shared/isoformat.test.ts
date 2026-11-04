import { describe, expect, it } from "vitest";

import { utcStamp } from "./isoformat.ts";

// Expected values from Python 3.12: datetime.fromisoformat(value.replace("Z", "+00:00"))
// .timestamp() for a value ending in Z or +00:00 with a zero UTC offset, as _stamp() reads it.
const ACCEPTED: readonly [string, number][] = [
  ["2026-11-03T12:34:56Z", 1793709296],
  ["2026-11-03T12:34:56+00:00", 1793709296],
  ["2026-11-03 12:34:56Z", 1793709296],
  ["2026-11-03T12:34:56.5Z", 1793709296.5],
  ["2026-11-03T12:34:56,123456789Z", 1793709296.123456],
  ["2026-11-03T12Z", 1793707200],
  ["2026-11-03T1234Z", 1793709240],
  ["2026-11-03T12:34Z", 1793709240],
  ["20261103T123456Z", 1793709296],
  ["2026-W45-2T12:00Z", 1793707200],
  ["2026W452T12:00Z", 1793707200],
  ["2026-11-03x12:34:56Z", 1793709296],
  ["2026-11-03T12:34:56.Z", 1793709296],
];

const REFUSED: readonly string[] = [
  "2026-307T00:00Z",
  "2026-11-03T12:34:56+00:00:00Z",
  "2026-11-03T12:34:56.123+0000",
  "2026-11-03Z",
  "2026-11-03T25:00:00Z",
  "2026-11-03T12:34:56+01:00",
  "2026-11-03T12:34:56",
  "2026-02-30T00:00:00Z",
  "2026-11-03T12:34:56+00:00:00.000001",
];

describe("utcStamp", () => {
  it.each(ACCEPTED)("accepts %s as Python does", (value, expected) => {
    expect(utcStamp(value)).toBeCloseTo(expected, 6);
  });

  it.each(REFUSED)("refuses %s as Python does", (value) => {
    expect(utcStamp(value)).toBeNull();
  });

  it("refuses a value that is not a string", () => {
    expect(utcStamp(1793709296)).toBeNull();
  });
});
