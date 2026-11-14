import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { testTargets, workerArguments } from "./check.ts";
import { checkContext, inspectionContext } from "./package-check.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("test selection", () => {
  it("focuses source tests without accidentally starting the full contract suite", () => {
    expect(testTargets(["src/ci.test.ts", "--reporter=dot"])).toEqual({
      unit: ["src/ci.test.ts", "--reporter=dot"],
      contract: null,
    });
  });

  it("caps workers by default, honours smaller counts and rejects larger or percentage counts", () => {
    expect(workerArguments([])).toEqual(["--maxWorkers=4"]);
    expect(workerArguments(["--maxWorkers", "2"])).toEqual(["--maxWorkers", "2"]);
    for (const args of [
      ["--maxWorkers=5"],
      ["--maxWorkers=50%"],
      ["--maxWorkers"],
      ["--minWorkers", "0"],
    ]) {
      expect(() => workerArguments(args)).toThrow(/one to four/);
    }
  });
});

describe("native argv", () => {
  it("passes whitespace and shell-shaped filenames literally without a shell command", () => {
    const scratch = mkdtempSync(join(tmpdir(), "native-argv-"));
    const output = join(scratch, "argv.json"),
      marker = join(scratch, "must-not-execute");
    const args = ["space in filename", `literal $(touch ${marker})`];
    const writer =
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))";
    const module = join(root, "scripts/check.ts");
    const program = `import { run } from ${JSON.stringify(module)}; run(${JSON.stringify(
      scratch,
    )}, process.execPath, ${JSON.stringify(["-e", writer, output, ...args])});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: scratch,
      encoding: "utf8",
      env: { ...process.env, COMMAND: `touch ${marker}` },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(args);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("package inspection provenance", () => {
  const valid = {
    CHECK_REVISION: "a".repeat(40),
    CHECK_SOURCE_SHA256: "b".repeat(64),
    CHECK_SOURCE_DIRTY: "true",
  };

  it("preserves dirty snapshot identity without making an immutable commit claim", () => {
    expect(checkContext(valid)).toEqual({ ...valid, CHECK_SOURCE_DIRTY: true });
    expect(inspectionContext(valid)).toMatchObject({
      kind: "snapshot-package-inspection",
      immutableCommitClaim: false,
      CHECK_SOURCE_DIRTY: true,
    });
    expect(inspectionContext({ ...valid, CHECK_SOURCE_DIRTY: "false" }).immutableCommitClaim).toBe(
      false,
    );
  });

  it("rejects missing or malformed snapshot fields rather than silently losing identity", () => {
    for (const changes of [
      { CHECK_REVISION: "main" },
      { CHECK_SOURCE_SHA256: "missing" },
      { CHECK_SOURCE_DIRTY: "unknown" },
    ]) {
      expect(() => checkContext({ ...valid, ...changes })).toThrow(/provenance/);
    }
    expect(() => checkContext({})).toThrow(/provenance/);
    expect(() => inspectionContext({ CHECK_SOURCE_DIRTY: "true" })).toThrow(/provenance/);
  });
});
