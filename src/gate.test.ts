import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { gateScript, stepLogName } from "./gate.ts";

describe("gateScript", () => {
  it("runs steps in order, logs each and stops at the first failure", () => {
    const logs = mkdtempSync(join(tmpdir(), "gate-"));
    const script = gateScript([
      { name: "lint", run: "echo linted" },
      { name: "unit test", run: "echo failing >&2; false" },
      { name: "never", run: "echo never" },
    ]).replaceAll("/gate-logs", logs);
    const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("lint ok\nunit test FAIL\nfailing\n");
    expect(readFileSync(join(logs, "01-lint.log"), "utf8")).toBe("linted\n");
    expect(stepLogName(2, "unit test")).toBe("02-unit_test.log");
  });

  it("quotes step names and keeps commands verbatim", () => {
    expect(gateScript([{ name: "it's", run: "npm test -- --maxWorkers=4" }])).toContain(
      `printf "%s " 'it'\\''s'; { npm test -- --maxWorkers=4; }`,
    );
  });
});
