// Scheduled reminder briefs for owner-attested questions and failed worker turns
//.
import { afterEach, expect } from "vitest";

import { CASE_TIMEOUT_MS, contract, suite, workspaces } from "../lib/cases.ts";
import { ART, CHILD, emptyQueue, GAMEPLAY, type NativeWorld, TECH } from "../lib/unblock-native.ts";
import { confirmedAt, decide, Monitored, wake } from "../lib/unblock-runner.ts";
import type { Workspace } from "../lib/workspace.ts";

const TITLE = "Choose the local path";
const FAILED_ONE = "00000000-0000-0000-0000-00000000f001";
const FAILED_TWO = "00000000-0000-0000-0000-00000000f002";

interface Question {
  item?: string;
  title?: string;
  options?: string[];
  count?: number;
}

/** A rendered question on the owner's latest turn, optionally with an exact owner attestation. */
function question(
  m: Monitored,
  owner: string,
  {
    item = "question-item",
    title = TITLE,
    options = ["First", "Second"],
    count = 1,
  }: Question = {},
  attested = true,
): void {
  const questions = Array.from({ length: count }, () => ({ title, options }));
  const thread = m.world.thread(owner);
  thread.status = { type: "active", activeFlags: ["waitingOnUserInput"] };
  thread.turn = { id: "question-turn", status: "inProgress" };
  thread.read = { id: owner, updatedAt: 1 };
  thread.items = () => ({
    data: [{ turnId: "question-turn", item: { id: item, type: "agentMessage", questions } }],
  });
  const pending = questions.map((q, index) => ({
    question_turn_id: "question-turn",
    question_item_id: item,
    question_index: index,
    title: q.title,
    options: q.options,
    confirmed_at: confirmedAt(),
    confirmed_pending: true,
  }));
  decide(
    m.ws,
    owner,
    attested
      ? { thread_id: owner, state: "pending", pending_questions: pending }
      : { thread_id: owner, state: "clear" },
  );
}

/** The owner's exact reply after its question, attested in its resolution record. */
function answered(m: Monitored, owner: string, item = "question-item"): void {
  const thread = m.world.thread(owner);
  thread.status = { type: "idle" };
  thread.items = () => ({
    data: [
      { turnId: "answer-turn", item: { id: "answer-item", type: "userMessage" } },
      {
        turnId: "question-turn",
        item: {
          id: item,
          type: "agentMessage",
          questions: [{ title: TITLE, options: ["First", "Second"] }],
        },
      },
    ],
  });
  decide(m.ws, owner, {
    thread_id: owner,
    state: "clear",
    resolutions: [
      {
        question_turn_id: "question-turn",
        question_item_id: item,
        answer_turn_id: "answer-turn",
        answer_item_id: "answer-item",
      },
    ],
  });
}

function emptyQueues(world: NativeWorld): void {
  for (const thread of [TECH, ART, GAMEPLAY]) world.thread(thread).queue = emptyQueue;
}

/** Give the monitor a fresh queued entry so the next slot has a new inventory to remind. */
function newWork(world: NativeWorld, id: string): void {
  world.thread(TECH).queue = () => ({ data: [{ id, clientUserMessageId: id, input: [] }] });
}

function briefQuestions(text: string): Array<Record<string, unknown>> {
  const start = "Owner-attested confirmed pending questions: ";
  const end = ". Surface the exact owner";
  const at = text.indexOf(start);
  if (at < 0) return [];
  return JSON.parse(text.slice(at + start.length, text.indexOf(end, at)));
}

