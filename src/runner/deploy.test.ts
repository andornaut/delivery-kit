import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { holdLock } from "@andornaut/coordination-kit/build/shared";
import { describe, expect, it } from "vitest";

import { type ExecResult, Interrupted, spawnExec, WRANGLER_ENTRY } from "../lib/exec.ts";
import { readDeliveryControl } from "../state/control.ts";
import { ciStatusFile, writeLines } from "../state/paths.ts";
import { lockHeld } from "../status/locks.ts";
import {
  commitFile,
  gitSync,
  makeGame,
  ok,
  recordingEvents,
  testContext,
} from "../testing/game.ts";
import {
  deployAfterCi,
  readPending,
  retryDeploy,
  stageDeploy,
  withDeliveryRunner,
} from "./deploy.ts";

const failed: ExecResult = { status: 1, stderr: "temporarily unavailable", stdout: "" };

function setup(deploy: () => ExecResult | Promise<ExecResult> = () => ok()) {
  const test = makeGame();
  const sha = gitSync(test.repo, "rev-parse", "main");
  const events = recordingEvents();
  const wranglerCalls: (string | undefined)[] = [];
  const remote = { result: ok(`${sha}\trefs/heads/main\n`) };
  const context = testContext(test, {
    events,
    exec: async (spec) => {
      if (spec.command === process.execPath) {
        wranglerCalls.push(spec.cwd);
        return deploy();
      }
      if (spec.args[2] === "ls-remote") {
        return remote.result;
      }
      return spawnExec(spec);
    },
  });
  const gated = (head: string) => {
    const work = join(context.paths.dir, `gate-${head}`);
    gitSync(test.repo, "worktree", "add", "-q", "--detach", work, head);
    const entry = join(work, WRANGLER_ENTRY);
    mkdirSync(dirname(entry), { recursive: true });
    mkdirSync(join(work, "dist"));
    writeFileSync(entry, "// fixture Wrangler\n");
    writeLines(join(work, ".bus-built.sha"), head);
    return { sha: head, work };
  };
  const pending = gated(sha);
  mkdirSync(context.paths.ciDir, { recursive: true });
  writeLines(ciStatusFile(context.paths, sha), "success");
  return { context, events, gated, pending, remote, test, wranglerCalls };
}

