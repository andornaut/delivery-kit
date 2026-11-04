import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deployAfterCi } from "../deploy.ts";
import { depart, requestStore } from "./departure.ts";
import { captureRequest } from "./requests.ts";
import {
  commitFile,
  fakeExec,
  gateDocker,
  gitSync,
  makeGame,
  mergeFastForward,
  mergeWithCommit,
  recordingEvents,
  testContext,
  type TestGame,
} from "./testGame.ts";

function originMain(test: TestGame): string {
  return gitSync(test.origin, "rev-parse", "main");
}

function setup(mode: "none" | "wrangler" = "none") {
  const test = makeGame((config) => {
    (config.deploy as Record<string, unknown>).mode = mode;
    delete (config.deploy as Record<string, unknown>).skipPattern;
  });
  const events = recordingEvents();
  const started: string[] = [];
  const failGate = { value: false };
  const wrangler = { status: 0 };
  const exec = fakeExec((spec) => {
    if (spec.command === process.execPath) {
      return { status: wrangler.status, stderr: "", stdout: "" };
    }
    return gateDocker({
      gate: () =>
        failGate.value
          ? { status: 1, stderr: "", stdout: "lint FAIL\n" }
          : { status: 0, stderr: "", stdout: "lint ok\n" },
    })(spec);
  });
  const context = testContext(test, { events, exec, startCi: (sha) => started.push(sha) });
  const kinds = (): string[] => events.list.map(([kind]) => kind);
  const creates = (): number => exec.calls.filter((call) => call.args[0] === "create").length;
  return { context, creates, events, exec, failGate, kinds, started, test, wrangler };
}

