import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { messageExpectation, MessageStore } from "../messages/store.ts";
import { recordHealth, recordMessageHealth } from "./health.ts";
import { captureMessageSummary } from "./snapshot.ts";

const RECIPIENT = "00000000-0000-4000-8000-000000000001";

function snapshot(ids: string[]): Record<string, unknown> {
  return {
    errors: {},
    history: { [RECIPIENT]: { reason_code: "complete", status: "complete" } },
    question_state: {},
    queues: {
      [RECIPIENT]: ids.map((id) => ({
        clientUserMessageId: id,
        id,
        input: [{ text: id, type: "text" }],
      })),
    },
    snapshot_id: "00000000-0000-4000-8000-0000000000aa",
    worker_health: {},
  };
}

describe("recordHealth", () => {
  it("ages items across distinct slots and reports one episode", () => {
    const unblock = mkdtempSync(join(tmpdir(), "health-"));
    const events: string[] = [];
    const context = { emit: (_kind: string, key: string) => events.push(key), unblock };
    const first = recordHealth(context, RECIPIENT, 60, snapshot(["a"]), { status: "accepted" });
    expect(first).toMatchObject({ backlog_slots: 1, review_status: "ok" });
    expect(first).not.toHaveProperty("process_health_status");
    const second = recordHealth(context, RECIPIENT, 120, snapshot(["a", "b"]), {
      status: "unchanged",
    });
    expect(second).toMatchObject({ backlog_slots: 2, review_status: "failed" });
    expect(second.review_reason).toContain("unacknowledged queue items");
    recordHealth(context, RECIPIENT, 180, snapshot(["a", "b"]), { status: "unchanged" });
    expect(events).toHaveLength(1);
    const record = JSON.parse(
      readFileSync(join(unblock, "health", `${RECIPIENT}.json`), "utf8"),
    ) as {
      backlog_items: Record<string, Record<string, { age: number }>>;
    };
    expect(record.backlog_items[RECIPIENT]?.b?.age).toBe(2);
    const recovered = recordHealth(context, RECIPIENT, 240, snapshot([]), { status: "accepted" });
    expect(recovered).toMatchObject({ backlog_slots: 0, review_status: "ok" });
  });

  it("does not age a deferral explained by the recipient's own question", () => {
    const unblock = mkdtempSync(join(tmpdir(), "health-"));
    const context = { emit: () => undefined, unblock };
    for (const slot of [60, 120]) {
      const health = recordHealth(context, RECIPIENT, slot, snapshot([]), {
        status: "deferred",
        waiting_on_user: true,
      });
      expect(health).toMatchObject({ deferral_slots: 0, review_status: "ok" });
    }
  });
});

