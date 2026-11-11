// Public `inbox snapshot` inventory, history, question and worker metadata
//. Assertions read stdout and STATE/unblock/snapshots/<id>.json.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, expect } from "vitest";

import { cli } from "../lib/adapter.ts";
import { CASE_TIMEOUT_MS, contract, suite, workspaces } from "../lib/cases.ts";
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

const CHILD = "00000000-0000-0000-0000-000000000003";
const FAILED_TURN = "00000000-0000-0000-0000-000000000004";
const OTHER = "00000000-0000-0000-0000-000000000099";

/** Worker failures: exact lineage, parent action and latest failed typed turn. */
export function workerFailures(snap: Json): string[][] {
  const out = new Set<string>();
  for (const [parent, value] of Object.entries((snap.worker_health ?? {}) as Json)) {
    for (const child of value.children ?? []) {
      if (
        child.parent_id === parent &&
        child.lineage_verified === true &&
        child.requires_parent_action === true &&
        child.turn_status === "failed" &&
        ["child_id", "turn_id", "error_code"].every((f) => typeof child[f] === "string" && child[f])
      ) {
        out.add(JSON.stringify([parent, child.child_id, child.turn_id, child.error_code]));
      }
    }
  }
  return [...out].sort().map((row) => JSON.parse(row) as string[]);
}

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

  contract("the reviewed child collector produces safe failure and timeout metadata", async () => {
    const { ws, native } = await setup();
    native.socket.on("thread/list", (params: Json) => ({
      result: {
        data: params.archived
          ? []
          : [{ id: CHILD, parentThreadId: TECH, status: { type: "idle" }, updatedAt: 1 }],
      },
    }));
    native.threads[CHILD] = {
      thread: { id: CHILD, parentThreadId: TECH, status: { type: "idle" }, updatedAt: 1 },
    };
    native.turns[CHILD] = [
      {
        id: FAILED_TURN,
        status: "failed",
        error: { codexErrorInfo: "contextWindowExceeded", message: "PRIVATE_BODY" },
      },
    ];
    const ok = await snapshot(ws, TECH, ["--parent", TECH]);
    for (const call of native.socket.callsOf("thread/list"))
      expect(call.params.parentThreadId).toBe(TECH);
    expect(workerFailures(ok.file!)).toEqual([[TECH, CHILD, FAILED_TURN, "contextWindowExceeded"]]);
    expect(ok.file!.worker_health[TECH].schema_status).toBe("available");
    expect(ok.public.worker_health).toEqual(ok.file!.worker_health);
    expect(JSON.stringify(ok.file)).not.toContain("PRIVATE_BODY");
    native.socket.on("thread/list", { hang: true });
    const timeout = await snapshot(ws, TECH, ["--parent", TECH]);
    expect(timeout.file!.worker_health[TECH].status).toBe("unavailable");
    expect(timeout.file!.worker_health[TECH].schema_status).toBe("unknown");
    expect(workerFailures(timeout.file!)).toEqual([]);
    expect(JSON.stringify(timeout.file)).not.toContain("PRIVATE_BODY");
  });

  contract(
    "parent scope rejects duplicate, noncanonical and unowned parents before native calls",
    async () => {
      const { ws, native } = await setup();
      for (const parents of [[TECH, TECH], [TECH.replace("00000000", "ABCDEFAB")], [OTHER]]) {
        const result = await cli(ws, [
          "inbox",
          "snapshot",
          "--recipient",
          TECH,
          ...parents.flatMap((p) => ["--parent", p]),
        ]);
        expect(result.code, parents.join(",")).toBe(2);
      }
      for (const change of [{ state: "held" }, { schema: 99 }]) {
        writeCodexRoute(ws, change);
        const result = await cli(ws, ["inbox", "snapshot", "--recipient", TECH, "--parent", TECH]);
        expect(result.code, JSON.stringify(change)).not.toBe(0);
      }
      expect(native.socket.connections).toEqual([]);
      writeCodexRoute(ws);
      expect((await snapshot(ws, TECH)).result.code).toBe(0);
    },
  );

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

  contract(
    "history failure diagnostics keep the safe prefix without private bodies",
    async () => {
      const { ws, native } = await setup();
      const prefix = {
        turnId: "known-turn",
        item: { id: "known-reply", type: "userMessage", content: "PRIVATE_BODY" },
      };
      const history = async (page: unknown) => {
        native.items = () => page;
        return (await snapshot(ws, TECH)).file!;
      };
      const malformed = (await history({ data: [prefix, { item: { text: "PRIVATE_BODY" } }] }))
        .history[TECH];
      expect(malformed.reason_code).toBe("malformed_row");
      expect(malformed.user_reply_refs).toEqual([
        { turn_id: "known-turn", item_id: "known-reply" },
      ]);
      const unknown = (
        await history({
          data: [prefix, { turnId: "unknown-turn", item: { id: "unknown", type: "PRIVATE_TYPE" } }],
          nextCursor: "older",
        })
      ).history[TECH];
      expect(unknown.category).toBe("unknown_item");
      expect(unknown.status).toBe("unavailable");
      expect(unknown.nextCursor).toBe("older");
      const compacted = (
        await history({
          data: [{ turnId: "compact-turn", item: { id: "compact", type: "contextCompaction" } }],
        })
      ).history[TECH];
      expect(compacted.category).toBe("context_compaction");
      expect(compacted.status).toBe("partial");
      expect(compacted.complete).toBe(false);
      // A native call that never answers within the five-second transport bound.
      const failedSnapshot = await history({ hang: true });
      expect(failedSnapshot.history[TECH].reason_code).toBe("transport_failure");
      expect(failedSnapshot.errors).toEqual({});
      expect(failedSnapshot.queues[TECH]).toEqual([entry("one"), entry("two")]);
      expect(JSON.stringify([malformed, unknown, compacted, failedSnapshot])).not.toContain(
        "PRIVATE_",
      );
    },
    CASE_TIMEOUT_MS,
  );

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
