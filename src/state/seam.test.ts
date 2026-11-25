import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { coordinatorCliReport } from "./seam.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("coordinatorCliReport", () => {
  it("reports nothing seen without a readable seam record", () => {
    const empty = { distSha256: null, seenAt: null, supported: null, version: null };
    const root = mkdtempSync(join(tmpdir(), "seam-"));
    roots.push(root);
    expect(coordinatorCliReport(join(root, "seam.json"))).toEqual(empty);
  });
});
