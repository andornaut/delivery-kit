// Runner identity and the read-only status report.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { execute, impl, type Resident, startRunner } from "../lib/adapter.ts";
import { contract, EXIT_REFUSED, suite, workspaces } from "../lib/cases.ts";
import { hold } from "../lib/locks.ts";
import { at } from "../lib/time.ts";
import { KIT_ROOT, type Workspace } from "../lib/workspace.ts";

interface Report {
  status: string;
  runner_lock_held: boolean;
  loop_lock_held: boolean;
  identity_status: string;
  identity: Record<string, unknown> | null;
  idle: boolean;
  idle_blockers: string[];
  drained: boolean;
  events: Record<string, unknown>;
  reporter_blockers: string[];
  queued_branches: number;
  observer_adoption: string;
  observer_adoption_reason: string | null;
  control: {
    desired_state: string;
    desired_status: string;
    migration_required: boolean;
    observed: { state: string; sha: string | null; runnerToken: string } | null;
    observed_status: string;
    draining: boolean;
    mismatch: boolean | null;
    mismatch_reason: string | null;
  };
}

function kitVersion(): string {
  return (JSON.parse(readFileSync(join(KIT_ROOT, "package.json"), "utf8")) as { version: string })
    .version;
}

function quiet(ws: Workspace, ci = false): void {
  ws.config = {
    schema: 1,
    git: { main: "main", remote: "origin", github: ci ? "owner/game" : "" },
    schedule: { departures: ["00"], timezone: "UTC" },
    gate: { image: "unused", install: "", steps: [] },
    resources: { cpus: 4, loadLimit: 24, memoryMiB: 4096 },
    deploy: { mode: "none", skipPattern: "" },
    reports: {},
  };
  // No departure is due while these cases run: the next slot is 59 virtual minutes away.
  ws.setClock(at(1), 1);
}

async function report(ws: Workspace): Promise<Report> {
  const result = await execute(impl.status(ws));
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Report;
}

async function started(ws: Workspace): Promise<Resident> {
  const runner = startRunner(ws);
  await runner.until(
    () => ws.exists("runner.identity.json") && ws.read("runner.lock").trim() !== "",
  );
  return runner;
}

function types(ws: Workspace): string[] {
  return ws.exists("events.jsonl") ? ws.events().map((event) => String(event.type)) : [];
}

/** runner.started is appended and the cursor has consumed every line of events.jsonl. */
function ingestedStart(ws: Workspace): boolean {
  return (
    types(ws).includes("runner.started") &&
    ws.exists("seam.json") &&
    ws.exists("events.cursor") &&
    Number(ws.readJson("events.cursor").offset) === ws.read("events.jsonl").length
  );
}

