import { describe, expect, it } from "vitest";

import { digest, dumpsJson, pyFloat, pyJsonDumps, unicodeDumps } from "./pyjson.ts";

// Expected strings are Python 3.12 json.dumps output for the same values.
describe("dumpsJson", () => {
  it("writes the sorted-key record encoding of bus and inbox state", () => {
    expect(
      dumpsJson({ state: "pending", id: "a", entries: [["bus/x", "f".repeat(4)]], none: null }),
    ).toBe('{"entries": [["bus/x", "ffff"]], "id": "a", "none": null, "state": "pending"}');
    expect(dumpsJson({ e: [], o: {}, n: 3, t: true, u: "café", b: 12345678901234567890n })).toBe(
      '{"b": 12345678901234567890, "e": [], "n": 3, "o": {}, "t": true, "u": "caf\\u00e9"}',
    );
    expect(dumpsJson({ kept: 1, skipped: undefined })).toBe('{"kept": 1}');
  });

  it("writes floats as Python's repr", () => {
    expect(dumpsJson([0.5, 123.456, 0.0001, 1793709296.5])).toBe(
      "[0.5, 123.456, 0.0001, 1793709296.5]",
    );
    // JavaScript writes these positionally or with a one-digit exponent.
    expect(dumpsJson([0.00001, 1.5e-7, -2.5e-5])).toBe("[1e-05, 1.5e-07, -2.5e-05]");
    expect(pyFloat(1.5e300)).toBe("1.5e+300");
  });
});

describe("unicodeDumps", () => {
  it("writes json.dumps(ensure_ascii=False) in insertion order", () => {
    expect(unicodeDumps({ b: ["é\n", 1, null, true], a: "\u007f" })).toBe(
      '{"b": ["é\\n", 1, null, true], "a": "\u007f"}',
    );
  });
});

describe("digest", () => {
  it("hashes the sorted ensure_ascii encoding", () => {
    expect(pyJsonDumps({ b: 1, a: "é" }, true)).toBe('{"a": "\\u00e9", "b": 1}');
    expect(digest({ b: 1, a: "é" })).toBe(digest({ a: "é", b: 1 }));
  });
});
