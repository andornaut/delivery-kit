// runner start and runner stop on a real runner in the fixture workspace. The workspace HOME has
// no systemd user unit, so start spawns the installed CLI detached and stop signals it.
import { expect } from "vitest";

import { cli } from "../lib/adapter.ts";
import { CASE_TIMEOUT_MS, contract, EXIT_INVALID, suite, workspaces } from "../lib/cases.ts";
import { at } from "../lib/time.ts";
import type { Workspace } from "../lib/workspace.ts";

function quiet(ws: Workspace): void {
  ws.config = {
    schema: 1,
    git: { main: "main", remote: "origin", github: "" },
    schedule: { departures: ["00"], timezone: "UTC" },
    gate: { image: "unused", install: "", steps: [] },
    resources: { cpus: 4, loadLimit: 24, memoryMiB: 4096 },
    deploy: { mode: "none", skipPattern: "" },
    reports: {},
  };
  // No departure is due while the case runs: the next slot is 59 virtual minutes away.
  ws.setClock(at(1), 1);
}

/** Kill the runner the case started when an assertion failed before it was stopped. */
function reap(ws: Workspace): void {
  if (!ws.exists("runner.identity.json")) return;
  const pid = Number(ws.readJson("runner.identity.json").pid);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

suite("runner lifecycle", () => {
  const workspace = workspaces();

  contract(
    "runner start spawns one runner and runner stop stops it once it is idle and drained",
    async () => {
      const ws = workspace();
      quiet(ws);
      let stoppedCleanly = false;
      try {
        const started = await cli(ws, ["runner", "start"]);
        expect(started.code, started.stderr).toBe(0);
        const start = JSON.parse(started.stdout) as Record<string, unknown>;
        const pid = ws.readJson("runner.identity.json").pid;
        expect(start).toEqual({
          game: ws.game,
          method: "spawn",
          pid,
          schema: 1,
          status: { coordinator_cli: expect.anything(), idle: true, running: true },
        });
        expect(ws.readJson("runner.json").pid).toBe(pid);
        expect(ws.exists("runner.out")).toBe(true);

        const again = await cli(ws, ["runner", "start"]);
        expect([again.code, again.stdout]).toEqual([EXIT_INVALID, ""]);
        expect(again.stderr).toContain("already running; nothing started");
        expect(ws.readJson("runner.identity.json").pid).toBe(pid);

        const stopped = await cli(ws, ["runner", "stop", "--timeout", "120"]);
        expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
        expect(JSON.parse(stopped.stdout)).toEqual({
          game: ws.game,
          locksFree: true,
          method: "signal",
          pid,
          schema: 1,
          stopped: true,
        });
        stoppedCleanly = true;
        const status = JSON.parse((await cli(ws, ["status"])).stdout) as Record<string, unknown>;
        expect([status.runner_lock_held, status.loop_lock_held]).toEqual([false, false]);
        // Neither command touches desired delivery control.
        expect((status.control as Record<string, unknown>).desired_state).toBe("enabled");

        const idle = await cli(ws, ["runner", "stop"]);
        expect(idle.code).toBe(0);
        expect(JSON.parse(idle.stdout)).toMatchObject({ method: "none", pid: null, stopped: true });
      } finally {
        if (!stoppedCleanly) reap(ws);
      }
    },
    CASE_TIMEOUT_MS,
  );
});
