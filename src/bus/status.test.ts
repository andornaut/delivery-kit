import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { holdLock } from "../lock.ts";
import { busPaths } from "./state.ts";
import { recordIdentity, statusReport } from "./status.ts";
import { makeGame } from "./testGame.ts";

function paths() {
  return busPaths(makeGame().game.busDir);
}

describe("status report", () => {
  it("reports an idle, drained bus with no runner", () => {
    const bus = paths();
    expect(statusReport(bus)).toEqual({
      drained: true,
      identity: null,
      identity_status: "absent",
      idle: true,
      idle_blockers: [],
      loop_lock_held: false,
      gate_failed: [],
      reporter_blockers: [],
      runner_lock_held: false,
      status: "not running",
    });
  });

  it("attests the current runner by its lock token and goes stale when it stops", () => {
    const bus = paths();
    const lock = holdLock(bus.runnerLock);
    recordIdentity(bus, {
      config: "/c",
      pid: 42,
      sourceCommit: null,
      startedNs: 1_800_000_000_123_456_789n,
      toolRoot: "/t",
      version: "1.0.0",
    });
    // The holder is another open file description of the same process, so the probe sees it.
    const running = statusReport(bus);
    expect(running).toMatchObject({
      identity_status: "current",
      runner_lock_held: true,
      status: "running",
    });
    expect((running.identity as { started_ns: bigint }).started_ns).toBe(
      1_800_000_000_123_456_789n,
    );
    lock.release();
    expect(statusReport(bus).identity_status).toBe("stale");
  });

  it("lists idle and reporter blockers", () => {
    const bus = paths();
    writeFileSync(bus.activeDeparture, "1\n");
    writeFileSync(bus.deployPending, "x\n");
    writeFileSync(bus.lastPushSha, `${"a".repeat(40)}\n`);
    mkdirSync(bus.ciDir);
    writeFileSync(join(bus.ciDir, `${"b".repeat(40)}.status`), "running\n");
    mkdirSync(bus.requestsDir);
    writeFileSync(join(bus.requestsDir, "r1.json"), '{"state": "pending"}\n');
    mkdirSync(bus.eventsDir);
    writeFileSync(join(bus.eventsDir, "e.json"), '{"sent": false}\n');
    mkdirSync(bus.gateFailedDir);
    writeFileSync(join(bus.gateFailedDir, "c".repeat(40)), "failed\n");
    expect(statusReport(bus)).toMatchObject({
      drained: false,
      idle: false,
      idle_blockers: [
        "active_departure",
        "deploy_retry_pending",
        `ci_watch:${"b".repeat(40)}`,
        `ci_watch_unrecorded:${"a".repeat(40)}`,
        "request_pending:r1",
      ],
      gate_failed: ["c".repeat(40)],
      reporter_blockers: ["unsent_events:1"],
    });
  });

  it("reports an unreadable ci/ or events directory and a corrupt identity as blockers", () => {
    const bus = paths();
    // A file where a directory belongs cannot be listed, unlike a directory that is absent.
    writeFileSync(bus.ciDir, "");
    writeFileSync(bus.eventsDir, "");
    writeFileSync(bus.identity, "{not json");
    expect(statusReport(bus)).toMatchObject({
      drained: false,
      identity: null,
      identity_status: "unreadable",
      idle: false,
      idle_blockers: ["identity_unreadable", "ci_dir_unreadable"],
      reporter_blockers: ["events_dir_unreadable"],
    });
  });

  it("sees a runner lock held by a Bash flock holder", async () => {
    const bus = paths();
    writeFileSync(bus.runnerLock, "");
    const holder = spawn(
      "bash",
      ["-c", 'exec 5<>"$1"; flock 5; echo held; exec sleep 30', "h", bus.runnerLock],
      {
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    await new Promise((resolve) => {
      holder.stdout.once("data", resolve);
    });
    try {
      expect(statusReport(bus)).toMatchObject({ runner_lock_held: true, status: "running" });
    } finally {
      holder.kill("SIGKILL");
    }
  });
});
