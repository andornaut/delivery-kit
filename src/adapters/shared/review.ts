// Common backlog and decision policy carried by both harnesses' scheduled reviews.
export const UNBLOCK_INSTRUCTIONS =
  "Review recent Art, Gameplay and Tech activity alongside the backlog. " +
  "Resolve reciprocal waits with the smallest owner question. " +
  "At every existing :20/:50 scheduled review, inventory ALL registered game, kit and " +
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
  "Find every hold, block and pending user decision. For a pending decision, make sure its owner " +
  "has it open as a structured prompt in its own session with its recommendation first; if not, " +
  "ask the owner to open it now, then list it for the user with owner, exact text, options and " +
  "where to answer. For a hold, if its reason no longer applies, tell the owner it is released " +
  "and to resume approved work; if it still applies, name the exact blocker and the role that " +
  "can clear it. For a block, send the exact request to the role that can clear it. Never " +
  "interrupt, answer, cancel or clear another owner's question, and never make a user decision " +
  "yourself or treat silence as an answer. Keep pending prompts open while doing independent " +
  "authorized work; do not end or interrupt their turn to clear them.";
