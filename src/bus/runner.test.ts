import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { requestStore } from "./departure.ts";
import { captureRequest } from "./requests.ts";
import { observer, reviewLine, RunnerRefused, runRunner } from "./runner.ts";
import { readTrimmed } from "./state.ts";
import { recordingCoordinator } from "./testCoordinator.ts";
import {
  fakeExec,
  gateDocker,
  makeGame,
  manualClock,
  mergeFastForward,
  recordingEvents,
  testContext,
  type TestGame,
} from "./testGame.ts";
import { zonedParts } from "./time.ts";

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
          coordinationKitVersion: "2.0.0",
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

describe("observer", () => {
  it("observes a wake minute that begins while a pass is still running", async () => {
    // 22:20 EST; the fixture's wake minutes are :20 and :50.
    const twenty = Date.UTC(2026, 10, 4, 3, 20, 0) / 1000;
    const fifty = twenty + 30 * 60;
    const clock = manualClock(twenty - 60);
    const coordinator = recordingCoordinator();
    const context = testContext(makeGame(), { clock, coordinator });
    const controller = new AbortController();
    const delivered = coordinator.outcome;
    coordinator.outcome = (slot) => {
      if (coordinator.reviews.length === 1) {
        // The :20 pass is still running when the clock reaches :50.
        clock.time = fifty;
      } else {
        controller.abort();
      }
      return delivered(slot);
    };
    await observer(context, controller.signal, () => undefined);
    expect(coordinator.reviews).toEqual([twenty, fifty]);
  });

  it("calls the seam once per due slot, then reports slots and ingests in that order", async () => {
    const twenty = Date.UTC(2026, 10, 4, 3, 20, 0) / 1000;
    const clock = manualClock(twenty - 60);
    const order: string[] = [];
    const coordinator = recordingCoordinator();
    const events = recordingEvents();
    const test = makeGame((config) => {
      (config.schedule as Record<string, unknown>).departures = ["20"];
      (config.reports as Record<string, unknown>).scheduledTicks = true;
    });
    const context = testContext(test, { clock, coordinator, events });
    const controller = new AbortController();
    coordinator.outcome = () => {
      order.push("review");
      return { claimed: true, detail: "", reason: "nothing-due", status: "skipped" };
    };
    const emit = events.emit.bind(events);
    events.emit = (kind, key, message) => {
      order.push(kind);
      emit(kind, key, message);
    };
    events.ingest = () => {
      order.push("ingest");
      if (clock.time > twenty + 120) {
        controller.abort();
      }
    };
    await observer(context, controller.signal, () => undefined);
    expect(coordinator.reviews).toEqual([twenty]);
    expect(order.slice(order.indexOf("review"), order.indexOf("review") + 3)).toEqual([
      "review",
      "scheduled-status",
      "ingest",
    ]);
    // A skipped nothing-due slot is not dispatched by this runner and prints nothing.
    expect(context.lines.filter((line) => line.includes("review"))).toEqual([]);
  });
});

describe("reviewLine", () => {
  const cli = { distSha256: "a".repeat(64), version: "2.0.0" };
  it.each([
    [
      { claimed: true, cli, detail: "brief r-1 sent", reason: null, status: "delivered" },
      { line: "bus: scheduled review 60: brief r-1 sent", stderr: false },
    ],
    [
      { claimed: true, cli, detail: "turn active", reason: "recipient-busy", status: "deferred" },
      { line: "bus: review deferred: recipient-busy: turn active", stderr: true },
    ],
    [
      { claimed: true, detail: "", reason: "cli-version", status: "deferred" },
      { line: "bus: review deferred: cli-version", stderr: true },
    ],
    [
      { claimed: true, cli, detail: "receipt r-1", reason: "already-delivered", status: "skipped" },
      { line: "bus: scheduled review 60: skipped already-delivered: receipt r-1", stderr: false },
    ],
    [{ claimed: true, cli, detail: "", reason: "nothing-due", status: "skipped" }, undefined],
    [
      { claimed: false, why: "exit 1" },
      { line: "bus: scheduled review 60 unavailable (exit 1); no delivery claimed", stderr: false },
    ],
  ] as const)("prints %j as its runner line", (outcome, expected) => {
    expect(reviewLine(60, outcome)).toEqual(expected);
  });
});