function ciStatus(test: TestGame, sha: string, value: string): void {
  const directory = join(test.game.busDir, "ci");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${sha}.status`), `${value}\n`);
}

describe("trunk-based departures", () => {
  it("gates and pushes a fast-forward main HEAD, then watches its CI", async () => {
    const { context, exec, kinds, started, test } = setup();
    const head = mergeFastForward(test, "feature");
    expect(await depart(context)).toBe(0);
    expect(originMain(test)).toBe(head);
    expect(readFileSync(context.paths.lastPushSha, "utf8")).toBe(`${head}\n`);
    expect(started).toEqual([head]);
    expect(kinds()).toEqual(["scheduled-status", "attempt", "push"]);
    const create = exec.calls.find((call) => call.args[0] === "create")?.args ?? [];
    expect(create[2]).toBe(`delivery-kit-gate-archies-dog-walks-${head.slice(0, 12)}`);
    expect(create).toContain(
      `type=bind,src=${join(test.game.busDir, `gate-${head}`)},dst=/src,readonly`,
    );
    expect(exec.calls.at(-1)?.args).toEqual(["rm", "--force", create[2]]);
    // The gate worktree was detached at HEAD and is gone after a push with no deployment.
    expect(existsSync(join(test.game.busDir, `gate-${head}`))).toBe(false);
    expect(gitSync(test.repo, "worktree", "list", "--porcelain")).not.toContain("gate-");
    expect(gitSync(test.repo, "rev-parse", "HEAD")).toBe(head);
    expect(gitSync(test.repo, "status", "--porcelain", "--untracked-files=no")).toBe("");
  });

  it("gates and pushes a merge-commit HEAD as it is", async () => {
    const { context, test } = setup();
    const head = mergeWithCommit(test, "feature");
    expect(gitSync(test.repo, "rev-list", "--parents", "-n", "1", head).split(" ")).toHaveLength(3);
    expect(await depart(context)).toBe(0);
    expect(originMain(test)).toBe(head);
  });

  it("does not depart an unchanged HEAD", async () => {
    const { context, creates, events, test } = setup();
    mergeFastForward(test, "feature");
    expect(await depart(context)).toBe(0);
    const before = events.list.length;
    expect(await depart(context)).toBe(0);
    expect(creates()).toBe(1);
    expect(events.list.slice(before).map(([kind, , message]) => [kind, message])).toEqual([
      ["scheduled-status", expect.stringContaining("nothing new on main; no departure.")],
    ]);
  });

  it("records a failed gate, never re-gates it and departs the fix merged next", async () => {
    const { context, creates, failGate, kinds, test } = setup();
    const before = originMain(test);
    const broken = mergeFastForward(test, "broken");
    failGate.value = true;
    expect(await depart(context)).toBe(1);
    expect(originMain(test)).toBe(before);
    expect(readFileSync(join(test.game.busDir, "gate-failed", broken), "utf8")).toContain(
      "full-gate",
    );
    expect(kinds()).toContain("blocked-full-gate");
    failGate.value = false;
    expect(await depart(context)).toBe(0);
    expect(creates()).toBe(1);
    const fixed = mergeFastForward(test, "fix");
    expect(await depart(context)).toBe(0);
    expect(originMain(test)).toBe(fixed);
    expect(gitSync(test.repo, "merge-base", "--is-ancestor", broken, fixed)).toBe("");
  });

  it("reports a non-fast-forward rejection and pushes nothing", async () => {
    const { context, events, test } = setup();
    // Someone else advanced the remote main with a commit this checkout does not have.
    const other = join(test.base, "other");
    execFileSync("git", ["clone", "-q", test.origin, other]);
    commitFile(other, "elsewhere.txt", "elsewhere\n");
    gitSync(other, "push", "-q", "origin", "main");
    const remote = originMain(test);
    mergeFastForward(test, "feature");
    expect(await depart(context)).toBe(1);
    expect(originMain(test)).toBe(remote);
    expect(events.list.at(-1)).toEqual([
      "blocked-push",
      expect.any(String),
      expect.stringContaining("non-fast-forward"),
    ]);
    expect(existsSync(join(test.game.busDir, "gate-failed"))).toBe(false);
  });

  it("departs a fix merged after red CI, with no repair approval", async () => {
    const { context, started, test } = setup();
    const red = mergeFastForward(test, "red");
    expect(await depart(context)).toBe(0);
    ciStatus(test, red, "failure");
    const fix = mergeFastForward(test, "fix");
    expect(await depart(context)).toBe(0);
    expect(originMain(test)).toBe(fix);
    expect(started).toEqual([red, fix]);
  });

  it("departs the current HEAD for a request and rejects one whose HEAD moved", async () => {
    const { context, kinds, test } = setup();
    const head = mergeFastForward(test, "feature");
    const receipt = await captureRequest(requestStore(context), "r1");
    expect(receipt).toBe(`{"head": "${head}", "id": "r1", "state": "pending"}\n`);
    expect(await depart(context, "r1")).toBe(0);
    expect(originMain(test)).toBe(head);
    expect(kinds()).toEqual(["attempt", "push"]);
    await expect(captureRequest(requestStore(context), "r2")).rejects.toThrow(
      "nothing new to depart",
    );
    mergeFastForward(test, "next");
    await captureRequest(requestStore(context), "r3");
    mergeFastForward(test, "later");
    expect(await depart(context, "r3")).toBe(1);
    expect(
      JSON.parse(readFileSync(join(test.game.busDir, "requests", "r3.json"), "utf8")),
    ).toMatchObject({
      reason: "main moved since the request",
      state: "rejected",
    });
  });

  it("holds main at high load", async () => {
    const test = makeGame();
    const events = recordingEvents();
    const context = testContext(test, { events, load: 30 });
    const before = originMain(test);
    mergeFastForward(test, "feature");
    expect(await depart(context)).toBe(1);
    expect(originMain(test)).toBe(before);
    expect(events.list.at(-1)?.[0]).toBe("blocked-load");
  });
});

describe("deployment after CI", () => {
  it("stages the deployment at push and deploys only when CI passes", async () => {
    const { context, exec, kinds, test } = setup("wrangler");
    const head = mergeFastForward(test, "feature");
    expect(await depart(context)).toBe(0);
    expect(exec.calls.some((call) => call.command === process.execPath)).toBe(false);
    const [pending, work = ""] = readFileSync(context.paths.deployPending, "utf8").split("\n");
    expect(pending).toBe(head);
    ciStatus(test, head, "success");
    expect(await deployAfterCi(context, head)).toBe(true);
    expect(exec.calls.find((call) => call.command === process.execPath)?.args).toEqual([
      "node_modules/wrangler/bin/wrangler.js",
      "deploy",
      "--config",
      "wrangler.jsonc",
      "--no-bundle",
      "--tag",
      head.slice(0, 8),
      "--message",
      `Scheduled bus ${head}`,
    ]);
    expect(existsSync(join(context.paths.deployDir, `${head}.completed`))).toBe(true);
    expect(existsSync(work)).toBe(false);
    expect(kinds()).toEqual(expect.arrayContaining(["deploy_retry", "deploy_success"]));
  });

  it("retries a failed deployment at the next departure and lets a newer push supersede it", async () => {
    const { context, test, wrangler } = setup("wrangler");
    const first = mergeFastForward(test, "first");
    expect(await depart(context)).toBe(0);
    ciStatus(test, first, "success");
    wrangler.status = 1;
    expect(await deployAfterCi(context, first)).toBe(false);
    wrangler.status = 0;
    expect(await depart(context)).toBe(0);
    expect(existsSync(join(context.paths.deployDir, `${first}.completed`))).toBe(true);
    const second = mergeFastForward(test, "second");
    expect(await depart(context)).toBe(0);
    const third = mergeFastForward(test, "third");
    expect(await depart(context)).toBe(0);
    expect(existsSync(join(context.paths.deployDir, `${second}.superseded`))).toBe(true);
    expect(readFileSync(context.paths.deployPending, "utf8").split("\n")[0]).toBe(third);
  });
});
