import { describe, expect, it } from "vitest";

import { pyDumps } from "./state.ts";

describe("pyDumps", () => {
  it("matches the 0.9.x sorted-key record encoding", () => {
    expect(
      pyDumps({ state: "pending", id: "a", entries: [["bus/x", "f".repeat(4)]], none: null }),
    ).toBe('{"entries": [["bus/x", "ffff"]], "id": "a", "none": null, "state": "pending"}');
    expect(pyDumps({ e: [], o: {}, n: 3, t: true, u: "café", b: 12345678901234567890n })).toBe(
      '{"b": 12345678901234567890, "e": [], "n": 3, "o": {}, "t": true, "u": "caf\\u00e9"}',
    );
  });
});
