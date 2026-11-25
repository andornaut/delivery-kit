import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Exec } from "../lib/exec.ts";
import { readTrimmed } from "../lib/files.ts";
import { zonedParts } from "../lib/time.ts";
import { recordingCoordinator } from "../testing/coordinator.ts";
import {
  fakeExec,
  gateDocker,
  makeGame,
  manualClock,
  mergeFastForward,
  recordingEvents,
  testContext,
  type TestGame,
} from "../testing/game.ts";
import { requestStore } from "./departure.ts";
import { captureRequest } from "./requests.ts";
import { RunnerRefused, runRunner, scheduledStep } from "./runner.ts";

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

/** A clock that moves only when the test sets `time`; each sleep waits for it or for an abort. */
function steppedClock(start: number) {
  const clock = {
    now: () => clock.time,
    async sleep(seconds: number, signal?: AbortSignal) {
      const wake = clock.time + seconds;
      clock.sleeping.push(seconds);
      try {
        while (clock.time < wake && signal?.aborted !== true) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => {
            setTimeout(resolve, 1);
          });
        }
      } finally {
        clock.sleeping.splice(clock.sleeping.indexOf(seconds), 1);
      }
    },
    sleeping: [] as number[],
    time: start,
  };
  return clock;
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
    const coordinator = recordingCoordinator();
    const context = testContext(test, {
      clock,
      coordinator,
      events,
      exec: fakeExec(gateDocker()),
      startCi: (sha) => started.push(sha),
    });
    await captureRequest(requestStore(context), "r1");
    const running = runRunner({ cliPath: cliFile(test), signal: controller.signal }, () => context);
    const request = join(context.paths.requestsDir, "r1.json");
    await until(
      () => readTrimmed(request)?.includes('"finished"') === true && coordinator.reviews.length > 0,
    );
    controller.abort();
    await running;
    expect(JSON.parse(readFileSync(request, "utf8")), context.lines.join("\n")).toMatchObject({
      departure_exit: 0,
      state: "finished",
    });
    expect(started).toHaveLength(1);
    expect(context.lines).toContainEqual(expect.stringMatching(/scheduled review \d+: delivered/u));
    expect(JSON.parse(readFileSync(context.paths.identity, "utf8"))).toMatchObject({
      cli_sha256: createHash("sha256").update("loaded build").digest("hex"),
      coordination_kit_version: "0.0.0-test",
      pid: process.pid,
    });
    expect(readTrimmed(context.paths.runnerLock)).toBe(
      JSON.parse(readFileSync(context.paths.identity, "utf8")).token,
    );
    expect(JSON.parse(readFileSync(context.paths.runnerJson, "utf8"))).toMatchObject({
      cliPath: expect.stringContaining("cli.js"),
      cliSha256: JSON.parse(readFileSync(context.paths.identity, "utf8")).cli_sha256,
      coordinationKitVersion: "0.0.0-test",
    });
    expect(readFileSync(context.paths.activeDeparture, "utf8")).toBe("");
    expect(readFileSync(context.paths.resourcesLog, "utf8")).toContain("load average");
    expect(coordinator.probes).toBe(1);
    expect(events.opens).toBe(1);
    const token = JSON.parse(readFileSync(context.paths.identity, "utf8")).token as string;
    expect(events.starts).toEqual([
      [
        token,
        {
          cliSha256: createHash("sha256").update("loaded build").digest("hex"),
          coordinationKitVersion: "3.0.0",
          deliveryKitVersion: expect.any(String),
          distSha256: "a".repeat(64),
          token,
        },
      ],
    ]);
    // Deployment mode none reports the pushed SHA as deployment disabled.
    expect(events.list.map(([type]) => type)).toContain("deploy_disabled");
    const slot = coordinator.reviews[0] ?? 0;
    expect(slot % 60).toBe(0);
    expect([20, 50]).toContain(zonedParts("America/Toronto", slot).minute);
  });
});

describe("scheduled-slot reports", () => {
  it("reports the slot's own departure when it is active as the observer reports the slot", async () => {
    // 22:20 EST: a departure slot and, in the fixture, a review wake minute.
    const slot = Date.UTC(2026, 10, 4, 3, 20, 0) / 1000;
    const test = makeGame((config) => {
      (config.deploy as Record<string, unknown>).mode = "none";
      (config.reports as Record<string, unknown>).scheduledTicks = true;
      (config.schedule as Record<string, unknown>).departures = ["20"];
    });
    const clock = steppedClock(slot - 1);
    const events = recordingEvents();
    const coordinator = recordingCoordinator();
    const controller = new AbortController();
    const slotReports = () => events.list.filter(([type]) => type === "scheduled-status");
    const inner = fakeExec(gateDocker());
    // The departure stays active until the observer has reported its slot.
    const exec: Exec = async (spec) => {
      if (spec.args.includes("ls-remote")) {
        await until(() => slotReports().length > 0);
      }
      return inner(spec);
    };
    const context = testContext(test, { clock, coordinator, events, exec });
    const delivered = coordinator.outcome;
    // The review call holds the observer's pass until the departure loop records its start.
    coordinator.outcome = async (wake) => {
      await until(() => readTrimmed(context.paths.activeDeparture) === String(slot));
      return delivered(wake);
    };
    const running = runRunner({ cliPath: cliFile(test), signal: controller.signal }, () => context);
    // The departure loop and the observer both sleep toward the slot before it begins.
    await until(() => clock.sleeping.filter((seconds) => seconds === 1).length >= 2);
    // The test is the only writer of the stepped clock's time.
    // eslint-disable-next-line require-atomic-updates
    clock.time = slot;
    await until(() => slotReports().length >= 2);
    controller.abort();
    await running;
    expect(coordinator.reviews).toEqual([slot]);
    expect(slotReports(), context.lines.join("\n")).toEqual([
      [
        "scheduled-status",
        String(slot),
        expect.stringContaining(
          "scheduled slot: this slot's departure is checking main; any attempt is reported separately.",
        ),
      ],
      [
        "scheduled-status",
        String(slot),
        expect.stringContaining("scheduled slot: nothing new on main; no departure."),
      ],
    ]);
  });
});

describe("scheduledStep", () => {
  it("departs within the slot's first minute and never replays a missed slot", () => {
    const next = 1_000_000;
    expect(scheduledStep(next - 1, next)).toBe("early");
    expect(scheduledStep(next, next)).toBe("due");
    expect(scheduledStep(next + 59, next)).toBe("due");
    expect(scheduledStep(next + 60, next)).toBe("missed");
    expect(scheduledStep(next + 3600, next)).toBe("missed");
  });
});
