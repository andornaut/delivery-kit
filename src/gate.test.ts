import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ExecResult } from "./bus/exec.ts";
import {
  assertContainerRules,
  FAKE_WRANGLER,
  fakeExec,
  gateDocker,
  gitSync,
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
    const input = {
      departure: "departure-1",
      logs,
      sha: gitSync(test.repo, "rev-parse", "HEAD"),
      work: test.repo,
    };
    return { context, exec, input, logs, test };
  }
  const NAME = "delivery-kit-gate-archies-dog-walks-departure-1";
  const verbs = (exec: { calls: { args: readonly string[] }[] }) =>
    exec.calls.map((call) => call.args[0]);

  it("copies the exact commit in, logs, dist/ and node_modules/ out, and removes the container", async () => {
    const { context, exec, input, logs, test } = setup({});
    expect(await runGate(context, input)).toEqual({ ok: true, output: "lint ok\ntest ok\n" });
    expect(readFileSync(join(logs, "01-lint.log"), "utf8")).toBe("linted\n");
    expect(readFileSync(join(test.repo, "dist", "index.js"), "utf8")).toBe("built\n");
    expect(existsSync(join(test.repo, "node_modules", FAKE_WRANGLER))).toBe(true);
    const copies = exec.calls.filter((call) => call.args[0] === "cp").map((call) => call.args[2]);
    expect(copies).toEqual([
      `${NAME}:/tmp/gate-logs/.`,
      `${NAME}:/tmp/work/dist/.`,
      `${NAME}:/tmp/work/node_modules/.`,
    ]);
    const create = exec.calls.find((call) => call.args[0] === "create")?.args ?? [];
    expect(create).toEqual(
      expect.arrayContaining([
        "--group-add",
        String(statSync(test.repo).gid),
        `type=bind,src=${test.repo},dst=/src,readonly`,
      ]),
    );
    const tree = gitSync(test.repo, "rev-parse", "HEAD^{tree}");
    const copy = exec.calls.find((call) => call.args.includes(`EXPECTED_TREE=${tree}`))?.args ?? [];
    expect(copy.at(-1)).toContain('test "$actual" = "$EXPECTED_TREE"');
    expect(
      exec.calls.some(
        (call) => call.args[0] === "cp" && !call.args.some((arg) => arg.startsWith(NAME)),
      ),
    ).toBe(false);
    expect(exec.calls.at(-1)?.args).toEqual(["rm", "--force", NAME]);
  });

  it("removes the container when the copied tree is not the departure commit", async () => {
    const test = makeGame();
    const exec = fakeExec((spec) =>
      spec.args.some((arg) => arg.startsWith("EXPECTED_TREE="))
        ? { status: 4, stderr: "", stdout: "" }
        : gateDocker()(spec),
    );
    const context = testContext(test, { exec });
    const logs = mkdtempSync(join(tmpdir(), "logs-"));
    const outcome = await runGate(context, {
      departure: "departure-1",
      logs,
      sha: gitSync(test.repo, "rev-parse", "HEAD"),
      work: test.repo,
    });
    expect(outcome).toEqual({
      failure: "infrastructure",
      ok: false,
      reason: "gate container copy of the checkout does not match the departure commit",
    });
    expect(exec.calls.some((call) => call.args.at(-1)?.includes("npm ci") === true)).toBe(false);
    expect(exec.calls.at(-1)?.args).toEqual(["rm", "--force", NAME]);
  });

  const DOCKER_FAILURES: readonly [string, ExecResult, string][] = [
    [
      "create",
      { status: 1, stderr: "Error: No such image: node:24\n", stdout: "" },
      "docker create of the gate container failed: Error: No such image: node:24",
    ],
    [
      "start",
      { status: 1, stderr: "", stdout: "" },
      "docker start of the gate container failed: exit 1",
    ],
    [
      "network",
      { status: 1, stderr: "Error: network bridge not found\n", stdout: "" },
      "docker network disconnect failed: Error: network bridge not found",
    ],
  ];
  it("reports a failed docker create, start or network detach as an infrastructure failure", async () => {
    for (const [verb, result, reason] of DOCKER_FAILURES) {
      const test = makeGame();
      const exec = fakeExec((spec) => (spec.args[0] === verb ? result : gateDocker()(spec)));
      const context = testContext(test, { exec });
      // eslint-disable-next-line no-await-in-loop
      const outcome = await runGate(context, {
        departure: "departure-1",
        logs: mkdtempSync(join(tmpdir(), "logs-")),
        sha: gitSync(test.repo, "rev-parse", "HEAD"),
        work: test.repo,
      });
      expect(outcome, verb).toEqual({ failure: "infrastructure", ok: false, reason });
      const ranSteps = exec.calls.some((call) => call.args.at(-1)?.startsWith("set -e") === true);
      expect(ranSteps, verb).toBe(false);
      expect(exec.calls.at(-1)?.args, verb).toEqual(["rm", "--force", NAME]);
    }
  });

  it("names the tool the gate image lacks", async () => {
    const test = makeGame();
    const exec = fakeExec((spec) =>
      spec.args.some((arg) => arg.startsWith("EXPECTED_TREE="))
        ? { status: 3, stderr: "", stdout: "tail\n" }
        : gateDocker()(spec),
    );
    const context = testContext(test, { exec });
    const outcome = await runGate(context, {
      departure: "departure-1",
      logs: mkdtempSync(join(tmpdir(), "logs-")),
      sha: gitSync(test.repo, "rev-parse", "HEAD"),
      work: test.repo,
    });
    expect(outcome).toMatchObject({ failure: "infrastructure", ok: false });
    expect(outcome.ok ? "" : outcome.reason).toBe(
      `the gate image ${context.config.gate.image} has no tail; it needs sh, git, tar, ls, tail`,
    );
  });

  it("reports a Docker error around the gate steps and a failed output copy as infrastructure", async () => {
    const gone = setup({ gate: () => ({ status: 125, stderr: "daemon gone\n", stdout: "" }) });
    expect(await runGate(gone.context, gone.input)).toEqual({
      failure: "infrastructure",
      ok: false,
      reason: "docker exec of the gate steps failed: daemon gone",
    });
    const test = makeGame();
    const exec = fakeExec((spec) =>
      spec.args[0] === "cp" && spec.args.some((arg) => arg.endsWith(":/tmp/work/dist/."))
        ? { status: 1, stderr: "no space left on device\n", stdout: "" }
        : gateDocker()(spec),
    );
    const outcome = await runGate(testContext(test, { exec }), {
      departure: "departure-1",
      logs: mkdtempSync(join(tmpdir(), "logs-")),
      sha: gitSync(test.repo, "rev-parse", "HEAD"),
      work: test.repo,
    });
    expect(outcome).toEqual({
      failure: "infrastructure",
      ok: false,
      reason: "docker cp of dist/ failed: no space left on device",
    });
  });

  it("removes the container after a failed install and copies no dist/ or node_modules/", async () => {
    const { context, exec, input, test } = setup({
      install: () => ({ status: 1, stderr: "", stdout: "" }),
    });
    expect(await runGate(context, input)).toMatchObject({
      failure: "step",
      ok: false,
      stage: "install",
    });
    expect(verbs(exec)).not.toContain("network");
    expect(existsSync(join(test.repo, "dist"))).toBe(false);
    expect(existsSync(join(test.repo, "node_modules"))).toBe(false);
    expect(exec.calls.at(-1)?.args).toEqual(["rm", "--force", NAME]);
  });

  it("copies no dist/ or node_modules/ out of a failed gate", async () => {
    const { context, exec, input, test } = setup({
      gate: () => ({ status: 1, stderr: "", stdout: "test FAIL\n" }),
    });
    expect(await runGate(context, input)).toMatchObject({
      failure: "step",
      ok: false,
      stage: "full-gate",
    });
    expect(existsSync(join(test.repo, "dist"))).toBe(false);
    expect(existsSync(join(test.repo, "node_modules"))).toBe(false);
    expect(exec.calls.filter((call) => call.args[0] === "cp").map((call) => call.args[2])).toEqual([
      `${NAME}:/tmp/gate-logs/.`,
    ]);
    expect(exec.calls.at(-1)?.args).toEqual(["rm", "--force", NAME]);
  });

  it("verifies the tree before any output is copied into it", async () => {
    const { context, input, test } = setup({});
    const seen: boolean[] = [];
    const verify = () => {
      seen.push(existsSync(join(test.repo, "dist")), existsSync(join(test.repo, "node_modules")));
      return Promise.resolve(undefined);
    };
    expect(await runGate(context, input, verify)).toMatchObject({ ok: true });
    expect(seen).toEqual([false, false]);
    expect(existsSync(join(test.repo, "node_modules", FAKE_WRANGLER))).toBe(true);
  });

  it("copies dist/ alone when the gate container has no node_modules/", async () => {
    const { context, input, test } = setup({ noNodeModules: true });
    expect(await runGate(context, input)).toMatchObject({ ok: true });
    expect(existsSync(join(test.repo, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(test.repo, "node_modules"))).toBe(false);
  });

  it("removes the container after a gate timeout", async () => {
    const { context, exec, input } = setup({
      gate: () => ({ status: null, stderr: "", stdout: "" }),
    });
    expect(await runGate(context, input)).toEqual({
      failure: "step",
      ok: false,
      reason: "gate TIMED OUT",
      stage: "full-gate",
    });
    expect(exec.calls.at(-1)?.args).toEqual(["rm", "--force", NAME]);
  });

  it("discards a gate that fails verification, copies no outputs and removes the container", async () => {
    const { context, exec, input, test } = setup({});
    const outcome = await runGate(context, input, () => Promise.resolve("tree changed"));
    expect(outcome).toEqual({ failure: "infrastructure", ok: false, reason: "tree changed" });
    expect(existsSync(join(test.repo, "dist"))).toBe(false);
    expect(existsSync(join(test.repo, "node_modules"))).toBe(false);
    expect(exec.calls.at(-1)?.args).toEqual(["rm", "--force", NAME]);
  });

  it("removes containers a stopped runner left behind before creating its own", async () => {
    const { context, exec, input } = setup({}, "delivery-kit-gate-archies-dog-walks-departure-0\n");
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
      "delivery-kit-gate-archies-dog-walks-departure-0",
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
      departure: "departure-1",
      logs,
      sha: gitSync(test.repo, "rev-parse", "HEAD"),
      work: test.repo,
    });
    expect(outcome).toEqual({
      failure: "infrastructure",
      ok: false,
      reason: "gate container still has a network interface; gate not run",
    });
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
    const dir = mkdtempSync(join(tmpdir(), "bind-"));
    const bind = `type=bind,src=${dir},dst=/src,readonly`;
    const run = ["run", "--user", "19001:19001", "-e", "HOME=/tmp", "--mount", bind, "img"];
    expect(() => assertContainerRules(docker(...run))).toThrow("--group-add");
    expect(() =>
      assertContainerRules(docker(...run, "--group-add", String(statSync(dir).gid))),
    ).not.toThrow();
    expect(bindMount("/a", "/b")).toEqual(["--mount", "type=bind,src=/a,dst=/b,readonly"]);
  });
});
