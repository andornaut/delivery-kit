// Runner identity and the read-only status report (from tests/test_status.py).
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { execute, impl, type Resident, startRunner } from "../lib/adapter.ts";
import { ciDisabled, contract, queueModel, suite, workspaces } from "../lib/cases.ts";
import { hold } from "../lib/locks.ts";
import { at } from "../lib/time.ts";
import { BASH_ROOT } from "../lib/parity.ts";
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
  reporter_blockers: string[];
  queued_branches: number;
}

function kitVersion(): string {
  if (impl.name === "bash") return readFileSync(join(BASH_ROOT, "VERSION"), "utf8").trim();
  return (JSON.parse(readFileSync(join(KIT_ROOT, "package.json"), "utf8")) as { version: string })
    .version;
}

function quiet(ws: Workspace, ci = false): void {
  ws.config = {
    schema: 1,
    git: { main: "main", remote: "origin", github: ci ? "owner/game" : "" },
    schedule: { departures: ["00"], timezone: "UTC" },
    gate: { image: "unused", install: "", steps: [] },
    resources: { cpus: 4, loadLimit: 24 },
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

suite("status", () => {
  const workspace = workspaces();

  contract("a stale record with a free lock is not running, idle and drained", async () => {
    const ws = workspace();
    quiet(ws);
    await (await started(ws)).stop();
    ws.write("active-departure", "");
    const result = await report(ws);
    expect([result.status, result.runner_lock_held, result.identity_status]).toEqual([
      "not running",
      false,
      "stale",
    ]);
    expect(result.idle && result.drained).toBe(true);
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

  contract("an older runner holding the lock is running but unattested", async () => {
    const ws = workspace();
    quiet(ws);
    await (await started(ws)).stop();
    // A pre-0.9 runner opened the lock with truncation and wrote no token.
    const holder = await hold(ws.path("runner.lock"), "5>");
    try {
      const result = await report(ws);
      expect([result.status, result.identity_status]).toEqual(["running", "unattested"]);
      expect((await report(ws)).status).toBe("running");
    } finally {
      await holder.release();
    }
  });

  contract("a missing lock and record are reported absent and not created", async () => {
    const ws = workspace();
    quiet(ws);
    rmSync(ws.path("runner.lock"), { force: true });
    const result = await report(ws);
    expect([result.status, result.identity_status]).toEqual(["not running", "absent"]);
    expect(existsSync(ws.path("runner.lock"))).toBe(false);
    expect(existsSync(ws.path("runner.identity.json"))).toBe(false);
  });

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

  ciDisabled("without CI configured, an unrecorded pushed SHA is not a blocker", async () => {
    const ws = workspace();
    quiet(ws, false);
    ws.write("active-departure", "1793556000\n");
    ws.write("deploy-pending", "a".repeat(40) + "\n");
    ws.write(`ci/${"b".repeat(40)}.status`, "running\n");
    ws.write("last-push.sha", "d".repeat(40) + "\n");
    ws.write("requests/one.json", JSON.stringify({ state: "started" }));
    expect((await report(ws)).idle_blockers).toEqual([
      "active_departure",
      "deploy_retry_pending",
      `ci_watch:${"b".repeat(40)}`,
      "request_started:one",
    ]);
  });

  contract("unsent events and a running flush are not drained", async () => {
    const ws = workspace();
    quiet(ws);
    ws.write("events/one.json", JSON.stringify({ sent: false }));
    ws.write("events/two.json", JSON.stringify({ sent: false, suppressed: true }));
    ws.write("events/dispatch.lock", "");
    const flush = await hold(ws.path("events", "dispatch.lock"));
    try {
      const result = await report(ws);
      expect(result.idle).toBe(true);
      expect(result.drained).toBe(false);
      expect(result.reporter_blockers).toEqual(["event_flush_running", "unsent_events:1"]);
    } finally {
      await flush.release();
    }
  });

  contract("a refused duplicate start leaves the holder's identity token intact", async () => {
    const ws = workspace();
    quiet(ws);
    const runner = await started(ws);
    try {
      const token = ws.read("runner.lock");
      const duplicate = await execute(impl.run(ws), { timeoutMs: 10_000 });
      expect(duplicate.code).toBe(1);
      expect(ws.read("runner.lock")).toBe(token);
      expect((await report(ws)).identity_status).toBe("current");
    } finally {
      await runner.stop();
    }
  });

  queueModel("queued branches are counted", async () => {
    const ws = workspace();
    quiet(ws);
    ws.queue(["bus/one", "bus/two"]);
    expect((await report(ws)).queued_branches).toBe(2);
  });
});
