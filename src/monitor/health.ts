// Scheduled monitor health in `<unblock>/health/<recipient>.json`: per-item backlog ages across
// distinct slots, deferral counts, question observation history, and one
// `monitor-stuck` event per failed episode. Delivery acceptance deduplicates reminders; it never
// acknowledges queue work or records recovery.
import {
  hasErrors,
  hash,
  healthPath,
  inventorySignature,
  list,
  type QuestionNotice,
  questionObservations,
  rec,
  sortedUnique,
  unacknowledged,
  workerFailures,
} from "./reconcile.ts";
import { type Json, payloadSignature, persist, readRecord, snapshotPath } from "./store.ts";

/** Emit one bus event: the kind is fixed, the key and message vary. */
export type HealthEmit = (kind: string, key: string, message: string) => void;

export interface HealthContext {
  readonly unblock: string;
  readonly emit: HealthEmit;
}

type NoticeKey = Pick<QuestionNotice, "identity" | "signature" | "level">;

function recordQuestions(
  record: Json,
  snapshot: Json,
  slot: number,
  acceptedKeys: readonly unknown[],
): void {
  const previous = rec(record.question_observations);
  record.question_observations = previous;
  for (const [identity, [signature, , question]] of questionObservations(snapshot)) {
    let old = rec(previous[identity]);
    const lastSlot = old.last_slot;
    if (lastSlot !== undefined && lastSlot !== null && slot < Number(lastSlot)) {
      continue;
    }
    const answeredSeen = truthy(old.answered_seen) || question.state === "answered";
    if (old.signature !== signature) {
      old = { accepted_levels: [], first_slot: slot, signature, state: question.state };
    }
    old.last_slot = slot;
    old.answered_seen = answeredSeen;
    for (const value of acceptedKeys) {
      const notice = rec(value) as Partial<NoticeKey>;
      if (
        notice.identity === identity &&
        notice.signature === signature &&
        (notice.level === "initial" || notice.level === "escalation")
      ) {
        old.accepted_levels = [
          ...new Set([...list(old.accepted_levels).map(String), notice.level]),
        ].sort();
      }
    }
    previous[identity] = old;
  }
}

function stuckMessage(unblock: string, recipient: string, snapshotId: string): string {
  return (
    `Monitor needs owner reconciliation for ${recipient} after two distinct slots: ` +
    `inspect local snapshot ${snapshotPath(unblock, snapshotId)}; classify queued work, preserve ` +
    "independent work, and explicitly monitor-ack handled, superseded or retained IDs. Check " +
    "recipient clearance/native question state for deferred reminders. Accepted reminders do not " +
    "acknowledge queue work."
  );
}

interface BacklogItem {
  readonly payload_signature: string;
  readonly slots: unknown[];
  readonly age: number;
}

function backlog(
  unblock: string,
  record: Json,
  snapshot: Json,
  slot: number,
): Record<string, Json> {
  const [queues] = unacknowledged(unblock, snapshot);
  const previousItems = rec(record.backlog_items);
  const errors = rec(snapshot.errors);
  const items: Record<string, Json> = {};
  for (const [thread, entries] of Object.entries(previousItems)) {
    if (Object.hasOwn(errors, thread)) {
      items[thread] = rec(entries);
    }
  }
  for (const [thread, entries] of Object.entries(queues)) {
    const current: Record<string, BacklogItem> = {};
    for (const entry of entries) {
      const signature = payloadSignature(entry);
      const previous = rec(rec(previousItems[thread])[entry.id]);
      const slots = previous.payload_signature === signature ? [...list(previous.slots)] : [];
      if (!slots.includes(slot)) {
        slots.push(slot);
      }
      current[entry.id] = { age: slots.length, payload_signature: signature, slots };
    }
    items[thread] = current;
  }
  return items;
}

/** Python truthiness for parsed JSON. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object" && value !== null) {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

function degradedValue(value: Json): boolean {
  return value.status !== "complete" || value.complete !== true;
}

/**
 * Update and persist the recipient's health record for this slot's
 * outcome and return the printed health fields.
 */