suite("status", () => {
  const workspace = workspaces();

  contract(
    "paused control with no observation is explicit intent without fabricated phase",
    async () => {
      const ws = workspace({ deliveryState: "paused" });
      quiet(ws);
      const result = await report(ws);
      expect(result.control).toMatchObject({
        desired_state: "paused",
        migration_required: false,
        observed: null,
        observed_status: "missing",
        draining: false,
        mismatch: null,
        mismatch_reason: "observation_missing",
      });
    },
  );

  contract("a stale record with a free lock is not running, idle and drained", async () => {
    const ws = workspace();
    quiet(ws);
    const runner = await started(ws);
    // runner.started is ingested before the stop, so the event log is drained.
    await runner.until(
      () =>
        ws.exists("events.cursor") &&
        Number(ws.readJson("events.cursor").offset) > 0 &&
        Number(ws.readJson("events.cursor").offset) === ws.read("events.jsonl").length,
    );
    await runner.stop();
    ws.write("active-departure", "");
    const result = await report(ws);
    expect([result.status, result.runner_lock_held, result.identity_status]).toEqual([
      "not running",
      false,
      "stale",
    ]);
    expect(result.idle && result.drained).toBe(true);
    expect([result.observer_adoption, result.observer_adoption_reason]).toEqual([
      "unknown",
      "runner_not_current",
    ]);
  });

  contract("a held lock with the matching token is running with its record", async () => {
    const ws = workspace();
    quiet(ws);
    const runner = await started(ws);
    try {
      const identity = ws.readJson("runner.identity.json");
      expect(identity.pid).toBe(runner.child.pid);
      expect(identity.version).toBe(kitVersion());
      expect(identity.state_dir).toBe(ws.state);
      expect(identity.started_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      const result = await report(ws);
      expect([result.status, result.identity_status]).toEqual(["running", "current"]);
      expect(result.identity).toEqual(identity);
      expect(ws.read("runner.lock").trim()).toBe(identity.token);
    } finally {
      await runner.stop();
    }
  });

  contract(
    "observer adoption is current once an in-range CLI has ingested this runner's runner.started",
    async () => {
      const ws = workspace();
      quiet(ws);
      const runner = await started(ws);
      try {
        await runner.until(() => ingestedStart(ws));
        const result = await report(ws);
        expect([result.observer_adoption, result.observer_adoption_reason]).toEqual([
          "current",
          null,
        ]);
      } finally {
        await runner.stop();
      }
    },
  );

  contract("observer adoption is unknown while the CLI last seen is out of range", async () => {
    const ws = workspace();
    quiet(ws);
    ws.scriptCoordinator({ version: "2.0.1" });
    const runner = await started(ws);
    try {
      await runner.until(() => ws.exists("seam.json") && types(ws).includes("runner.started"));
      const result = await report(ws);
      expect([result.observer_adoption, result.observer_adoption_reason]).toEqual([
        "unknown",
        "cli_out_of_range",
      ]);
    } finally {
      await runner.stop();
    }
  });

  contract(
    "a lock holder whose token does not match the identity record is unattested",
    async () => {
      const ws = workspace();
      quiet(ws);
      await (await started(ws)).stop();
      // A runner between taking runner.lock and writing its token, or one whose identity write
      // failed, holds the lock with no matching token. Truncating the lock reproduces that.
      const holder = await hold(ws.path("runner.lock"), "5>");
      try {
        const result = await report(ws);
        expect([result.status, result.identity_status]).toEqual(["running", "unattested"]);
        expect((await report(ws)).status).toBe("running");
      } finally {
        await holder.release();
      }
    },
  );

  contract("an active departure and pending work are not idle", async () => {
    const ws = workspace();
    quiet(ws, true);
    ws.write("loop.lock", "");
    const loop = await hold(ws.path("loop.lock"));
    try {
      ws.write("active-departure", "1793556000\n");
      ws.write("deploy-pending", "a".repeat(40) + "\n");
      ws.write(`ci/${"b".repeat(40)}.status`, "running\n");
      ws.write("last-push.sha", "d".repeat(40) + "\n");
      ws.write("requests/one.json", JSON.stringify({ state: "started" }));
      const result = await report(ws);
      expect(result.loop_lock_held).toBe(true);
      expect(result.idle).toBe(false);
      expect(result.idle_blockers).toEqual([
        "active_departure",
        "deploy_retry_pending",
        `ci_watch:${"b".repeat(40)}`,
        `ci_watch_unrecorded:${"d".repeat(40)}`,
        "request_started:one",
      ]);
      expect(result.drained).toBe(false);
    } finally {
      await loop.release();
    }
  });

  contract(
    "an uningested, rotated or torn event log and a 6.0 outbox are not drained",
    async () => {
      const ws = workspace();
      quiet(ws);
      const line = '{"schema":1}\n';
      ws.write("events.jsonl", line);
      let result = await report(ws);
      expect([result.idle, result.drained]).toEqual([true, false]);
      expect(result.reporter_blockers).toEqual([`events_uningested:${line.length}`]);
      // The line has no ID, so the cursor names the file by inode and device.
      const { dev, ino } = statSync(ws.path("events.jsonl"));
      const cursor = { at: "2026-11-18T21:30:00Z", file: "events.jsonl", lastId: null, lines: 1 };
      ws.write(
        "events.cursor",
        JSON.stringify({
          ...cursor,
          dev,
          firstId: null,
          inode: ino,
          offset: line.length,
          schema: 1,
        }),
      );
      result = await report(ws);
      expect(result.drained).toBe(true);
      // A cursor naming another file does not count toward the live log.
      ws.write(
        "events.cursor",
        JSON.stringify({
          ...cursor,
          dev,
          firstId: "f".repeat(64),
          inode: ino,
          offset: line.length,
          schema: 1,
        }),
      );
      result = await report(ws);
      expect(result.drained).toBe(false);
      expect(result.reporter_blockers).toEqual([
        `events_uningested:${line.length}`,
        "events_cursor_unmatched",
      ]);
      ws.write(
        "events.cursor",
        JSON.stringify({
          ...cursor,
          dev,
          firstId: null,
          inode: ino,
          offset: line.length,
          schema: 1,
        }),
      );
      result = await report(ws);
      expect(result.drained).toBe(true);
      expect(result.events).toEqual({
        cursorOffset: line.length,
        drained: true,
        file: ws.path("events.jsonl"),
        rotated: [],
        size: line.length,
        torn: false,
      });
      ws.write("events.jsonl", `${line}{"torn"`);
      ws.write("events.1800000000.jsonl", line);
      ws.write("events/one.json", JSON.stringify({ sent: false }));
      result = await report(ws);
      expect(result.drained).toBe(false);
      expect(result.reporter_blockers).toEqual([
        "events_uningested:7",
        "events_rotated:1",
        "events_torn",
        "events_legacy_outbox",
      ]);
      expect(result.events).toMatchObject({
        drained: false,
        rotated: ["events.1800000000.jsonl"],
        torn: true,
      });
    },
  );

  contract("a refused duplicate start leaves the holder's identity token intact", async () => {
    const ws = workspace();
    quiet(ws);
    const runner = await started(ws);
    try {
      const token = ws.read("runner.lock");
      const duplicate = await execute(impl.run(ws), { timeoutMs: 10_000 });
      expect(duplicate.code).toBe(EXIT_REFUSED);
      expect(ws.read("runner.lock")).toBe(token);
      expect((await report(ws)).identity_status).toBe("current");
    } finally {
      await runner.stop();
    }
  });
});
