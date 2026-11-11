import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deployAfterCi } from "../deploy.ts";
import { depart, LOAD_RECHECK_SECONDS, LOAD_WAIT_SECONDS, requestStore } from "./departure.ts";
import type { Exec, ExecResult, ExecSpec } from "./exec.ts";
import { captureRequest } from "./requests.ts";
import {
  commitFile,
  type ContextParts,
  FAKE_WRANGLER,
  fakeExec,
  gateDocker,
  gitSync,
  makeGame,
  manualClock,
  mergeFastForward,
  mergeWithCommit,
  recordingEvents,
  testContext,
  type TestGame,
} from "./testGame.ts";

function originMain(test: TestGame): string {
  return gitSync(test.origin, "rev-parse", "main");
}

function setup(
  mode: "none" | "wrangler" = "none",
  gate: { noNodeModules?: boolean } = {},
  parts: Pick<ContextParts, "clock" | "load"> = {},
) {
  const test = makeGame((config) => {
    (config.deploy as Record<string, unknown>).mode = mode;
    delete (config.deploy as Record<string, unknown>).skipPattern;
  });
  const events = recordingEvents();
  const started: string[] = [];
  const failGate = { value: false };
  const dockerDown = { value: false };
  const wrangler = { status: 0 };
  const exec = fakeExec((spec) => {
    if (spec.command === process.execPath) {
      return { status: wrangler.status, stderr: "", stdout: "" };
    }
    if (dockerDown.value && spec.command === "docker" && spec.args[0] === "create") {
      return { status: 1, stderr: "Cannot connect to the Docker daemon\n", stdout: "" };
    }
    return gateDocker({
      ...gate,
      gate: () =>
        failGate.value
          ? { status: 1, stderr: "", stdout: "lint FAIL\n" }
          : { status: 0, stderr: "", stdout: "lint ok\n" },
    })(spec);
  });
  const context = testContext(test, {
    ...parts,
    events,
    exec,
    startCi: (sha) => started.push(sha),
  });
  const kinds = (): string[] => events.list.map(([kind]) => kind);
  const creates = (): number => exec.calls.filter((call) => call.args[0] === "create").length;
  return { context, creates, dockerDown, events, exec, failGate, kinds, started, test, wrangler };
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

  it("does not depart a HEAD that already equals the remote main", async () => {
    const { context, creates, events } = setup();
    expect(await depart(context)).toBe(0);
    expect(creates()).toBe(0);
    expect(events.list.map(([kind, , message]) => [kind, message])).toEqual([
      ["scheduled-status", expect.stringContaining("nothing new on main; no departure.")],
    ]);
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
    const { context, creates, events, failGate, kinds, test } = setup();
    const before = originMain(test);
    const broken = mergeFastForward(test, "broken");
    failGate.value = true;
    expect(await depart(context)).toBe(1);
    expect(originMain(test)).toBe(before);
    expect(readFileSync(join(test.game.busDir, "gate-failed", broken), "utf8")).toContain(
      "full-gate",
    );
    expect(kinds()).toContain("blocked-full-gate");
    const report = events.list.find(([kind]) => kind === "blocked-full-gate")?.[2] ?? "";
    expect(report).toContain("a fix merged on main is required");
    expect(report).not.toContain("operator fix");
    failGate.value = false;
    expect(await depart(context)).toBe(0);
    expect(creates()).toBe(1);
    const fixed = mergeFastForward(test, "fix");
    expect(await depart(context)).toBe(0);
    expect(originMain(test)).toBe(fixed);
    expect(gitSync(test.repo, "merge-base", "--is-ancestor", broken, fixed)).toBe("");
  });

  it("reports an unavailable Docker as blocked-gate, records nothing and gates again next time", async () => {
    const { context, creates, dockerDown, events, test } = setup();
    const head = mergeFastForward(test, "feature");
    dockerDown.value = true;
    expect(await depart(context)).toBe(1);
    expect(existsSync(join(test.game.busDir, "gate-failed"))).toBe(false);
    expect(events.list.at(-1)).toEqual([
      "blocked-gate",
      expect.any(String),
      expect.stringContaining("Cannot connect to the Docker daemon"),
    ]);
    expect(events.list.at(-1)?.[2]).toMatch(/the next departure gates it again\.$/);
    dockerDown.value = false;
    expect(await depart(context)).toBe(0);
    expect(creates()).toBe(2);
    expect(originMain(test)).toBe(head);
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
    expect(events.list.at(-1)?.[2]).toMatch(/Tech merges the remote main into local main\.$/);
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
    expect(await depart(context, { requestId: "r1" })).toBe(0);
    expect(originMain(test)).toBe(head);
    expect(kinds()).toEqual(["attempt", "push"]);
    await expect(captureRequest(requestStore(context), "r2")).rejects.toThrow(
      "nothing new to depart",
    );
    mergeFastForward(test, "next");
    await captureRequest(requestStore(context), "r3");
    mergeFastForward(test, "later");
    expect(await depart(context, { requestId: "r3" })).toBe(1);
    expect(
      JSON.parse(readFileSync(join(test.game.busDir, "requests", "r3.json"), "utf8")),
    ).toMatchObject({
      reason: "main moved since the request",
      state: "rejected",
    });
  });
});

