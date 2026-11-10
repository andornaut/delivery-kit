import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { testTargets, workerArguments } from "./check.ts";
import { checkContext, inspectionContext } from "./package-check.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("native check interface", () => {
  it("keeps native npm checks independent of Make and Docker", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const name of ["build", "check", "lint", "test", "verify", "contract", "package:check"]) {
      expect(manifest.scripts[name], name).not.toMatch(/\b(?:make|docker)\b/);
    }
    for (const file of ["scripts/check.ts", "scripts/contract.ts", "scripts/package-check.ts"]) {
      expect(readFileSync(join(root, file), "utf8"), file).not.toMatch(
        /(?:run|spawnSync)\([^;]*["'](?:make|docker)["']/,
      );
    }
  });

  it("exposes only check as the public Make target", () => {
    const makefile = readFileSync(join(root, "Makefile"), "utf8");
    const targets = [...makefile.matchAll(/^([a-z][a-z-]*):(?:\s|$)/gm)].map((match) => match[1]);
    expect(targets).toEqual(["check"]);
    expect(makefile).toContain("./tests/container/run check");
    expect(makefile).not.toContain("check-info");
  });

  it("uses ordinary serial lint-staged and direct local formatters", () => {
    expect(readFileSync(join(root, ".husky/pre-commit"), "utf8")).toBe(
      "npx lint-staged --concurrent false\n",
    );
    const config = JSON.parse(readFileSync(join(root, ".lintstagedrc"), "utf8"));
    expect(config["*"]).toBe("prettier --write --ignore-unknown");
    expect(config["*.{js,mjs}"]).toBe("eslint --fix --max-warnings 0");
    expect(existsSync(join(root, "tests/container/staged"))).toBe(false);
    expect(existsSync(join(root, "tests/container/staged-git"))).toBe(false);
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

  it("supports native inspection without inventing a commit or source hash", () => {
    expect(inspectionContext({})).toEqual({
      kind: "snapshot-package-inspection",
      immutableCommitClaim: false,
    });
  });
});