suite("unblock briefs", () => {
  const workspace = workspaces();
  const open: Monitored[] = [];
  afterEach(async () => {
    for (const monitored of open.splice(0)) await monitored.close();
  });
  async function routed(ws: Workspace = workspace()): Promise<Monitored> {
    const monitored = await Monitored.routed(ws);
    emptyQueues(monitored.world);
    open.push(monitored);
    return monitored;
  }

  contract(
    "a confirmed question is briefed at its first slot, escalated once at a distinct slot, then quiet",
    async () => {
      const m = await routed();
      question(m, ART);
      await m.start();
      expect((await m.slot(wake(0))).result?.status).toBe("accepted");
      const text = m.world.lastText();
      for (const value of [ART, "question-turn", "question-item", TITLE, "First", "Second"])
        expect(text).toContain(value);
      expect(text).toContain('"level": "initial"');
      expect(text).toContain("Never auto reissue");
      expect(text).toContain("UI visibility is unknown");
      expect((await m.slot(wake(1))).result?.status).toBe("accepted");
      expect(m.world.lastText()).toContain('"level": "escalation"');
      expect((await m.slot(wake(2))).result?.status).toBe("unchanged");
      expect(m.world.mutations()).toHaveLength(2);
      expect(m.world.mutations().every((call) => call.params.threadId === TECH)).toBe(true);
    },
  );

  contract(
    "unknown, answered and unproven questions are never briefed, and a pending guard still defers",
    async () => {
      const m = await routed();
      const title = "UNCONFIRMED_PRIVATE_TITLE";
      // Unknown: a rendered question without any owner attestation.
      question(m, ART, { title }, false);
      await m.start();
      expect((await m.slot(wake(0))).result?.status).toBe("accepted");
      // Answered: the exact attested reply follows the question.
      answered(m, ART);
      newWork(m.world, "work-1");
      expect((await m.slot(wake(1))).result?.status).toBe("accepted");
      // Unproven: attested, but the owner's latest turn cannot be read consistently.
      question(m, ART, { title });
      m.world.thread(ART).read = {};
      newWork(m.world, "work-2");
      expect((await m.slot(wake(2))).result?.status).toBe("accepted");
      for (const call of m.world.mutations()) {
        const text = String((call.params.input as Array<{ text: string }>)[0]?.text);
        expect(text).not.toContain(title);
        expect(text).not.toContain("Owner-attested confirmed pending questions");
      }
      // Proven, but the monitor's own decision guard is pending.
      question(m, ART, { title });
      decide(m.ws, TECH, { thread_id: TECH, state: "pending" });
      newWork(m.world, "work-3");
      expect((await m.slot(wake(3))).result?.status).toBe("deferred");
      expect(m.world.mutations()).toHaveLength(3);
      expect(m.ws.readJson(`unblock/decisions/${TECH}.json`).state).toBe("pending");
    },
  );

  contract(
    "an answered question is not resurrected; a replacement question is briefed as initial",
    async () => {
      const m = await routed();
      question(m, ART);
      await m.start();
      expect((await m.slot(wake(0))).result?.status).toBe("accepted");
      answered(m, ART);
      expect((await m.slot(wake(1))).result?.status).toBe("unchanged");
      question(m, ART, { item: "replacement-exact-item" });
      expect((await m.slot(wake(2))).result?.status).toBe("accepted");
      const [row, ...rest] = briefQuestions(m.world.lastText());
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        level: "initial",
        item_id: "replacement-exact-item",
        owner: ART,
      });
    },
  );

  contract("an answered question identity cannot become pending again", async () => {
    const m = await routed();
    question(m, ART);
    await m.start();
    expect((await m.slot(wake(0))).result?.status).toBe("accepted");
    answered(m, ART);
    expect((await m.slot(wake(1))).result?.status).toBe("unchanged");
    question(m, ART);
    expect((await m.slot(wake(2))).result?.status).toBe("unchanged");
    expect(m.world.mutations()).toHaveLength(1);
  });

  contract("the monitor's own confirmed question wait never fails health by itself", async () => {
    const m = await routed();
    question(m, TECH);
    await m.start();
    for (const index of [0, 1]) {
      const tick = await m.slot(wake(index));
      expect(tick.result).toMatchObject({
        status: "deferred",
        monitor_status: "ok",
        deferral_slots: 0,
      });
      expect(m.receipt(wake(index)).waiting_on_user).toBe(true);
    }
    expect(m.ws.events().filter((event) => event.kind === "monitor-stuck")).toEqual([]);
    expect(m.world.mutations()).toEqual([]);
  });

  contract("the question brief is bounded without slicing original options", async () => {
    const m = await routed();
    question(m, ART, { options: ["x".repeat(5000), "Second"], count: 10 });
    await m.start();
    expect((await m.slot(wake(0))).result?.status).toBe("accepted");
    const rows = briefQuestions(m.world.lastText());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(10);
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(32768);
    expect(
      rows.every(
        (row) => JSON.stringify(row.options) === JSON.stringify(["x".repeat(5000), "Second"]),
      ),
    ).toBe(true);
    expect((m.receipt(wake(0)).question_notice_keys as unknown[]).length).toBe(rows.length);
  });

  contract(
    "a new worker failure bypasses an unchanged queue and preserves the guard",
    async () => {
      const m = await routed();
      m.ws.config.reports = { workerParents: ["art"] };
      const child = (turn: string) => {
        m.world.children.set(`${ART}:false`, [
          {
            id: CHILD,
            parentThreadId: ART,
            source: { subAgent: { thread_spawn: { parent_thread_id: ART, depth: 1 } } },
            status: { type: "idle" },
            updatedAt: 1,
          },
        ]);
        const thread = m.world.thread(CHILD);
        thread.read = {
          id: CHILD,
          parentThreadId: ART,
          source: { subAgent: { thread_spawn: { parent_thread_id: ART, depth: 1 } } },
          updatedAt: 1,
        };
        thread.status = { type: "idle" };
        thread.turn = {
          id: turn,
          status: "failed",
          error: { codexErrorInfo: "contextWindowExceeded" },
        };
      };
      child(FAILED_ONE);
      await m.start();
      expect((await m.slot(wake(0))).result?.status).toBe("accepted");
      const text = m.world.lastText();
      for (const reference of [ART, CHILD, FAILED_ONE, "contextWindowExceeded"])
        expect(text).toContain(reference);
      expect(text).toContain("recipient guards");
      expect(text).toContain("Parent decides");
      expect((await m.slot(wake(1))).result?.status).toBe("unchanged");
      expect(m.world.mutations()).toHaveLength(1);
      child(FAILED_TWO);
      decide(m.ws, TECH, { thread_id: TECH, state: "pending" });
      expect((await m.slot(wake(2))).result?.status).toBe("deferred");
      expect(m.world.mutations()).toHaveLength(1);
      decide(m.ws, TECH, { thread_id: TECH, state: "clear" });
      expect((await m.slot(wake(3))).result?.status).toBe("accepted");
      expect(m.world.mutations()).toHaveLength(2);
      expect(m.world.mutations().every((call) => call.params.threadId === TECH)).toBe(true);
      const record = m.health();
      expect(record.accepted_worker_failures).toHaveLength(2);
      expect(record).not.toHaveProperty("handled");
      // The earlier failure was already reminded, so it does not force another reminder.
      child(FAILED_ONE);
      expect((await m.slot(wake(4))).result?.status).toBe("unchanged");
      // Child health is collected at every slot through the scoped parent inventory only.
      const inventories = m.socket.callsOf("thread/list");
      expect(inventories.every((call) => call.params.parentThreadId === ART)).toBe(true);
      expect(
        m.socket.calls
          .filter((call) => call.method.startsWith("turn/"))
          .every((call) => call.params.threadId !== CHILD),
      ).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});