describe("departures at high load", () => {
  // 03:00 America/Toronto: the fixture's scheduled departure slot. The fixture loadLimit is 24.
  const SLOT = 1_800_000_000;

  it("re-checks the load every minute and departs once it falls within the window", async () => {
    const clock = manualClock(SLOT);
    const checks: number[] = [];
    const load = (): number => {
      checks.push(clock.time - SLOT);
      return clock.time < SLOT + 5 * 60 ? 30 : 1;
    };
    const { context, creates, kinds, started, test } = setup("none", {}, { clock, load });
    const head = mergeFastForward(test, "feature");
    expect(await depart(context)).toBe(0);
    expect(checks).toEqual([0, 60, 120, 180, 240, 300]);
    expect(originMain(test)).toBe(head);
    expect(creates()).toBe(1);
    expect(started).toEqual([head]);
    expect(kinds()).toEqual(["scheduled-status", "attempt", "push"]);
    expect(context.lines).toContain(
      "2027-01-15 03:00 EST bus: load at or above 24; re-checking every 60 seconds until " +
        "2027-01-15 03:15 EST",
    );
  });

  it("skips the slot, main retained, when the load stays high for the whole window", async () => {
    const clock = manualClock(SLOT);
    let checks = 0;
    const load = (): number => {
      checks += 1;
      return 30;
    };
    const { context, creates, events, kinds, test } = setup("none", {}, { clock, load });
    const before = originMain(test);
    mergeFastForward(test, "feature");
    expect(await depart(context)).toBe(1);
    expect(clock.time).toBe(SLOT + LOAD_WAIT_SECONDS);
    expect(checks).toBe(LOAD_WAIT_SECONDS / LOAD_RECHECK_SECONDS + 1);
    expect(originMain(test)).toBe(before);
    expect(creates()).toBe(0);
    expect(kinds()).toEqual(["scheduled-status", "attempt", "blocked-load"]);
    expect(context.lines).toContain(
      "2027-01-15 03:00 EST bus: blocked at load: load at or above 24; main retained",
    );
    const report = events.list.at(-1)?.[2] ?? "";
    expect(report).toContain("blocked at load: load at or above 24; main retained");
    expect(report).toContain("this clears by itself");
    expect(report).not.toContain("operator fix");
  });

  it("holds every departure at a loadLimit of 0, after waiting out the window", async () => {
    const test = makeGame((config) => {
      (config.resources as Record<string, unknown>).loadLimit = 0;
    });
    const clock = manualClock(SLOT);
    const events = recordingEvents();
    const context = testContext(test, { clock, events, load: 0 });
    const before = originMain(test);
    mergeFastForward(test, "feature");
    expect(await depart(context)).toBe(1);
    expect(clock.time).toBe(SLOT + LOAD_WAIT_SECONDS);
    expect(originMain(test)).toBe(before);
    expect(events.list.at(-1)?.[0]).toBe("blocked-load");
    expect(events.list.at(-1)?.[2]).toContain("load at or above 0; main retained");
  });

  it("waits for a one-off request from the moment it starts", async () => {
    // Mid-hour, so a window measured from the 03:00 slot would already have closed.
    const start = SLOT + 30 * 60;
    const clock = manualClock(start);
    const load = (): number => (clock.time < start + 10 * 60 ? 30 : 1);
    const { context, kinds, test } = setup("none", {}, { clock, load });
    const head = mergeFastForward(test, "feature");
    await captureRequest(requestStore(context), "r1");
    expect(await depart(context, { requestId: "r1" })).toBe(0);
    expect(clock.time).toBe(start + 10 * 60);
    expect(originMain(test)).toBe(head);
    expect(kinds()).toEqual(["attempt", "push"]);
  });

  it("stops a load wait on shutdown without a blocked report", async () => {
    const clock = manualClock(SLOT);
    const shutdown = new AbortController();
    const load = (): number => {
      if (clock.time >= SLOT + 2 * 60) {
        shutdown.abort();
      }
      return 30;
    };
    const { context, creates, kinds, test } = setup("none", {}, { clock, load });
    const before = originMain(test);
    mergeFastForward(test, "feature");
    expect(await depart(context, { signal: shutdown.signal })).toBe(1);
    expect(clock.time).toBe(SLOT + 2 * 60);
    expect(originMain(test)).toBe(before);
    expect(creates()).toBe(0);
    expect(kinds()).toEqual(["scheduled-status", "attempt"]);
    expect(context.lines).toContain(
      "2027-01-15 03:00 EST bus: departure stopped by shutdown " +
        "(the load wait was stopped by a shutdown signal)",
    );
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
    // The deployment runs the Wrangler the gate installed, copied out of its container.
    expect(existsSync(join(work, "node_modules", FAKE_WRANGLER))).toBe(true);
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
    expect(exec.calls.find((call) => call.command === process.execPath)?.cwd).toBe(work);
    expect(existsSync(join(context.paths.deployDir, `${head}.completed`))).toBe(true);
    // The worktree is removed with the node_modules/ the gate copied into it.
    expect(existsSync(work)).toBe(false);
    expect(kinds()).toEqual(expect.arrayContaining(["deploy_retry", "deploy_success"]));
  });

  it("refuses to deploy when the gated worktree has no Wrangler and retains the pending deployment", async () => {
    const { context, exec, kinds, test } = setup("wrangler", { noNodeModules: true });
    const head = mergeFastForward(test, "feature");
    expect(await depart(context)).toBe(0);
    const work = readFileSync(context.paths.deployPending, "utf8").split("\n")[1] ?? "";
    expect(existsSync(join(work, "dist"))).toBe(true);
    ciStatus(test, head, "success");
    expect(await deployAfterCi(context, head)).toBe(false);
    expect(exec.calls.some((call) => call.command === process.execPath)).toBe(false);
    expect(context.lines).toContainEqual(
      expect.stringContaining(
        `deployment of ${head} refused: node_modules/wrangler/bin/wrangler.js is missing`,
      ),
    );
    expect(kinds()).toContain("deploy_failure");
    expect(kinds()).not.toContain("deploy_retry");
    expect(readFileSync(context.paths.deployPending, "utf8").split("\n")[0]).toBe(head);
    expect(existsSync(work)).toBe(true);
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

describe("shutdown", () => {
  function interruptible(test: TestGame, when: (spec: ExecSpec) => boolean, result: ExecResult) {
    const events = recordingEvents();
    const base = fakeExec(gateDocker());
    const exec: Exec = (spec) => (when(spec) ? Promise.resolve(result) : base(spec));
    return { context: testContext(test, { events, exec }), events };
  }
  const killed: ExecResult = { signal: "SIGTERM", status: null, stderr: "", stdout: "" };

  it("ends quietly when the shutdown signal kills ls-remote", async () => {
    const test = makeGame();
    mergeFastForward(test, "feature");
    const { context, events } = interruptible(
      test,
      (spec) => spec.args.includes("ls-remote"),
      killed,
    );
    expect(await depart(context)).toBe(1);
    expect(events.list).toEqual([]);
    expect(context.lines.at(-1)).toContain("departure stopped by shutdown");
  });

  it("still reports a genuine ls-remote failure", async () => {
    const test = makeGame();
    mergeFastForward(test, "feature");
    const failure: ExecResult = {
      status: 128,
      stderr: "fatal: unable to access remote",
      stdout: "",
    };
    const { context, events } = interruptible(
      test,
      (spec) => spec.args.includes("ls-remote"),
      failure,
    );
    expect(await depart(context)).toBe(1);
    expect(events.list.map(([kind]) => kind)).toEqual(["blocked-fetch"]);
  });

  it("records no gate failure when the shutdown signal stops the gate", async () => {
    const test = makeGame();
    const head = mergeFastForward(test, "feature");
    const gate = (spec: ExecSpec): boolean => spec.args.at(-1)?.startsWith("set -e") === true;
    const { context, events } = interruptible(test, gate, killed);
    expect(await depart(context)).toBe(1);
    expect(existsSync(join(test.game.busDir, "gate-failed", head))).toBe(false);
    expect(events.list.map(([kind]) => kind)).toEqual(["scheduled-status", "attempt"]);
    expect(originMain(test)).not.toBe(head);
  });
});
