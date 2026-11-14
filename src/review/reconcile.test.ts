import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RpcClient } from "../adapters/codex/rpc.ts";
import { recordHealth } from "./health.ts";
import {
  inventorySignature,
  questionBrief,
  type QuestionNotice,
  questionNotices,
  reconcileSlot,
  unacknowledged,
  workerFailures,
} from "./reconcile.ts";
import { payloadSignature, persist, queueEntry, retentionPath, snapshotPath } from "./store.ts";

const OWNER = "00000000-0000-4000-8000-000000000002";
const RECIPIENT = "00000000-0000-4000-8000-000000000001";

function question(index: number, options: unknown): Record<string, unknown> {
  return {
    item_id: "item",
    kind: "rendered_prompt",
    options,
    proof_complete: true,
    proof_refs: [
      {
        kind: "owner_pending_attestation",
        question_index: index,
        question_item_id: "item",
        question_turn_id: "turn",
        recipient: OWNER,
      },
    ],
    proof_scope: "latest_turn",
    question_index: index,
    state: "pending",
    title: "Choose",
    turn_id: "turn",
  };
}

describe("reconcile", () => {
  it.each(["wrong provider", "legacy matching"])(
    "keeps retention transport binding during mixed reconciliation: %s",
    (binding) => {
      const unblock = mkdtempSync(join(tmpdir(), "reconcile-retention-"));
      const entry = queueEntry("same-id", "same payload");
      persist(retentionPath(unblock, RECIPIENT, entry.id), {
        active: true,
        ...(binding === "wrong provider" ? { harness: "claude" } : {}),
        payload_signature: payloadSignature(entry),
        queue_id: entry.id,
        recipient: RECIPIENT,
        snapshot_id: "original",
      });
      if (binding === "legacy matching") {
        persist(snapshotPath(unblock, "original"), { harness: "codex", snapshot_id: "original" });
      }
      const [queues, count] = unacknowledged(unblock, {
        harness: "codex",
        harnesses: { [RECIPIENT]: "codex" },
        queues: { [RECIPIENT]: [entry] },
      });
      expect(count).toBe(binding === "legacy matching" ? 1 : 0);
      expect(queues[RECIPIENT]).toEqual(binding === "legacy matching" ? [] : [entry]);
    },
  );

  it("sorts and deduplicates verified failed child turns", () => {
    const child = (id: string) => ({
      child_id: id,
      error_code: "contextWindowExceeded",
      lineage_verified: true,
      parent_id: OWNER,
      requires_parent_action: true,
      turn_id: "t",
      turn_status: "failed",
    });
    const snapshot = {
      worker_health: { [OWNER]: { children: [child("b"), child("a"), child("a")] } },
    };
    expect(workerFailures(snapshot)).toEqual([
      [OWNER, "a", "t", "contextWindowExceeded"],
      [OWNER, "b", "t", "contextWindowExceeded"],
    ]);
  });

  it("bounds the question brief by whole rows", () => {
    const notices: QuestionNotice[] = Array.from({ length: 10 }, (_, index) => ({
      identity: `i${index}`,
      level: "initial",
      owner: OWNER,
      question: question(index, ["x".repeat(5000)]),
      signature: `s${index}`,
    }));
    const [rows, keys] = questionBrief(notices);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(10);
    expect(keys).toHaveLength(rows.length);
    expect(rows[0]).toMatchObject({ level: "initial", options: ["x".repeat(5000)], owner: OWNER });
  });

  it("escalates a proven question once at a distinct slot", () => {
    const unblock = mkdtempSync(join(tmpdir(), "reconcile-"));
    const snapshot = { question_state: { [OWNER]: { questions: [question(0, ["a"])] } }, slot: 2 };
    const [notice] = questionNotices(unblock, RECIPIENT, snapshot);
    expect(notice?.level).toBe("initial");
    persist(join(unblock, "health", `${RECIPIENT}.json`), {
      question_observations: {
        [notice!.identity]: {
          accepted_levels: ["initial"],
          first_slot: 1,
          last_slot: 1,
          signature: notice!.signature,
        },
      },
    });
    expect(questionNotices(unblock, RECIPIENT, snapshot)[0]?.level).toBe("escalation");
  });

  it.each(["retained"])(
    "sends a guarded review in each distinct slot with %s inventory",
    async (inventory) => {
      const unblock = mkdtempSync(join(tmpdir(), "reconcile-"));
      const entry = queueEntry("q1", "Review work");
      const snapshot = {
        errors: {},
        queues: { [OWNER]: inventory === "empty" ? [] : [entry] },
        snapshot_id: "snapshot",
      };
      persist(join(unblock, "decisions", `${RECIPIENT}.json`), {
        state: "clear",
        thread_id: RECIPIENT,
      });
      if (inventory === "retained") {
        persist(retentionPath(unblock, OWNER, entry.id), {
          active: true,
          payload_signature: payloadSignature(entry),
          queue_id: entry.id,
          recipient: OWNER,
        });
      }
      const call = vi.fn<RpcClient["call"]>(async (method) => {
        switch (method) {
          case "thread/read":
            return { thread: { canAcceptDirectInput: true, status: { type: "idle" } } };
          case "thread/turns/list":
            return { data: [{ id: "turn-one", status: "completed" }] };
          case "thread/items/list":
            return { data: [] };
          case "turn/start":
            return { turnId: "turn-two" };
          default:
            throw new Error(`Unexpected method: ${method}`);
        }
      });
      const client: RpcClient = { call, close: () => {} };
      const first = await reconcileSlot(
        client,
        { recipient: RECIPIENT, slot: 1, unblock },
        snapshot,
      );
      expect(first.status).toBe("accepted");
      recordHealth({ emit: vi.fn(), unblock }, RECIPIENT, 1, snapshot, first);
      const second = await reconcileSlot(
        client,
        { recipient: RECIPIENT, slot: 2, unblock },
        snapshot,
      );
      expect(second.status).toBe("accepted");
      expect(second.requestId).not.toBe(first.requestId);
      expect(call.mock.calls.map(([method]) => method)).toEqual([
        "thread/read",
        "thread/turns/list",
        "thread/items/list",
        "turn/start",
        "thread/read",
        "thread/turns/list",
        "thread/items/list",
        "turn/start",
      ]);
      const sends = call.mock.calls.filter(([method]) => method === "turn/start");
      expect(sends[0]?.[1]).toMatchObject({
        input: [{ text: expect.stringContaining("Scheduled review, slot 1.") }],
      });
      expect(sends[1]?.[1]).toMatchObject({
        input: [{ text: expect.stringContaining("Scheduled review, slot 2.") }],
      });
    },
  );

  it.each(["inventory error", "missing clearance"])(
    "blocks a distinct slot with accepted inventory and %s",
    async (blocker) => {
      const unblock = mkdtempSync(join(tmpdir(), "reconcile-"));
      const snapshot = { errors: {}, queues: { [RECIPIENT]: [] } };
      persist(join(unblock, "health", `${RECIPIENT}.json`), {
        accepted_signature: inventorySignature(unblock, snapshot),
      });
      if (blocker === "inventory error") {
        persist(join(unblock, "decisions", `${RECIPIENT}.json`), {
          state: "clear",
          thread_id: RECIPIENT,
        });
      }
      const call = vi.fn<RpcClient["call"]>();
      const result = await reconcileSlot(
        { call, close: () => {} },
        { recipient: RECIPIENT, slot: 2, unblock },
        { ...snapshot, errors: blocker === "inventory error" ? { [OWNER]: "unavailable" } : {} },
      );
      expect(result.status).toBe("deferred");
      expect(call).not.toHaveBeenCalled();
    },
  );
});
