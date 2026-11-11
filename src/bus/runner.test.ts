import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { deliverScheduledWake } from "../review/wake.ts";
import { requestStore } from "./departure.ts";
import { captureRequest } from "./requests.ts";
import { RunnerRefused, runRunner } from "./runner.ts";
import { readTrimmed } from "./state.ts";
import {
  fakeExec,
  makeGame,
  manualClock,
  mergeFastForward,
  ok,
  recordingEvents,
  testContext,
  type TestGame,
} from "./testGame.ts";
import { zonedParts } from "./time.ts";

vi.mock("../review/wake.ts", () => ({
  deliverScheduledWake: vi.fn(() => Promise.resolve("delivered")),
}));

function holdWithBash(path: string): Promise<() => void> {
  writeFileSync(path, "holder-token\n");
  const holder = spawn(
    "bash",
    ["-c", 'exec 5<>"$1"; flock 5; echo held; exec sleep 60', "h", path],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return new Promise((resolve) => {
    holder.stdout.once("data", () => {
      resolve(() => holder.kill("SIGKILL"));
    });
  });
}

function cliFile(test: TestGame): string {
  const path = join(test.base, "cli.js");
  writeFileSync(path, "loaded build");
  return path;
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000 && !condition(); attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

describe("runRunner", () => {
  it("refuses a second runner and leaves the holder's token intact", async () => {
    const test = makeGame();
    const context = testContext(test);
    const control = readFileSync(join(context.paths.dir, "delivery-control.json"), "utf8");
    const release = await holdWithBash(context.paths.runnerLock);
    try {
      await expect(
        runRunner({ cliPath: cliFile(test), signal: new AbortController().signal }, () => context),
      ).rejects.toThrow(new RunnerRefused("a runner is already active"));
      expect(readFileSync(context.paths.runnerLock, "utf8")).toBe("holder-token\n");
      expect(readFileSync(join(context.paths.dir, "delivery-control.json"), "utf8")).toBe(control);
    } finally {
      release();
    }
  });

  it("records identity and pin, serves a request, runs the review and stops on abort", async () => {
    const test = makeGame((config) => {
      (config.deploy as Record<string, unknown>).mode = "none";
    });
    mergeFastForward(test, "feature");
    const events = recordingEvents();
    const clock = manualClock(Date.UTC(2026, 10, 4, 3, 15, 0) / 1000);
    const controller = new AbortController();
    const started: string[] = [];
    const context = testContext(test, {
      clock,
      events,
      exec: fakeExec(() => ok("lint ok\n")),
      startCi: (sha) => started.push(sha),
    });
    await captureRequest(requestStore(context), "r1");
    const running = runRunner({ cliPath: cliFile(test), signal: controller.signal }, () => context);
    const request = join(context.paths.requestsDir, "r1.json");
    await until(
      () =>
        readTrimmed(request)?.includes('"finished"') === true &&
        vi.mocked(deliverScheduledWake).mock.calls.length > 0,
    );
    controller.abort();
    await running;
    expect(JSON.parse(readFileSync(request, "utf8"))).toMatchObject({
      departure_exit: 0,
      state: "finished",
    });
    expect(started).toHaveLength(1);
    expect(JSON.parse(readFileSync(context.paths.identity, "utf8"))).toMatchObject({
      pid: process.pid,
    });
    expect(readTrimmed(context.paths.runnerLock)).toBe(
      JSON.parse(readFileSync(context.paths.identity, "utf8")).token,
    );
    expect(JSON.parse(readFileSync(context.paths.runnerJson, "utf8"))).toMatchObject({
      cliPath: expect.stringContaining("cli.js"),
    });
    expect(readFileSync(context.paths.activeDeparture, "utf8")).toBe("");
    expect(readFileSync(context.paths.resourcesLog, "utf8")).toContain("load average");
    const slot = vi.mocked(deliverScheduledWake).mock.calls[0]?.[2] ?? 0;
    expect(slot % 60).toBe(0);
    expect([20, 50]).toContain(zonedParts("America/Toronto", slot).minute);
  });
});
