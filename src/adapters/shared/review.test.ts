import { describe, expect, it } from "vitest";

import { reminder } from "../../review/reconcile.ts";
import { brief } from "../claude/spool.ts";
import type { ActiveScope } from "./route.ts";

const route: ActiveScope = {
  peers: ["tech-session"],
  recipient: "coordinator-session",
  recipientRole: "game-coordinator",
  status: "active",
  targets: [{ name: "Archie/tech", sessionId: "tech-session" }],
};

const codex = reminder(1800, { "tech-session": ["ordinary-1", "guarded-2"] }, "/snapshot", {
  questionDiagnostics: [],
  questions: [],
  workerFailures: [],
});
const claude = brief(1800, route, [
  { kind: "queue_inventory", reason_code: "claude_no_native_api", status: "unavailable" },
]);

const requirements = [
  [
    "full backlog at each existing slot",
    "At every existing :20/:50 scheduled review, inventory ALL registered game, kit and " +
      "game-coordinator recipients and ready worker handoffs",
    "including recipients outside the active route targets",
    "Read the actual queued payloads and current handoff artifacts",
    "Classify EVERY original, including independent ordinary work, as handled, superseded or retained",
    "then process independent ordinary work within its approved scope",
  ],
  [
    "handling evidence before exact acknowledgement",
    "Acceptance is delivery only, not handling",
    "ACK or remove only the exact unchanged original after confirmed handled or superseded evidence",
    "confirmed delivery alone never permits ACK or removal",
    "Reconcile ambiguous delivery before retrying",
  ],
  [
    "guarded decisions and retained work",
    "Retain guarded or unanswered items with their ID, owner, reason and next review boundary",
    "Never interrupt, answer, cancel or clear another owner's question",
    "never make a user decision yourself or treat silence as an answer",
    "Keep pending prompts open while doing independent authorized work",
    "do not end or interrupt their turn to clear them",
  ],
  [
    "supported routing and unavailable visibility",
    "through available supported interfaces and owner cooperation",
    "Use native live delivery only for confirmed unblockers after checking recipient guards and native questions",
    "route ordinary work through the normal queue",
    "Report unavailable queue or worker visibility explicitly",
    "never infer empty or handled inventory or fabricate it",
    "A locally delivered channel queue does not establish visibility into native target queues or worker APIs",
    "Do not expand adapter capabilities",
    "Unavailable visibility is never clearance; report the limit",
  ],
  [
    "starvation escalation and completion accounting",
    "same item remains unhandled or repeatedly deferred across two distinct scheduled slots",
    "escalate starvation with its ID, blocker, required owner and next action instead of repeating reminders",
    "An unanswered question remains protected during escalation",
    "Finish with disposition counts and remaining IDs, including retained items",
    "Preserve existing recipient guards, deduplication and runtime cadence",
  ],
] as const;

describe.each([
  ["Codex", codex],
  ["Claude", claude],
])("%s rendered scheduled review", (_harness, text) => {
  it.each(requirements)("requires %s", (_requirement, ...clauses) => {
    for (const clause of clauses) {
      expect(text).toContain(clause);
    }
  });

  it("never authorizes removal based on delivery alone", () => {
    expect(text).not.toMatch(/original only after confirmed delivery or reconciliation/i);
    expect(text).not.toMatch(/remove (?:an )?original after confirmed delivery/i);
  });
});

it("preserves Codex snapshot IDs and Claude route targets and capability diagnostics", () => {
  expect(codex).toContain("Full local inventory: /snapshot\ntech-session: ordinary-1,guarded-2");
  expect(claude).toContain(
    "Active route targets (not the full backlog inventory):\nArchie/tech: tech-session",
  );
  expect(claude).toContain('"reason_code": "claude_no_native_api", "status": "unavailable"');
});
