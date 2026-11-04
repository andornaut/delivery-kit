import { describe, expect, it } from "vitest";

import { eventRequestId, NAMESPACE_DNS, slotRequestId, uuid5 } from "../shared/ids.ts";
import { digest, pyJsonDumps } from "../shared/pyjson.ts";

describe("uuid5", () => {
  it("matches Python uuid.uuid5", () => {
    expect(uuid5(NAMESPACE_DNS, "python.org")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
    expect(slotRequestId("00000000-0000-4000-8000-000000000001", 1793556000)).toBe(
      "7aa61266-bcb0-5efd-8eb2-7738245eef18",
    );
  });

  it("derives distinct event IDs per recipient", () => {
    const one = eventRequestId("e".repeat(64), "00000000-0000-4000-8000-000000000001");
    const two = eventRequestId("e".repeat(64), "00000000-0000-4000-8000-000000000002");
    expect(one).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(one).not.toBe(two);
    expect(eventRequestId("e".repeat(64), "00000000-0000-4000-8000-000000000003")).toBe(
      "939aa124-f32b-5262-8edc-f49799b62766",
    );
  });
});

describe("pyJsonDumps", () => {
  it("matches json.dumps with sort_keys and ensure_ascii", () => {
    expect(pyJsonDumps({ a: 'x"\\\n\u0001', b: [1, "\u00e9\u2028", null, true] }, true)).toBe(
      '{"a": "x\\"\\\\\\n\\u0001", "b": [1, "\\u00e9\\u2028", null, true]}',
    );
    expect(pyJsonDumps("\u{1f600}")).toBe('"\\ud83d\\ude00"');
    expect(pyJsonDumps({ z: 1, a: 2 })).toBe('{"z": 1, "a": 2}');
    expect(pyJsonDumps({ z: 1, a: 2 }, true)).toBe('{"a": 2, "z": 1}');
  });

  it("digests canonical JSON", () => {
    expect(digest(["a", "b"])).toBe(
      "3554d2b8a1e34099053865de8576d1460b807430ec8c6b85315c9607ba93d308",
    );
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
    expect(() => pyJsonDumps(1.5)).toThrow();
  });
});
