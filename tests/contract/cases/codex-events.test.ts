// Bus events for the confirmed Codex recipient, flushed by the resident runner's observer.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect } from "vitest";

import { CASE_TIMEOUT_MS, contract, suite, workspaces } from "../lib/cases.ts";
import { rpcError, STALE, TECH } from "../lib/unblock-native.ts";
import { codexRoute, Reviewed } from "../lib/unblock-runner.ts";
import type { Workspace } from "../lib/workspace.ts";
import { otherGame } from "../lib/routes.ts";

const EVENT = "a".repeat(64);
const RECEIPT = `events/native/${EVENT}-${TECH}.json`;

function seed(ws: Workspace, id = EVENT, created = 1): void {
  ws.write(
    `events/${id}.json`,
    JSON.stringify({
      created,
      id,
      kind: "attempt",
      key: `fixture-${id.slice(0, 4)}`,
      message: "Fixture bus: PRIVATE_EVENT",
      sent: false,
    }) + "\n",
  );
}

function sent(ws: Workspace, id = EVENT): boolean {
  return ws.exists(`events/${id}.json`) && ws.readJson(`events/${id}.json`).sent === true;
}

function receipt(ws: Workspace): Record<string, unknown> {
  return ws.readJson(RECEIPT);
}

function receiptStatus(ws: Workspace): string | undefined {
  return ws.exists(RECEIPT) ? String(receipt(ws).status) : undefined;
}

