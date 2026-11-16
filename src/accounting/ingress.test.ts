import { describe, expect, it } from "vitest";

import type { MessageState, MessageStatus, MessageSummary } from "../messages/types.ts";
import {
  auditIntake,
  type IngressIntake,
  type IntakeContext,
  messageIntake,
  snapshotIntake,
} from "./ingress.ts";
import type { LedgerProjection, LedgerRequest } from "./types.ts";

const context: IntakeContext = {
  ownerRole: "game-kit",
  harness: "codex",
  nativeId: "thread-kit",
  phase: "review",
  nextBoundary: "next owner review",
};

function snapshot() {
  return {
    snapshot_id: "observation-one",
    harness: "codex",
    queues: { "thread-kit": [] },
    history: {
      "thread-kit": {
        status: "complete",
        complete: true,
        cursor: null,
        nextCursor: null,
        user_reply_refs: [{ turn_id: "turn-one", item_id: "user-one" }],
        question_refs: [],
      },
    },
  };
}

function message(id: string, toRole = "game-kit"): MessageStatus {
  return {
    id,
    revision: 1,
    fromRole: "game-coordinator",
    toRole,
    intent: "queue",
    created: "2026-11-16T01:00:00Z",
    state: "accepted",
    attempts: 1,
    outbox: [],
    reason: null,
    ownerRole: null,
    nextBoundary: null,
  };
}

function messages(rows: MessageStatus[]): MessageSummary {
  return {
    schema: 1,
    status: "available",
    messages: rows,
    counts: Object.fromEntries(
      [
        "queued",
        "held",
        "blocked",
        "sending",
        "accepted",
        "ambiguous",
        "parent-required",
        "handled",
        "superseded",
        "retained",
      ].map((state) => [state, rows.filter((row) => row.state === state).length]),
    ) as Record<MessageState, number>,
  };
}

function known(
  result: IngressIntake,
  reviewed = false,
): Pick<LedgerProjection, "requests" | "coverage"> {
  const requests: LedgerRequest[] = result.commands.flatMap((command) =>
    command.type !== "register"
      ? []
      : [
          {
            ...command.request,
            kind: reviewed ? "request" : "unknown",
            reviewed,
            createdBy: context.ownerRole,
            sources: reviewed
              ? [
                  {
                    id: "review-origin",
                    relation: "attestation",
                    candidateId: null,
                    source: {
                      origin: "owner-attested",
                      reference: "owner-review:17",
                      native: null,
                      wordingHash: null,
                    },
                  },
                ]
              : [],
            state: "open",
            createdAt: "2026-11-16T01:00:00Z",
            updatedAt: "2026-11-16T01:00:00Z",
            revision: 1,
            children: [],
            evidence: [],
            closureEvidenceIds: [],
            reason: null,
            requiredOwner: null,
            nextBoundary: null,
            replacementId: null,
          },
        ],
  );
  return { requests, coverage: result.coverage };
}

