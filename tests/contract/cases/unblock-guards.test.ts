// Recipient decision guards and native question-history proof before any scheduled reminder
// (from tests/test_unblock.py).
import { rmSync } from "node:fs";

import { afterEach, expect } from "vitest";

import { startRunner } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { ART, type Params, TECH } from "../lib/unblock-native.ts";
import { decide, Monitored, wake } from "../lib/unblock-runner.ts";
import type { Workspace } from "../lib/workspace.ts";

const COMPACTION = "native latest-turn context compaction prevents complete question proof";

type Item = Record<string, unknown>;
const turnOne = (item: Item) => ({ turnId: "turn-one", item });

suite("unblock guards", () => {
  const workspace = workspaces();
  const open: Monitored[] = [];
  afterEach(async () => {
    for (const monitored of open.splice(0)) await monitored.close();
  });
  async function routed(
    ws: Workspace = workspace(),
    route: Record<string, unknown> = {},
  ): Promise<Monitored> {
    const monitored = await Monitored.routed(ws, route);
    open.push(monitored);
    return monitored;
  }
  /** Script the monitor's item history for every items/list call on its thread. */
  function history(m: Monitored, items: (params: Params) => unknown): void {
    m.world.thread(TECH).items = items;
  }

  contract("missing, malformed, mismatched and unknown decision records fail closed", async () => {
    const m = await routed();
    m.ws.write("unblock/pending-user-decision.json", JSON.stringify({ state: "clear" }));
    const contents: Array<string | null> = [
      null,
      "not json",
      "[]",
      "{}",
      JSON.stringify({ thread_id: TECH, state: "pending" }),
      JSON.stringify({ thread_id: ART, state: "clear" }),
      JSON.stringify({ thread_id: TECH, state: "unknown" }),
    ];
    await m.start();
    for (const [index, content] of contents.entries()) {
      if (content === null) rmSync(m.ws.path(`unblock/decisions/${TECH}.json`));
      else decide(m.ws, TECH, content);
      const tick = await m.slot(wake(index));
      expect(tick.result?.status, String(content)).toBe("deferred");
      const snapshot = m.ws.readJson<{ queues: Record<string, unknown> }>(
        `unblock/snapshots/${tick.result?.snapshot_id}.json`,
      );
      expect(Object.keys(snapshot.queues)).toContain(TECH);
    }
    expect(m.world.mutations()).toEqual([]);
    expect(m.ws.readJson("unblock/pending-user-decision.json")).toEqual({ state: "clear" });
  });

  contract(
    "another recipient's pending record neither blocks the monitor nor changes any record",
    async () => {
      const m = await routed();
      decide(m.ws, ART, { thread_id: ART, state: "pending" });
      m.ws.write("unblock/pending-user-decision.json", JSON.stringify({ state: "pending" }));
      const files = [
        `unblock/decisions/${TECH}.json`,
        `unblock/decisions/${ART}.json`,
        "unblock/pending-user-decision.json",
      ];
      const before = files.map((file) => m.ws.read(file));
      await m.start();
      expect((await m.slot(wake(0))).result?.status).toBe("accepted");
      expect(m.world.mutations()[0]?.params.threadId).toBe(TECH);
      expect(files.map((file) => m.ws.read(file))).toEqual(before);
    },
  );

  contract("a non-UUID monitor identity is never a clear recipient", async () => {
    for (const identity of ["../other", "tech"]) {
      const m = await routed(workspace(), { monitor_thread_id: identity });
      await m.start();
      const output = await m.jump(wake(0), (text) => text.includes("monitor deferred"));
      expect(output).toContain("MONITOR_ROUTE_FILE is unavailable or invalid");
      expect(m.socket.connections).toEqual([]);
    }
  });

  contract("an explicit pending marker overrides empty active flags", async () => {
    const m = await routed();
    decide(m.ws, TECH, { thread_id: TECH, state: "pending" });
    await m.start();
    const tick = await m.slot(wake(0));
    expect(tick.result?.status).toBe("deferred");
    expect(m.receipt(wake(0)).reason).toBe(
      "recipient-bound user-decision clearance missing, invalid or pending",
    );
    expect(m.world.mutations()).toEqual([]);
  });

  contract("the marker is rechecked after native metadata and before the mutation", async () => {
    const m = await routed();
    m.world.hook = (call) => {
      if (call.method === "thread/turns/list" && call.params.threadId === TECH) {
        decide(m.ws, TECH, { thread_id: TECH, state: "pending" });
      }
    };
    await m.start();
    expect((await m.slot(wake(0))).result?.status).toBe("deferred");
    expect(m.world.mutations()).toEqual([]);
  });

  contract(
    "a native question on a later history page overrides empty flags and a clear marker",
    async () => {
      const m = await routed();
      history(m, (params) =>
        params.cursor
          ? {
              data: [
                turnOne({
                  id: "license-question",
                  type: "agentMessage",
                  questions: [{ title: "License", options: ["One", "Two"] }],
                }),
              ],
            }
          : { data: [], nextCursor: "question-page" },
      );
      await m.start();
      expect((await m.slot(wake(0))).result?.status).toBe("deferred");
      expect(String(m.receipt(wake(0)).reason)).toContain("native question pending");
      expect(m.world.mutations()).toEqual([]);
    },
  );

  contract("unknown, truncated or question-tool history defers", async () => {
    const m = await routed();
    const pages: unknown[] = [
      {},
      { data: [], truncated: true },
      { data: [], nextCursor: "" },
      { data: [{ turnId: "other", item: { id: "x", type: "userMessage" } }] },
      { data: [turnOne({ id: "x", type: "unknown" })] },
      {
        data: [
          turnOne({
            id: "x",
            type: "dynamicToolCall",
            tool: "request_user_input_async",
            status: "completed",
          }),
        ],
      },
      { data: [turnOne({ id: "x", type: "mcpToolCall", status: "inProgress" })] },
    ];
    await m.start();
    for (const [index, page] of pages.entries()) {
      history(m, () => page);
      expect((await m.slot(wake(index))).result?.status, JSON.stringify(page)).toBe("deferred");
    }
    expect(m.world.mutations()).toEqual([]);
  });

  contract("a later user message does not prove question resolution", async () => {
    const m = await routed();
    history(m, () => ({
      data: [
        turnOne({ id: "q", type: "agentMessage", questions: [{ title: "Choose" }] }),
        turnOne({ id: "u", type: "userMessage", content: [] }),
      ],
    }));
    await m.start();
    expect((await m.slot(wake(0))).result?.status).toBe("deferred");
    expect(m.world.mutations()).toEqual([]);
  });

  contract("an omitted optional questions field means no question", async () => {
    const m = await routed();
    history(m, () => ({
      data: [turnOne({ id: "message", type: "agentMessage", text: "fixture" })],
    }));
    await m.start();
    expect((await m.slot(wake(0))).result?.status).toBe("accepted");
  });

  contract("an exact answer attestation resolves only its bound question", async () => {
    const m = await routed();
    const resolution = {
      question_turn_id: "turn-one",
      question_item_id: "question",
      answer_turn_id: "answer-turn",
      answer_item_id: "answer",
    };
    const variant = (
      answerType = "userMessage",
      answerTurn = "answer-turn",
      extraQuestion = false,
    ) =>
      history(m, (params) => {
        if (params.turnId === "answer-turn")
          return { data: [{ turnId: answerTurn, item: { id: "answer", type: answerType } }] };
        const items = [
          turnOne({ id: "question", type: "agentMessage", questions: [{ title: "choose" }] }),
        ];
        if (extraQuestion)
          items.push(
            turnOne({ id: "new-question", type: "dynamicToolCall", tool: "request_user_input" }),
          );
        return { data: items };
      });
    decide(m.ws, TECH, { thread_id: TECH, state: "clear", resolutions: [resolution] });
    variant();
    await m.start();
    expect((await m.slot(wake(0))).result?.status).toBe("accepted");
    // Each later slot must defer before any send: a new inventory would otherwise be reminded.
    m.world.thread(TECH).queue = () => ({ data: [] });
    let slot = 1;
    const variants: Array<[string, string, boolean]> = [
      ["agentMessage", "answer-turn", false],
      ["userMessage", "wrong-turn", false],
      ["unknown", "answer-turn", false],
      ["userMessage", "answer-turn", true],
    ];
    for (const args of variants) {
      variant(...args);
      expect((await m.slot(wake(slot))).result?.status, JSON.stringify(args)).toBe("deferred");
      slot += 1;
    }
    variant();
    for (const changed of [
      [resolution, resolution],
      [{ ...resolution, answer_item_id: "missing" }],
      [{ ...resolution, answer_turn_id: "" }],
    ]) {
      decide(m.ws, TECH, { thread_id: TECH, state: "clear", resolutions: changed });
      expect((await m.slot(wake(slot))).result?.status, JSON.stringify(changed)).toBe("deferred");
      slot += 1;
    }
    expect(m.world.mutations()).toHaveLength(1);
  });

  contract("latest-turn compaction defers even with visible exact proof", async () => {
    const question = { id: "question", type: "agentMessage", questions: [{}] };
    const answer = { id: "answer", type: "userMessage" };
    const marker = { id: "compaction", type: "contextCompaction" };
    const resolution = {
      question_turn_id: "turn-one",
      question_item_id: "question",
      answer_turn_id: "turn-one",
      answer_item_id: "answer",
    };
    const cases: Array<[string, Item[], unknown[]]> = [
      ["structural marker", [marker], []],
      ["unattested answer", [question, marker, answer], []],
      ["exact proof", [question, marker, answer], [resolution]],
      ["lost question proof", [marker, answer], [resolution]],
      ["lost answer proof", [question, marker], [resolution]],
      ["opaque lost proof", [marker], [resolution]],
      ["answer before question", [answer, marker, question], [resolution]],
      [
        "new rendered question",
        [question, marker, answer, { id: "new-question", type: "agentMessage", questions: [{}] }],
        [resolution],
      ],
      [
        "new question tool",
        [
          question,
          marker,
          answer,
          { id: "new-tool", type: "dynamicToolCall", tool: "request_user_input" },
        ],
        [resolution],
      ],
      [
        "unknown item",
        [question, marker, answer, { id: "unknown", type: "futureQuestion" }],
        [resolution],
      ],
    ];
    const m = await routed();
    await m.start();
    for (const [index, [name, items, resolutions]] of cases.entries()) {
      decide(m.ws, TECH, { thread_id: TECH, state: "clear", resolutions });
      // Paginate the visible proof independently of the structural marker.
      history(m, (params) => {
        const selected = params.cursor ? items.slice(1) : items.slice(0, 1);
        const page: Record<string, unknown> = { data: selected.map(turnOne) };
        if (!params.cursor) page.nextCursor = "remaining";
        return page;
      });
      const tick = await m.slot(wake(index));
      expect(tick.result?.status, name).toBe("deferred");
      if (name !== "unknown item") expect(m.receipt(wake(index)).reason, name).toBe(COMPACTION);
    }
    expect(m.world.mutations()).toEqual([]);
  });

  contract("older-turn compaction does not poison a clear latest turn", async () => {
    const m = await routed();
    history(m, (params) =>
      params.turnId === undefined
        ? {
            data: [
              { turnId: "older-turn", item: { id: "old-compaction", type: "contextCompaction" } },
            ],
          }
        : { data: [turnOne({ id: "message", type: "agentMessage", questions: null })] },
    );
    await m.start();
    expect((await m.slot(wake(0))).result?.status).toBe("accepted");
    expect(m.world.mutations()).toHaveLength(1);
    const turnReads = m.socket
      .callsOf("thread/items/list")
      .filter((c) => c.params.threadId === TECH && "turnId" in c.params);
    expect(turnReads.length).toBeGreaterThan(0);
    expect(turnReads.every((c) => c.params.turnId === "turn-one")).toBe(true);
  });

  contract(
    "an unrelated old resolution neither fetches its turns nor blocks the current clear turn",
    async () => {
      const m = await routed();
      decide(m.ws, TECH, {
        thread_id: TECH,
        state: "clear",
        resolutions: [
          {
            question_turn_id: "old-unavailable",
            question_item_id: "old-question",
            answer_turn_id: "old-answer",
            answer_item_id: "old-reply",
          },
        ],
      });
      await m.start();
      expect((await m.slot(wake(0))).result?.status).toBe("accepted");
      const calls = m.socket.callsOf("thread/items/list").filter((c) => c.params.threadId === TECH);
      expect(
        calls.every((c) => c.params.turnId === undefined || c.params.turnId === "turn-one"),
      ).toBe(true);
    },
  );

  contract("a same-turn answer must follow its exact question", async () => {
    const m = await routed();
    decide(m.ws, TECH, {
      thread_id: TECH,
      state: "clear",
      resolutions: [
        {
          question_turn_id: "turn-one",
          question_item_id: "question",
          answer_turn_id: "turn-one",
          answer_item_id: "answer",
        },
      ],
    });
    await m.start();
    for (const [index, answerFirst] of [true, false].entries()) {
      const items = [
        turnOne({ id: "question", type: "agentMessage", questions: [{}] }),
        turnOne({ id: "answer", type: "userMessage" }),
      ];
      history(m, () => ({ data: answerFirst ? items.reverse() : items }));
      expect((await m.slot(wake(index))).result?.status).toBe(
        answerFirst ? "deferred" : "accepted",
      );
    }
    expect(m.receipt(wake(0)).reason).toBe(
      "recipient answer item must follow its question in the same native turn",
    );
  });

  contract(
    "worker parents outside the active route defer before any native connection",
    async () => {
      const m = await routed(workspace(), { targets: [{ thread_id: ART, ownership: "active" }] });
      m.ws.config.reports = { workerParents: ["gameplay"] };
      await m.start();
      const output = await m.jump(wake(0), (text) => text.includes("monitor deferred"));
      expect(output).toContain(
        "WORKER_PARENT_THREADS requires parents in the active monitor route",
      );
      expect(m.socket.connections).toEqual([]);
    },
  );

  contract(
    "duplicate or noncanonical worker parents stop the runner before any native connection",
    async () => {
      const ws = workspace();
      const m = await routed(ws);
      for (const parents of [[ART, ART], ["ABCDEFAB-0000-0000-0000-000000000002"]]) {
        ws.writeRegistry({
          schema: 1,
          revision: 1,
          harness: "codex",
          roles: Object.fromEntries(
            parents.map((id, i) => [`parent-${i}`, { conversations: { codex: id } }]),
          ),
        });
        ws.config.reports = { workerParents: parents.map((_, i) => `parent-${i}`) };
        const result = await startRunner(ws).done;
        expect(result.code, result.stderr).toBe(2);
        expect(result.stderr).toMatch(/WORKER_PARENT_THREADS|workerParents/);
      }
      expect(m.socket.connections).toEqual([]);
    },
  );
});