export function recordHealth(
  context: HealthContext,
  recipient: string,
  slot: number,
  snapshot: Json,
  outcome: Json,
): Json {
  const { unblock } = context;
  const path = healthPath(unblock, recipient);
  const record: Json = readRecord(path) ?? { seen_slots: [] };
  const items = backlog(unblock, record, snapshot, slot);
  record.backlog_items = items;
  const ages = Object.values(items).flatMap((entries) =>
    Object.values(entries).map((item) => Number(rec(item).age)),
  );
  record.backlog_slots = Math.max(0, ...ages);
  const status = Object.hasOwn(outcome, "previousStatus") ? outcome.previousStatus : outcome.status;
  const userWait = outcome.waiting_on_user === true;
  const deferred =
    ((status === "deferred" || status === "blocked") && !userWait) || hasErrors(snapshot);
  const degraded = Object.values(rec(snapshot.history)).some((value) => {
    const history = rec(value);
    return (
      history.status === "unavailable" ||
      history.reason_code === "context_compaction" ||
      history.reason_code === "incomplete_page"
    );
  });
  const seen = list(record.seen_slots);
  record.seen_slots = seen;
  if (!seen.includes(slot)) {
    seen.push(slot);
    record.deferral_slots = deferred ? Number(record.deferral_slots ?? 0) + 1 : 0;
  }
  if (!deferred) {
    record.deferral_slots = 0;
  }
  const accepted = outcome.status === "accepted";
  if (accepted) {
    record.accepted_signature = inventorySignature(unblock, snapshot);
    record.accepted_worker_failures = sortedUnique([
      ...list(record.accepted_worker_failures),
      ...workerFailures(snapshot),
    ]);
  }
  recordQuestions(record, snapshot, slot, accepted ? list(outcome.question_notice_keys) : []);
  const backlogSlots = Number(record.backlog_slots ?? 0);
  const deferralSlots = Number(record.deferral_slots ?? 0);
  const failed = Math.max(backlogSlots, deferralSlots) >= 2;
  const workersDegraded = Object.values(rec(snapshot.worker_health)).some((value) => {
    const health = rec(value);
    return (
      degradedValue(health) ||
      health.schema_status === "unknown" ||
      health.schema_status === "unavailable"
    );
  });
  const questionsDegraded = Object.values(rec(snapshot.question_state)).some((value) => {
    const health = rec(value);
    return (
      degradedValue(health) ||
      list(health.questions).some((question) => rec(question).state === "unknown")
    );
  });
  const anyDegraded = degraded || workersDegraded || questionsDegraded;
  let monitorStatus = "ok";
  if (failed) {
    monitorStatus = "failed";
  } else if (anyDegraded) {
    monitorStatus = "degraded";
  }
  // The printed line selects its own key order.
  const health: Json = Object.fromEntries([
    ["question_state_status", questionsDegraded ? "degraded" : "ok"],
    ["worker_health_status", workersDegraded ? "degraded" : "ok"],
    ["monitor_status", monitorStatus],
    ["history_status", degraded ? "degraded" : "ok"],
    ["recipient", recipient],
    ["snapshot_id", snapshot.snapshot_id],
    ["backlog_slots", backlogSlots],
    ["deferral_slots", deferralSlots],
  ]);
  const reasons: string[] = [];
  if (failed) {
    if (backlogSlots >= 2) {
      reasons.push(
        "unacknowledged queue items observed in two distinct slots; inspect snapshot and explicitly reconcile IDs",
      );
    }
    if (deferralSlots >= 2) {
      reasons.push(
        "queue inventory or reminder delivery repeatedly deferred; inspect inventory errors and recipient clearance",
      );
    }
  } else {
    if (degraded) {
      reasons.push(
        "history metadata incomplete or unavailable; inspect history diagnostics without inferring question clearance",
      );
    }
    if (workersDegraded) {
      reasons.push(
        "worker metadata incomplete or unavailable; inspect worker health diagnostics without inferring recovery",
      );
    }
    if (questionsDegraded) {
      reasons.push(
        "question lifecycle or visibility unavailable; inspect question state diagnostics without " +
          "inferring pending decisions or clearance",
      );
    }
  }
  if (failed || anyDegraded) {
    health.monitor_reason = reasons.join("; ");
  }
  delete record.monitor_reason;
  Object.assign(record, health);
  record.last_delivery_status = outcome.status;
  if (!failed) {
    record.reported = false;
    delete record.problem_signature;
    delete record.episode_first_slot;
  } else if (!truthy(record.reported)) {
    const problemSignature = hash({
      deferred: deferralSlots >= 2,
      items: Object.fromEntries(
        Object.entries(items).map(([thread, entries]) => [
          thread,
          Object.entries(entries)
            .filter(([, item]) => Number(rec(item).age) >= 2)
            .map(([identity]) => identity)
            .sort(),
        ]),
      ),
    });
    record.problem_signature = problemSignature;
    record.episode_first_slot = slot;
    context.emit(
      "monitor-stuck",
      `${recipient}-${slot}-${problemSignature}`,
      stuckMessage(unblock, recipient, String(snapshot.snapshot_id)),
    );
    record.reported = true;
  }
  persist(path, record);
  return health;
}