suite("codex events", () => {
  const workspace = workspaces();
  const open: Reviewed[] = [];
  afterEach(async () => {
    for (const reviewed of open.splice(0)) await reviewed.close();
  });

  /** A reporter whose events go to `recipient`; the route names a different dispatch host. */
  async function reporter(
    options: {
      recipient?: string;
      /** Built after the reporter's registry exists, so it names that registry's roles. */
      route?: ((ws: Workspace) => unknown) | null;
      ws?: Workspace;
    } = {},
  ): Promise<Reviewed> {
    const ws = options.ws ?? workspace();
    const m = await Reviewed.routed(ws, { host: otherGame(ws) });
    open.push(m);
    if (options.route === null) rmSync(ws.routeFile);
    else if (options.route !== undefined) ws.writeRoute(options.route(ws));
    ws.config.reports = { project: "Fixture", recipient: options.recipient ?? "game-coordinator" };
    // Only observer event flushes run: no review wakes or departure slots are crossed.
    ws.updateCoordinatorConfig({ wakeMinutes: [] });
    const flock = join(ws.fakeBin, "flock");
    copyFileSync(new URL("../lib/event-flock.mjs", import.meta.url), flock);
    chmodSync(flock, 0o755);
    ws.env.DK_EVENT_LOCK = ws.path("events", "dispatch.lock");
    ws.env.DK_EVENT_PASSES = join(ws.fakeDir, "event-passes");
    writeFileSync(ws.env.DK_EVENT_PASSES, "");
    seed(ws);
    return m;
  }

  function passes(m: Reviewed): number {
    return readFileSync(m.ws.env.DK_EVENT_PASSES, "utf8").split("\n").length - 1;
  }

  /** Admission followed by a free dispatch lock includes all receipt and outbox writes. */
  async function completed(m: Reviewed, target: number): Promise<void> {
    await m.runner!.until(() => {
      if (passes(m) < target) return false;
      const probe = spawnSync("/usr/bin/flock", ["-n", "-E", "75", m.ws.env.DK_EVENT_LOCK, "true"]);
      if (probe.error) throw probe.error;
      if (probe.status === 75) return false;
      if (probe.status !== 0) throw new Error(`dispatch lock probe failed: ${probe.status}`);
      return true;
    });
  }

  /** Step one observer interval at a time, waiting for each flush to finish. */
  async function flushes(m: Reviewed, count: number): Promise<void> {
    await completed(m, Math.max(1, passes(m)));
    for (let step = 0; step < count; step += 1) {
      const target = passes(m) + 1;
      // Starts at minute 00; every case stays before the departure at minute 05.
      const now = m.ws.virtualNow();
      if (now + 60 >= now - (now % 3600) + 300)
        throw new Error("event fixture would cross its departure slot");
      m.ws.advanceClock(60);
      await completed(m, target);
    }
  }

  contract(
    "an active delivery persists its attempt before the mutation and deduplicates by receipt",
    async () => {
      const m = await reporter();
      const seen: unknown[] = [];
      m.world.hook = (call) => {
        if (call.method.startsWith("turn/")) {
          const state = receipt(m.ws);
          const attempts = state.attempts as Array<Record<string, unknown>>;
          seen.push([
            state.status,
            attempts.at(-1)?.status,
            state.clientUserMessageId === call.params.clientUserMessageId,
            call.params.expectedTurnId,
          ]);
        }
      };
      await m.start();
      await m.runner!.until(() => sent(m.ws));
      expect(seen).toEqual([["sending", "sending", true, "turn-one"]]);
      // The outbox flag is lost after native acceptance: the accepted receipt suppresses a resend.
      await completed(m, 1);
      seed(m.ws);
      await flushes(m, 1);
      await m.runner!.until(() => sent(m.ws));
      // A sent outbox entry is never flushed again.
      await flushes(m, 1);
      expect(m.world.mutations()).toHaveLength(1);
      expect(m.ws.read(RECEIPT)).not.toContain("PRIVATE_EVENT");
      expect(receipt(m.ws)).toMatchObject({ recipient: TECH, status: "accepted", event_id: EVENT });
    },
  );

  contract(
    "a completed idle recipient gets turn/start; an interrupted idle one gets nothing",
    async () => {
      const m = await reporter();
      Object.assign(m.world.thread(TECH), {
        status: { type: "idle" },
        turn: { id: "old", status: "completed" },
      });
      m.world.outcomes.push({ result: { turn: { id: "new" } } });
      await m.start();
      await m.runner!.until(() => sent(m.ws));
      const [start] = m.world.mutations();
      expect(start?.method).toBe("turn/start");
      expect(start?.params).not.toHaveProperty("expectedTurnId");

      const n = await reporter();
      Object.assign(n.world.thread(TECH), {
        status: { type: "idle" },
        turn: { id: "old", status: "interrupted" },
      });
      await n.start();
      await n.runner!.until(() => receiptStatus(n.ws) === "deferred");
      await flushes(n, 1);
      expect(n.world.mutations()).toEqual([]);
      expect(sent(n.ws)).toBe(false);
    },
  );

  contract("a pending local guard, native question or guard race never sends", async () => {
    for (const mode of ["local", "flags", "question", "race"]) {
      const m = await reporter();
      if (mode === "local")
        m.ws.write(
          `unblock/decisions/${TECH}.json`,
          JSON.stringify({ thread_id: TECH, state: "pending" }),
        );
      if (mode === "flags")
        m.world.thread(TECH).status = { type: "active", activeFlags: ["waitingOnUserInput"] };
      if (mode === "question") {
        m.world.thread(TECH).items = () => ({
          data: [{ turnId: "turn-one", item: { id: "q", type: "agentMessage", questions: [{}] } }],
        });
      }
      if (mode === "race") {
        m.world.hook = (call) => {
          if (call.method === "thread/turns/list") {
            m.ws.write(
              `unblock/decisions/${TECH}.json`,
              JSON.stringify({ thread_id: TECH, state: "pending" }),
            );
          }
        };
      }
      await m.start();
      await m.runner!.until(() => receiptStatus(m.ws) === "deferred");
      if (mode === "local" || mode === "race") {
        // Defers from the local record alone with no handshake: later flushes open no
        // connection either (in race mode the record turns pending during the first flush).
        const before = m.socket.connections.length;
        await flushes(m, 3);
        expect(m.socket.connections.length, mode).toBe(before);
      } else {
        await flushes(m, 1);
      }
      expect(m.world.mutations(), mode).toEqual([]);
      expect(sent(m.ws)).toBe(false);
    }
  });

  contract("a stale-turn rejection refreshes once with the same request identity", async () => {
    const m = await reporter();
    m.world.outcomes.push(STALE, { result: { turnId: "fresh" } });
    m.world.hook = (call) => {
      if (call.method === "thread/read" && m.world.mutations().length)
        m.world.thread(TECH).turn = { id: "fresh", status: "inProgress" };
    };
    await m.start();
    await m.runner!.until(() => sent(m.ws));
    const requests = m.world.mutations();
    expect(requests.map((call) => call.params.expectedTurnId)).toEqual(["turn-one", "fresh"]);
    expect(requests[0]!.params.clientUserMessageId).toBe(requests[1]!.params.clientUserMessageId);

    const n = await reporter();
    n.world.outcomes.push(STALE, STALE);
    await n.start();
    await n.runner!.until(() => receiptStatus(n.ws) === "rejected");
    await flushes(n, 2);
    expect(n.world.mutations()).toHaveLength(2);
    expect(sent(n.ws)).toBe(false);
  });

  contract(
    "ambiguous and rejected outcomes are never retried, even after a restart",
    async () => {
      const outcomes: Array<[unknown, string]> = [
        [{ close: true }, "ambiguous"],
        [{ result: {} }, "ambiguous"],
        [{ result: { turnId: "wrong" } }, "ambiguous"],
        [rpcError("PRIVATE_BODY", 1), "rejected"],
      ];
      let last: Reviewed | undefined;
      for (const [outcome, status] of outcomes) {
        const m = await reporter();
        m.world.outcomes.push(outcome);
        await m.start();
        await m.runner!.until(() => receiptStatus(m.ws) === status);
        await flushes(m, 2);
        expect(m.world.mutations()).toHaveLength(1);
        expect(m.ws.read(RECEIPT)).not.toContain("PRIVATE_BODY");
        expect(sent(m.ws)).toBe(false);
        last = m;
      }
      // An interrupted send found after a restart becomes ambiguous without any native read.
      const m = last!;
      await m.stop();
      m.ws.write(RECEIPT, JSON.stringify({ ...receipt(m.ws), status: "sending" }));
      const mark = m.socket.calls.length;
      const target = passes(m) + 1;
      await m.start();
      await m.runner!.until(() => receiptStatus(m.ws) === "ambiguous");
      await completed(m, target);
      await flushes(m, 1);
      expect(new Set(m.socket.calls.slice(mark).map((call) => call.method))).toEqual(
        new Set(["initialize", "initialized"]),
      );
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "invalid, malformed and held routes never fall back to the Codex queue",
    async () => {
      const cases: Array<[string, (ws: Workspace) => unknown]> = [
        ["malformed", () => "not json"],
        ["invalid", (ws) => codexRoute(ws, { schema: 1 })],
        ["held", (ws) => codexRoute(ws, { state: "held" })],
        ["held-unknown", (ws) => codexRoute(ws, { recipient: "no-such-role", state: "held" })],
      ];
      for (const [name, route] of cases) {
        const ws = workspace();
        const m = await reporter({ ws, route });
        await m.start();
        await flushes(m, 2);
        expect(m.socket.connections, name).toEqual([]);
        expect(
          m.ws.events().every((event) => event.sent === false),
          name,
        ).toBe(true);
      }
    },
    CASE_TIMEOUT_MS,
  );
});
