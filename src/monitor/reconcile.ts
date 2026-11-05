// Scheduled reminder reconciliation over one snapshot: which queue IDs, owner-attested
// questions and failed worker turns still need a reminder, the bounded brief
// that carries them, and the guarded send. State lives in `<unblock>/health/<recipient>.json`
// and the slot receipt; their keys are persisted game state.
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { RpcClient } from "../adapters/codex/rpc.ts";
import {
  CLEARANCE_MISSING,
  persistSlot,
  sendSlot,
  type SlotState,
} from "../adapters/codex/slot.ts";
import { decisionClear } from "../adapters/shared/decisions.ts";
import { slotRequestId } from "../adapters/shared/ids.ts";
import {
  dumpsDigest,
  isRecord,
  type PyJson,
  pyJsonDumps,
  sameJson,
  unicodeDumps,
} from "../adapters/shared/pyjson.ts";
import { type Json, type QueueEntry, readRecord, retained, snapshotPath } from "./store.ts";

const BRIEF_BOUND = 32768;
const DIAGNOSTIC_BOUND = 4096;

export function rec(value: unknown): Json {
  return isRecord(value) ? value : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** dict.get(key): a missing key is None. */
function get(object: Json, key: string): unknown {
  return object[key] ?? null;
}

function pick(object: Json, keys: readonly string[]): Json {
  return Object.fromEntries(keys.map((key) => [key, get(object, key)]));
}

/** sha256 of json.dumps(value, sort_keys=True). */
export function hash(value: unknown): string {
  return dumpsDigest(value as PyJson);
}

/** json.dumps(value) with ASCII escapes. */
function ascii(value: unknown): string {
  return pyJsonDumps(value, false, true);
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function healthPath(unblock: string, recipient: string): string {
  return join(unblock, "health", `${recipient}.json`);
}

/** The recipient's health record, or {} when it does not exist yet. */
function readHealth(unblock: string, recipient: string): Json {
  return readRecord(healthPath(unblock, recipient)) ?? {};
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function containsJson(rows: readonly unknown[], value: unknown): boolean {
  return rows.some((row) => sameJson(row, value));
}

function compareTuples(left: readonly unknown[], right: readonly unknown[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = String(left[index]);
    const b = String(right[index]);
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return left.length - right.length;
}

/** sorted(set(tuple(row) for row in rows)) as lists. */
export function sortedUnique(rows: readonly unknown[]): unknown[][] {
  const unique = new Map<string, unknown[]>();
  for (const row of rows) {
    const items = list(row);
    unique.set(ascii(items), items);
  }
  return [...unique.values()].sort(compareTuples);
}

function snapshotQueues(snapshot: Json): Record<string, QueueEntry[]> {
  return rec(snapshot.queues) as Record<string, QueueEntry[]>;
}

/** Queue entries without an exact active retention, and the retained count. */
export function unacknowledged(
  unblock: string,
  snapshot: Json,
): [Record<string, QueueEntry[]>, number] {
  const queues: Record<string, QueueEntry[]> = {};
  let kept = 0;
  for (const [recipient, entries] of Object.entries(snapshotQueues(snapshot))) {
    const open: QueueEntry[] = [];
    for (const entry of entries) {
      if (retained(unblock, recipient, entry)) {
        kept += 1;
      } else {
        open.push(entry);
      }
    }
    queues[recipient] = open;
  }
  return [queues, kept];
}

export function inventorySignature(unblock: string, snapshot: Json): string {
  const [queues] = unacknowledged(unblock, snapshot);
  return hash({ errors: rec(snapshot.errors), queues });
}

export function hasErrors(snapshot: Json): boolean {
  return Object.keys(rec(snapshot.errors)).length > 0;
}

/** Verified latest failed child turns as sorted [parent, child, turn, error_code] references. */
export function workerFailures(snapshot: Json): unknown[][] {
  const references: unknown[] = [];
  for (const [parent, health] of Object.entries(rec(snapshot.worker_health))) {
    for (const value of list(rec(health).children)) {
      const child = rec(value);
      if (
        child.parent_id === parent &&
        child.lineage_verified === true &&
        child.requires_parent_action === true &&
        child.turn_status === "failed" &&
        ["child_id", "turn_id", "error_code"].every(
          (field) => typeof child[field] === "string" && child[field] !== "",
        )
      ) {
        references.push([parent, child.child_id, child.turn_id, child.error_code]);
      }
    }
  }
  return sortedUnique(references);
}

function pendingWorkerFailures(
  unblock: string,
  recipient: string,
  snapshot: Json,
): unknown[][] {
  const accepted = list(readHealth(unblock, recipient).accepted_worker_failures);
  return workerFailures(snapshot).filter((reference) => !containsJson(accepted, reference));
}

export type Observation = readonly [signature: string, owner: string, question: Json];

/** Well-formed question observations by identity digest. */
export function questionObservations(snapshot: Json): Map<string, Observation> {
  const observations = new Map<string, Observation>();
  for (const [recipient, health] of Object.entries(rec(snapshot.question_state))) {
    for (const value of list(rec(health).questions)) {
      if (!isRecord(value) || !["pending", "answered", "unknown"].includes(String(value.state))) {
        continue;
      }
      const question = value;
      if (
        !["turn_id", "item_id", "kind"].every(
          (key) => typeof question[key] === "string" && question[key] !== "",
        ) ||
        !isInt(question.question_index) ||
        question.question_index < 0
      ) {
        continue;
      }
      const identity = hash([
        recipient,
        question.turn_id,
        question.item_id,
        question.question_index,
        question.kind,
      ]);
      const signature = hash([
        identity,
        question.state,
        get(question, "title"),
        get(question, "options"),
      ]);
      observations.set(identity, [signature, recipient, question]);
    }
  }
  return observations;
}

/** An owner-attested pending question on its owner's latest turn. */
function pendingProven(owner: string, question: Json): boolean {
  const proofs = question.proof_refs;
  return (
    question.state === "pending" &&
    question.proof_complete === true &&
    question.proof_scope === "latest_turn" &&
    Array.isArray(proofs) &&
    (proofs as unknown[]).some(
      (proof) =>
        isRecord(proof) &&
        proof.kind === "owner_pending_attestation" &&
        proof.recipient === owner &&
        proof.question_turn_id === question.turn_id &&
        proof.question_item_id === question.item_id &&
        proof.question_index === question.question_index,
    )
  );
}

export interface QuestionNotice {
  readonly identity: string;
  readonly signature: string;
  readonly level: "initial" | "escalation";
  readonly owner: string;
  readonly question: Json;
}

export function questionNotices(
  unblock: string,
  recipient: string,
  snapshot: Json,
  slot: number | null = null,
): QuestionNotice[] {
  const previous = rec(readHealth(unblock, recipient).question_observations);
  const current = slot ?? (isInt(snapshot.slot) ? snapshot.slot : null);
  const notices: QuestionNotice[] = [];
  for (const [identity, [signature, owner, question]] of questionObservations(snapshot)) {
    if (!pendingProven(owner, question)) {
      continue;
    }
    const old = rec(previous[identity]);
    const lastSlot = old.last_slot ?? null;
    if (
      (old.answered_seen !== undefined &&
        old.answered_seen !== null &&
        old.answered_seen !== false) ||
      (current !== null && lastSlot !== null && current < Number(lastSlot))
    ) {
      continue;
    }
    const matching = old.signature === signature;
    const firstSlot = old.first_slot ?? null;
    const level =
      matching && current !== null && firstSlot !== null && firstSlot !== current
        ? "escalation"
        : "initial";
    if (matching && list(old.accepted_levels).includes(level)) {
      continue;
    }
    notices.push({ identity, level, owner, question, signature });
  }
  return notices;
}

const BRIEF_FIELDS = ["turn_id", "item_id", "question_index", "kind", "title", "options"] as const;

/** Brief rows within the byte bound, never slicing original choices, and their notice keys. */
export function questionBrief(notices: readonly QuestionNotice[]): [Json[], Json[]] {
  const rows: Json[] = [];
  const keys: Json[] = [];
  for (const notice of notices) {
    const row: Json = Object.fromEntries([
      ["owner", notice.owner],
      ["level", notice.level],
      ...BRIEF_FIELDS.map((key) => [key, get(notice.question, key)]),
    ]);
    if (bytes(unicodeDumps([...rows, row])) > BRIEF_BOUND) {
      break;
    }
    rows.push(row);
    keys.push(
      Object.fromEntries([
        ["identity", notice.identity],
        ["signature", notice.signature],
        ["level", notice.level],
      ]),
    );
  }
  return [rows, keys];
}

/** Whether the snapshot's unacknowledged inventory was already reminded or explicitly retained. */
export function acceptedInventory(unblock: string, recipient: string, snapshot: Json): boolean {
  if (
    pendingWorkerFailures(unblock, recipient, snapshot).length > 0 ||
    questionNotices(unblock, recipient, snapshot).length > 0
  ) {
    return false;
  }
  const [queues, kept] = unacknowledged(unblock, snapshot);
  const errors = hasErrors(snapshot);
  if (kept > 0 && !Object.values(queues).some((entries) => entries.length > 0) && !errors) {
    return true;
  }
  const path = healthPath(unblock, recipient);
  if (errors || !existsSync(path)) {
    return false;
  }
  return (
    readHealth(unblock, recipient).accepted_signature === inventorySignature(unblock, snapshot)
  );
}

export interface Brief {
  readonly workerFailures: readonly unknown[];
  readonly questions: readonly Json[];
  readonly questionDiagnostics: readonly Json[];
}

export function reminder(
  slot: number,
  queues: Readonly<Record<string, readonly string[]>>,
  snapshotFile: string,
  brief: Brief,
): string {
  const inventory = Object.entries(queues)
    .map(([thread, ids]) => `${thread}: ${ids.length > 0 ? ids.join(",") : "none"}`)
    .join("\n");
  const workerReview =
    brief.workerFailures.length > 0
      ? `\nVerified latest failed child turns (parent, child, turn, typed code): ${ascii(brief.workerFailures)}.` +
        " Live deliver these exact references to the owning parent only after checking its " +
        "recipient guards and native questions. Request that parent checkpoint and quiesce affected " +
        "approved work before reassigning to a healthy existing worker or replacement, within the " +
        "session's worker limits. Preserve WIP, worktrees, jobs, exact decisions and " +
        "unanswered questions. Parent decides and confirms handling; acceptance is delivery only. " +
        "Do not contact or mutate children, spawn workers, clear guards, or infer stalls from silence."
      : "";
  const questionReview =
    brief.questions.length > 0
      ? `\nOwner-attested confirmed pending questions: ${unicodeDumps(brief.questions)}.` +
        " Surface the exact owner, native references, original title and choices, and where to answer " +
        "in the owner's native conversation. An escalation is a visibility notification after distinct " +
        "scheduled slots, not queue starvation, failed work, recovery or clearance. Only if needed, ask " +
        "that owner to restore its prompt through supported controls while preserving the original " +
        "decision and any replacement mapping. Never auto reissue, answer, cancel, clear guards, " +
        "interrupt or create another owner's question. UI visibility is unknown; acceptance is delivery only."
      : "";
  const diagnosticReview =
    brief.questionDiagnostics.length > 0
      ? `\nQuestion capability diagnostics (no pending-decision inference): ${ascii(brief.questionDiagnostics)}`
      : "";
  return (
    `Scheduled monitoring review, slot ${slot}. Review recent Art, Gameplay and Tech activity ` +
    "and these persisted queue IDs. Reconcile already handled IDs; prioritize actual user replies " +
    "and dependency unblockers. Use native live steering only for confirmed unblockers. Remove an " +
    "original only after confirmed delivery or reconciliation. Preserve unanswered questions and " +
    "independent work; silence is not a decision. Resolve reciprocal waits with the smallest owner " +
    "question. Report only new or unresolved blockers. This is a triage reminder, not permission " +
    "to interrupt turns, answer questions, restart work, or duplicate deliveries.\n" +
    `Full local inventory: ${snapshotFile}\n${inventory}${workerReview}${questionReview}` +
    `${diagnosticReview}`
  );
}

const QUESTION_DIAGNOSTIC_FIELDS = [
  "status",
  "pending_status",
  "cancelled_status",
  "ui_visibility",
  "diagnostics",
] as const;
function questionDiagnostics(snapshot: Json, snapshotFile: string): Json[] {
  const diagnostics = Object.entries(rec(snapshot.question_state)).map(([owner, value]) => ({
    owner,
    ...pick(rec(value), QUESTION_DIAGNOSTIC_FIELDS),
  }));
  // Diagnostics carry safe capability codes only, never unknown question bodies.
  if (bytes(ascii(diagnostics)) > DIAGNOSTIC_BOUND) {
    return [
      { reason_code: "question_diagnostics_exceed_brief_bounds", snapshot_path: snapshotFile },
    ];
  }
  return diagnostics;
}

export interface ReconcileTarget {
  readonly unblock: string;
  readonly coordinator: string;
  readonly slot: number;
  /** Aborts when the runner stops. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Reconcile: persist and return the slot receipt for one captured snapshot, sending at
 * most one reminder (plus one stale-turn refresh) when the inventory is new and the guards allow.
 */
export async function reconcileSlot(
  client: RpcClient,
  target: ReconcileTarget,
  captured: Json,
): Promise<SlotState> {
  const { coordinator, slot, unblock } = target;
  const path = join(unblock, `${coordinator}-${slot}.json`);
  const snapshot: Json = { ...captured, slot };
  const queues = Object.fromEntries(
    Object.entries(snapshotQueues(snapshot)).map(([thread, entries]) => [
      thread,
      entries.map((entry) => entry.id),
    ]),
  );
  const snapshotFile = snapshotPath(unblock, String(snapshot.snapshot_id));
  const state: SlotState = Object.fromEntries([
    ["coordinator", coordinator],
    ["slot", slot],
    ["queues", queues],
    ["snapshot_id", snapshot.snapshot_id],
    ["snapshot_path", snapshotFile],
    ["requestId", slotRequestId(coordinator, slot)],
  ]);
  const finish = (updates: SlotState): SlotState => {
    Object.assign(state, updates);
    persistSlot(path, state);
    return state;
  };
  if (hasErrors(snapshot)) {
    return finish({
      reason: "queue inventory incomplete; inspect snapshot and retry reconciliation",
      status: "deferred",
    });
  }
  const ownWait = list(rec(rec(snapshot.question_state)[coordinator]).questions).some((question) =>
    pendingProven(coordinator, rec(question)),
  );
  if (!decisionClear(unblock, coordinator)) {
    state.waiting_on_user = ownWait;
    return finish({ reason: CLEARANCE_MISSING, status: "deferred" });
  }
  if (acceptedInventory(unblock, coordinator, snapshot)) {
    return finish({
      reason:
        "inventory already reminded or explicitly retained; reconcile any remaining unacknowledged work",
      status: "unchanged",
    });
  }
  const [questions, noticeKeys] = questionBrief(
    questionNotices(unblock, coordinator, snapshot, slot),
  );
  state.question_notice_keys = noticeKeys;
  const qDiagnostics = questionDiagnostics(snapshot, snapshotFile);
  const text = reminder(slot, queues, snapshotFile, {
    questionDiagnostics: qDiagnostics,
    questions,
    workerFailures: pendingWorkerFailures(unblock, coordinator, snapshot),
  });
  return sendSlot(
    client,
    unblock,
    { stopping: () => target.signal?.aborted === true },
    { ownWait, path, recipient: coordinator, text },
    state,
  );
}
