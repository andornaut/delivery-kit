import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validPackArgs } from "./guards.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "guards-"));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

describe("validPackArgs", () => {
  it("requires an exact SHA and a new absolute directory", () => {
    const sha = "0".repeat(40);
    expect(validPackArgs([sha, join(root, "out")])).toBe(true);
    expect(validPackArgs([sha, root])).toBe(false);
    expect(validPackArgs([sha, "relative/out"])).toBe(false);
    expect(validPackArgs(["0".repeat(39), join(root, "out")])).toBe(false);
    expect(validPackArgs([sha])).toBe(false);
    expect(validPackArgs([sha, join(root, "out"), "extra"])).toBe(false);
  });
});
