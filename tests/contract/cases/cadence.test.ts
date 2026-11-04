// Wall-clock monitor cadence on a Codex route, independent of release ticks (from
// tests/test_monitor_cadence.py). The native boundary is the fake control socket: one
// connection per dispatched slot, queue reads name the route members, thread/list names parents.
import { writeFileSync } from "node:fs";
import { afterAll, expect } from "vitest";

import { cli, impl, startRunner } from "../lib/adapter.ts";
import { clearMonitor, codexGame, codexRoles, HELD, MONITOR, role, TARGET, TECH, v1Route } from "../lib/claude-codex.ts";
import { threads, tick, virtualNow } from "../lib/claude-fixture.ts";
import { bashConfig, contract, suite, workspaces } from "../lib/cases.ts";
import type { CodexSocket } from "../lib/codex-socket.ts";
import { at } from "../lib/time.ts";
import type { Workspace } from "../lib/workspace.ts";

const ROUTE_PARENTS = "WORKER_PARENT_THREADS requires parents in the active monitor route";

function monitorLines(text: string): string[] {
  return text.split("\n").filter((line) => /monitor|unblock/.test(line));
}

suite("monitor cadence", () => {
  const workspace = workspaces();
  const sockets: CodexSocket[] = [];
  const game = async (ws: Workspace) => {
    const socket = await codexGame(ws);
    sockets.push(socket);
    return socket;
  };
  afterAll(async () => {
    for (const socket of sockets) await socket.close();
  });

  contract("only current wall minutes dispatch, missed startup slots are skipped and releases report separately", async () => {
    const ws = workspace();
    const socket = await game(ws);
    // Started after :20 has begun: that slot is not replayed.
    const late = await tick(ws, at(20), { lead: -30, settle: 120 });
    expect(late.monitor).toEqual([]);
    expect(socket.connections).toHaveLength(0);
    const slots: number[] = [];
    for (const slot of [at(20), at(50)]) {
      const result = await tick(ws, slot);
      slots.push(...result.monitor.map((row) => row.slot));
    }
    expect(slots).toEqual([at(20), at(50)]);
    expect(socket.connections).toHaveLength(2);
    expect(threads(socket, "thread/queue/list")).toEqual([MONITOR, TARGET]);
    expect(socket.callsOf("thread/queue/list")).toHaveLength(4);
    expect(socket.callsOf("thread/list")).toEqual([]);
    expect(socket.calls.some((call) => JSON.stringify(call.params).includes(TECH))).toBe(false);
    expect(socket.calls.some((call) => JSON.stringify(call.params).includes(HELD))).toBe(false);
    // Release ticks at the departure minutes report through the event outbox.
    ws.setClock(at(-1, 50), 60);
    const runner = startRunner(ws);
    let stdout = "";
    runner.child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    try {
      await runner.until(() => virtualNow(ws) > at(11, 30));
    } finally {
      await runner.stop();
    }
    const reports = ws.events().filter((event) => event.kind === "scheduled-status");
    expect(reports.map((event) => event.key)).toEqual([String(at(0)), String(at(10))]);
    expect(stdout).toContain("bus: scheduled 00 10 (America/Toronto)");
  }, 90_000);

  contract("scheduled parents use the full active route independently of the report recipient", async () => {
    const ws = workspace();
    const socket = await game(ws);
    const extra = Array.from({ length: 8 }, (_, i) => `00000000-0000-0000-0000-${String(10 + i).padStart(12, "0")}`);
    const parents = [MONITOR, TARGET, ...extra];
    codexRoles(ws, extra);
    const route = v1Route(ws);
    ws.writeRoute({ ...route, targets: [...(route.targets as unknown[]), ...extra.map((id) => ({ thread_id: id, ownership: "active" }))] });
    ws.config.reports = { project: "Fixture", recipient: "tech", workerParents: ["monitor", "target", ...extra.map(role)] };
    const result = await tick(ws, at(20));
    expect(result.monitor.map((row) => row.slot)).toEqual([at(20)]);
    expect(result.stderr).not.toContain("monitor deferred");
    expect(result.stderr).not.toContain("WORKER_PARENT_THREADS");
    expect(threads(socket, "thread/list", "parentThreadId")).toEqual(parents);
    expect(threads(socket, "thread/queue/list")[0]).toBe(MONITOR);
    expect(threads(socket, "thread/queue/list")).not.toContain(TECH);
    expect(threads(socket, "thread/queue/list")).not.toContain(HELD);
  });

  contract("a nonhost route with a parent list neither dispatches nor rejects", async () => {
    const ws = workspace();
    const socket = await game(ws);
    ws.config.reports = { project: "Fixture", recipient: "tech", workerParents: ["monitor", "target"] };
    ws.writeRoute(v1Route(ws, { host_project_root: `${ws.repo}/dispatch-host` }));
    const result = await tick(ws, at(20));
    expect(monitorLines(result.stdout + result.stderr)).toEqual([]);
    expect(socket.calls).toEqual([]);
  });

  contract("held or unrelated parents defer before any native call", async () => {
    const ws = workspace();
    const socket = await game(ws);
    const unrelated = "00000000-0000-0000-0000-000000000099";
    codexRoles(ws, [unrelated]);
    for (const parent of ["held", "tech", role(unrelated)]) {
      ws.config.reports = { project: "Fixture", recipient: "tech", workerParents: ["monitor", parent] };
      const result = await tick(ws, at(20), { done: ({ stderr }) => stderr.includes(ROUTE_PARENTS) });
      expect(result.stderr, parent).toContain(ROUTE_PARENTS);
      expect(socket.calls, parent).toEqual([]);
    }
  }, 60_000);

  contract("a parent list never reaches the native boundary through an invalid or held route", async () => {
    const ws = workspace();
    const socket = await game(ws);
    ws.config.reports = { project: "Fixture", recipient: "tech", workerParents: ["monitor"] };
    for (const content of ["", "not json", JSON.stringify(v1Route(ws, { version: 2 })), JSON.stringify(v1Route(ws, { state: "held" }))]) {
      ws.writeRoute(content);
      const result = await tick(ws, at(20));
      expect(result.monitor, content).toEqual([]);
      expect(socket.calls, content).toEqual([]);
    }
  }, 60_000);

  bashConfig("legacy triage with a parent list and no route defers at the native boundary", async () => {
    const ws = workspace();
    const socket = await game(ws);
    const map = `${ws.root}/sessions.json`;
    writeFileSync(map, JSON.stringify({ codex: { tech: TECH, art: TARGET, gameplay: HELD } }));
    ws.writeRoute("");
    // No MONITOR_ROUTE_FILE: the departure's release-driven triage runs instead.
    ws.legacyConf = `unset MONITOR_ROUTE_FILE\nWORKER_PARENT_THREADS=${MONITOR}\nCODEX_SHARED_ROLES=''\nSESSION_MAP_FILE=${map}\nSHARED_TARGETS_FILE=''\n`;
    const result = await tick(ws, at(0), { done: ({ stderr }) => stderr.includes(ROUTE_PARENTS) });
    expect(result.stderr).toContain(ROUTE_PARENTS);
    expect(socket.calls).toEqual([]);
  });

  contract("route guards and disabled monitoring do not depend on the reporting flag", async () => {
    const ws = workspace();
    const socket = await game(ws);
    ws.config.reports = { project: "Fixture", recipient: "tech", scheduledTicks: false };
    await tick(ws, at(20));
    expect(socket.connections).toHaveLength(1);
    const updates: Array<Record<string, unknown>> = [
      { host_project_root: `${ws.repo}/nonhost` },
      { state: "held", monitor_thread_id: null },
      { monitor_thread_id: "invalid" },
      { monitor_thread_id: null },
      { harness: "other" },
      { targets: [] },
      { targets: [{ thread_id: MONITOR, ownership: "active" }, { thread_id: TARGET, ownership: "active" }] },
      { targets: [{ thread_id: "invalid", ownership: "active" }] },
    ];
    for (const update of updates) {
      ws.writeRoute(v1Route(ws, update));
      await tick(ws, at(20));
      expect(socket.connections, JSON.stringify(update)).toHaveLength(1);
    }
  }, 120_000);

  contract("the monitor report sink and route keep the Tech role distinct", async () => {
    for (const host of [true, false]) {
      const ws = workspace();
      const socket = await game(ws);
      ws.config.reports = { project: "Fixture", recipient: "monitor", scheduledTicks: true };
      ws.config.schedule = { departures: ["00"], timezone: "America/Toronto" };
      ws.updateGameDevConfig({ wakeMinutes: [1] });
      ws.writeRoute(v1Route(ws, { host_project_root: host ? ws.repo : `${ws.repo}/other-project` }));
      const checked = await cli(ws, ["check-config"]);
      expect(checked.code, checked.stderr).toBe(0);
      expect(checked.stdout).toContain("configuration accepted");
      expect(socket.calls).toEqual([]);
      ws.setClock(at(-1, 30), 60);
      const runner = startRunner(ws);
      const steered = () =>
        socket.callsOf("turn/steer").filter((call) => JSON.stringify(call.params).includes("scheduled slot"));
      try {
        await runner.until(() => steered().length > 0 && virtualNow(ws) > at(2, 30));
      } finally {
        await runner.stop();
      }
      for (const call of steered()) {
        expect(call.params.threadId).toBe(MONITOR);
        expect(call.params.expectedTurnId).toBe("turn-one");
      }
      const dispatched = socket.callsOf("thread/queue/list").map((call) => call.params.threadId);
      expect(dispatched.includes(TECH)).toBe(false);
      expect(dispatched.includes(MONITOR)).toBe(host);
      expect(ws.registry().roles.tech!.conversations.codex).toBe(TECH);
    }
  }, 90_000);

  contract("monitor minutes are validated at the observer without blocking or coupling to releases", async () => {
    const ws = workspace();
    const socket = await game(ws);
    for (const value of [[], [60], ["20+1"]]) {
      ws.updateGameDevConfig({ wakeMinutes: value });
      const result = await tick(ws, at(20), { done: ({ stderr }) => stderr.includes("MONITOR_MINUTES") });
      expect(result.stderr, JSON.stringify(value)).toContain(impl.name === "bash" ? "MONITOR_MINUTES" : "wakeMinutes");
      expect(socket.connections).toHaveLength(0);
    }
    ws.updateGameDevConfig({ wakeMinutes: [10] });
    const ten = await tick(ws, at(10));
    expect(ten.monitor.map((row) => row.slot)).toEqual([at(10)]);
    expect(socket.connections).toHaveLength(1);
  }, 60_000);

  contract("daylight-saving fold slots keep distinct epoch identities at the same wall minute", async () => {
    const ws = workspace();
    await game(ws);
    clearMonitor(ws);
    const first = Date.UTC(2026, 10, 1, 5, 20) / 1000; // 01:20 EDT
    const second = Date.UTC(2026, 10, 1, 6, 20) / 1000; // 01:20 EST
    const slots: number[] = [];
    for (const slot of [first, second]) slots.push(...(await tick(ws, slot)).monitor.map((row) => row.slot));
    expect(slots).toEqual([first, second]);
    expect(ws.exists(`unblock/${MONITOR}-${first}.json`)).toBe(true);
    expect(ws.exists(`unblock/${MONITOR}-${second}.json`)).toBe(true);
  });
});

