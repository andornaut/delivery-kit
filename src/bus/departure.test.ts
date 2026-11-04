import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { depart, requestStore } from "./departure.ts";
import { captureRequest } from "./requests.ts";
import {
  commitFile,
  fakeExec,
  gateDocker,
  gitSync,
  makeGame,
  queueBranch,
  recordingEvents,
  testContext,
  type TestGame,
} from "./testGame.ts";

function originMain(test: TestGame): string {
  return gitSync(test.origin, "rev-parse", "main");
}

function setup(mode: "none" | "wrangler" = "none") {
  return makeGame((config) => {
    (config.deploy as Record<string, unknown>).mode = mode;
    delete (config.deploy as Record<string, unknown>).skipPattern;
  });
}

describe("depart", () => {
  it("gates, pushes the exact batch, records last-push and starts CI", async () => {
    const test = setup();
    queueBranch(test, "bus/feature");
    const events = recordingEvents();
    const exec = fakeExec(gateDocker());
    const started: string[] = [];
    const context = testContext(test, { events, exec, startCi: (sha) => started.push(sha) });
    expect(await depart(context)).toBe(0);
    const pushed = originMain(test);
    expect(readFileSync(context.paths.lastPushSha, "utf8")).toBe(`${pushed}\n`);
    expect(gitSync(test.origin, "show", "--name-only", "--format=", "main")).toBe(
      "bus-feature.txt",
    );
    expect(started).toEqual([pushed]);
    expect(readFileSync(context.paths.queue, "utf8")).toBe("");
    expect(events.list.map(([kind]) => kind)).toEqual(["scheduled-status", "attempt", "push"]);
    expect(gitSync(test.repo, "branch", "--list", "bus/feature")).toBe("");
    const docker = exec.calls.map((call) => call.args);
    const name = docker.find((args) => args[0] === "create")?.[2] ?? "";
    expect(name).toMatch(/^delivery-kit-gate-archies-dog-walks-batch-\d+$/);
    const create = docker.find((args) => args[0] === "create") ?? [];
    expect(create).toEqual(
      expect.arrayContaining(["--label", "game-bus=owner/game", "node:24.21.0"]),
    );
    expect(create).toContain("type=volume,src=delivery-kit-npm-archies-dog-walks,dst=/var/tmp");
    // The only bind is the scratch worktree, read-only, read through its group.
    const binds = create.filter((arg) => arg.startsWith("type=bind"));
    expect(binds).toEqual([
      expect.stringMatching(/^type=bind,src=.*\/bus\/batch-\d+,dst=\/src,readonly$/),
    ]);
    const verbs = docker.map((args) => args.slice(0, 2).join(" "));
    expect(verbs.indexOf("network disconnect")).toBeGreaterThan(
      verbs.findIndex((verb) => verb.startsWith("exec")),
    );
    expect(docker.at(-1)).toEqual(["rm", "--force", name]);
    expect(context.lines.some((line) => line.endsWith("merged"))).toBe(true);
  });

  it("reports nothing waiting for an empty queue and blocks no push", async () => {
    const test = setup();
    const events = recordingEvents();
    const context = testContext(test, { events });
    const before = originMain(test);
    expect(await depart(context)).toBe(0);
    expect(originMain(test)).toBe(before);
    expect(events.list).toEqual([
      [
        "scheduled-status",
        expect.any(String),
        expect.stringContaining("scheduled slot: queue empty; no new batch is queued."),
      ],
    ]);
  });

  it("retains the queue at high load and reports the blocked stage", async () => {
    const test = setup();
    queueBranch(test, "bus/feature");
    const events = recordingEvents();
    const context = testContext(test, { events, load: 30 });
    expect(await depart(context)).toBe(1);
    expect(readFileSync(context.paths.queue, "utf8")).toBe("bus/feature\n");
    expect(events.list.at(-1)?.[0]).toBe("blocked-load");
  });

  it("keeps the queue and pushes nothing while the last push has red CI", async () => {
    const test = setup();
    queueBranch(test, "bus/feature");
    const context = testContext(test);
    const red = originMain(test);
    writeFileSync(context.paths.lastPushSha, `${red}\n`);
    mkdirSync(context.paths.ciDir, { recursive: true });
    writeFileSync(join(context.paths.ciDir, `${red}.status`), "failure\n");
    expect(await depart(context)).toBe(1);
    expect(originMain(test)).toBe(red);
    expect(context.lines).toContain(`bus: previous push ${red} has failing CI; queue retained`);
  });

  it("does not push a failed gate and keeps the batch branch", async () => {
    const test = setup();
    queueBranch(test, "bus/feature");
    const events = recordingEvents();
    const exec = fakeExec(
      gateDocker({ gate: () => ({ status: 1, stderr: "", stdout: "lint FAIL\n" }) }),
    );
    const context = testContext(test, { events, exec });
    const before = originMain(test);
    expect(await depart(context)).toBe(1);
    expect(originMain(test)).toBe(before);
    expect(events.list.map(([kind]) => kind)).toEqual(
      expect.arrayContaining(["blocked-full-gate", "blocked-batch"]),
    );
    expect(gitSync(test.repo, "branch", "--list", "batch-*")).not.toBe("");
  });

  it("skips a conflicting branch and lands the rest", async () => {
    const test = setup();
    queueBranch(test, "bus/a", "same.txt");
    gitSync(test.repo, "checkout", "-q", "-b", "bus/b", "main");
    commitFile(test.repo, "same.txt", "different\n");
    gitSync(test.repo, "checkout", "-q", "main");
    writeFileSync(join(test.game.busDir, "bus-queue"), "bus/b\n", { flag: "a" });
    const events = recordingEvents();
    const context = testContext(test, { events, exec: fakeExec(gateDocker()) });
    expect(await depart(context)).toBe(0);
    expect(events.list.map(([kind]) => kind)).toContain("conflict-bus/b");
    expect(gitSync(test.repo, "branch", "--list", "bus/b")).not.toBe("");
  });

  it("integrates a request's pinned tips and retains a branch advanced during the batch", async () => {
    const test = setup();
    queueBranch(test, "bus/feature");
    const exec = fakeExec((spec) => {
      if (spec.args.at(-1)?.startsWith("set -e") === true) {
        gitSync(test.repo, "checkout", "-q", "bus/feature");
        commitFile(test.repo, "later.txt", "later\n");
        gitSync(test.repo, "checkout", "-q", "main");
      }
      return gateDocker()(spec);
    });
    const events = recordingEvents();
    const context = testContext(test, { events, exec });
    await captureRequest(requestStore(context), "r1");
    expect(await depart(context, "r1")).toBe(0);
    expect(gitSync(test.origin, "show", "--name-only", "--format=", "main")).toBe(
      "bus-feature.txt",
    );
    expect(gitSync(test.repo, "branch", "--list", "bus/feature")).not.toBe("");
    expect(events.list[0]).toEqual([
      "attempt",
      "request-r1",
      expect.stringContaining("user-authorized one-off request r1: bus/feature;"),
    ]);
  });

  it("deploys gated assets through Wrangler and records the deployment", async () => {
    const test = setup("wrangler");
    queueBranch(test, "bus/feature");
    const events = recordingEvents();
    const exec = fakeExec(gateDocker());
    const context = testContext(test, { events, exec });
    expect(await depart(context)).toBe(0);
    const sha = originMain(test);
    const wrangler = exec.calls.find((call) => call.command === process.execPath);
    expect(wrangler?.args).toEqual([
      "node_modules/wrangler/bin/wrangler.js",
      "deploy",
      "--config",
      "wrangler.jsonc",
      "--no-bundle",
      "--tag",
      sha.slice(0, 8),
      "--message",
      `Scheduled bus ${sha}`,
    ]);
    expect(readFileSync(context.paths.lastDeploySha, "utf8")).toBe(`${sha}\n`);
    expect(existsSync(join(context.paths.deployDir, `${sha}.completed`))).toBe(true);
    expect(events.list.map(([kind]) => kind)).toEqual(
      expect.arrayContaining(["deploy_retry", "deploy_success"]),
    );
  });

  it("retains a failed deployment and retries it at the next departure", async () => {
    const test = setup("wrangler");
    queueBranch(test, "bus/feature");
    let wranglerStatus = 1;
    const exec = fakeExec((spec) =>
      spec.command === process.execPath
        ? { status: wranglerStatus, stderr: "", stdout: "" }
        : gateDocker()(spec),
    );
    const events = recordingEvents();
    const context = testContext(test, { events, exec });
    expect(await depart(context)).toBe(0);
    const sha = originMain(test);
    const [pendingSha, work] = readFileSync(context.paths.deployPending, "utf8").split("\n");
    expect(pendingSha).toBe(sha);
    expect(existsSync(join(work ?? "", ".bus-built.sha"))).toBe(true);
    expect(events.list.map(([kind]) => kind)).toContain("deploy_failure");
    wranglerStatus = 0;
    expect(await depart(context)).toBe(0);
    expect(existsSync(context.paths.deployPending)).toBe(false);
    expect(existsSync(work ?? "")).toBe(false);
    expect(events.list.map(([kind]) => kind)).toContain("deploy_success");
  });
});
