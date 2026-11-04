// Scheduled monitor health across distinct slots, driven through the resident runner's
// observer. Each slot is one wall-clock minute.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect } from "vitest";

import { contract, suite, workspaces } from "../lib/cases.ts";
import {
  ack,
  ART,
  clear,
  entry,
  health,
  type Json,
  monitorEvents,
  Native,
  retentionName,
  pyJson,
  snapshot,
  TECH,
  writeCodexRoute,
  writeDecision,
} from "../lib/monitor-native.ts";
import { MonitorSchedule } from "../lib/monitor-schedule.ts";
import type { Workspace } from "../lib/workspace.ts";

const SLOW = 120_000;

function readSnapshot(output: Json | undefined): Json {
  return JSON.parse(readFileSync(output!.snapshot_path as string, "utf8")) as Json;
}

suite("monitor scheduled health", () => {
  const workspace = workspaces();
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup(
    prepare: (ws: Workspace) => void = (ws) => writeCodexRoute(ws),
  ): Promise<{ ws: Workspace; native: Native; schedule: MonitorSchedule }> {
    const ws = workspace();
    prepare(ws);
    const native = await new Native(ws).listen();
    cleanups.push(() => native.close());
    const schedule = new MonitorSchedule(ws);
    cleanups.push(() => schedule.stop());
    return { ws, native, schedule };
  }

  function ages(ws: Workspace): Record<string, number> {
    const items = (health(ws).backlog_items as Json)[TECH] as Record<string, { age: number }>;
    return Object.fromEntries(Object.entries(items).map(([id, item]) => [id, item.age]));
  }

  contract(
    "two distinct slots fail health once per unchanged episode",
    async () => {
      const { ws, native, schedule } = await setup();
      clear(ws);
      await schedule.start();
      const first = await schedule.slot();
      expect(first.output).toMatchObject({ status: "accepted", monitor_status: "ok" });
      const second = await schedule.slot();
      expect(second.output).toMatchObject({
        status: "unchanged",
        monitor_status: "failed",
        backlog_slots: 2,
      });
      await schedule.slot();
      expect(monitorEvents(ws)).toHaveLength(1);
      native.queues = { [TECH]: [], [ART]: [] };
      expect((await schedule.slot()).output).toMatchObject({
        status: "accepted",
        monitor_status: "ok",
      });
      rmSync(ws.path("unblock", "decisions", TECH + ".json"));
      expect((await schedule.slot()).output!.status).toBe("deferred");
      const failed = await schedule.slot();
      expect(failed.output).toMatchObject({ status: "deferred", monitor_status: "failed" });
      expect(monitorEvents(ws)).toHaveLength(2);
    },
    SLOW,
  );

  contract(
    "metadata degradation does not age delivery failures or hide backlog",
    async () => {
      const { ws, native, schedule } = await setup();
      clear(ws);
      native.queues = { [TECH]: [], [ART]: [] };
      ws.write(
        join("unblock", "health", TECH + ".json"),
        JSON.stringify({
          seen_slots: [10, 20],
          deferral_slots: 8,
          monitor_status: "failed",
          reported: true,
          monitor_reason: "old failure",
          problem_signature: "old",
        }),
      );
      // History pages fail; exact latest-turn reads for delivery still succeed.
      let history: (params: Json) => unknown = () => ({
        error: { code: -32000, message: "transport" },
      });
      native.items = (params: Json) => (params.turnId ? { data: [] } : history(params));
      await schedule.start();
      for (let i = 0; i < 2; i++) {
        const result = (await schedule.slot()).output!;
        expect(result).toMatchObject({
          monitor_status: "degraded",
          history_status: "degraded",
          deferral_slots: 0,
          backlog_slots: 0,
        });
      }
      expect(health(ws).reported).toBe(false);
      for (const page of [
        { data: [{ turnId: "compact", item: { id: "compact", type: "contextCompaction" } }] },
        { data: [], truncated: true },
      ]) {
        history = () => page;
        expect((await schedule.slot()).output).toMatchObject({
          monitor_status: "degraded",
          deferral_slots: 0,
        });
      }
      native.queues[TECH] = [entry("one")];
      expect((await schedule.slot()).output!.backlog_slots).toBe(1);
      const failed = (await schedule.slot()).output!;
      expect(failed.monitor_status).toBe("failed");
      expect(failed.history_status).toBe("degraded");
      expect(failed.monitor_reason).toContain("unacknowledged queue items");
      expect(failed.monitor_reason).not.toContain("repeatedly deferred");
      expect(monitorEvents(ws)).toHaveLength(1);
      native.queues[TECH] = [];
      // One more page exists for history; the question collector's second page completes.
      history = (params: Json) =>
        params.cursor ? { data: [] } : { data: [], nextCursor: "older" };
      const recovered = (await schedule.slot()).output!;
      expect(recovered.monitor_status).toBe("ok");
      expect(recovered.history_status).toBe("ok");
      expect(health(ws).monitor_reason).toBeUndefined();
    },
    SLOW,
  );

  for (const cause of ["inventory", "delivery"] as const) {
    contract(
      `queue ${cause} deferrals fail across two slots even with degraded history`,
      async () => {
        const { ws, native, schedule } = await setup();
        native.items = (params: Json) =>
          params.turnId
            ? { data: [] }
            : { data: [{ turnId: "compact", item: { id: "compact", type: "contextCompaction" } }] };
        native.queues = { [TECH]: [], [ART]: [] };
        if (cause === "inventory") {
          clear(ws);
          native.queueError.add(TECH);
        }
        await schedule.start();
        const first = (await schedule.slot()).output!;
        expect(first.status).toBe("deferred");
        expect(first.monitor_status).toBe("degraded");
        const second = (await schedule.slot()).output!;
        expect(second.monitor_status).toBe("failed");
        expect(second.deferral_slots).toBe(2);
        expect(second.monitor_reason).toContain("inventory or reminder delivery");
        expect(monitorEvents(ws)).toHaveLength(1);
      },
      SLOW,
    );
  }

  contract(
    "a question collection failure reports visibility without queue failure or raw errors",
    async () => {
      const { ws, native, schedule } = await setup();
      clear(ws);
      native.queues = { [TECH]: [], [ART]: [] };
      // A row bound to another thread is safe history but fails the exact-recipient question read.
      native.items = (params: Json) =>
        params.turnId
          ? { data: [] }
          : {
              data: [
                {
                  turnId: "turn",
                  threadId: "00000000-0000-0000-0000-000000000099",
                  item: { id: "reply", type: "userMessage", content: "PRIVATE_NATIVE_ERROR" },
                },
              ],
            };
      await schedule.start();
      for (let i = 0; i < 2; i++) {
        const { output } = await schedule.slot();
        expect(output!.monitor_status).toBe("degraded");
        expect(output!.question_state_status).toBe("degraded");
        expect(output!.deferral_slots).toBe(0);
        const snap = readSnapshot(output);
        expect(snap.question_state[TECH].pending_status).toBe("unavailable");
        expect(JSON.stringify(snap)).not.toContain("PRIVATE_NATIVE_ERROR");
      }
      expect(monitorEvents(ws)).toEqual([]);
    },
    SLOW,
  );

  contract(
    "worker diagnostics never age queue starvation",
    async () => {
      const { ws, native, schedule } = await setup();
      ws.writeRegistry({
        schema: 1,
        revision: 1,
        harness: "codex",
        roles: { tech: { conversations: { codex: TECH } } },
      });
      ws.config.reports = { workerParents: ["tech"] };
      clear(ws);
      native.queues = { [TECH]: [], [ART]: [] };
      native.socket.on("thread/list", { error: { code: -32000, message: "unavailable" } });
      await schedule.start();
      for (let i = 0; i < 2; i++) {
        const result = (await schedule.slot()).output!;
        expect(result).toMatchObject({
          worker_health_status: "degraded",
          monitor_status: "degraded",
          history_status: "ok",
          backlog_slots: 0,
          deferral_slots: 0,
        });
        expect(result.monitor_reason).toContain("worker metadata");
      }
      expect(monitorEvents(ws)).toEqual([]);
    },
    SLOW,
  );

  contract(
    "a persistent item ages through arrivals, inventory errors, edits and retention",
    async () => {
      const { ws, native, schedule } = await setup();
      clear(ws);
      native.queues = { [TECH]: [entry("A")], [ART]: [] };
      await schedule.start();
      await schedule.slot();
      expect(ages(ws)).toEqual({ A: 1 });
      native.queues[TECH] = [entry("A"), entry("B")];
      const second = (await schedule.slot()).output!;
      // A reminder delivery can be accepted while monitor health has failed.
      expect(second).toMatchObject({ status: "accepted", monitor_status: "failed" });
      expect(ages(ws)).toEqual({ A: 2, B: 1 });
      native.queues[TECH] = [entry("A"), entry("B"), entry("C")];
      await schedule.slot();
      expect(ages(ws)).toEqual({ A: 3, B: 2, C: 1 });
      expect(monitorEvents(ws)).toHaveLength(1);
      native.queueError.add(TECH);
      await schedule.slot();
      expect(ages(ws)).toEqual({ A: 3, B: 2, C: 1 });
      native.queueError.delete(TECH);
      native.queues[TECH]![1]!.input = [];
      await schedule.slot();
      expect(ages(ws)).toEqual({ A: 4, B: 1, C: 2 });
      const taken = await snapshot(ws, TECH);
      await ack(ws, TECH, taken.public.snapshot_id as string, ["B"], "retained", "planned work");
      await schedule.slot();
      expect(ages(ws)).toEqual({ A: 5, C: 3 });
      expect(monitorEvents(ws)).toHaveLength(1);
      native.queues[TECH] = [entry("C")];
      await schedule.slot();
      expect(ages(ws)).toEqual({ C: 4 });
      native.queues[TECH]![0]!.input = [];
      const resolved = (await schedule.slot()).output!;
      expect(ages(ws)).toEqual({ C: 1 });
      expect(resolved.monitor_status).toBe("ok");
      expect(monitorEvents(ws)).toHaveLength(1);
    },
    SLOW,
  );

  contract(
    "legacy aggregate counters cannot establish a queue item's past age",
    async () => {
      const { ws, native, schedule } = await setup();
      clear(ws);
      native.queues = { [TECH]: [entry("A")], [ART]: [] };
      ws.write(
        join("unblock", "health", TECH + ".json"),
        JSON.stringify({ seen_slots: [100, 200], backlog_slots: 99 }),
      );
      await schedule.start();
      expect((await schedule.slot()).output!.backlog_slots).toBe(1);
    },
    SLOW,
  );

  contract(
    "retention is nonmutating and exact, and a handled attempt invalidates it",
    async () => {
      const { ws, native, schedule } = await setup();
      clear(ws);
      native.queues = { [TECH]: [entry("one")], [ART]: [] };
      const taken = await snapshot(ws, TECH);
      const retained = await ack(
        ws,
        TECH,
        taken.public.snapshot_id as string,
        ["one"],
        "retained",
        "independent planned work",
      );
      expect(retained.rows![0]!.state).toBe("retained");
      expect(native.deletions()).toEqual([]);
      expect(native.queues[TECH]).toEqual([entry("one")]);
      await schedule.start();
      for (let i = 0; i < 2; i++) {
        const result = (await schedule.slot()).output!;
        expect(result.status).toBe("unchanged");
        expect(result.monitor_status).toBe("ok");
      }
      expect(monitorEvents(ws)).toEqual([]);
      native.queues[TECH]![0]!.input = [];
      await schedule.slot();
      expect((await schedule.slot()).output!.monitor_status).toBe("failed");
      native.queues[TECH] = [entry("one"), entry("new-work")];
      await schedule.slot();
      expect(Object.keys(ages(ws))).toEqual(["new-work"]);
      const fresh = await snapshot(ws, TECH);
      native.deleteResult = false;
      const notDeleted = await ack(
        ws,
        TECH,
        fresh.public.snapshot_id as string,
        ["one"],
        "handled",
      );
      expect(notDeleted.rows![0]!.state).toBe("not_deleted");
      expect(ws.readJson(retentionName(TECH, "one")).active).toBe(false);
      await schedule.slot();
      expect(Object.keys(ages(ws)).sort()).toEqual(["new-work", "one"]);
      native.deleteResult = true;
      const deleted = await ack(ws, TECH, fresh.public.snapshot_id as string, ["one"], "handled");
      expect(deleted.rows![0]!.state).toBe("deleted");
      expect(native.queues[TECH]).toEqual([entry("new-work")]);
    },
    SLOW,
  );

  contract(
    "the real question collector keeps partial old history apart from complete current proof",
    async () => {
      const { ws, native, schedule } = await setup((w) =>
        writeCodexRoute(w, { monitor_thread_id: ART }, [TECH]),
      );
      clear(ws, ART);
      const question = {
        turnId: "current",
        item: {
          id: "prompt",
          type: "agentMessage",
          text: "PRIVATE_UNRELATED_BODY",
          questions: [{ title: "Choose a local path", options: ["First", "Second"] }],
        },
      };
      const compact = {
        turnId: "older",
        item: { id: "old-compaction", type: "contextCompaction" },
      };
      const marker = {
        thread_id: TECH,
        state: "pending",
        pending_questions: [
          {
            question_turn_id: "current",
            question_item_id: "prompt",
            question_index: 0,
            title: "Choose a local path",
            options: ["First", "Second"],
            confirmed_pending: true,
            confirmed_at: new Date().toISOString(),
          },
        ],
      };
      writeDecision(ws, TECH, marker);
      native.threads[TECH] = {
        thread: {
          id: TECH,
          updatedAt: 1,
          status: { type: "active", activeFlags: ["waitingOnUserInput"] },
        },
      };
      native.turns[TECH] = [{ id: "current", status: "inProgress" }];
      let truncated = false;
      native.items = (params: Json) => {
        if (params.threadId !== TECH) return { data: [] };
        if (params.turnId) return { data: [question], truncated };
        return { data: [question, compact] };
      };
      await schedule.start();
      const first = readSnapshot((await schedule.slot()).output);
      const value = first.question_state[TECH];
      expect(value.status).toBe("partial");
      expect(value.complete).toBe(false);
      expect(value.latest_turn_proof.complete).toBe(true);
      expect(value.questions[0].proof_complete).toBe(true);
      const notices = () =>
        native
          .reminders()
          .filter((text) => text.includes("Owner-attested confirmed pending questions"));
      expect(notices()).toHaveLength(1);
      expect(notices()[0]).toContain("Choose a local path");
      expect(JSON.stringify(first)).not.toContain("PRIVATE_UNRELATED_BODY");
      truncated = true;
      const second = readSnapshot((await schedule.slot()).output);
      expect(second.question_state[TECH].latest_turn_proof.complete).toBe(false);
      expect(second.question_state[TECH].questions[0].state).toBe("unknown");
      expect(notices()).toHaveLength(1);
      expect(ws.readJson(join("unblock", "decisions", TECH + ".json"))).toEqual(marker);
    },
    SLOW,
  );

  contract(
    "a worker failure reminder requires exact lineage and a latest failed typed turn",
    async () => {
      const child = "00000000-0000-0000-0000-000000000003";
      const failedTurn = "00000000-0000-0000-0000-000000000004";
      const variants: Array<[string, Json, Json, boolean]> = [
        [
          "failed",
          { parentThreadId: TECH },
          { status: "failed", error: { codexErrorInfo: "contextWindowExceeded" } },
          true,
        ],
        [
          "invalid lineage",
          { parentThreadId: ART },
          { status: "failed", error: { codexErrorInfo: "contextWindowExceeded" } },
          false,
        ],
        [
          "retrying",
          { parentThreadId: TECH },
          { status: "inProgress", error: { codexErrorInfo: "contextWindowExceeded" } },
          false,
        ],
        ["recovered", { parentThreadId: TECH }, { status: "completed" }, false],
        [
          "untyped",
          { parentThreadId: TECH },
          { status: "failed", error: { message: "PRIVATE_BODY" } },
          false,
        ],
      ];
      for (const [name, lineage, turn, expected] of variants) {
        const { ws, native, schedule } = await setup();
        ws.writeRegistry({
          schema: 1,
          revision: 1,
          harness: "codex",
          roles: { tech: { conversations: { codex: TECH } } },
        });
        ws.config.reports = { workerParents: ["tech"] };
        clear(ws);
        native.queues = { [TECH]: [], [ART]: [] };
        native.socket.on("thread/list", (params: Json) => ({
          result: {
            data: params.archived
              ? []
              : [{ id: child, parentThreadId: TECH, status: { type: "idle" }, updatedAt: 1 }],
          },
        }));
        native.threads[child] = {
          thread: { id: child, status: { type: "idle" }, updatedAt: 1, ...lineage },
        };
        native.turns[child] = [{ id: failedTurn, ...turn }];
        await schedule.start();
        await schedule.slot();
        const reference = pyJson([[TECH, child, failedTurn, "contextWindowExceeded"]]);
        const reminders = native.reminders().join("\n");
        expect(reminders.includes("Verified latest failed child turns"), name).toBe(expected);
        if (expected) expect(reminders).toContain(reference);
        expect(reminders).not.toContain("PRIVATE_BODY");
        await schedule.stop();
      }
    },
    SLOW,
  );

  // 26 recipients times ten question pages exceed the shared 256-call collection budget.
  async function exhaustedBudget(): Promise<{ snap: Json; native: Native }> {
    const targets = Array.from(
      { length: 25 },
      (_, i) => `00000000-0000-0000-0000-${String(100 + i).padStart(12, "0")}`,
    );
    const { ws, native, schedule } = await setup((w) => writeCodexRoute(w, {}, targets));
    ws.writeRegistry({
      schema: 1,
      revision: 1,
      harness: "codex",
      roles: { tech: { conversations: { codex: TECH } } },
    });
    ws.config.reports = { workerParents: ["tech"] };
    clear(ws);
    native.queues = {};
    let page = 0;
    native.items = (params: Json) =>
      params.turnId ? { data: [] } : { data: [], nextCursor: `page-${++page}` };
    await schedule.start();
    return { snap: readSnapshot((await schedule.slot()).output), native };
  }

  contract(
    "worker and question collection share the reserved call budget",
    async () => {
      const { snap, native } = await exhaustedBudget();
      expect(snap.collection_budget.calls_used).toBe(256);
      expect(snap.collection_budget.reason_code).toBe("collection_call_budget_exhausted");
      expect(snap.worker_health[TECH].status).toBe("unavailable");
      expect(native.socket.methods()).not.toContain("thread/list");
    },
    SLOW,
  );
});