describe("accounting ingress", () => {
  it("captures stable pending native references and protects unanswered question metadata", () => {
    const input = snapshot();
    const history = input.history["thread-kit"];
    history.user_reply_refs.push({ turn_id: "turn-one", item_id: "user-one" });
    Object.assign(history, {
      status: "partial",
      complete: false,
      nextCursor: "older-page",
      question_refs: [
        { turn_id: "turn-question", item_id: "question-item", kind: "rendered_prompt" },
      ],
    });
    Object.assign(input.queues, {
      "thread-kit": [
        {
          id: "queue-one",
          clientUserMessageId: "relay-one",
          get input() {
            throw new Error("payload must never be read");
          },
        },
      ],
    });
    const result = snapshotIntake(context, input);
    expect(result.candidateIds).toHaveLength(3);
    expect(result.pendingCandidateIds).toEqual(result.candidateIds);
    expect(
      result.commands
        .filter((command) => command.type === "register")
        .every(
          (command) =>
            command.request.kind === "unknown" &&
            !command.request.reviewed &&
            command.request.source.wordingHash === null,
        ),
    ).toBe(true);
    const question = result.commands.find(
      (command) => command.type === "register" && command.request.question,
    );
    expect(question).toMatchObject({
      request: { question: { status: "unknown", resolutionRef: null } },
    });
    expect(Object.isFrozen(question)).toBe(true);
    expect(history.question_refs).toEqual([
      { turn_id: "turn-question", item_id: "question-item", kind: "rendered_prompt" },
    ]);
    expect(snapshotIntake(context, { ...input, snapshot_id: "new-snapshot" }).candidateIds).toEqual(
      result.candidateIds,
    );
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        requiredOwner: "game-kit",
        reason: "bounded-native-history-incomplete",
        nextBoundary: context.nextBoundary,
        range: { from: "head", through: "older-page" },
      }),
    );
    expect(result.accounting_ready).toBe(false);
  });

  it("captures messages once for their owner without treating accepted or handled delivery as requests", () => {
    const first = messages([
      message("relay-a"),
      message("relay-b"),
      message("relay-a"),
      message("other", "art-kit"),
    ]);
    const result = messageIntake(context, first);
    expect(result.candidateIds).toHaveLength(2);
    expect(result.pendingCandidateIds).toHaveLength(2);
    expect(result.commands.filter((command) => command.type === "register")).toHaveLength(2);
    const handled = messages([{ ...message("relay-a"), state: "handled" }, message("relay-b")]);
    expect(messageIntake(context, handled).candidateIds).toEqual(result.candidateIds);
    expect(messageIntake({ ...context, ownerRole: "art-kit" }, first).candidateIds).toHaveLength(1);
    expect(result.accounting_ready).toBe(false);
  });

  it("never re-registers classified candidates and skips unchanged coverage on repeated observation", () => {
    const input = messages([message("relay-reviewed")]);
    const initial = messageIntake(context, input);
    const projection = known(initial, true);
    const reconciled = messageIntake({ ...context, known: projection }, input);
    expect(reconciled.pendingCandidateIds).toEqual([]);
    expect(reconciled.commands.every((command) => command.type === "coverage")).toBe(true);
    expect(
      messageIntake({ ...context, known: { ...projection, coverage: reconciled.coverage } }, input)
        .commands,
    ).toEqual([]);
    expect(projection.requests[0]).toMatchObject({
      kind: "request",
      reviewed: true,
      state: "open",
    });
    expect(reconciled.accounting_ready).toBe(false);
  });

  it("retains Claude references with unavailable native history and local-message visibility", () => {
    const claude: IntakeContext = { ...context, harness: "claude", nativeId: "claude-kit" };
    const result = snapshotIntake(claude, {
      harness: "claude",
      queues: { "claude-kit": [{ id: "delivered-one", clientUserMessageId: "delivered-one" }] },
    });
    expect(result.candidateIds).toHaveLength(1);
    expect(result.coverage[0]?.state).toBe("unavailable");
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ reason: "claude-native-history-unsupported" }),
    );
    expect(
      messageIntake(context, {
        schema: 1,
        status: "unavailable",
        counts: null,
        messages: null,
        reason: "unreadable-inbox",
      }),
    ).toMatchObject({ accounting_ready: false, coverage: [{ state: "unavailable" }] });
  });

  it("fails closed for missing native bindings and preserves valid references from a malformed page", () => {
    expect(snapshotIntake({ ...context, nativeId: null }, snapshot())).toMatchObject({
      accounting_ready: false,
      candidateIds: [],
      coverage: [{ state: "unavailable" }],
    });
    const input = snapshot();
    Object.assign(input.history["thread-kit"], {
      user_reply_refs: [{ turn_id: "turn-one", item_id: "user-one" }, { turn_id: "unknown" }],
    });
    const result = snapshotIntake(context, input);
    expect(result.candidateIds).toHaveLength(1);
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ reason: "malformed-native-reference" }),
    );
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ reason: "historical-human-origin-unattested" }),
    );
  });

  it("records reviewed audit windows without approving sources or filling unknown native references", () => {
    const result = auditIntake(context, {
      reference: "owner-audit:9",
      reviewed: true,
      range: { from: "audit-start", through: "audit-end" },
      sources: [
        {
          origin: "unknown",
          reference: "old-relay:8",
          native: {
            harness: null,
            threadId: null,
            turnId: null,
            itemId: null,
            index: null,
          },
          wordingHash: null,
        },
      ],
      gaps: [{ from: "missing-a", through: "missing-b", reason: "old-worker-unreadable" }],
    });
    expect(result.commands[0]).toMatchObject({
      type: "register",
      request: {
        kind: "unknown",
        reviewed: false,
        source: { origin: "unknown", native: { threadId: null } },
      },
    });
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        range: { from: "missing-a", through: "missing-b" },
        reason: "old-worker-unreadable",
        requiredOwner: "game-kit",
      }),
    );
    expect(result.accounting_ready).toBe(false);
    expect(
      auditIntake(context, {
        reference: "owner-audit:empty-window",
        reviewed: true,
        range: { from: "known-start", through: "known-end" },
        sources: [],
        gaps: [],
      }).accounting_ready,
    ).toBe(true);
  });
});
