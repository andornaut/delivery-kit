import { describe, expect, it } from "vitest";

import { recordingCoordinator } from "../../testing/coordinator.ts";
import { makeGame, manualClock, recordingEvents, testContext } from "../../testing/game.ts";
import { observer, retriesLater, reviewLine } from "./observer.ts";

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
      return {
        claimed: true,
        detail: "route on another host",
        reason: "nothing-due",
        status: "skipped",
      };
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
    // A nothing-due slot is not dispatched by this runner; its call is still logged.
    expect(context.lines.filter((line) => line.includes("review"))).toEqual([
      `bus: scheduled review ${twenty}: skipped nothing-due: route on another host`,
    ]);
  });
});

describe("reviewLine", () => {
  const cli = { distSha256: "a".repeat(64), version: "3.0.0" };
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
    [
      {
        claimed: true,
        cli,
        detail: "not the route host",
        reason: "nothing-due",
        status: "skipped",
      },
      { line: "bus: scheduled review 60: skipped nothing-due: not the route host", stderr: false },
    ],
    [
      { claimed: true, cli, detail: "", reason: "nothing-due", status: "skipped" },
      { line: "bus: scheduled review 60: skipped nothing-due", stderr: false },
    ],
    [
      { claimed: true, cli, detail: "spooled", reason: "in-flight", status: "deferred" },
      { line: "bus: review deferred: in-flight: spooled", stderr: true },
    ],
    [
      { claimed: false, why: "exit 1" },
      { line: "bus: scheduled review 60 unavailable (exit 1); no delivery claimed", stderr: false },
    ],
  ] as const)("prints %j as its runner line", (outcome, expected) => {
    expect(reviewLine(60, outcome)).toEqual(expected);
  });
});

describe("retriesLater", () => {
  it("retains only a confirmed compaction-reserved deferral", () => {
    const deferred = { claimed: true, detail: "", status: "deferred" } as const;
    expect(retriesLater({ ...deferred, reason: "compaction-reserved" })).toBe(true);
    expect(retriesLater({ ...deferred, reason: "recipient-busy" })).toBe(false);
    expect(
      retriesLater({ claimed: true, detail: "", reason: "compaction-reserved", status: "skipped" }),
    ).toBe(false);
    expect(retriesLater({ claimed: false, why: "compaction-reserved" })).toBe(false);
  });
});
