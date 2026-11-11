import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gameLayout, type Layout, loadLayout } from "../../layout.ts";
import { makeFixture } from "../../testFixtures.ts";
import { NAMESPACE_URL, uuid5 } from "../shared/ids.ts";
import { dumpsDigest, dumpsJson } from "../shared/pyjson.ts";
import { BudgetClient, codexAdapter, historyRefs } from "./index.ts";
import { connectControl } from "./rpc.ts";
import {
  type FakeControl,
  type FakeHandler,
  type FakeReply,
  startFakeControl,
} from "./testControlSocket.ts";

const RECIPIENT = "00000000-0000-4000-8000-000000000003";
const TURN = "turn-1";

const controls: FakeControl[] = [];

afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.close()));
});

interface Scene {
  status?: { type: string; activeFlags?: string[] };
  turn?: { id: string; status: string } | null;
  items?: Record<string, unknown>[];
  queue?: Record<string, unknown>[];
  overrides?: Record<string, (params: Record<string, unknown>) => FakeReply>;
}

function sceneHandler(scene: Scene): FakeHandler {
  return (method, params) => {
    const override = scene.overrides?.[method];
    if (override !== undefined) {
      return override(params);
    }
    switch (method) {
      case "thread/read":
        return {
          result: {
            thread: {
              canAcceptDirectInput: true,
              status: scene.status ?? { activeFlags: [], type: "idle" },
            },
          },
        };
      case "thread/turns/list": {
        const turn = scene.turn === undefined ? { id: TURN, status: "completed" } : scene.turn;
        return { result: { data: turn === null ? [] : [turn] } };
      }
      case "thread/items/list":
        return {
          result: {
            data: (scene.items ?? []).map((item) => ({ item, turnId: params.turnId ?? TURN })),
            nextCursor: null,
          },
        };
      case "turn/start":
        return { result: { turn: { id: "turn-2" } } };
      case "turn/steer":
        return { result: { turnId: params.expectedTurnId } };
      case "thread/queue/list":
        return { result: { data: scene.queue ?? [] } };
      case "thread/queue/delete":
        return { result: { deleted: true } };
      default:
        return { error: { code: -32601, message: "unknown method" } };
    }
  };
}

interface Setup {
  readonly layout: Layout;
  readonly unblock: string;
  readonly receipt: string;
  readonly control: FakeControl;
}

async function setup(scene: Scene, decision: Record<string, unknown> | null = {}): Promise<Setup> {
  const { root } = makeFixture();
  const layout = loadLayout(root);
  const unblock = join(gameLayout(layout, "archies-dog-walks").busDir, "unblock");
  mkdirSync(join(unblock, "decisions"), { recursive: true });
  if (decision !== null) {
    writeFileSync(
      join(unblock, "decisions", `${RECIPIENT}.json`),
      JSON.stringify({ resolutions: [], state: "clear", thread_id: RECIPIENT, ...decision }),
    );
  }
  const socketDir = mkdtempSync(join(tmpdir(), "codex-"));
  const control = await startFakeControl(socketDir, sceneHandler(scene));
  controls.push(control);
  return { control, layout, receipt: join(unblock, `${RECIPIENT}-1793757000.json`), unblock };
}

function adapter(context: Setup) {
  return codexAdapter(context.layout, { controlSocket: context.control.path, deadlineMs: 5000 });
}

function receiptOf(context: Setup): Record<string, unknown> {
  return JSON.parse(readFileSync(context.receipt, "utf8")) as Record<string, unknown>;
}

const REQUEST = uuid5(NAMESPACE_URL, `hourly-unblock:${RECIPIENT}:1793757000`);

