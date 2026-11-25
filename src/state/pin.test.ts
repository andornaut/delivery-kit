import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { pinMismatch } from "./pin.ts";

const LOADED = {
  cliSha256: "a".repeat(64),
  integrity: "sha512-loaded",
  sourceCommit: "c".repeat(40),
  version: "8.3.0",
};

describe("pinMismatch", () => {
  it("accepts an installation with the same version, bundle digest and integrity", () => {
    expect(pinMismatch(LOADED, { ...LOADED })).toBeUndefined();
    // The source commit is metadata, not part of the pin.
    expect(pinMismatch(LOADED, { ...LOADED, sourceCommit: null })).toBeUndefined();
  });

  it.each([{ version: "8.4.0" }, { cliSha256: "b".repeat(64) }, { integrity: null }])(
    "reports %j as a mismatch",
    (change) => {
      expect(pinMismatch(LOADED, { ...LOADED, ...change })).toBeDefined();
    },
  );

  it("describes both sides and keys the event by their descriptions", () => {
    const installed = { ...LOADED, cliSha256: null, integrity: null, version: "8.4.0" };
    const loaded = `8.3.0 (cli ${"a".repeat(12)}, integrity sha512-loaded)`;
    const other = "8.4.0 (cli missing, integrity missing)";
    expect(pinMismatch(LOADED, installed)).toEqual({
      detail:
        `Runner pin mismatch: loaded ${loaded}, installed ${other}; the runner finishes on the ` +
        "loaded code until a controlled idle replacement.",
      key: createHash("sha256").update(`${loaded} -> ${other}`).digest("hex"),
      logLine: `bus: pin mismatch: loaded ${loaded}, installed ${other}; finishing on the loaded code`,
    });
  });
});
