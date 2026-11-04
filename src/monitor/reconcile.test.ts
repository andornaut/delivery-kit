import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  acceptedInventory,
  inventorySignature,
  questionBrief,
  type QuestionNotice,
  questionNotices,
  workerFailures,
} from "./reconcile.ts";
import { persist } from "./store.ts";

const OWNER = "00000000-0000-4000-8000-000000000002";
const MONITOR = "00000000-0000-4000-8000-000000000001";

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
    const [notice] = questionNotices(unblock, MONITOR, snapshot);
    expect(notice?.level).toBe("initial");
    persist(join(unblock, "health", `${MONITOR}.json`), {
      question_observations: {
        [notice!.identity]: {
          accepted_levels: ["initial"],
          first_slot: 1,
          last_slot: 1,
          signature: notice!.signature,
        },
      },
    });
    expect(questionNotices(unblock, MONITOR, snapshot)[0]?.level).toBe("escalation");
  });

  it("treats an unchanged accepted inventory as already reminded", () => {
    const unblock = mkdtempSync(join(tmpdir(), "reconcile-"));
    const snapshot = { errors: {}, queues: { [MONITOR]: [] } };
    expect(acceptedInventory(unblock, MONITOR, snapshot)).toBe(false);
    persist(join(unblock, "health", `${MONITOR}.json`), {
      accepted_signature: inventorySignature(unblock, snapshot),
    });
    expect(acceptedInventory(unblock, MONITOR, snapshot)).toBe(true);
  });
});