describe("Python-compatible identifiers and JSON", () => {
  it("derives uuid5 request IDs exactly as uuid.uuid5(NAMESPACE_URL, ...)", () => {
    expect(REQUEST).toBe("1b46490f-6992-563e-aa4e-5de4399e6d56");
    expect(uuid5(NAMESPACE_URL, `bus-event:${"a".repeat(64)}:${RECIPIENT}`)).toBe(
      "749c82df-1ea3-5f1b-b902-03c8e9ebd25d",
    );
  });

  it("matches json.dumps(sort_keys=True) bytes and digests", () => {
    const value = ["cm-1", [{ type: "text", text: "café \u007f\n" }], { b: 1, a: null, c: true }];
    expect(dumpsJson(value)).toBe(
      '["cm-1", [{"text": "caf\\u00e9 \\u007f\\n", "type": "text"}], {"a": null, "b": 1, "c": true}]',
    );
    expect(dumpsDigest(value)).toBe(
      "8ec4570b8524d2a3e59df46f82e03d48a0067b4a6f23ecedc9932225753c5703",
    );
  });
});

describe("connectControl", () => {
  it("initializes, skips notifications and unrelated responses, and matches by id", async () => {
    const context = await setup({});
    const client = await connectControl(performance.now() + 5000, context.control.path);
    try {
      const listed = await client.call("thread/queue/list", { threadId: RECIPIENT });
      expect(listed).toEqual({ data: [] });
    } finally {
      client.close();
    }
    expect(context.control.calls.map((call) => call.method)).toEqual([
      "initialize",
      "initialized",
      "thread/queue/list",
    ]);
    expect(context.control.calls[0]?.params).toEqual({
      capabilities: { experimentalApi: true },
      clientInfo: { name: "hourly-unblock", version: "1" },
    });
  });

  it("rejects a native error with its code", async () => {
    const context = await setup({});
    const client = await connectControl(performance.now() + 5000, context.control.path);
    try {
      await expect(client.call("missing/method", {})).rejects.toMatchObject({ code: -32601 });
    } finally {
      client.close();
    }
  });
});

