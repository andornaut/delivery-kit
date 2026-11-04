// Scheduled Codex monitor reminder delivery through the resident runner (from tests/test_unblock.py).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect } from "vitest";

import type { RpcCall } from "../lib/codex-socket.ts";
import { bashConfig, contract, suite, workspaces } from "../lib/cases.ts";
import { rpcError, STALE, TECH, ART, GAMEPLAY } from "../lib/unblock-native.ts";
import { Monitored, wake } from "../lib/unblock-runner.ts";
import type { Workspace } from "../lib/workspace.ts";

const STDOUT_KEYS = [
  "status", "previousStatus", "reason", "snapshot_id", "snapshot_path", "history_status",
  "worker_health_status", "question_state_status", "process_health_status", "monitor_status",
  "monitor_reason", "recipient", "backlog_slots", "deferral_slots",
];

suite("unblock delivery", () => {
  const workspace = workspaces();
  const open: Monitored[] = [];
  afterEach(async () => {
    for (const monitored of open.splice(0)) await monitored.close();
  });
  async function routed(ws: Workspace = workspace()): Promise<Monitored> {
    const monitored = await Monitored.routed(ws);
    open.push(monitored);
    return monitored;
  }

  contract("an active reminder reads every peer queue page and persists only IDs", async () => {
    const m = await routed();
    await m.start();
    const tick = await m.slot(wake(0));
    expect(tick.result?.status).toBe("accepted");
    const receipt = m.receipt(wake(0));
    expect(receipt.queues).toEqual(
      Object.fromEntries([TECH, ART, GAMEPLAY].map((role) => [role, ["queue-one", "queue-two"]])),
    );
    const [steer, ...rest] = m.world.mutations();
    expect(rest).toEqual([]);
    expect(steer?.method).toBe("turn/steer");
    expect(steer?.params.expectedTurnId).toBe("turn-one");
    expect(m.ws.read(`unblock/${TECH}-${wake(0)}.json`)).not.toContain("private user content");
    expect(JSON.stringify(steer?.params)).not.toContain("private user content");
    expect(m.socket.methods()).not.toContain("thread/queue/delete");
    // Each queue is paged through both pages for every recipient.
    for (const thread of [TECH, ART, GAMEPLAY]) {
      const pages = m.socket.callsOf("thread/queue/list").filter((call) => call.params.threadId === thread);
      expect(pages.map((call) => call.params.cursor ?? null)).toEqual([null, "next"]);
    }
  });

  contract("a completed idle monitor gets turn/start without model or permission overrides", async () => {
    const m = await routed();
    Object.assign(m.world.thread(TECH), { status: { type: "idle" }, turn: { id: "previous", status: "completed" } });
    m.world.outcomes.push({ result: { turn: { id: "new" } } });
    await m.start();
    expect((await m.slot(wake(0))).result?.status).toBe("accepted");
    const [start] = m.world.mutations();
    expect(start?.method).toBe("turn/start");
    expect(new Set(Object.keys(start!.params))).toEqual(new Set(["threadId", "input", "clientUserMessageId"]));
  });

  contract("questions, approvals and ambiguous or interrupted states defer without mutation", async () => {
    const m = await routed();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: "active", activeFlags: ["waitingOnUserInput"] }, "inProgress"],
      [{ type: "active", activeFlags: ["waitingOnApproval"] }, "inProgress"],
      [{ type: "active" }, "inProgress"],
      [{ type: "notLoaded" }, "completed"],
      [{ type: "idle" }, "interrupted"],
      [{ type: "idle" }, "failed"],
    ];
    await m.start();
    for (const [index, [status, turn]] of cases.entries()) {
      Object.assign(m.world.thread(TECH), { status, turn: { id: "previous", status: turn } });
      expect((await m.slot(wake(index))).result?.status, JSON.stringify(status)).toBe("deferred");
      expect(m.receipt(wake(index)).status).toBe("deferred");
    }
    expect(m.world.mutations()).toEqual([]);
  });

  contract("only an explicit stale-turn rejection refreshes once with the same request ID", async () => {
    const m = await routed();
    m.world.outcomes.push(STALE, { result: { turnId: "turn-one" } });
    await m.start();
    expect((await m.slot(wake(0))).result?.status).toBe("accepted");
    const requests = m.world.mutations();
    expect(requests).toHaveLength(2);
    expect(requests[0]!.params.clientUserMessageId).toBe(requests[1]!.params.clientUserMessageId);
    const reads = m.socket.callsOf("thread/read").filter((call) => call.params.threadId === TECH);
    expect(reads).toHaveLength(2);
  });

  contract("a lost response or unexpected acceptance is ambiguous and never resent", async () => {
    const m = await routed();
    // A dropped connection and a five-second receive timeout stand in for the transport timeout.
    const outcomes: unknown[] = [{ close: true }, { hang: true }, { result: {} }, { result: { turnId: "unexpected-other-turn" } }];
    await m.start();
    for (const [index, outcome] of outcomes.entries()) {
      m.world.outcomes.push(outcome);
      const before = m.world.mutations().length;
      expect((await m.slot(wake(index))).result?.status).toBe("ambiguous");
      expect(m.world.mutations().length - before).toBe(1);
      expect(m.receipt(wake(index)).status).toBe("ambiguous");
    }
  }, 60_000);

  contract("other native rejections are rejected without a stale retry", async () => {
    const m = await routed();
    m.world.outcomes.push(rpcError("other error"));
    await m.start();
    expect((await m.slot(wake(0))).result?.status).toBe("rejected");
    expect(m.world.mutations()).toHaveLength(1);
    expect(m.receipt(wake(0))).toMatchObject({ status: "rejected", errorCode: -32600 });
  });

  contract("the receipt is durable at sending before the native mutation", async () => {
    const m = await routed();
    const seen: string[] = [];
    m.world.hook = (call) => {
      if (call.method === "turn/steer") seen.push(String(m.receipt(wake(0)).status));
    };
    await m.start();
    expect((await m.slot(wake(0))).result?.status).toBe("accepted");
    expect(seen).toEqual(["sending"]);
    expect(m.receipt(wake(0))).toMatchObject({
      status: "accepted",
      method: "turn/steer",
      attempt: 1,
      turnId: "turn-one",
    });
  });

  contract("a prior accepted or interrupted send is deduplicated without resending and still snapshots", async () => {
    for (const status of ["accepted", "sending"]) {
      const m = await routed();
      m.ws.write(`unblock/${TECH}-${wake(0)}.json`, JSON.stringify({ status }));
      await m.start();
      const tick = await m.slot(wake(0));
      expect(tick.result).toMatchObject({
        status: "deduplicated",
        previousStatus: status === "sending" ? "ambiguous" : status,
      });
      expect(m.world.mutations()).toEqual([]);
      expect(m.ws.list("unblock", "snapshots")).toContain(`${tick.result?.snapshot_id}.json`);
      expect(m.receipt(wake(0)).status).toBe(status === "sending" ? "ambiguous" : "accepted");
    }
  });

  contract("the same slot after a runner restart collects worker health again without redelivery", async () => {
    const m = await routed();
    m.ws.config.reports = { workerParents: ["art"] };
    await m.start();
    expect((await m.slot(wake(0))).result?.status).toBe("accepted");
    await m.stop();
    await m.start();
    const tick = await m.slot(wake(0));
    expect(tick.result).toMatchObject({ status: "deduplicated", previousStatus: "accepted" });
    expect(m.world.mutations()).toHaveLength(1);
    expect(m.socket.callsOf("thread/queue/list").filter((c) => c.params.threadId === TECH && !c.params.cursor)).toHaveLength(2);
    // The scoped parent's child inventory is read at both runs, and only for that parent.
    const inventories = m.socket.callsOf("thread/list").filter((c) => c.params.archived === false);
    expect(inventories.map((c) => c.params.parentThreadId)).toEqual([ART, ART]);
  });

  contract("unavailable absolute socket paths defer without a native connection", async () => {
    const m = await routed();
    const regular = join(m.ws.root, "regular-file");
    writeFileSync(regular, "");
    for (const [index, path] of [regular, join(m.ws.root, "missing.sock")].entries()) {
      m.ws.env.CODEX_CONTROL_SOCKET = path;
      await m.start();
      const tick = await m.slot(wake(index));
      expect(tick.result?.status).toBe("deferred");
      expect(String(tick.result?.reason)).toContain("CODEX_CONTROL_SOCKET");
      await m.stop();
    }
    expect(m.socket.connections).toEqual([]);
  });

  contract("a missing or relative socket path defers before the helper runs", async () => {
    const m = await routed();
    for (const [index, path] of [undefined, "relative.sock"].entries()) {
      if (path === undefined) delete m.ws.env.CODEX_CONTROL_SOCKET;
      else m.ws.env.CODEX_CONTROL_SOCKET = path;
      await m.start();
      const tick = await m.slot(wake(index));
      expect(tick.result).toBeUndefined();
      expect(tick.output).toContain("CODEX_CONTROL_SOCKET");
      await m.stop();
    }
    expect(m.socket.connections).toEqual([]);
    expect(m.ws.exists(`unblock/${TECH}-${wake(0)}.json`)).toBe(false);
  });

  contract("the explicit control socket carries the delivery with guards intact", async () => {
    const m = await routed();
    await m.start();
    expect((await m.slot(wake(0))).result?.status).toBe("accepted");
    expect(m.socket.connections).toHaveLength(1);
    expect(m.socket.methods()[0]).toBe("initialize");
  });

  contract("notifications and server requests interleaved with a response are skipped, never answered", async () => {
    const m = await routed();
    let first = true;
    m.socket.on("thread/queue/list", (params: Record<string, unknown>, call: RpcCall) => {
      const page = m.world.thread(String(params.threadId)).queue(params);
      if (!first) return { result: page };
      first = false;
      return {
        result: page,
        before: [
          { method: "thread/status/changed", params: {} },
          { id: call.id, method: "item/tool/requestUserInput", params: {} },
        ],
      };
    });
    await m.start();
    const tick = await m.slot(wake(0));
    expect(tick.result?.status).toBe("accepted");
    expect(m.receipt(wake(0)).queues).toMatchObject({ [TECH]: ["queue-one", "queue-two"] });
    // The client sends requests only: no response to the server's question is recorded.
    expect(m.socket.calls.every((call) => !call.method.startsWith("item/"))).toBe(true);
  });

  contract("runner output reports only status fields, never queue contents", async () => {
    const m = await routed();
    await m.start();
    const tick = await m.slot(wake(0));
    expect(Object.keys(tick.result ?? {}).every((key) => STDOUT_KEYS.includes(key))).toBe(true);
    expect(tick.result).toHaveProperty("history_status");
    expect(tick.output).not.toContain("private user content");
    expect(tick.output).not.toContain("queue-one");
  });

  bashConfig("an empty MONITOR_ROUTE_FILE with worker parents defers without a native connection", async () => {
    const m = await routed();
    m.ws.config.reports = { workerParents: ["art"] };
    m.ws.legacyConf = "MONITOR_ROUTE_FILE=''\n";
    await m.start();
    const output = await m.jump(wake(0), (text) => text.includes("monitor deferred"));
    expect(output).toContain("MONITOR_ROUTE_FILE must be an absolute route path");
    expect(m.socket.connections).toEqual([]);
  });
});
