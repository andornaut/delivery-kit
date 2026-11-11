import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { watchCi } from "../ci.ts";
import { deployAfterCi } from "../deploy.ts";
import { lockIsFree } from "../lock.ts";
import { deliverScheduledWake } from "../review/wake.ts";
import { readDeliveryControl, setDesiredDelivery } from "./control.ts";
import { depart, requestStore } from "./departure.ts";
import { captureRequest, claimRequest } from "./requests.ts";
import { runRunner } from "./runner.ts";
import {
  fakeExec,
  gateDocker,
  gitSync,
  makeGame,
  manualClock,
  mergeFastForward,
  ok,
  testContext,
} from "./testGame.ts";

vi.mock("../ci.ts", async (original) => ({
  ...(await original<typeof import("../ci.ts")>()),
  watchCi: vi.fn(() => Promise.resolve("success")),
}));
vi.mock("../review/wake.ts", () => ({
  deliverScheduledWake: vi.fn(() => Promise.resolve("delivered")),
}));
vi.mock("./requests.ts", async (original) => {
  const actual = await original<typeof import("./requests.ts")>();
  return { ...actual, claimRequest: vi.fn(actual.claimRequest) };
});

afterEach(() => vi.clearAllMocks());

function desired(dir: string, state: "enabled" | "paused"): void {
  setDesiredDelivery({ dir }, { reason: "operator test", requester: "game-dev", state });
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (condition()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error("runner did not reach the expected state");
}

function runnerFile(base: string): string {
  const file = join(base, "cli.js");
  writeFileSync(file, "loaded test build");
  return file;
}

describe("delivery admission", () => {
  it("blocks a direct paused departure before retry, remote reads or gate work", async () => {
    const test = makeGame();
    const head = mergeFastForward(test, "feature");
    const context = testContext(test, { exec: vi.fn(() => Promise.resolve(ok())) });
    desired(test.game.busDir, "paused");
    writeFileSync(context.paths.deployPending, `${head}\n/retained\n`);
    expect(await depart(context)).toBe(1);
    expect(context.exec).not.toHaveBeenCalled();
    expect(readDeliveryControl({ dir: test.game.busDir }).desired.state).toBe("paused");
  });

  it.each(["missing", "invalid"])("blocks %s control without enabling it", async (kind) => {
    const test = makeGame();
    const path = join(test.game.busDir, "delivery-control.json");
    if (kind === "missing") {
      unlinkSync(path);
    } else {
      writeFileSync(path, "invalid\n");
    }
    const context = testContext(test, { exec: vi.fn(() => Promise.resolve(ok())) });
    expect(await depart(context)).toBe(1);
    expect(context.exec).not.toHaveBeenCalled();
    expect(() => readDeliveryControl({ dir: test.game.busDir })).toThrow();
  });

  it("finishes an admitted gate and push after pause, then blocks the next departure", async () => {
    const test = makeGame((config) => {
      config.deploy!.mode = "none";
    });
    const head = mergeFastForward(test, "feature");
    const docker = gateDocker();
    let paused = false;
    const exec = fakeExec((spec) => {
      if (spec.command === "docker" && spec.args[0] === "create") {
        desired(test.game.busDir, "paused");
        paused = true;
      }
      return docker(spec);
    });
    const context = testContext(test, { exec });
    expect(await depart(context)).toBe(0);
    expect(paused).toBe(true);
    expect(gitSync(test.origin, "rev-parse", "main")).toBe(head);
    const before = exec.calls.length;
    mergeFastForward(test, "next");
    expect(await depart(context)).toBe(1);
    expect(exec.calls).toHaveLength(before);
  });

  it("retains the exact failed gate SHA in durable observation", async () => {
    const test = makeGame();
    const head = mergeFastForward(test, "feature");
    const context = testContext(test, {
      exec: fakeExec(gateDocker({ gate: () => ({ status: 1, stderr: "", stdout: "failed" }) })),
    });
    expect(await depart(context)).toBe(1);
    expect(readDeliveryControl({ dir: test.game.busDir }).observed).toMatchObject({
      sha: head,
      state: "failed",
      updatedAt: expect.any(String),
    });
  });
});

describe("paused resident runner", () => {
  it("records a fatal loop failure and stops backgrounds before releasing singleton locks", async () => {
    const test = makeGame();
    const context = testContext(test);
    mkdirSync(context.paths.requestsDir, { recursive: true });
    writeFileSync(join(context.paths.requestsDir, "broken.json"), "invalid\n");
    await expect(
      runRunner(
        {
          cliPath: runnerFile(test.base),
          signal: new AbortController().signal,
        },
        () => context,
      ),
    ).rejects.toThrow(SyntaxError);
    expect(readDeliveryControl({ dir: test.game.busDir }).observed?.state).toBe("failed");
    expect(lockIsFree(context.paths.runnerLock)).toBe(true);
    expect(lockIsFree(context.paths.loopLock)).toBe(true);
  });

  it("honours a reservation when pause occurs before the request is claimed", async () => {
    const test = makeGame((config) => {
      config.deploy!.mode = "none";
    });
    const head = mergeFastForward(test, "feature");
    const context = testContext(test, { exec: fakeExec(gateDocker()) });
    await captureRequest(requestStore(context), "race");
    vi.mocked(claimRequest).mockImplementationOnce(async (store) => {
      const record = readDeliveryControl({ dir: test.game.busDir });
      expect(Object.keys(record.activities)).toHaveLength(1);
      desired(test.game.busDir, "paused");
      const actual = await vi.importActual<typeof import("./requests.ts")>("./requests.ts");
      return actual.claimRequest(store);
    });
    const stop = new AbortController();
    const running = runRunner(
      { cliPath: runnerFile(test.base), signal: stop.signal },
      () => context,
    );
    try {
      await until(() =>
        readFileSync(join(context.paths.requestsDir, "race.json"), "utf8").includes('"finished"'),
      );
      expect(gitSync(test.origin, "rev-parse", "main")).toBe(head);
      expect(readDeliveryControl({ dir: test.game.busDir }).desired.state).toBe("paused");
    } finally {
      stop.abort();
      await running;
    }
  });

  it("keeps requests pending across scheduled slots and restart, then serves them on resume", async () => {
    const test = makeGame((config) => {
      config.deploy!.mode = "none";
    });
    const head = mergeFastForward(test, "feature");
    desired(test.game.busDir, "paused");
    const clock = manualClock(Date.UTC(2026, 10, 9, 21, 19, 55) / 1000);
    const exec = fakeExec(gateDocker());
    const context = testContext(test, { clock, exec });
    await captureRequest(requestStore(context), "pending");
    const path = join(context.paths.requestsDir, "pending.json");
    const initial = readFileSync(path, "utf8");
    const cliPath = runnerFile(test.base);
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const stop = new AbortController();
      const start = clock.now();
      const running = runRunner({ cliPath, signal: stop.signal }, () => context);
      try {
        // eslint-disable-next-line no-await-in-loop
        await until(() => clock.now() > start + 4000);
        expect(readFileSync(path, "utf8")).toBe(initial);
        expect(
          exec.calls.some((call) => call.command === "docker" && call.args[0] === "create"),
        ).toBe(false);
      } finally {
        stop.abort();
        // eslint-disable-next-line no-await-in-loop
        await running;
      }
      expect(readDeliveryControl({ dir: test.game.busDir }).observed?.state).toBe("stopped");
    }
    expect(deliverScheduledWake).toHaveBeenCalled();
    desired(test.game.busDir, "enabled");
    const stop = new AbortController();
    const running = runRunner({ cliPath, signal: stop.signal }, () => context);
    try {
      await until(() => readFileSync(path, "utf8").includes('"finished"'));
      expect(gitSync(test.origin, "rev-parse", "main")).toBe(head);
    } finally {
      stop.abort();
      await running;
    }
  });

  it("keeps observing missing control and adopts explicit initialization without restart", async () => {
    const test = makeGame((config) => {
      config.deploy!.mode = "none";
    });
    mergeFastForward(test, "feature");
    unlinkSync(join(test.game.busDir, "delivery-control.json"));
    const context = testContext(test, {
      clock: manualClock(Date.UTC(2026, 10, 9, 21, 19, 55) / 1000),
      exec: fakeExec(gateDocker()),
    });
    await captureRequest(requestStore(context), "pending");
    const stop = new AbortController();
    const running = runRunner(
      { cliPath: runnerFile(test.base), signal: stop.signal },
      () => context,
    );
    try {
      await until(() => vi.mocked(deliverScheduledWake).mock.calls.length > 0);
      expect(readFileSync(join(context.paths.requestsDir, "pending.json"), "utf8")).toContain(
        '"pending"',
      );
      desired(test.game.busDir, "enabled");
      await until(() =>
        readFileSync(join(context.paths.requestsDir, "pending.json"), "utf8").includes(
          '"finished"',
        ),
      );
    } finally {
      stop.abort();
      await running;
    }
  });

  it.each(["failure", "timeout", "unauthenticated"] as const)(
    "resumes recorded CI while paused and records %s with its exact SHA",
    async (result) => {
      const test = makeGame();
      const head = gitSync(test.repo, "rev-parse", "main");
      const context = testContext(test);
      mkdirSync(context.paths.ciDir, { recursive: true });
      writeFileSync(join(context.paths.ciDir, `${head}.status`), "running\n");
      desired(test.game.busDir, "paused");
      vi.mocked(watchCi).mockResolvedValueOnce(result);
      const stop = new AbortController();
      const running = runRunner(
        { cliPath: runnerFile(test.base), signal: stop.signal },
        () => context,
      );
      try {
        await until(
          () => readDeliveryControl({ dir: test.game.busDir }).observed?.state === "failed",
        );
        expect(readDeliveryControl({ dir: test.game.busDir }).observed?.sha).toBe(head);
      } finally {
        stop.abort();
        await running;
      }
    },
  );

  it("keeps another CI activity current when an older watch fails", async () => {
    const test = makeGame();
    const first = gitSync(test.repo, "rev-parse", "main");
    const second = mergeFastForward(test, "feature");
    const context = testContext(test);
    mkdirSync(context.paths.ciDir, { recursive: true });
    for (const sha of [first, second]) {
      writeFileSync(join(context.paths.ciDir, `${sha}.status`), "running\n");
    }
    desired(test.game.busDir, "paused");
    let finishFirst: (value: "failure") => void = () => undefined;
    let finishSecond: (value: "success") => void = () => undefined;
    const older = new Promise<"failure">((resolve) => {
      finishFirst = resolve;
    });
    const newer = new Promise<"success">((resolve) => {
      finishSecond = resolve;
    });
    vi.mocked(watchCi).mockImplementation((_context, sha) => (sha === first ? older : newer));
    const stop = new AbortController();
    const running = runRunner(
      { cliPath: runnerFile(test.base), signal: stop.signal },
      () => context,
    );
    try {
      await until(() => vi.mocked(watchCi).mock.calls.length === 2);
      finishFirst("failure");
      await until(
        () => Object.keys(readDeliveryControl({ dir: test.game.busDir }).activities).length === 1,
      );
      expect(readDeliveryControl({ dir: test.game.busDir }).observed).toMatchObject({
        sha: second,
        state: "checking",
      });
      finishSecond("success");
      await until(
        () => Object.keys(readDeliveryControl({ dir: test.game.busDir }).activities).length === 0,
      );
      expect(readDeliveryControl({ dir: test.game.busDir }).observed).toMatchObject({
        sha: first,
        state: "failed",
      });
    } finally {
      finishFirst("failure");
      finishSecond("success");
      vi.mocked(watchCi).mockResolvedValue("success");
      stop.abort();
      await running;
    }
  });

  it("finishes a pushed pending deployment after CI while paused", async () => {
    const test = makeGame((config) => {
      delete config.deploy!.skipPattern;
    });
    const head = mergeFastForward(test, "feature");
    const context = testContext(test, { exec: fakeExec(gateDocker()) });
    expect(await depart(context)).toBe(0);
    desired(test.game.busDir, "paused");
    expect(await deployAfterCi(context, head)).toBe(true);
    expect(readFileSync(context.paths.lastDeploySha, "utf8")).toBe(`${head}\n`);
    expect(readDeliveryControl({ dir: test.game.busDir }).observed?.state).toBe("idle");
  });
});
