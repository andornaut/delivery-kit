// Wall-clock monitor cadence on a Codex route, independent of release ticks. The native boundary is
// the fake control socket: one connection per dispatched slot, queue reads name the route members,
// thread/list names parents.

import { afterAll, expect } from "vitest";

import { cli, execute, impl, startRunner } from "../lib/adapter.ts";
import {
  clearMonitor,
  codexGame,
  codexRoles,
  HELD,
  MONITOR,
  role,
  TARGET,
  TECH,
  cadenceRoute,
} from "../lib/claude-codex.ts";
import { threads, tick, virtualNow } from "../lib/claude-fixture.ts";
import {
  CASE_TIMEOUT_MS,
  contract,
  suite,
  WORKER_PARENTS_ROUTE_MESSAGE,
  workspaces,
} from "../lib/cases.ts";
import { CodexSocket } from "../lib/codex-socket.ts";
import { otherGame, routeRole } from "../lib/routes.ts";
import { at } from "../lib/time.ts";
import type { Workspace } from "../lib/workspace.ts";

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

  contract(
    "only current wall minutes dispatch, missed startup slots are skipped and releases report separately",
    async () => {
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
        // Wait for both release reports, not a fixed span of virtual time: a slow host may
        // still be writing the second one when the clock passes the window.
        await runner.until(
          () =>
            virtualNow(ws) > at(11, 30) &&
            ws.events().filter((event) => event.kind === "scheduled-status").length >= 2,
        );
      } finally {
        await runner.stop();
      }
      const reports = ws.events().filter((event) => event.kind === "scheduled-status");
      expect(reports.map((event) => event.key)).toEqual([String(at(0)), String(at(10))]);
      expect(stdout).toContain("bus: scheduled 00 10 (America/Toronto)");
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "scheduled parents use the full active route independently of the report recipient",
    async () => {
      const ws = workspace();
      const socket = await game(ws);
      const extra = Array.from(
        { length: 8 },
        (_, i) => `00000000-0000-0000-0000-${String(10 + i).padStart(12, "0")}`,
      );
      const parents = [MONITOR, TARGET, ...extra];
      codexRoles(ws, extra);
      ws.writeRoute(
        cadenceRoute(ws, { targets: [TARGET, ...extra].map((id) => routeRole(ws, "codex", id)) }),
      );
      ws.config.reports = {
        project: "Fixture",
        recipient: "tech",
        workerParents: ["monitor", "target", ...extra.map(role)],
      };
      const result = await tick(ws, at(20));
      expect(result.monitor.map((row) => row.slot)).toEqual([at(20)]);
      expect(result.stderr).not.toContain("monitor deferred");
      expect(result.stderr).not.toContain(WORKER_PARENTS_ROUTE_MESSAGE);
      expect(threads(socket, "thread/list", "parentThreadId")).toEqual(parents);
      expect(threads(socket, "thread/queue/list")[0]).toBe(MONITOR);
      expect(threads(socket, "thread/queue/list")).not.toContain(TECH);
      expect(threads(socket, "thread/queue/list")).not.toContain(HELD);
    },
  );

  contract("a nonhost route with a parent list neither dispatches nor rejects", async () => {
    const ws = workspace();
    const socket = await game(ws);
    ws.config.reports = {
      project: "Fixture",
      recipient: "tech",
      workerParents: ["monitor", "target"],
    };
    ws.writeRoute(cadenceRoute(ws, { host: otherGame(ws) }));
    const result = await tick(ws, at(20));
    expect(monitorLines(result.stdout + result.stderr)).toEqual([]);
    expect(socket.calls).toEqual([]);
  });

  contract(
    "held or unrelated parents defer before any native call",
    async () => {
      const ws = workspace();
      const socket = await game(ws);
      const unrelated = "00000000-0000-0000-0000-000000000099";
      codexRoles(ws, [unrelated]);
      for (const parent of ["held", "tech", role(unrelated)]) {
        ws.config.reports = {
          project: "Fixture",
          recipient: "tech",
          workerParents: ["monitor", parent],
        };
        const result = await tick(ws, at(20), {
          done: ({ stderr }) => stderr.includes(WORKER_PARENTS_ROUTE_MESSAGE),
        });
        expect(result.stderr, parent).toContain(WORKER_PARENTS_ROUTE_MESSAGE);
        expect(socket.calls, parent).toEqual([]);
      }
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "a parent list never reaches the native boundary through an invalid or held route",
    async () => {
      const ws = workspace();
      const socket = await game(ws);
      ws.config.reports = { project: "Fixture", recipient: "tech", workerParents: ["monitor"] };
      for (const content of [
        "",
        "not json",
        JSON.stringify(cadenceRoute(ws, { schema: 2 })),
        JSON.stringify(cadenceRoute(ws, { state: "held" })),
      ]) {
        ws.writeRoute(content);
        const result = await tick(ws, at(20));
        expect(result.monitor, content).toEqual([]);
        expect(socket.calls, content).toEqual([]);
      }
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "route guards and disabled monitoring do not depend on the reporting flag",
    async () => {
      const ws = workspace();
      const socket = await game(ws);
      ws.config.reports = { project: "Fixture", recipient: "tech", scheduledTicks: false };
      await tick(ws, at(20));
      expect(socket.connections).toHaveLength(1);
      const updates: Array<Record<string, unknown>> = [
        { host: otherGame(ws) },
        { state: "held" },
        { monitor: "no-such-role" },
        { monitor: undefined },
        { harness: "codex" },
        { targets: [] },
        { targets: [MONITOR, TARGET].map((id) => routeRole(ws, "codex", id)) },
        { targets: ["no-such-role"] },
      ];
      for (const update of updates) {
        ws.writeRoute(cadenceRoute(ws, update));
        await tick(ws, at(20));
        expect(socket.connections, JSON.stringify(update)).toHaveLength(1);
      }
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "the monitor report sink and route keep the Tech role distinct",
    async () => {
      for (const host of [true, false]) {
        const ws = workspace();
        const socket = await game(ws);
        ws.config.reports = { project: "Fixture", recipient: "monitor", scheduledTicks: true };
        ws.config.schedule = { departures: ["00"], timezone: "America/Toronto" };
        ws.updateGameDevConfig({ wakeMinutes: [1] });
        ws.writeRoute(cadenceRoute(ws, { host: host ? ws.game : otherGame(ws) }));
        const checked = await cli(ws, ["check-config"]);
        expect(checked.code, checked.stderr).toBe(0);
        expect(checked.stdout).toContain("configuration accepted");
        expect(socket.calls).toEqual([]);
        // The observer dispatches only the current wall minute. At speed 60 a slow host's
        // notifier iteration can outlast the wake minute and miss it, so this case runs the
        // clock at 6 (a virtual minute is ten real seconds).
        ws.setClock(at(-1, 30), 6);
        const runner = startRunner(ws);
        const steered = () =>
          socket
            .callsOf("turn/steer")
            .filter((call) => JSON.stringify(call.params).includes("scheduled slot"));
        // The wake's slot comes from the runner's own report line, and its receipt is written
        // after its native calls; wait for both rather than a precomputed slot or a time span.
        const wake = () => {
          const match = /bus: scheduled monitor (\d+): /.exec(runner.output().stdout);
          return match ? Number(match[1]) : undefined;
        };
        try {
          await runner.until(() => {
            if (steered().length === 0) return false;
            if (!host) return virtualNow(ws) > at(2, 30);
            const slot = wake();
            return slot !== undefined && ws.exists(`unblock/${MONITOR}-${slot}.json`);
          });
        } finally {
          await runner.stop();
        }
        if (host) {
          // The configured wake minute, in whichever hour the runner reached it.
          expect(new Date(wake()! * 1000).getUTCMinutes()).toBe(1);
        } else {
          expect(wake()).toBeUndefined();
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
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "monitor minutes are validated at the observer without blocking or coupling to releases",
    async () => {
      const ws = workspace();
      const socket = await game(ws);
      // 1.0: an empty list is valid and schedules no wake; other invalid values are rejected
      // when the configuration loads, naming /wakeMinutes.
      ws.updateGameDevConfig({ wakeMinutes: [] });
      const none = await tick(ws, at(20));
      expect(none.monitor).toEqual([]);
      expect(socket.connections).toHaveLength(0);
      for (const value of [[60], ["20+1"]]) {
        ws.updateGameDevConfig({ wakeMinutes: value });
        ws.setClock(at(19, 30), 60);
        const result = await execute(impl.run(ws), { timeoutMs: 15_000 });
        expect(result.code, JSON.stringify(value)).not.toBe(0);
        expect(result.code, JSON.stringify(value)).not.toBeNull();
        const log = ws.exists("runner.log") ? ws.read("runner.log") : "";
        expect(result.stdout + result.stderr + log, JSON.stringify(value)).toContain(
          "/wakeMinutes",
        );
        expect(socket.connections).toHaveLength(0);
      }

      ws.updateGameDevConfig({ wakeMinutes: [10] });
      const ten = await tick(ws, at(10));
      expect(ten.monitor.map((row) => row.slot)).toEqual([at(10)]);
      // 1.0 delivers health events natively to the monitor on their own connections.
      expect(
        socket.ownConnections(),
        JSON.stringify(socket.calls.filter(CodexSocket.isEvent).map((c) => c.params.input)),
      ).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "daylight-saving fold slots keep distinct epoch identities at the same wall minute",
    async () => {
      const ws = workspace();
      await game(ws);
      clearMonitor(ws);
      const first = Date.UTC(2026, 10, 1, 5, 20) / 1000; // 01:20 EDT
      const second = Date.UTC(2026, 10, 1, 6, 20) / 1000; // 01:20 EST
      const slots: number[] = [];
      for (const slot of [first, second])
        slots.push(...(await tick(ws, slot)).monitor.map((row) => row.slot));
      expect(slots).toEqual([first, second]);
      expect(ws.exists(`unblock/${MONITOR}-${first}.json`)).toBe(true);
      expect(ws.exists(`unblock/${MONITOR}-${second}.json`)).toBe(true);
    },
  );
});
