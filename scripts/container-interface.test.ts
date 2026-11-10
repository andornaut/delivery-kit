import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkContext, testTargets, workerArguments } from "./container-check.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("container interface metadata", () => {
  it("reports the declared categories without Docker, and follows the same overridden task list", () => {
    for (const tasks of ["lint test build", "test", "build lint"]) {
      const result = spawnSync(
        "make",
        ["--no-print-directory", "check-info", `CHECK_TASKS=${tasks}`],
        {
          cwd: root,
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ version: 1, checks: tasks.split(" ") });
    }
  });

  it("rejects unknown and duplicate categories rather than advertising an inconsistent interface", () => {
    for (const tasks of ["lint invalid", "test test", ""]) {
      const result = spawnSync(
        "make",
        ["--no-print-directory", "check-info", `CHECK_TASKS=${tasks}`],
        {
          cwd: root,
          encoding: "utf8",
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('"version":1');
    }
  });

  it("keeps COMMAND and TEST_ARGS literal when Make exports them", () => {
    const scratch = mkdtempSync(join(tmpdir(), "make-literals-"));
    const commandMarker = join(scratch, "command-expanded");
    const testMarker = join(scratch, "test-expanded");
    const result = spawnSync(
      "make",
      [
        "--no-print-directory",
        "check-info",
        `COMMAND=$(shell touch ${commandMarker})`,
        `TEST_ARGS=$(shell touch ${testMarker})`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(commandMarker)).toBe(false);
    expect(existsSync(testMarker)).toBe(false);
  });
});

describe("test selection", () => {
  it("runs both unit and contract suites by default", () => {
    expect(testTargets([])).toEqual({ unit: [], contract: [] });
  });

  it("focuses source tests without accidentally starting the full contract suite", () => {
    expect(testTargets(["src/ci.test.ts", "--reporter=dot"])).toEqual({
      unit: ["src/ci.test.ts", "--reporter=dot"],
      contract: null,
    });
  });

  it("normalizes contract paths and preserves the supplied filter arguments", () => {
    expect(testTargets(["tests/contract/cases/smoke.test.ts", "--reporter=dot"])).toEqual({
      unit: null,
      contract: ["cases/smoke.test.ts", "--reporter=dot"],
    });
  });

  it("splits mixed file scopes without dropping either suite", () => {
    expect(testTargets(["scripts/guards.test.ts", "cases/smoke.test.ts"])).toEqual({
      unit: ["scripts/guards.test.ts"],
      contract: ["cases/smoke.test.ts"],
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

describe("formatter argv", () => {
  it("preserves argv literally and gives it precedence over shell COMMAND", () => {
    const scratch = mkdtempSync(join(tmpdir(), "formatter-argv-"));
    const output = join(scratch, "argv.json");
    const marker = join(scratch, "must-not-execute");
    const args = ["space in filename", `literal $(touch ${marker})`];
    const module = join(root, "scripts/container-check.ts");
    const writer =
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))";
    const invocation = [process.execPath, "-e", writer, output, ...args];
    const result = spawnSync(process.execPath, [module, "exec", ...invocation], {
      cwd: scratch,
      encoding: "utf8",
      env: { ...process.env, CHECK_WRITABLE: "1", COMMAND: `touch ${marker}` },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(args);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("snapshot provenance", () => {
  it("preserves dirty snapshot identity without converting the revision into a clean source claim", () => {
    expect(
      checkContext({
        CHECK_REVISION: "a".repeat(40),
        CHECK_SOURCE_SHA256: "b".repeat(64),
        CHECK_SOURCE_DIRTY: "true",
      }),
    ).toEqual({
      CHECK_REVISION: "a".repeat(40),
      CHECK_SOURCE_SHA256: "b".repeat(64),
      CHECK_SOURCE_DIRTY: true,
    });
  });

  it("rejects missing or malformed revision, archive hash and dirty state", () => {
    const valid = {
      CHECK_REVISION: "a".repeat(40),
      CHECK_SOURCE_SHA256: "b".repeat(64),
      CHECK_SOURCE_DIRTY: "false",
    };
    for (const changes of [
      { CHECK_REVISION: "main" },
      { CHECK_SOURCE_SHA256: "missing" },
      { CHECK_SOURCE_DIRTY: "unknown" },
    ]) {
      expect(() => checkContext({ ...valid, ...changes })).toThrow(/provenance/);
    }
    expect(() => checkContext({})).toThrow(/provenance/);
  });

  it("refuses existing package proof destinations before building or overwriting them", () => {
    const module = join(root, "scripts/container-check.ts");
    for (const target of ["scratch/package-proof", ".claude/release-output"]) {
      const fixture = mkdtempSync(join(tmpdir(), "check-output-"));
      mkdirSync(join(fixture, "tests/contract"), { recursive: true });
      mkdirSync(join(fixture, "scratch"));
      mkdirSync(join(fixture, target), { recursive: true });
      const marker = join(fixture, target, "retained");
      writeFileSync(marker, "unchanged");
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { runChecks } from ${JSON.stringify(module)}; process.exitCode = runChecks(['build']);`,
        ],
        {
          cwd: fixture,
          encoding: "utf8",
          env: {
            ...process.env,
            TMPDIR: join(fixture, "scratch"),
            CHECK_REVISION: "a".repeat(40),
            CHECK_SOURCE_SHA256: "b".repeat(64),
            CHECK_SOURCE_DIRTY: "true",
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("snapshot package proof output already exists");
      expect(readFileSync(marker, "utf8")).toBe("unchanged");
    }
  });
});
