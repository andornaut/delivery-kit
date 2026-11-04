// Recipient-bound user-decision clearance (unblock.py:118-145). The marker is written by the
// recipient's owner; delivery-kit only reads it. A missing or invalid marker is never clearance.
import { join } from "node:path";

import { readJsonIfExists } from "../../durable.ts";

const FIELDS = [
  "question_turn_id",
  "question_item_id",
  "answer_turn_id",
  "answer_item_id",
] as const;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DecisionRecord = Readonly<Record<string, unknown>>;

/** The validated marker in `<unblock>/decisions/<recipient>.json`, or null. */
export function decisionRecord(unblockDir: string, recipient: string): DecisionRecord | null {
  if (!CANONICAL_UUID.test(recipient)) {
    return null;
  }
  let marker: unknown;
  try {
    marker = readJsonIfExists(join(unblockDir, "decisions", `${recipient}.json`));
  } catch {
    return null;
  }
  if (typeof marker !== "object" || marker === null || Array.isArray(marker)) {
    return null;
  }
  const record = marker as DecisionRecord;
  if (record.thread_id !== recipient) {
    return null;
  }
  const resolutions = Object.hasOwn(record, "resolutions") ? record.resolutions : [];
  if (!Array.isArray(resolutions)) {
    return null;
  }
  const seen = new Set<string>();
  for (const resolution of resolutions as unknown[]) {
    if (typeof resolution !== "object" || resolution === null) {
      return null;
    }
    const entry = resolution as Record<string, unknown>;
    if (FIELDS.some((field) => typeof entry[field] !== "string" || entry[field] === "")) {
      return null;
    }
    const reference = JSON.stringify([entry.question_turn_id, entry.question_item_id]);
    if (seen.has(reference)) {
      return null;
    }
    seen.add(reference);
  }
  return record;
}

export function decisionClear(unblockDir: string, recipient: string): boolean {
  return decisionRecord(unblockDir, recipient)?.state === "clear";
}
