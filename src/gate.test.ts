import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ExecResult } from "./bus/exec.ts";
import {
  assertContainerRules,
  commitFile,
  FAKE_WRANGLER,
  fakeExec,
  gateDocker,
  gitSync,
  makeGame,
  mergeWithCommit,
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
});

describe("runGate", () => {
  function setup(fake: Parameters<typeof gateDocker>[0], leftovers = "", memoryMiB = 4096) {
    const test = makeGame((config) => {
      config.resources!.memoryMiB = memoryMiB;
    });
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
    const { context, exec, input, logs, test } = setup({}, "", 2305);
    expect(await runGate(context, input)).toEqual({ ok: true, output: "lint ok\ntest ok\n" });
    expect(readFileSync(join(logs, "01-lint.log"), "utf8")).toBe("linted\n");
    expect(readFileSync(join(test.repo, "dist", "index.js"), "utf8")).toBe("built\n");
    expect(existsSync(join(test.repo, "node_modules", FAKE_WRANGLER))).toBe(true);
    const copies = exec.calls.filter((call) => call.args[0] === "cp").map((call) => call.args[2]);
    expect(copies).toEqual([
      expect.stringMatching(/delivery-gate-identity-.*\/identity\.tar$/u),
      `${NAME}:/tmp/gate-logs/.`,
      `${NAME}:/tmp/work/dist/.`,
      `${NAME}:/tmp/work/node_modules/.`,
    ]);
    const create = exec.calls.find((call) => call.args[0] === "create")?.args ?? [];
    expect(create).toEqual(
      expect.arrayContaining([
        "--group-add",
        String(statSync(test.repo).gid),
        expect.stringMatching(
          /type=bind,src=.*delivery-gate-identity-.*\/copied,dst=\/src,readonly/u,
        ),
      ]),
    );
    expect(create[create.indexOf("--memory") + 1]).toBe("2305m");
    expect(create[create.indexOf("--cpus") + 1]).toBe("4");
    const tree = gitSync(test.repo, "rev-parse", "HEAD^{tree}");
    const copy = exec.calls.find((call) => call.args.includes(`EXPECTED_TREE=${tree}`))?.args ?? [];
    expect(copy.at(-1)).toContain('test "$actual" = "$EXPECTED_TREE"');
    expect(
      exec.calls.filter((call) => call.args[0] === "cp" && call.args[2]?.endsWith("identity.tar")),
    ).toHaveLength(1);
    const identityCheck = exec.calls.find((call) =>
      call.args.some((arg) => arg.startsWith("EXPECTED_COMMIT=")),
    );
    expect(identityCheck?.args.at(-1)).not.toContain("node ");
    expect(exec.calls.at(-1)?.args).toEqual(["rm", "--force", NAME]);
  });

  it("provides the real shallow merge HEAD and clean tree before install and every gate category", async () => {
    let expected = "";
    let tree = "";
    let parent = "";
    const seen: string[] = [];
    const inspect = (work: string): ExecResult => {
      expect(gitSync(work, "rev-parse", "HEAD")).toBe(expected);
      expect(gitSync(work, "rev-parse", "HEAD^{tree}")).toBe(tree);
      expect(gitSync(work, "write-tree")).toBe(tree);
      expect(gitSync(work, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
      expect(gitSync(work, "rev-list", "--count", "HEAD")).toBe("1");
      expect(
        spawnSync("git", ["-C", work, "cat-file", "-e", parent], { stdio: "ignore" }).status,
      ).not.toBe(0);
      expect(readFileSync(join(work, ".git", "config"), "utf8")).not.toContain("remote");
      expect(readFileSync(join(work, ".git", "config"), "utf8")).not.toContain("worktree");
      expect(readFileSync(join(work, " leading.txt"), "utf8")).toBe("leading filename\n");
      seen.push(work);
      return ok();
    };
    const test = setup({ install: inspect, gate: inspect });
    commitFile(test.test.repo, " leading.txt", "leading filename\n");
    parent = gitSync(test.test.repo, "rev-parse", "HEAD");
    expected = mergeWithCommit(test.test, "identity-topic");
    tree = gitSync(test.test.repo, "rev-parse", "HEAD^{tree}");
    test.input.sha = expected;
    expect(await runGate(test.context, test.input)).toEqual({ ok: true, output: "" });
    expect(seen).toHaveLength(2);
    expect(gitSync(test.test.repo, "rev-parse", "HEAD")).toBe(expected);
    expect(gitSync(test.test.repo, "rev-list", "--count", "HEAD")).toBe("5");
  });

  it("rejects an ignored unknown store before any source-bound container exists", async () => {
    const test = setup({});
    commitFile(test.test.repo, ".gitignore", ".private-store/\n");
    test.input.sha = gitSync(test.test.repo, "rev-parse", "HEAD");
    const store = join(test.test.repo, ".private-store");
    mkdirSync(store, { mode: 0o000 });
    const outcome = await runGate(test.context, test.input);
    expect(outcome).toMatchObject({
      ok: false,
      failure: "infrastructure",
      reason: "gate source contains a path outside the approved tracked inventory",
    });
    expect(verbs(test.exec)).not.toContain("create");
    expect(verbs(test.exec)).not.toContain("start");
    expect(test.exec.calls.some((call) => call.args.includes("sh"))).toBe(false);
  });

  it("mounts only verified source staging without any original Git metadata", async () => {
    const test = makeGame();
    let inspected = false;
    const exec = fakeExec((spec) => {
      if (spec.args[0] === "create") {
        const mount = spec.args.find((arg) => arg.endsWith("dst=/src,readonly"));
        const path = /src=([^,]+)/u.exec(mount ?? "")?.[1];
        expect(path).toBeDefined();
        expect(path).not.toBe(test.repo);
        expect(lstatSync(path!).isDirectory()).toBe(true);
        expect(existsSync(join(path!, ".git"))).toBe(false);
        expect(readdirSync(path!).sort()).toEqual(["README.md", "delivery-kit.json"]);
        inspected = true;
      }
      return gateDocker()(spec);
    });
    expect(
      await runGate(testContext(test, { exec }), {
        departure: "masked",
        work: test.repo,
        sha: gitSync(test.repo, "rev-parse", "HEAD"),
        logs: mkdtempSync(join(tmpdir(), "logs-")),
      }),
    ).toMatchObject({ ok: true });
    expect(inspected).toBe(true);
  });

  it("ignores inherited image Git redirections and injected configuration during source proof", async () => {
    const test = setup({
      environment: {
        GIT_DIR: "/missing/foreign-git",
        GIT_WORK_TREE: "/missing/foreign-work",
        GIT_COMMON_DIR: "/missing/common",
        GIT_INDEX_FILE: "/missing/index",
        GIT_OBJECT_DIRECTORY: "/missing/objects",
        GIT_ALTERNATE_OBJECT_DIRECTORIES: "/missing/alternates",
        GIT_SHALLOW_FILE: "/missing/shallow",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.worktree",
        GIT_CONFIG_VALUE_0: "/missing/injected",
      },
    });
    expect(await runGate(test.context, test.input)).toMatchObject({ ok: true });
  });

  it("refuses an unknown Git cleanliness result instead of treating empty stdout as clean", async () => {
    const bin = mkdtempSync(join(tmpdir(), "gate-git-"));
    const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$1" = status ]; then exit 1; fi\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    );
    const test = setup({ environment: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
    expect(await runGate(test.context, test.input)).toMatchObject({
      ok: false,
      failure: "infrastructure",
      reason: expect.stringContaining("gate source identity validation failed"),
    });
    expect(test.exec.calls.some((call) => call.args.at(-1)?.includes("npm ci"))).toBe(false);
  });

  it("refuses a source whose current HEAD differs from the selected exact commit", async () => {
    const test = setup({});
    commitFile(test.test.repo, "README.md", "new source\n");
    expect(await runGate(test.context, test.input)).toMatchObject({
      ok: false,
      failure: "infrastructure",
      reason: "source HEAD mismatch",
    });
    expect(verbs(test.exec)).not.toContain("create");
  });

  it("rejects a changed container source after the independent copy-tree check", async () => {
    const test = setup({
      afterCopy: (work) => writeFileSync(join(work, "README.md"), "changed copy\n"),
    });
    expect(await runGate(test.context, test.input)).toMatchObject({
      ok: false,
      failure: "infrastructure",
      reason: expect.stringContaining("gate source identity validation failed"),
    });
    expect(test.exec.calls.some((call) => call.args.at(-1)?.includes("npm ci"))).toBe(false);
    expect(readFileSync(join(test.test.repo, "README.md"), "utf8")).toBe("game\n");
  });

  it("refuses categories when install changes the copied tracked source", async () => {
    let installedWork = "";
    let ranCategory = false;
    const test = setup({
      install: (work) => {
        installedWork = work;
        writeFileSync(join(work, "README.md"), "install changed source\n");
        return ok();
      },
      gate: () => {
        ranCategory = true;
        return ok();
      },
    });
    expect(await runGate(test.context, test.input)).toMatchObject({
      ok: false,
      failure: "infrastructure",
      reason: expect.stringContaining("gate source identity validation failed"),
    });
    expect(ranCategory).toBe(false);
    expect(installedWork).not.toBe("");
    expect(readFileSync(join(test.test.repo, "README.md"), "utf8")).toBe("game\n");
    expect(
      test.exec.calls.filter((call) => call.args.some((arg) => arg.startsWith("EXPECTED_COMMIT="))),
    ).toHaveLength(2);
  });

  it("refuses an install that hides changed tracked bytes with an index flag", async () => {
    let ranCategory = false;
    const test = setup({
      install: (work) => {
        gitSync(work, "update-index", "--assume-unchanged", "README.md");
        writeFileSync(join(work, "README.md"), "hidden install change\n");
        expect(gitSync(work, "status", "--porcelain=v1")).toBe("");
        return ok();
      },
      gate: () => {
        ranCategory = true;
        return ok();
      },
    });
    expect(await runGate(test.context, test.input)).toMatchObject({
      ok: false,
      failure: "infrastructure",
      reason: expect.stringContaining("gate source identity validation failed"),
    });
    expect(ranCategory).toBe(false);
    expect(readFileSync(join(test.test.repo, "README.md"), "utf8")).toBe("game\n");
  });

  it("rejects dirty source before image exposure and leaves the original files dirty", async () => {
    const test = setup({});
    writeFileSync(join(test.test.repo, "README.md"), "uncommitted change\n");
    expect(await runGate(test.context, test.input)).toMatchObject({
      ok: false,
      failure: "infrastructure",
      reason: "gate source identity copy is dirty",
    });
    expect(verbs(test.exec)).not.toContain("create");
    expect(gitSync(test.test.repo, "status", "--porcelain")).toContain("M README.md");
    expect(gitSync(test.test.repo, "diff", "--cached", "--name-only")).toBe("");
    expect(test.exec.calls.some((call) => call.args.at(-1)?.includes("npm ci"))).toBe(false);
  });

  it("rejects a corrupted binary metadata transfer before extraction and install", async () => {
    const test = makeGame();
    const exec = fakeExec((spec) => {
      if (spec.args[0] === "cp" && spec.args[3]?.endsWith(":/tmp/gate-source-identity.tar")) {
        const archive = spec.args[2]!;
        const bytes = readFileSync(archive);
        bytes[0] = bytes[0]! ^ 1;
        writeFileSync(archive, bytes);
      }
      return gateDocker()(spec);
    });
    expect(
      await runGate(testContext(test, { exec }), {
        departure: "identity",
        work: test.repo,
        sha: gitSync(test.repo, "rev-parse", "HEAD"),
        logs: mkdtempSync(join(tmpdir(), "logs-")),
      }),
    ).toMatchObject({
      ok: false,
      failure: "infrastructure",
      reason: expect.stringContaining("gate source identity validation failed"),
    });
    expect(exec.calls.some((call) => call.args.at(-1)?.includes("npm ci"))).toBe(false);
  });

  it("retains the existing image tool contract without requiring Node for identity transfer", async () => {
    const test = makeGame();
    const exec = fakeExec((spec) =>
      spec.args.at(-1)?.includes("for tool in git tar ls tail")
        ? { status: 3, stdout: "git\n", stderr: "" }
        : gateDocker()(spec),
    );
    expect(
      await runGate(testContext(test, { exec }), {
        departure: "identity",
        work: test.repo,
        sha: gitSync(test.repo, "rev-parse", "HEAD"),
        logs: mkdtempSync(join(tmpdir(), "logs-")),
      }),
    ).toMatchObject({
      ok: false,
      failure: "infrastructure",
      reason: expect.stringContaining("it needs sh, git, tar, ls, tail"),
    });
    expect(exec.calls.some((call) => call.args.at(-1)?.includes("npm ci"))).toBe(false);
  });

  it.each(["identity-archive", "identity-verification"])(
    "stops before install on %s transfer failure and removes the container",
    async (stage) => {
      const test = makeGame();
      const exec = fakeExec((spec) => {
        if (
          (stage === "identity-archive" &&
            spec.args[0] === "cp" &&
            spec.args[3]?.endsWith(":/tmp/gate-source-identity.tar")) ||
          (stage === "identity-verification" &&
            spec.args[0] === "exec" &&
            spec.args.some((arg) => arg.startsWith("EXPECTED_COMMIT=")))
        ) {
          return { status: 1, stdout: "", stderr: "fixture transfer failed" };
        }
        return gateDocker()(spec);
      });
      expect(
        await runGate(testContext(test, { exec }), {
          departure: "identity",
          work: test.repo,
          sha: gitSync(test.repo, "rev-parse", "HEAD"),
          logs: mkdtempSync(join(tmpdir(), "logs-")),
        }),
      ).toMatchObject({ ok: false, failure: "infrastructure" });
      expect(exec.calls.some((call) => call.args.at(-1)?.includes("npm ci"))).toBe(false);
      expect(exec.calls.at(-1)?.args).toEqual([
        "rm",
        "--force",
        "delivery-kit-gate-archies-dog-walks-identity",
      ]);
    },
  );

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

  it.each([
    ["npm error code E504", "infrastructure"],
    ["npm error code E404", "step"],
  ])("classifies a failed install logging %s as %s", async (line, failure) => {
    const { context, input } = setup({ install: () => ({ status: 1, stderr: "", stdout: "" }) });
    writeFileSync(join(input.logs, "install.log"), `${line}\nnpm error 504 Gateway Time-out\n`);
    expect(await runGate(context, input)).toMatchObject({ failure, ok: false });
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
      expect.stringMatching(/delivery-gate-identity-.*\/identity\.tar$/u),
      `${NAME}:/tmp/gate-logs/.`,
    ]);
    expect(exec.calls.at(-1)?.args).toEqual(["rm", "--force", NAME]);
  });

  it("verifies the tree before any output is copied into it", async () => {
    const { context, exec, input, test } = setup({});
    const seen: boolean[] = [];
    let stage = "";
    const verify = () => {
      const mount = exec.calls
        .find((call) => call.args[0] === "create")
        ?.args.find((arg) => arg.endsWith("dst=/src,readonly"));
      stage = /src=([^,]+)/u.exec(mount ?? "")?.[1] ?? "";
      expect(existsSync(stage)).toBe(true);
      seen.push(existsSync(join(test.repo, "dist")), existsSync(join(test.repo, "node_modules")));
      return Promise.resolve(undefined);
    };
    expect(await runGate(context, input, verify)).toMatchObject({ ok: true });
    expect(seen).toEqual([false, false]);
    expect(existsSync(join(test.repo, "node_modules", FAKE_WRANGLER))).toBe(true);
    expect(existsSync(stage)).toBe(false);
  });

  it("retains approved staging if container removal fails instead of deleting a live mount", async () => {
    const test = makeGame();
    let stage = "";
    const exec = fakeExec((spec) => {
      if (spec.args[0] === "create") {
        const mount = spec.args.find((arg) => arg.endsWith("dst=/src,readonly"));
        stage = /src=([^,]+)/u.exec(mount ?? "")?.[1] ?? "";
      }
      if (spec.args[0] === "rm") {
        return { status: 1, stdout: "", stderr: "fixture removal failed" };
      }
      return gateDocker()(spec);
    });
    const context = testContext(test, { exec });
    expect(
      await runGate(context, {
        departure: "cleanup",
        work: test.repo,
        sha: gitSync(test.repo, "rev-parse", "HEAD"),
        logs: mkdtempSync(join(tmpdir(), "logs-")),
      }),
    ).toMatchObject({
      ok: false,
      failure: "infrastructure",
      reason: "gate container removal failed; approved source stage retained",
    });
    expect(existsSync(stage)).toBe(true);
    expect(context.lines.some((line) => line.includes("approved source stage retained"))).toBe(
      true,
    );
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
