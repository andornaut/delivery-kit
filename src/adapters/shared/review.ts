// Common backlog and decision policy carried by both harnesses' scheduled reviews.
import { isRecord, unicodeDumps } from "./pyjson.ts";

export const UNBLOCK_INSTRUCTIONS =
  "Review recent Art, Gameplay and Tech activity alongside the backlog. " +
  "Reconcile the durable request ledger at this review boundary, including untriaged source " +
  "references, assigned work, required targets, criteria, dependencies and coverage gaps. " +
  "Request completion is separate from message handling, agent idle state and publication. " +
  "Preserve unknown source ranges and native question references; ask the responsible owner " +
  "to reconcile them without inventing provenance or repeating an already answered decision. " +
  "A ledger classification or status never grants approval, clears a native question or " +
  "changes delivery controls. Required consumer targets remain open until their evidence exists. " +
  "Resolve reciprocal waits with the smallest owner question. " +
  "At every caller-configured scheduled review, inventory ALL registered game, kit and " +
  "game-coordinator recipients and ready worker handoffs, including recipients outside the " +
  "active route targets, through available supported interfaces and owner cooperation. " +
  "Inventory verified workers' queues as well as registered parents' queues and ready " +
  "handoffs; require verified lineage, never arbitrary UUIDs. If historical worker queue " +
  "reads are unavailable or installed inbox ACK refuses a nonregistered worker UUID, " +
  "preserve the original, report the limit and route reconciliation to its owning parent. " +
  "Never bypass that refusal, force-load a worker queue, auto-ACK or expand capabilities. " +
  "Read the actual queued payloads and current handoff artifacts. Report unavailable queue " +
  "or worker visibility explicitly; never infer empty or handled inventory or fabricate it. " +
  "A locally delivered channel queue does not establish visibility into native target queues " +
  "or worker APIs. Do not expand adapter capabilities. " +
  "Classify EVERY original, including independent ordinary work, as handled, superseded or " +
  "retained, with evidence for the disposition. Prioritize actual user replies and dependency " +
  "unblockers, then process independent ordinary work within its approved scope. " +
  "Use native live delivery only for confirmed unblockers after checking recipient guards " +
  "and native questions; route ordinary work through the normal queue. Acceptance is delivery " +
  "only, not handling. Reconcile ambiguous delivery before retrying. ACK or remove only the " +
  "exact unchanged original after confirmed handled or superseded evidence; confirmed delivery " +
  "alone never permits ACK or removal. Retain guarded or unanswered items with their ID, owner, " +
  "reason and next review boundary. Unavailable visibility is never clearance; report the limit. " +
  "If the same item remains unhandled or repeatedly deferred across two distinct scheduled " +
  "slots, escalate starvation with its ID, blocker, required owner and next action instead of " +
  "repeating reminders. An unanswered question remains protected during escalation. " +
  "Finish with disposition counts and remaining IDs, including retained items. " +
  "Preserve existing recipient guards, deduplication and runtime cadence; add no runtime or " +
  "queue feature, timer or manual review slot. " +
  "Durable local message IDs are separate from native queue ACK IDs. Recipients pull original " +
  "bodies through message status --recipient ROLE --include-body in their own session. " +
  "Accepted local messages still require recipient handling; preserve retained, held and " +
  "guarded messages with their owner, reason and next boundary. Never auto retry an ambiguous " +
  "attempt or treat a message health warning as question clearance. " +
  "Report every unhandled or repeatedly deferred local ID after two distinct slots, including " +
  "held, retained or guarded work. Preserve its protection and actual next boundary; reporting " +
  "is owner visibility, never retry, wake, auto-ACK, clearance or resume permission. " +
  "Find every hold, block and pending user decision. For a pending decision, make sure its owner " +
  "has it open as a structured prompt in its own session with its recommendation first; if not, " +
  "ask the owner to open it now, then list it for the user with owner, exact text, options and " +
  "where to answer. For a hold, if its reason no longer applies, tell the owner it is released " +
  "and to resume approved work; if it still applies, name the exact blocker and the role that " +
  "can clear it. For a block, send the exact request to the role that can clear it. Never " +
  "interrupt, answer, cancel or clear another owner's question, and never make a user decision " +
  "yourself or treat silence as an answer. Keep pending prompts open while doing independent " +
  "authorized work; do not end or interrupt their turn to clear them.";

function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  const row = isRecord(value) ? value : {};
  return Object.fromEntries(
    names.filter((name) => Object.hasOwn(row, name)).map((name) => [name, row[name]]),
  );
}

const MESSAGE_FIELDS = [
  "id",
  "fromRole",
  "toRole",
  "workerId",
  "parentRole",
  "intent",
  "created",
  "state",
  "attempts",
  "reason",
  "revision",
  "ownerRole",
  "nextBoundary",
] as const;

/** Only public metadata enters either harness's brief, even if a future record gains fields. */
export function messageReview(
  context: { readonly snapshotPath: string; readonly health?: unknown },
  summary: unknown,
): string {
  if (summary === undefined) {
    return "";
  }
  if (!isRecord(summary) || summary.status !== "available" || !Array.isArray(summary.messages)) {
    return (
      "\nDurable local message visibility is unavailable/unknown (unreadable-inbox); " +
      "counts and messages are unknown, never empty or handled. " +
      `Inspect local snapshot ${context.snapshotPath}; preserve originals and recipient guards.`
    );
  }
  const messages = (summary.messages as unknown[]).map((value) => {
    const row = isRecord(value) ? value : {};
    return {
      ...fields(row, MESSAGE_FIELDS),
      outbox: Array.isArray(row.outbox)
        ? (row.outbox as unknown[]).map((entry) => fields(entry, ["requestId", "hop", "state"]))
        : [],
    };
  });
  const counts = isRecord(summary.counts)
    ? Object.fromEntries(
        Object.entries(summary.counts).filter(
          ([, count]) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
        ),
      )
    : null;
  const health = fields(context.health, [
    "message_health_status",
    "message_backlog_slots",
    "message_health_reason",
  ]);
  if (isRecord(context.health)) {
    for (const name of ["message_stalled", "message_protected"]) {
      const rows = context.health[name];
      if (Array.isArray(rows)) {
        health[name] = (rows as unknown[]).map((row) =>
          fields(row, [
            "id",
            "toRole",
            "workerId",
            "parentRole",
            "ownerRole",
            "reason",
            "nextBoundary",
            "nextAction",
            "protected",
          ]),
        );
      }
    }
  }
  const metadata = unicodeDumps({ counts, health, messages, schema: 1, status: "available" });
  const bounded =
    Buffer.byteLength(metadata, "utf8") <= 32768
      ? metadata
      : unicodeDumps({
          counts,
          metadata_omitted: true,
          reason: "brief-bound",
          status: "available",
        });
  return (
    `\nDurable local messages (metadata only): ${bounded}. ` +
    `Full local metadata: ${context.snapshotPath}. Each recipient pulls its original body with ` +
    "message status --recipient ROLE --include-body in its own session. Reconcile handled or " +
    "superseded evidence, or retain with owner/reason/nextBoundary. Acceptance is delivery only. " +
    "Do not map these IDs to native inbox ACKs, auto retry, or clear pending questions."
  );
}
