import { describe, expect, it } from "vitest";

import type { MessageState, MessageStatus, MessageSummary } from "../messages/types.ts";
import {
  auditIntake,
  type IngressIntake,
  type IntakeContext,
  messageIntake,
  snapshotIntake,
} from "./ingress.ts";
import type { LedgerProjection, LedgerRequest, LedgerSource } from "./types.ts";

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
    const projection = known(result);
    const cancelled = projection.requests.map((request) => ({
      ...request,
      state: "cancelled" as const,
    }));
    expect(
      auditIntake(
        { ...context, known: { ...projection, requests: cancelled } },
        {
          reference: "owner-audit:empty-window",
          reviewed: true,
          range: { from: "known-start", through: "known-end" },
          sources: [],
          gaps: [],
        },
      ),
    ).toMatchObject({
      accounting_ready: false,
      gaps: expect.arrayContaining([
        expect.objectContaining({ reason: "protected-question-unresolved" }),
      ]),
    });
    const parent = "00000000-0000-4000-8000-000000000020";
    const observedChild = "00000000-0000-4000-8000-000000000021";
    const unseenChild = "00000000-0000-4000-8000-000000000022";
    const unverifiedChild = "00000000-0000-4000-8000-000000000023";
    const workerSnapshot = {
      harness: "codex",
      queues: { [parent]: [], [observedChild]: [] },
      history: {
        [parent]: snapshot().history["thread-kit"],
        [observedChild]: {
          ...snapshot().history["thread-kit"],
          user_reply_refs: [{ turn_id: "child-turn", item_id: "child-input" }],
        },
        [unverifiedChild]: snapshot().history["thread-kit"],
      },
      worker_health: {
        [parent]: {
          status: "partial",
          complete: false,
          counts: { omitted: 2 },
          children: [
            { child_id: observedChild, parent_id: parent, lineage_verified: true },
            { child_id: unseenChild, parent_id: parent, lineage_verified: true },
            { child_id: unverifiedChild, parent_id: parent, lineage_verified: false },
          ],
        },
      },
    };
    const workers = snapshotIntake({ ...context, nativeId: parent }, workerSnapshot);
    expect(workers.candidateIds).toHaveLength(2);
    expect(workers.gaps).toContainEqual(
      expect.objectContaining({
        reason: "child-native-history-unavailable",
        source: expect.objectContaining({
          native: expect.objectContaining({ threadId: unseenChild }),
        }),
        requiredParent: { ownerRole: context.ownerRole, nativeId: parent },
        range: { from: null, through: null },
        requiredOwner: context.ownerRole,
      }),
    );
    expect(workers.gaps).toContainEqual(
      expect.objectContaining({ reason: "worker-inventory-omitted" }),
    );
    expect(workers.gaps).toContainEqual(
      expect.objectContaining({ reason: "worker-inventory-incomplete" }),
    );
    expect(workers.gaps).toContainEqual(
      expect.objectContaining({ reason: "worker-lineage-unavailable" }),
    );
    expect(
      workers.commands
        .filter((command) => command.type === "register")
        .map((command) => command.request.source.native?.threadId)
        .sort(),
    ).toEqual([parent, observedChild]);
    expect(workers.accounting_ready).toBe(false);
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
    const covered = {
      ...initial.coverage[0]!,
      state: "covered" as const,
      gaps: [],
      source: {
        origin: "owner-attested" as const,
        reference: "owner-reviewed:local-window",
        native: null,
        wordingHash: null,
      },
    };
    const reviewed = { ...projection, coverage: [covered] };
    const preserved = messageIntake({ ...context, known: reviewed }, input);
    expect(preserved.commands).toEqual([]);
    expect(preserved.coverage).toEqual([covered]);
    expect(preserved.gaps).toEqual([]);
    expect(preserved.observedGaps).toContainEqual(
      expect.objectContaining({
        reason: "transport-is-not-human-origin-proof",
      }),
    );
    expect(preserved.accounting_ready).toBe(true);
    expect(Object.isFrozen(covered)).toBe(false);
    const changed = messageIntake(
      { ...context, known: reviewed },
      messages([message("relay-reviewed"), message("new-source")]),
    );
    expect(changed.coverage[0]?.id).not.toBe(covered.id);
    expect(changed.commands).toContainEqual(expect.objectContaining({ type: "coverage" }));
    expect(changed.accounting_ready).toBe(false);
    const mismatchedRange = messageIntake(
      {
        ...context,
        known: {
          ...reviewed,
          coverage: [
            {
              ...covered,
              range: { from: "different-start", through: "different-end" },
            },
          ],
        },
      },
      input,
    );
    expect(mismatchedRange.commands).toContainEqual(expect.objectContaining({ type: "coverage" }));
    expect(mismatchedRange.accounting_ready).toBe(false);
    const pending = messageIntake(
      { ...context, known: { ...known(initial), coverage: [covered] } },
      input,
    );
    expect(pending.coverage).toEqual([covered]);
    expect(pending.accounting_ready).toBe(false);
    expect(pending.gaps).toContainEqual(
      expect.objectContaining({ reason: "owner-review-required" }),
    );
    const guarded = messageIntake(
      {
        ...context,
        known: {
          ...reviewed,
          requests: reviewed.requests.map((request) => ({
            ...request,
            question: {
              native: null,
              options: null,
              text: null,
              status: "unknown" as const,
              resolutionRef: null,
            },
          })),
        },
      },
      input,
    );
    expect(guarded.accounting_ready).toBe(false);
    expect(guarded.gaps).toContainEqual(
      expect.objectContaining({ reason: "protected-question-unresolved" }),
    );
    expect(guarded.pendingCandidateIds).toEqual([]);
    const handedOff = {
      ...reviewed,
      requests: reviewed.requests.map((request) => ({
        ...request,
        assignment: {
          ownerRole: "art-kit",
          harness: "codex" as const,
          nativeId: "00000000-0000-4000-8000-000000000030",
          worker: null,
        },
        question: {
          native: null,
          options: null,
          text: null,
          status: "pending" as const,
          resolutionRef: null,
        },
      })),
    };
    const observedAgain = messageIntake({ ...context, known: handedOff }, input);
    expect(observedAgain.commands).toEqual([]);
    expect(observedAgain.pendingCandidateIds).toEqual([]);
    expect(observedAgain.gaps).toEqual([]);
    expect(observedAgain.accounting_ready).toBe(true);
    expect(
      auditIntake(
        { ...context, ownerRole: "art-kit", known: handedOff },
        {
          reference: "art-owner-review:empty-window",
          reviewed: true,
          range: { from: "known-start", through: "known-end" },
          sources: [],
          gaps: [],
        },
      ),
    ).toMatchObject({
      accounting_ready: false,
      gaps: expect.arrayContaining([
        expect.objectContaining({
          reason: "protected-question-unresolved",
          requiredOwner: "art-kit",
        }),
      ]),
    });
    expect(handedOff.requests[0]?.question.status).toBe("pending");
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
    const sources: LedgerSource[] = Array.from({ length: 9 }, (_, index) => ({
      origin: "unknown",
      reference: `synthetic-owner-audit:${index + 1}`,
      native: { harness: null, threadId: null, turnId: null, itemId: null, index: null },
      wordingHash: null,
    }));
    sources.push({
      origin: "unknown",
      reference: "synthetic-approval-ledger:clause-1",
      native: null,
      wordingHash: null,
    });
    const submission = {
      reference: "owner-audit:9",
      reviewed: true,
      range: { from: "audit-start", through: "audit-end" },
      sources,
      gaps: [{ from: "missing-a", through: "missing-b", reason: "old-worker-unreadable" }],
    };
    const result = auditIntake(context, submission);
    const registers = result.commands.filter((command) => command.type === "register");
    expect(registers).toHaveLength(10);
    expect(
      registers.every((command) => command.request.kind === "unknown" && !command.request.reviewed),
    ).toBe(true);
    expect(registers.find((command) => command.request.source.native !== null)).toMatchObject({
      request: { source: { origin: "unknown", native: { threadId: null } } },
    });
    expect(auditIntake({ ...context, known: known(result) }, submission).commands).toEqual([]);
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