describe("pending deployment lifecycle", () => {
  it.each([false, true])(
    "shares a failed attempt with an overlapping trigger (retry first: %s)",
    async (retryFirst) => {
      const entered = Promise.withResolvers<void>();
      const deploy = Promise.withResolvers<ExecResult>();
      const { context, events, pending, wranglerCalls } = setup(() => {
        entered.resolve();
        return deploy.promise;
      });
      await stageDeploy(context, pending, true);

      const ci = () => deployAfterCi(context, pending.sha);
      const scheduled = () => withDeliveryRunner(context, () => retryDeploy(context));
      const first = retryFirst ? scheduled() : ci();
      await entered.promise;
      const second = retryFirst ? ci() : scheduled();
      deploy.resolve(failed);

      await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
      expect(wranglerCalls).toEqual([pending.work]);
      expect(events.list.filter(([kind]) => kind === "deploy_retry")).toHaveLength(1);
      expect(readPending(context)).toEqual(pending);
      expect(existsSync(pending.work)).toBe(true);

      await expect(scheduled()).resolves.toBe(false);
      expect(wranglerCalls).toEqual([pending.work, pending.work]);
    },
  );

  it("preserves the completed record and newer pending worktree when staging overlaps CI deploy", async () => {
    const entered = Promise.withResolvers<void>();
    const deploy = Promise.withResolvers<ExecResult>();
    const { context, gated, pending, remote, test, wranglerCalls } = setup(() => {
      entered.resolve();
      return deploy.promise;
    });
    await stageDeploy(context, pending, true);
    const next = gated(commitFile(test.repo, "next.txt", "next\n"));

    const first = deployAfterCi(context, pending.sha);
    await entered.promise;
    remote.result = ok(`${next.sha}\trefs/heads/main\n`);
    const stage = stageDeploy(context, next, true);
    const stale = deployAfterCi(context, pending.sha);
    deploy.resolve(ok());

    await expect(Promise.all([first, stage, stale])).resolves.toEqual([true, undefined, false]);
    expect(wranglerCalls).toEqual([pending.work]);
    const completed = join(context.paths.deployDir, `${pending.sha}.completed`);
    expect(readFileSync(completed, "utf8")).toBe(`${pending.sha}\n${pending.work}\n`);
    expect(readPending(context)).toEqual(next);
    expect(existsSync(pending.work)).toBe(false);
    expect(existsSync(next.work)).toBe(true);
  });

  it("deploys after CI while a departure holds its lock", async () => {
    const { context, pending, wranglerCalls } = setup();
    await stageDeploy(context, pending, true);
    const departure = holdLock(context.paths.departureLock, { nonBlocking: true });
    try {
      await expect(deployAfterCi(context, pending.sha)).resolves.toBe(true);
      expect(wranglerCalls).toEqual([pending.work]);
    } finally {
      departure.release();
    }
  });

  it("holds a direct caller's singleton while an overlapping deployment remains active", async () => {
    const entered = Promise.withResolvers<void>();
    const deploy = Promise.withResolvers<ExecResult>();
    const { context, pending } = setup(() => {
      entered.resolve();
      return deploy.promise;
    });
    await stageDeploy(context, pending, true);
    const directExit = Promise.withResolvers<void>();
    const direct = withDeliveryRunner(context, () => directExit.promise);

    const ci = deployAfterCi(context, pending.sha);
    await entered.promise;
    directExit.resolve();
    await direct;
    try {
      expect(lockHeld(context.paths.runnerLock)).toBe(true);
      expect(lockHeld(context.paths.loopLock)).toBe(true);
    } finally {
      deploy.resolve(ok());
      await ci;
    }
    expect(lockHeld(context.paths.runnerLock)).toBe(false);
    expect(lockHeld(context.paths.loopLock)).toBe(false);
  });

  it("records a remote lookup failure and retries the retained deployment later", async () => {
    const { context, events, pending, remote, wranglerCalls } = setup();
    await stageDeploy(context, pending, true);
    const healthy = remote.result;
    remote.result = failed;

    await expect(retryDeploy(context)).resolves.toBe(false);
    expect(readPending(context)).toEqual(pending);
    expect(existsSync(pending.work)).toBe(true);
    expect(wranglerCalls).toEqual([]);
    expect(context.lines).toContainEqual(expect.stringContaining("remote main lookup failed"));
    expect(events.list).toEqual([
      ["deploy_failure", pending.sha, expect.stringContaining("retained pending assets")],
    ]);
    expect(readDeliveryControl({ dir: context.paths.dir }).lastFailure?.sha).toBe(pending.sha);

    remote.result = healthy;
    await expect(retryDeploy(context)).resolves.toBe(true);
    expect(wranglerCalls).toEqual([pending.work]);
    expect(readPending(context)).toBeUndefined();
  });

  it("propagates an interrupted remote lookup and releases the lifecycle lock", async () => {
    const { context, events, pending, remote, wranglerCalls } = setup();
    await stageDeploy(context, pending, true);
    const healthy = remote.result;
    remote.result = { signal: "SIGTERM", status: null, stderr: "", stdout: "" };

    await expect(deployAfterCi(context, pending.sha)).rejects.toBeInstanceOf(Interrupted);
    expect(readPending(context)).toEqual(pending);
    expect(wranglerCalls).toEqual([]);
    expect(events.list).toEqual([]);
    expect(readDeliveryControl({ dir: context.paths.dir }).lastFailure).toBeNull();

    remote.result = healthy;
    await expect(retryDeploy(context)).resolves.toBe(true);
  });
});
