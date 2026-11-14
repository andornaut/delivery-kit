// Public `inbox snapshot` inventory, history, question and worker metadata
//. Assertions read stdout and STATE/unblock/snapshots/<id>.json.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, expect } from "vitest";

import { contract, suite, workspaces } from "../lib/cases.ts";
import {
  ART,
  entry,
  type Json,
  mode,
  Native,
  snapshot,
  TECH,
  writeCodexRoute,
  writeDecision,
} from "../lib/review-native.ts";
import type { Workspace } from "../lib/workspace.ts";

const OTHER = "00000000-0000-0000-0000-000000000099";

suite("inbox snapshot", () => {
  const workspace = workspaces();
  const natives: Native[] = [];
  afterEach(async () => {
    for (const native of natives.splice(0)) await native.close();
  });

  async function setup(): Promise<{ ws: Workspace; native: Native }> {
    const ws = workspace();
    writeCodexRoute(ws);
    const native = await new Native(ws).listen();
    natives.push(native);
    return { ws, native };
  }

  contract(
    "question state reads existing records only and reports unknown visibility",
    async () => {
      const { ws } = await setup();
      const marker = { thread_id: ART, state: "pending", pending_questions: [] };
      writeDecision(ws, ART, marker);
      const before = ws.read("unblock", "decisions", ART + ".json");
      const { file, public: output } = await snapshot(ws, ART);
      expect(ws.read("unblock", "decisions", ART + ".json")).toBe(before);
      const value = file!.question_state[ART];
      expect(value.ui_visibility).toBe("unknown");
      expect(value.pending_status).toBe("unavailable");
      expect(value.diagnostics).toContain("exact_unresolved_request_unavailable");
      expect(mode(output.path as string)).toBe(0o600);
    },
  );

  contract(
    "questions use the explicit recipient route scope without native expansion",
    async () => {
      const { ws, native } = await setup();
      native.queues[OTHER] = [];
      const { file } = await snapshot(ws, OTHER);
      expect(Object.keys(file!.question_state)).toEqual([OTHER]);
      expect(file!.question_state[OTHER].status).toBe("unavailable");
      expect(file!.question_state[OTHER].diagnostics).toContain(
        "question_recipient_outside_active_route",
      );
      // Only the history read touches the item list; the question collector never runs.
      expect(native.socket.callsOf("thread/items/list")).toHaveLength(1);
      const scoped = await snapshot(ws, ART);
      expect(scoped.file!.question_state[ART].status).toBe("complete");
    },
  );

  contract("an oversized question keeps no partial choices and is unknown", async () => {
    const { ws, native } = await setup();
    native.items = () => ({
      data: [
        {
          turnId: "question-turn",
          item: {
            id: "question-item",
            type: "agentMessage",
            questions: [{ title: "Choose", options: ["x".repeat(40000), "Second"] }],
          },
        },
      ],
    });
    const { file } = await snapshot(ws, ART);
    const value = file!.question_state[ART];
    expect(value.questions[0].state).toBe("unknown");
    expect(value.questions[0].options).toBeNull();
    expect(value.diagnostics).toContain("question_content_bound_exceeded");
  });

  contract("worker collection is explicit and scoped, and failure is unavailable", async () => {
    const { ws, native } = await setup();
    native.socket.on("thread/list", { data: [] });
    const plain = await snapshot(ws, ART);
    expect(plain.file!.worker_health).toEqual({});
    expect(native.socket.methods()).not.toContain("thread/list");
    const scoped = await snapshot(ws, ART, ["--parent", TECH]);
    expect(Object.keys(scoped.file!.worker_health)).toEqual([TECH]);
    expect(scoped.file!.worker_health[TECH].status).toBe("complete");
    expect(
      new Set(native.socket.callsOf("thread/list").map((call) => call.params.parentThreadId)),
    ).toEqual(new Set([TECH]));
    native.socket.on("thread/list", { error: { code: -32000, message: "PRIVATE_ERROR" } });
    const unavailable = await snapshot(ws, ART, ["--parent", TECH]);
    expect(unavailable.file!.worker_health[TECH].status).toBe("unavailable");
    expect(unavailable.file!.worker_health[TECH].complete).toBe(false);
    expect(JSON.stringify(unavailable.file)).not.toContain("PRIVATE_ERROR");
    expect(unavailable.file!.errors).toEqual({});
    expect(native.deletions()).toEqual([]);
    expect(native.socket.methods().some((method) => method.startsWith("turn/"))).toBe(false);
  });

  contract("a snapshot paginates and retains the full payload without a stdout leak", async () => {
    const { ws, native } = await setup();
    const { result, public: output } = await snapshot(ws, TECH);
    expect(result.stdout).not.toContain("private payload");
    expect(output.queue_ids).toEqual(["one", "two"]);
    expect(
      native.socket.callsOf("thread/queue/list").map((call) => call.params.cursor ?? null),
    ).toEqual([null, "1"]);
    const path = output.path as string;
    expect(mode(path)).toBe(0o600);
    expect(mode(dirname(path))).toBe(0o700);
    expect(JSON.parse(readFileSync(path, "utf8")).queues[TECH]).toEqual([
      entry("one"),
      entry("two"),
    ]);
  });

  contract("history references are typed and paginated and never store native bodies", async () => {
    const { ws, native } = await setup();
    native.items = (params: Json) => {
      if (params.cursor === "older") {
        return {
          data: [
            {
              turnId: "answer-turn",
              item: { id: "answer", type: "userMessage", content: "private native reply" },
            },
          ],
        };
      }
      return {
        data: [
          {
            turnId: "question-turn",
            item: {
              id: "prompt",
              type: "agentMessage",
              text: "private native question",
              questions: [{}],
            },
          },
          {
            turnId: "question-turn",
            item: { id: "tool", type: "dynamicToolCall", tool: "request_user_input" },
          },
        ],
        nextCursor: "older",
      };
    };
    const recent = await snapshot(ws, TECH);
    const first = native.socket.callsOf("thread/items/list")[0]!.params;
    expect(first.turnId).toBeUndefined();
    expect(first.sortDirection).toBe("desc");
    const history = recent.file!.history[TECH];
    expect(history.status).toBe("partial");
    expect(history.nextCursor).toBe("older");
    expect(history.question_refs.map((row: Json) => row.kind)).toEqual([
      "rendered_prompt",
      "question_tool",
    ]);
    const older = await snapshot(ws, TECH, ["--history-cursor", "older"]);
    expect(older.file!.history[TECH].user_reply_refs).toEqual([
      { turn_id: "answer-turn", item_id: "answer" },
    ]);
    expect(older.file!.history[TECH].status).toBe("complete");
    expect(JSON.stringify(recent.file)).not.toContain("private native");
    expect(JSON.stringify(older.file)).not.toContain("private native");
    expect(older.file!.queues[TECH]).toEqual([entry("one"), entry("two")]);
  });

  contract("compaction preserves both sides and pagination without clearance", async () => {
    const { ws, native } = await setup();
    native.items = () => ({
      data: [
        { turnId: "question", item: { id: "prompt", type: "agentMessage", questions: [{}] } },
        {
          turnId: "compact",
          item: { id: "compact", type: "contextCompaction", text: "PRIVATE_BODY" },
        },
        { turnId: "answer", item: { id: "reply", type: "userMessage", content: "PRIVATE_BODY" } },
      ],
      nextCursor: "older",
    });
    writeDecision(ws, TECH, { thread_id: TECH, state: "pending" });
    const before = ws.read("unblock", "decisions", TECH + ".json");
    const { file, public: output } = await snapshot(ws, TECH);
    const value = file!.history[TECH];
    expect(value.status).toBe("partial");
    expect(value.complete).toBe(false);
    expect(value.reason_code).toBe("context_compaction");
    expect(value.category).toBe("context_compaction");
    expect(value.nextCursor).toBe("older");
    expect(value.question_refs).toEqual([
      { turn_id: "question", item_id: "prompt", kind: "rendered_prompt" },
    ]);
    expect(value.user_reply_refs).toEqual([{ turn_id: "answer", item_id: "reply" }]);
    expect(JSON.stringify(file)).not.toContain("PRIVATE_BODY");
    expect(file!.queues[TECH]).toEqual([entry("one"), entry("two")]);
    expect((output.history as Json)[TECH].complete).toBe(false);
    expect(ws.read("unblock", "decisions", TECH + ".json")).toBe(before);
  });

  contract("the snapshot exit depends on queue inventory, not history availability", async () => {
    const { ws, native } = await setup();
    native.items = () => ({ error: { code: -32000, message: "PRIVATE_TRANSPORT_BODY" } });
    for (const inventoryFails of [false, true]) {
      if (inventoryFails) native.queueError.add(TECH);
      const { result, public: output } = await snapshot(ws, TECH);
      expect(result.code).toBe(inventoryFails ? 1 : 0);
      expect(output.complete).toBe(!inventoryFails);
      expect((output.history as Json)[TECH].status).toBe("unavailable");
      expect(output.queue_ids).toEqual(inventoryFails ? [] : ["one", "two"]);
      expect(result.stdout).not.toContain("PRIVATE_TRANSPORT_BODY");
    }
  });
});
