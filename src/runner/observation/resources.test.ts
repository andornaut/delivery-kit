import { describe, expect, it } from "vitest";

import { clockLine, uptimeLine } from "./resources.ts";

describe("resource report lines", () => {
  it("prints uptime(1)'s up time and load averages", () => {
    expect(uptimeLine(59 * 60, [0.5, 1, 1.256])).toBe("up 0:59,  load average: 0.50, 1.00, 1.26");
    expect(uptimeLine(86400 + 3600 + 5 * 60, [2, 1, 0])).toBe(
      "up 1 day, 1:05,  load average: 2.00, 1.00, 0.00",
    );
    expect(uptimeLine(3 * 86400, [0])).toBe("up 3 days, 0:00,  load average: 0.00");
  });

  it("prints the wall clock to the second in the schedule's time zone", () => {
    expect(clockLine("America/Toronto", Date.UTC(2026, 10, 4, 3, 20, 7) / 1000)).toBe(
      "2026-11-03 22:20:07 EST",
    );
  });
});