describe("scheduled durable message health", () => {
  function inbox() {
    const root = mkdtempSync(join(tmpdir(), "message-health-"));
    const layout = { reviewDir: join(root, "review") };
    const store = new MessageStore({
      layout,
      resolveOwner: () => ({ harness: "codex", nativeId: RECIPIENT, parentBinding: null }),
    });
    return { context: { unblock: join(root, "unblock") }, layout, store };
  }

  it("ages accepted-but-unhandled local IDs across known distinct slots without native ACK mapping", async () => {
    const { context, layout, store } = inbox();
    const queued = await store.enqueue({
      schema: 1,
      id: "local-only",
      body: "private body",
      created: "2026-11-14T20:00:00Z",
      fromRole: "art-kit",
      toRole: "game-coordinator",
      intent: "queue",
    });
    const first = recordMessageHealth(context, RECIPIENT, 60, captureMessageSummary(layout));
    expect(first).toMatchObject({ message_health_status: "ok", message_backlog_slots: 1 });
    const lease = await store.beginAttempt(messageExpectation(queued));
    const accepted = lease.complete({ source: lease.source, state: "accepted", reason: null });
    expect(
      recordMessageHealth(context, RECIPIENT, 60, captureMessageSummary(layout)),
    ).toMatchObject({
      message_health_status: "ok",
      message_backlog_slots: 1,
    });
    expect(
      recordMessageHealth(context, RECIPIENT, 120, {
        schema: 1,
        status: "unavailable",
        reason: "unreadable-inbox",
        counts: null,
        messages: null,
      }),
    ).toMatchObject({
      message_health_status: "unknown",
      message_backlog_slots: null,
      message_counts: null,
    });
    const second = recordMessageHealth(context, RECIPIENT, 180, captureMessageSummary(layout));
    expect(second).toMatchObject({
      message_health_status: "stalled",
      message_backlog_slots: 2,
      message_stalled: [
        {
          id: "local-only",
          ownerRole: "game-coordinator",
          nextAction: expect.stringContaining("preserve questions"),
        },
      ],
    });
    const state = JSON.parse(
      readFileSync(join(context.unblock, "health", `messages-${RECIPIENT}.json`), "utf8"),
    );
    expect(state.message_backlog_items["local-only"].slots).toEqual([60, 180]);
    expect(state).not.toHaveProperty("backlog_items");
    expect(JSON.stringify(state)).not.toContain(queued.envelope.body);
    expect(store.read("local-only")).toEqual(accepted);
    const expected = messageExpectation(accepted);
    await store.reconcile(expected, {
      kind: "handled",
      ref: "recipient/handled",
      retention: null,
      source: expected.source,
    });
    expect(
      recordMessageHealth(context, RECIPIENT, 240, captureMessageSummary(layout)),
    ).toMatchObject({
      message_backlog_slots: 0,
      message_counts: { handled: 1 },
      message_health_status: "ok",
      message_stalled: [],
    });
  });

  it("reports retained, held and guarded IDs after two slots without changing their protections", async () => {
    const { context, layout, store } = inbox();
    const input = {
      schema: 1 as const,
      body: "unanswered question stays private",
      created: "2026-11-14T20:00:00Z",
      fromRole: "art-kit",
      toRole: "game-coordinator",
      intent: "queue" as const,
    };
    const retention = {
      ownerRole: "game-coordinator",
      reason: "pending user decision",
      nextBoundary: "explicit owner answer",
    };
    const queued = await store.enqueue({ ...input, id: "question" });
    const retained = await store.reconcile(messageExpectation(queued), {
      kind: "retained",
      ref: "owner/decision",
      retention,
      source: null,
    });
    const held = await store.hold(
      messageExpectation(await store.enqueue({ ...input, id: "held" })),
      retention,
    );
    const guarded = await store.enqueue({ ...input, id: "guarded" });
    const lease = await store.beginAttempt(messageExpectation(guarded));
    const blocked = lease.complete({ reason: "guarded", source: lease.source, state: "blocked" });
    const questionPath = join(context.unblock, "decisions", `${RECIPIENT}.json`);
    const marker = JSON.stringify({
      state: "pending",
      thread_id: RECIPIENT,
      question: "owner decision remains open",
    });
    mkdirSync(join(context.unblock, "decisions"), { recursive: true });
    writeFileSync(questionPath, marker);
    expect(
      recordMessageHealth(context, RECIPIENT, 60, captureMessageSummary(layout)),
    ).toMatchObject({
      message_health_status: "ok",
      message_backlog_slots: 1,
      message_stalled: [],
    });
    expect(
      recordMessageHealth(context, RECIPIENT, 60, captureMessageSummary(layout)),
    ).toMatchObject({
      message_health_status: "ok",
      message_backlog_slots: 1,
    });
    const second = recordMessageHealth(context, RECIPIENT, 120, captureMessageSummary(layout));
    expect(second).toMatchObject({
      message_health_status: "stalled",
      message_backlog_slots: 2,
    });
    expect(second.message_stalled).toHaveLength(3);
    expect(second.message_stalled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "question",
          reason: "retained",
          protected: true,
          ownerRole: retention.ownerRole,
          nextBoundary: retention.nextBoundary,
          nextAction: expect.stringContaining("actual recorded nextBoundary without changing it"),
        }),
        expect.objectContaining({
          id: "held",
          reason: "explicit-hold",
          protected: true,
          ownerRole: retention.ownerRole,
          nextBoundary: retention.nextBoundary,
        }),
        expect.objectContaining({
          id: "guarded",
          reason: "guarded",
          protected: true,
          ownerRole: "game-coordinator",
          nextBoundary: null,
          nextAction: expect.stringContaining("records the blocker and an explicit nextBoundary"),
        }),
      ]),
    );
    expect(second.message_protected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "question",
          ownerRole: retention.ownerRole,
          nextBoundary: retention.nextBoundary,
        }),
        expect.objectContaining({ id: "held" }),
        expect.objectContaining({ id: "guarded", reason: "guarded" }),
      ]),
    );
    expect(store.read("question")).toEqual(retained);
    expect(store.read("held")).toEqual(held);
    expect(store.read("guarded")).toEqual(blocked);
    expect(readFileSync(questionPath, "utf8")).toBe(marker);
  });
});
