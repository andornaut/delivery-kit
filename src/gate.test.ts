import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertContainerRules,
  fakeExec,
  gateDocker,
  makeGame,
  ok,
  testContext,
} from "./bus/testGame.ts";
import { bindMount } from "./container.ts";
import { gateScript, runGate, stepLogName } from "./gate.ts";

describe("gateScript", () => {
  it("runs steps in order, logs each and stops at the first failure", () => {
    const logs = mkdtempSync(join(tmpdir(), "gate-"));
    const script = gateScript([
      { name: "lint", run: "echo linted" },
      { name: "unit test", run: "echo failing >&2; false" },
      { name: "never", run: "echo never" },
    ])
      .replaceAll("/tmp/gate-logs", logs)
      .replace("cd /tmp/work", "cd /tmp");
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

describe("runGate", () => {
  function setup(fake: Parameters<typeof gateDocker>[0], leftovers = "") {
    const test = makeGame();
    const exec = fakeExec((spec) =>
      spec.args[0] === "ps" ? ok(leftovers) : gateDocker(fake)(spec),
    );
    const context = testContext(test, { exec });
    const logs = mkdtempSync(join(tmpdir(), "logs-"));
    const input = { batch: "batch-1", logs, sha: "a".repeat(40), work: test.repo };
    return { context, exec, input, logs, test };
  }
  const NAME = "delivery-kit-gate-archies-dog-walks-batch-1";
  const verbs = (exec: { calls: { args: readonly string[] }[] }) =>
    exec.calls.map((call) => call.args[0]);

  it("copies the exact commit in, logs and dist/ out, and removes the container", async () => {
    const { context, exec, input, logs, test } = setup({});
    expect(await runGate(context, input)).toEqual({ ok: true, output: "lint ok\ntest ok\n" });
    expect(readFileSync(join(logs, "01-lint.log"), "utf8")).toBe("linted\n");
    expect(readFileSync(join(test.repo, "dist", "index.js"), "utf8")).toBe("built\n");
    expect(existsSync(join(logs, "source.tar"))).toBe(false);
    expect(exec.calls.find((call) => call.args[0] === "cp")?.args).toEqual([
      "cp",
      join(logs, "source.tar"),
      `${NAME}:/tmp/source.tar`,
    ]);
    expect(exec.calls.at(-1)?.args).toEqual(["rm", "--force", NAME]);
  });

  it("removes the container after a failed install and copies no dist/", async () => {
    const { context, exec, input, test } = setup({
      install: () => ({ status: 1, stderr: "", stdout: "" }),
    });
    expect(await runGate(context, input)).toMatchObject({ ok: false, stage: "install" });
    expect(verbs(exec)).not.toContain("network");
    expect(existsSync(join(test.repo, "dist"))).toBe(false);
    expect(exec.calls.at(-1)?.args).toEqual(["rm", "--force", NAME]);
  });

  it("removes the container after a gate timeout", async () => {
    const { context, exec, input } = setup({
      gate: () => ({ status: null, stderr: "", stdout: "" }),
    });
    expect(await runGate(context, input)).toEqual({
      ok: false,
      reason: "gate TIMED OUT",
      stage: "full-gate",
    });
    expect(exec.calls.at(-1)?.args).toEqual(["rm", "--force", NAME]);
  });

  it("discards a gate that fails verification, copies no dist/ and removes the container", async () => {
    const { context, exec, input, test } = setup({});
    const outcome = await runGate(context, input, () => Promise.resolve("tree changed"));
    expect(outcome).toEqual({ ok: false, reason: "tree changed", stage: "full-gate" });
    expect(existsSync(join(test.repo, "dist"))).toBe(false);
    expect(exec.calls.at(-1)?.args).toEqual(["rm", "--force", NAME]);
  });

  it("removes containers a stopped runner left behind before creating its own", async () => {
    const { context, exec, input } = setup({}, "delivery-kit-gate-archies-dog-walks-batch-0\n");
    await runGate(context, input);
    expect(exec.calls[0]?.args).toEqual([
      "ps",
      "--all",
      "--filter",
      "label=delivery-kit-gate=archies-dog-walks",
      "--format",
      "{{.Names}}",
    ]);
    expect(exec.calls[1]?.args).toEqual([
      "rm",
      "--force",
      "delivery-kit-gate-archies-dog-walks-batch-0",
    ]);
    expect(exec.calls[2]?.args[0]).toBe("create");
  });

  it("refuses to run the steps while the container still has a network interface", async () => {
    const test = makeGame();
    const exec = fakeExec((spec) =>
      spec.args.at(-1)?.includes("/sys/class/net") === true
        ? { status: 1, stderr: "", stdout: "" }
        : gateDocker()(spec),
    );
    const context = testContext(test, { exec });
    const logs = mkdtempSync(join(tmpdir(), "logs-"));
    const outcome = await runGate(context, {
      batch: "batch-1",
      logs,
      sha: "a".repeat(40),
      work: test.repo,
    });
    expect(outcome).toMatchObject({ ok: false, stage: "full-gate" });
    expect(exec.calls.some((call) => call.args.at(-1)?.startsWith("set -e") === true)).toBe(false);
    expect(exec.calls.at(-1)?.args).toEqual(["rm", "--force", NAME]);
  });
});

describe("container rules", () => {
  it("reject a writable bind, -v and a container not run as uid 19001", () => {
    const docker = (...args: string[]) => ({ args, command: "docker" });
    expect(() =>
      assertContainerRules(docker("run", "--user", "19001:19001", "-e", "HOME=/tmp", "img")),
    ).not.toThrow();
    expect(() => assertContainerRules(docker("run", "-u", "1000:1000", "img"))).toThrow("19001");
    expect(() =>
      assertContainerRules(docker("exec", "x", "--mount", "type=bind,src=/a,dst=/b")),
    ).toThrow("writable bind mount");
    expect(() => assertContainerRules(docker("exec", "x", "-v", "/a:/b:ro"))).toThrow("--mount");
    expect(bindMount("/a", "/b")).toEqual(["--mount", "type=bind,src=/a,dst=/b,readonly"]);
  });
});
