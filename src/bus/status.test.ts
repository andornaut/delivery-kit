import { spawn } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { holdLock } from "@andornaut/coordination-kit/build/shared";
import { describe, expect, it } from "vitest";

import {
  beginDeliveryActivity,
  claimDeliveryRunner,
  setDesiredDelivery,
  setObservedDelivery,
} from "./control.ts";
import { busPaths } from "./state.ts";
import { recordIdentity, statusReport } from "./status.ts";
import { makeGame } from "./testGame.ts";

function paths() {
  return busPaths(makeGame().game.busDir);
}

function controlledRunner() {
  const bus = paths();
  const store = { dir: bus.dir };
  setDesiredDelivery(store, {
    state: "enabled",
    reason: "fixture adoption",
    requester: "game-coordinator",
  });
  const runner = holdLock(bus.runnerLock);
  const loop = holdLock(bus.loopLock);
  const lock = {
    release() {
      loop.release();
      runner.release();
    },
  };
  const identity = recordIdentity(bus, {
    config: "/c",
    pid: 42,
    sourceCommit: null,
    toolRoot: "/t",
    version: "2.1.0",
  });
  const token = identity.token as string;
  claimDeliveryRunner(store, token);
  return { bus, lock, loop, store, token };
}

describe("status report", () => {
  it("reports the bundled coordination-kit and the supported range", () => {
    const { bus, lock } = controlledRunner();
    try {
      expect(statusReport(bus).coordination_kit).toEqual({
        bundled: "0.0.0-test",
        supported: ">=2.0.1 <4.0.0",
      });
    } finally {
      lock.release();
    }
  });

  it("reports the last coordinator CLI identity the runner recorded, read-only", () => {
    const { bus, lock } = controlledRunner();
    try {
      expect(statusReport(bus).coordinator_cli).toEqual({
        distSha256: null,
        seenAt: null,
        supported: null,
        version: null,
      });
      const distSha256 = "e".repeat(64);
      for (const [version, supported] of [
        ["1.2.0", false],
        ["2.0.1", false],
        ["3.0.0", true],
        ["3.4.2", true],
        ["4.0.2", true],
        ["5.0.0", false],
      ] as const) {
        writeFileSync(
          bus.seam,
          JSON.stringify({ distSha256, schema: 1, seenAt: "2026-11-18T12:00:00Z", version }),
        );
        expect(statusReport(bus).coordinator_cli).toEqual({
          distSha256,
          seenAt: "2026-11-18T12:00:00Z",
          supported,
          version,
        });
      }
      writeFileSync(bus.seam, "{");
      expect(statusReport(bus).coordinator_cli).toMatchObject({ version: null });
    } finally {
      lock.release();
    }
  });

  it.each(["checking"] as const)(
    "does not attest live %s when only the runner lock is held",
    (state) => {
      const test = controlledRunner();
      try {
        if (state === "checking" || state === "deploying") {
          beginDeliveryActivity(test.store, test.token, {
            id: "batch",
            state,
            sha: "a".repeat(40),
          });
        } else {
          setObservedDelivery(test.store, test.token, { state, sha: null });
        }
        expect(statusReport(test.bus)).toMatchObject({ control: { observed_status: "current" } });
        test.loop.release();
        expect(statusReport(test.bus)).toMatchObject({
          identity_status: "current",
          runner_lock_held: true,
          loop_lock_held: false,
          control: {
            observed: { state, runnerToken: test.token },
            observed_status: "unattested",
            draining: false,
            mismatch: null,
            mismatch_reason: "observation_unattested",
          },
        });
      } finally {
        test.lock.release();
      }
    },
  );

  it.each(["checking"] as const)("reports paused %s work as expected draining", (state) => {
    const test = controlledRunner();
    try {
      expect(
        beginDeliveryActivity(test.store, test.token, {
          id: "batch",
          state,
          sha: "a".repeat(40),
        }),
      ).toBe(true);
      setDesiredDelivery(test.store, {
        state: "paused",
        reason: "operator pause",
        requester: "game-coordinator",
      });
      expect(statusReport(test.bus)).toMatchObject({
        control: {
          desired_state: "paused",
          observed: { state, sha: "a".repeat(40), runnerToken: test.token },
          observed_status: "current",
          draining: true,
          mismatch: false,
          mismatch_reason: null,
        },
      });
    } finally {
      test.lock.release();
    }
  });

  it.each(["failed"] as const)("does not make paused %s a mismatch", (state) => {
    const test = controlledRunner();
    try {
      setObservedDelivery(test.store, test.token, { state, sha: null });
      setDesiredDelivery(test.store, {
        state: "paused",
        reason: "operator pause",
        requester: "game-coordinator",
      });
      expect(statusReport(test.bus)).toMatchObject({
        control: {
          observed_status: "current",
          draining: false,
          mismatch: false,
          mismatch_reason: null,
        },
      });
    } finally {
      test.lock.release();
    }
  });

  it("attests stopped after shutdown and reports enabled but stopped as a mismatch", () => {
    const test = controlledRunner();
    setObservedDelivery(test.store, test.token, { state: "stopped", sha: null });
    test.lock.release();
    expect(statusReport(test.bus)).toMatchObject({
      identity_status: "stale",
      idle: true,
      control: {
        observed: { state: "stopped", sha: null },
        observed_status: "current",
        mismatch: true,
        mismatch_reason: "desired_enabled_observed_stopped",
      },
    });
    const loop = holdLock(test.bus.loopLock);
    try {
      expect(statusReport(test.bus)).toMatchObject({
        control: { observed_status: "unattested", mismatch: null },
      });
    } finally {
      loop.release();
    }
    writeFileSync(test.bus.runnerLock, "different-token\n");
    expect(statusReport(test.bus)).toMatchObject({
      control: { observed_status: "unattested", mismatch: null },
    });
  });

  it.each(["deploying"] as const)(
    "does not attest %s after the singleton stops or a replaced identity",
    (state) => {
      const test = controlledRunner();
      beginDeliveryActivity(test.store, test.token, { id: "batch", state, sha: "a".repeat(40) });
      test.lock.release();
      expect(statusReport(test.bus)).toMatchObject({
        control: {
          observed_status: "unattested",
          mismatch: null,
          mismatch_reason: "observation_unattested",
        },
      });
      const replacement = holdLock(test.bus.runnerLock);
      const replacementLoop = holdLock(test.bus.loopLock);
      try {
        recordIdentity(test.bus, {
          config: "/c",
          pid: 43,
          sourceCommit: null,
          toolRoot: "/t",
          version: "2.1.0",
        });
        expect(statusReport(test.bus)).toMatchObject({
          identity_status: "current",
          control: {
            observed_status: "stale",
            mismatch: null,
            mismatch_reason: "observation_unattested",
          },
        });
      } finally {
        replacementLoop.release();
        replacement.release();
      }
    },
  );

  it("reports corrupt control as unknown migration without changing idle or drain semantics", () => {
    const bus = paths();
    writeFileSync(join(bus.dir, "delivery-control.json"), '{"desired":{"state":"paused"}}');
    expect(statusReport(bus)).toMatchObject({
      idle: true,
      drained: true,
      control: {
        desired_state: "unknown",
        desired_status: "invalid",
        migration_required: true,
        observed_status: "invalid",
        mismatch: null,
        mismatch_reason: "control_invalid",
      },
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
      config_status: "unknown",
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

  it("reports whether the configuration on disk is the one the runner loaded", () => {
    const bus = paths();
    const config = join(bus.dir, "delivery-kit.json");
    writeFileSync(config, '{"gate":{"image":"node:24"}}\n');
    const lock = holdLock(bus.runnerLock);
    recordIdentity(bus, { config, pid: 42, sourceCommit: null, toolRoot: "/t", version: "2.0.3" });
    expect(statusReport(bus).config_status).toBe("loaded");
    writeFileSync(config, '{"gate":{"image":"archie-check"}}\n');
    expect(statusReport(bus).config_status).toBe("changed");
    lock.release();
    expect(statusReport(bus).config_status).toBeNull();
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
    writeFileSync(bus.eventsLog, '{"schema":1}\n');
    mkdirSync(bus.legacyOutbox);
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
      reporter_blockers: ["events_uningested:13", "events_legacy_outbox"],
    });
  });

  it("reports the event log read-only, drained once ingest reaches its end", () => {
    const bus = paths();
    writeFileSync(bus.eventsLog, '{"schema":1}\n');
    // The line has no ID, so the cursor names the file by inode and device.
    const { dev, ino } = statSync(bus.eventsLog);
    const cursor = { at: "2026-11-18T21:30:00Z", file: "events.jsonl", lastId: null, lines: 1 };
    writeFileSync(
      bus.eventsCursor,
      JSON.stringify({ ...cursor, dev, firstId: null, inode: ino, offset: 13, schema: 1 }),
    );
    expect(statusReport(bus)).toMatchObject({
      drained: true,
      events: {
        cursorOffset: 13,
        drained: true,
        file: bus.eventsLog,
        rotated: [],
        size: 13,
        torn: false,
      },
      reporter_blockers: [],
    });
    writeFileSync(join(bus.dir, "events.1800000000.jsonl"), "");
    expect(statusReport(bus)).toMatchObject({
      drained: false,
      events: { drained: false, rotated: ["events.1800000000.jsonl"] },
      reporter_blockers: ["events_rotated:1"],
    });
  });

  it("reports an unreadable ci/ directory or event log and a corrupt identity as blockers", () => {
    const bus = paths();
    // A file where a directory belongs cannot be listed, unlike a directory that is absent.
    writeFileSync(bus.ciDir, "");
    mkdirSync(bus.eventsLog);
    writeFileSync(bus.identity, "{not json");
    expect(statusReport(bus)).toMatchObject({
      drained: false,
      identity: null,
      identity_status: "unreadable",
      idle: false,
      idle_blockers: ["identity_unreadable", "ci_dir_unreadable"],
      reporter_blockers: ["events_unreadable"],
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