describe("codexAdapter.deliver", () => {
  it("starts a turn on an idle thread and records the accepted receipt", async () => {
    const context = await setup({});
    const result = await adapter(context).deliver(context.receipt, REQUEST, RECIPIENT, "review");
    expect(result).toEqual({ requestId: REQUEST, status: "accepted" });
    const start = context.control.calls.find((call) => call.method === "turn/start");
    expect(start?.params).toEqual({
      clientUserMessageId: REQUEST,
      input: [{ text: "review", type: "text" }],
      threadId: RECIPIENT,
    });
    expect(receiptOf(context)).toEqual({
      attempts: [{ method: "turn/start", status: "accepted", turnId: "turn-2" }],
      clientUserMessageId: REQUEST,
      recipient: RECIPIENT,
      status: "accepted",
    });
    expect(readFileSync(context.receipt, "utf8")).toMatch(/^\{"attempts": \[\{"method": /);
  });

  it("steers a busy turn with its expected turn ID", async () => {
    const context = await setup({
      status: { activeFlags: [], type: "active" },
      turn: { id: TURN, status: "inProgress" },
    });
    const result = await adapter(context).deliver(context.receipt, REQUEST, RECIPIENT, "review");
    expect(result.status).toBe("accepted");
    const steer = context.control.calls.find((call) => call.method === "turn/steer");
    expect(steer?.params.expectedTurnId).toBe(TURN);
  });

  it("retries once after a stale-turn rejection", async () => {
    let steers = 0;
    const context = await setup({
      overrides: {
        "turn/steer": (params) => {
          steers += 1;
          return steers === 1
            ? { error: { code: -32600, message: "expectedTurnId does not match the active turn" } }
            : { result: { turnId: params.expectedTurnId } };
        },
      },
      status: { activeFlags: [], type: "active" },
      turn: { id: TURN, status: "inProgress" },
    });
    const result = await adapter(context).deliver(context.receipt, REQUEST, RECIPIENT, "review");
    expect(result.status).toBe("accepted");
    expect(receiptOf(context).attempts).toEqual([
      { expectedTurnId: TURN, method: "turn/steer", status: "rejected" },
      { expectedTurnId: TURN, method: "turn/steer", status: "accepted", turnId: TURN },
    ]);
  });

  it("does not retry a rejection that is not a stale turn", async () => {
    const context = await setup({
      overrides: { "turn/start": () => ({ error: { code: -32000, message: "refused" } }) },
    });
    const result = await adapter(context).deliver(context.receipt, REQUEST, RECIPIENT, "review");
    expect(result.status).toBe("rejected");
    expect(context.control.methods().filter((method) => method === "turn/start")).toHaveLength(1);
    expect(receiptOf(context).status).toBe("rejected");
  });

  it("defers without a recipient-bound clearance and opens no connection", async () => {
    const context = await setup({}, null);
    const result = await adapter(context).deliver(context.receipt, REQUEST, RECIPIENT, "review");
    expect(result.status).toBe("deferred");
    expect(context.control.calls).toEqual([]);
    expect(context.control.methods().some((method) => method.startsWith("turn/"))).toBe(false);
    expect(receiptOf(context).status).toBe("deferred");
  });

  it("defers while the recipient waits on a question or approval", async () => {
    const context = await setup({
      status: { activeFlags: ["waitingOnUserInput"], type: "active" },
    });
    const result = await adapter(context).deliver(context.receipt, REQUEST, RECIPIENT, "review");
    expect(result).toMatchObject({ reason: "recipient waiting on a question or approval" });
  });

  it("defers on an unanswered native question in the latest turn", async () => {
    const context = await setup({ items: [{ id: "q1", questions: [{}], type: "agentMessage" }] });
    const result = await adapter(context).deliver(context.receipt, REQUEST, RECIPIENT, "review");
    expect(result).toMatchObject({
      reason: `native question pending: question_turn_id=${TURN} question_item_id=q1`,
      status: "deferred",
    });
  });

  it("delivers when every latest-turn question has a verified later answer", async () => {
    const context = await setup(
      {
        items: [
          { id: "q1", questions: [{}], type: "agentMessage" },
          { id: "u1", type: "userMessage" },
        ],
      },
      {
        resolutions: [
          {
            answer_item_id: "u1",
            answer_turn_id: TURN,
            question_item_id: "q1",
            question_turn_id: TURN,
          },
        ],
      },
    );
    const result = await adapter(context).deliver(context.receipt, REQUEST, RECIPIENT, "review");
    expect(result.status).toBe("accepted");
  });

  it("records an interrupted send as ambiguous and never resends it", async () => {
    const context = await setup({ overrides: { "turn/start": () => ({ drop: true }) } });
    const first = await adapter(context).deliver(context.receipt, REQUEST, RECIPIENT, "review");
    expect(first.status).toBe("ambiguous");
    const second = await adapter(context).deliver(context.receipt, REQUEST, RECIPIENT, "review");
    expect(second.status).toBe("ambiguous");
    expect(context.control.methods().filter((method) => method === "turn/start")).toHaveLength(1);
  });

  it("turns a stale sending receipt into ambiguous without sending", async () => {
    const context = await setup({});
    writeFileSync(
      context.receipt,
      JSON.stringify({
        attempts: [{ method: "turn/start", status: "sending" }],
        clientUserMessageId: REQUEST,
        recipient: RECIPIENT,
        status: "sending",
      }),
    );
    const result = await adapter(context).deliver(context.receipt, REQUEST, RECIPIENT, "review");
    expect(result.status).toBe("ambiguous");
    expect(receiptOf(context).status).toBe("ambiguous");
    expect(context.control.methods().some((method) => method.startsWith("turn/"))).toBe(false);
  });

  it("treats an acceptance without a turn ID as ambiguous", async () => {
    const context = await setup({ overrides: { "turn/start": () => ({ result: {} }) } });
    const result = await adapter(context).deliver(context.receipt, REQUEST, RECIPIENT, "review");
    expect(result.status).toBe("ambiguous");
  });

  it("refuses a receipt bound to another request", async () => {
    const context = await setup({});
    await adapter(context).deliver(context.receipt, REQUEST, RECIPIENT, "review");
    const other = uuid5(NAMESPACE_URL, "other");
    const result = await adapter(context).deliver(context.receipt, other, RECIPIENT, "review");
    expect(result.status).toBe("blocked");
  });

  it("binds seed fields to the receipt", async () => {
    const context = await setup({});
    const codex = adapter(context);
    const first = { event_id: "e1" };
    const result = await codex.deliver(context.receipt, REQUEST, RECIPIENT, "review", first);
    expect(result.status).toBe("accepted");
    expect(receiptOf(context).event_id).toBe("e1");
    const seed = { event_id: "e2" };
    const rebound = await codex.deliver(context.receipt, REQUEST, RECIPIENT, "review", seed);
    expect(rebound.status).toBe("blocked");
  });

  it("defers without a control socket and writes no receipt", async () => {
    const context = await setup({});
    const missing = codexAdapter(context.layout, { controlSocket: join(tmpdir(), "absent.sock") });
    const result = await missing.deliver(context.receipt, REQUEST, RECIPIENT, "review");
    expect(result.status).toBe("deferred");
    expect(existsSync(context.receipt)).toBe(false);
  });

  it("refuses a receipt outside the bus layout", async () => {
    const context = await setup({});
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "unblock", "r.json");
    const result = await adapter(context).deliver(outside, REQUEST, RECIPIENT, "review");
    expect(result.status).toBe("blocked");
  });
});

describe("codexAdapter.status", () => {
  it("maps each native thread status to an adapter status", async () => {
    const rows: [{ type: string; activeFlags?: string[] }, string][] = [
      [{ activeFlags: [], type: "idle" }, "available"],
      [{ activeFlags: [], type: "active" }, "busy"],
      [{ activeFlags: ["waitingOnApproval"], type: "active" }, "blocked"],
      [{ type: "notLoaded" }, "unavailable"],
    ];
    for (const [status, expected] of rows) {
      // eslint-disable-next-line no-await-in-loop
      const context = await setup({ status });
      // eslint-disable-next-line no-await-in-loop
      await expect(adapter(context).status(RECIPIENT), expected).resolves.toMatchObject({
        status: expected,
      });
    }
  });
});

describe("codexAdapter.inventory and ack", () => {
  const entry = {
    clientUserMessageId: "cm-1",
    id: "q-1",
    input: [{ text: "café", type: "text" }],
  };

  it("lists queued submissions with their payload signature form", async () => {
    const context = await setup({ queue: [entry] });
    const inventory = await adapter(context).inventory(RECIPIENT);
    expect(inventory).toEqual({
      entries: [{ clientUserMessageId: "cm-1", payload: "caf\u00e9", queueId: "q-1" }],
      status: "available",
    });
  });

  it("follows cursors and reports an incomplete page as unavailable", async () => {
    let pages = 0;
    const paged = await setup({
      overrides: {
        "thread/queue/list": (params) => {
          pages += 1;
          return params.cursor === undefined
            ? { result: { data: [entry], nextCursor: "c1" } }
            : { result: { data: [{ ...entry, id: "q-2" }], nextCursor: null } };
        },
      },
    });
    const listed = await adapter(paged).inventory(RECIPIENT);
    expect(listed.entries.map((item) => item.queueId)).toEqual(["q-1", "q-2"]);
    expect(pages).toBe(2);
    const truncated = await setup({
      overrides: { "thread/queue/list": () => ({ result: { data: [], truncated: true } }) },
    });
    const incomplete = await adapter(truncated).inventory(RECIPIENT);
    expect(incomplete.status).toBe("unavailable");
  });

  it("deletes an unchanged entry, refuses a changed one and confirms an absent one", async () => {
    const context = await setup({ queue: [entry] });
    const payload = "caf\u00e9";
    const codex = adapter(context);
    const handled = await codex.ack(RECIPIENT, "q-1", payload, "handled");
    expect(handled).toMatchObject({ reason: "deleted", status: "accepted" });
    const changed = await codex.ack(RECIPIENT, "q-1", "[]", "handled");
    expect(changed).toMatchObject({ reason: "changed_payload", status: "rejected" });
    const absent = await codex.ack(RECIPIENT, "q-9", payload, "handled");
    expect(absent).toMatchObject({ reason: "confirmed_absent", status: "unchanged" });
    const retained = await codex.ack(RECIPIENT, "q-1", payload, "retained", "waiting on Tech");
    expect(retained).toMatchObject({ reason: "retained", status: "unchanged" });
    const unexplained = await codex.ack(RECIPIENT, "q-1", payload, "retained");
    expect(unexplained.status).toBe("rejected");
    const deletes = context.control.methods().filter((method) => method === "thread/queue/delete");
    expect(deletes).toHaveLength(1);
  });
});

describe("historyRefs", () => {
  it("returns question and reply references without bodies", async () => {
    const context = await setup({
      items: [
        { id: "q1", questions: [{ text: "secret body" }], type: "agentMessage" },
        { id: "u1", text: "answer body", type: "userMessage" },
      ],
    });
    const client = await connectControl(performance.now() + 5000, context.control.path);
    try {
      const refs = await historyRefs(client, RECIPIENT);
      expect(refs).toMatchObject({
        complete: true,
        question_refs: [{ item_id: "q1", kind: "rendered_prompt", turn_id: TURN }],
        reason_code: "complete",
        status: "complete",
        user_reply_refs: [{ item_id: "u1", turn_id: TURN }],
      });
      expect(JSON.stringify(refs)).not.toContain("body");
    } finally {
      client.close();
    }
  });
});

describe("collectors", () => {
  it("reports every collector unavailable without a control socket", async () => {
    const context = await setup({});
    const missing = codexAdapter(context.layout, { controlSocket: join(tmpdir(), "absent.sock") });
    const collected = await missing.collectors.collect({
      historyCursor: null,
      parents: [RECIPIENT],
      recipients: [RECIPIENT],
      slot: null,
      unblockDir: context.unblock,
    });
    expect(collected.history).toEqual({
      [RECIPIENT]: { reason_code: "collector_unavailable", status: "unavailable" },
    });
    expect(collected.question_state[RECIPIENT]).toMatchObject({ status: "unavailable" });
    expect(collected.worker_health[RECIPIENT]).toMatchObject({ status: "unavailable" });
  });

  it("collects history over the socket within the shared call budget", async () => {
    const context = await setup({ items: [{ id: "u1", type: "userMessage" }] });
    const collected = await adapter(context).collectors.collect({
      historyCursor: null,
      parents: [],
      recipients: [RECIPIENT],
      slot: null,
      unblockDir: context.unblock,
    });
    expect(collected.history[RECIPIENT]).toMatchObject({
      status: "complete",
      user_reply_refs: [{ item_id: "u1", turn_id: TURN }],
    });
    expect(collected).not.toHaveProperty("process_health_source");
    expect(collected.collection_budget).toMatchObject({ max_calls: 256 });
  });

  it("stops a collector at the call budget", async () => {
    const client = { call: () => Promise.resolve({}), close: () => undefined };
    const shared = new BudgetClient(client, performance.now() + 60_000);
    for (let index = 0; index < 256; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await shared.call("thread/read", {});
    }
    await expect(shared.call("thread/read", {})).rejects.toThrow("deadline");
    expect(shared.reasonCode).toBe("collection_call_budget_exhausted");
  });
});
