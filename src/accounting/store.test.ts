import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as durable from "../durable.ts";
import { LedgerStore } from "./store.ts";
import type {
  EvidenceKind,
  LedgerAssignment,
  LedgerCommand,
  LedgerEvidence,
  LedgerRequestInput,
  LedgerSource,
  LedgerStoreOptions,
  LedgerTransaction,
} from "./types.ts";

const AT = "2026-11-16T01:00:00.000Z";
const SOURCE: LedgerSource = {
  native: null,
  origin: "owner-attested",
  reference: "review:explicit-owner",
  wordingHash: null,
};
const UNKNOWN: LedgerSource = {
  native: null,
  origin: "unknown",
  reference: null,
  wordingHash: null,
};
const NATIVE = {
  harness: "codex" as const,
  index: 0,
  itemId: "question-item",
  threadId: "00000000-0000-4000-8000-000000000001",
  turnId: "turn-1",
};
const ASSIGNMENT: LedgerAssignment = {
  harness: "codex",
  nativeId: NATIVE.threadId,
  ownerRole: "delivery-kit",
  worker: null,
};

function request(
  id: string,
  requiredEvidence: readonly EvidenceKind[] = ["artifact"],
): LedgerRequestInput {
  return {
    assignment: null,
    dependencies: [],
    id,
    kind: "request",
    parentId: null,
    question: null,
    reviewed: true,
    source: SOURCE,
    summary: "Scoped non-secret request",
    targets: [
      {
        consumers: [],
        criteria: [{ description: "Exact result", id: "criterion", requiredEvidence }],
        description: "Outcome",
        id: "target",
      },
    ],
  };
}

function fixture(resolveOwner?: LedgerStoreOptions["resolveOwner"]) {
  const directory = join(mkdtempSync(join(tmpdir(), "accounting-")), "accounting");
  const options = { directory, ...(resolveOwner === undefined ? {} : { resolveOwner }) };
  const store = new LedgerStore(options);
  let sequence = 0;
  const transaction = (
    command: LedgerCommand,
    actor = "delivery-kit",
    source = SOURCE,
  ): LedgerTransaction => ({
    actor,
    at: AT,
    command,
    commandId: `operation-${++sequence}`,
    expectedRevision: store.read().revision,
    schema: 1,
    source,
  });
  const send = (command: LedgerCommand, actor?: string, source?: LedgerSource) =>
    store.apply(transaction(command, actor, source));
  const register = (input: LedgerRequestInput) => send({ request: input, type: "register" });
  const evidence = (
    id: string,
    proofId: string,
    kind: EvidenceKind = "artifact",
    consumer: string | null = null,
    outcome: LedgerEvidence["outcome"] = "passed",
  ) =>
    send({
      evidence: {
        consumer,
        criterionId: "criterion",
        id: proofId,
        kind,
        outcome,
        reference: `artifact:${proofId}`,
        targetId: "target",
      },
      id,
      type: "evidence",
    });
  return { directory, evidence, options, register, send, store, transaction };
}

afterEach(() => vi.restoreAllMocks());

describe("request accounting journal", () => {
  it("deduplicates operations and retains original source through explicit triage", async () => {
    const f = fixture();
    expect(f.store.report({ at: AT })).toMatchObject({
      coverageState: "unknown",
      initialized: false,
      revision: 0,
    });
    const input = {
      ...request("candidate"),
      kind: "unknown" as const,
      reviewed: false,
      source: UNKNOWN,
      targets: [],
    };
    const transaction = f.transaction({ request: input, type: "register" });
    const event = await f.store.apply(transaction);
    const bytes = readFileSync(join(f.directory, "events", "000000000001.json"));
    expect(await new LedgerStore(f.options).apply(transaction)).toEqual(event);
    await expect(
      f.store.apply({ ...transaction, actor: "game-coordinator" }),
    ).rejects.toMatchObject({ code: "command-conflict" });
    await f.register({ ...input, id: "second-clause" });
    expect(f.store.report({ at: AT })).toMatchObject({
      coverageState: "incomplete",
      untriaged: ["candidate", "second-clause"],
      unknownSource: ["candidate", "second-clause"],
    });
    await f.send({
      id: "candidate",
      kind: "request",
      reason: "Owner reviewed exact clause",
      reviewed: true,
      type: "classify",
    });
    await f.send({
      dependencies: [],
      id: "candidate",
      reason: "Explicit scope",
      summary: "Reviewed clause",
      targets: request("candidate").targets,
      type: "amend",
    });
    await f.send({
      id: "candidate",
      link: {
        candidateId: "candidate",
        id: "owner-origin",
        relation: "attestation",
        source: SOURCE,
      },
      type: "link",
    });
    expect(f.store.read("candidate")).toMatchObject({
      source: UNKNOWN,
      state: "open",
      summary: "Reviewed clause",
    });
    expect(f.store.report({ at: "2026-11-16T03:00:00.000Z" })).toMatchObject({
      stalled: ["candidate", "second-clause"],
      unassigned: ["candidate", "second-clause"],
      unknownSource: ["second-clause"],
    });
    expect(readFileSync(join(f.directory, "events", "000000000001.json"))).toEqual(bytes);
    expect(f.store.history("candidate")).toHaveLength(4);
  });

  it("serializes competing writers and recovers both sides of the atomic commit boundary by replay", async () => {
    const f = fixture();
    const first = f.transaction({ request: request("first"), type: "register" });
    const other = {
      ...first,
      command: { request: request("other"), type: "register" as const },
      commandId: "other-writer",
    };
    const result = await Promise.allSettled([
      f.store.apply(first),
      new LedgerStore(f.options).apply(other),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "stale-revision" },
    });
    const committed = f.store.read().requests[0]!.id;
    const originalWrite = durable.writeJsonDurable;
    const before = f.transaction({
      id: committed,
      reason: "Beginning work",
      requiredOwner: "delivery-kit",
      nextBoundary: "next review",
      state: "started",
      type: "progress",
    });
    vi.spyOn(durable, "writeJsonDurable").mockImplementationOnce((path, value) =>
      originalWrite(path, value, {
        onStage: (stage) => {
          if (stage === "synced") {
            throw new Error("power loss before rename");
          }
        },
      }),
    );
    await expect(f.store.apply(before)).rejects.toThrow("power loss before rename");
    expect(new LedgerStore(f.options).read().revision).toBe(1);
    expect(readdirSync(join(f.directory, "events"))).toHaveLength(1);
    vi.restoreAllMocks();
    vi.spyOn(durable, "writeJsonDurable").mockImplementationOnce((path, value) =>
      originalWrite(path, value, {
        onStage: (stage) => {
          if (stage === "renamed") {
            throw new Error("lost commit response");
          }
        },
      }),
    );
    await expect(f.store.apply(before)).rejects.toThrow("lost commit response");
    expect(new LedgerStore(f.options).read().revision).toBe(2);
    vi.restoreAllMocks();
    expect((await new LedgerStore(f.options).apply(before)).revision).toBe(2);
    expect(readdirSync(join(f.directory, "events"))).toHaveLength(2);
  });

  it("requires current passed stage proof, publication and every declared consumer before completion", async () => {
    const f = fixture();
    const input = request("release", [
      "check",
      "integration",
      "delivery",
      "publication",
      "consumer-adoption",
    ]);
    await f.register({
      ...input,
      targets: [{ ...input.targets[0]!, consumers: ["archie/tech", "chibi/tech"] }],
    });
    await expect(
      f.send({
        id: "release",
        nextBoundary: null,
        reason: "Says checked",
        requiredOwner: null,
        state: "checked",
        type: "progress",
      }),
    ).rejects.toMatchObject({ code: "incomplete-evidence" });
    await f.evidence("release", "green", "check");
    await f.send({
      id: "release",
      nextBoundary: null,
      reason: "Actual green check",
      requiredOwner: null,
      state: "checked",
      type: "progress",
    });
    await f.evidence("release", "red", "check", null, "failed");
    await expect(
      f.send({ evidenceIds: ["green"], id: "release", reason: "Stale green", type: "close" }),
    ).rejects.toMatchObject({ code: "incomplete-evidence" });
    await f.evidence("release", "new-green", "check");
    await f.evidence("release", "merged", "integration");
    await f.send({
      id: "release",
      nextBoundary: null,
      reason: "Integrated exact source",
      requiredOwner: null,
      state: "integrated",
      type: "progress",
    });
    await f.evidence("release", "delivered", "delivery");
    await f.send({
      id: "release",
      nextBoundary: null,
      reason: "Delivered exact artifact",
      requiredOwner: null,
      state: "delivered",
      type: "progress",
    });
    await f.evidence("release", "published", "publication");
    await f.evidence("release", "archie", "consumer-adoption", "archie/tech");
    const partial = ["new-green", "merged", "delivered", "published", "archie"];
    await expect(
      f.send({
        evidenceIds: partial,
        id: "release",
        reason: "One consumer missing",
        type: "close",
      }),
    ).rejects.toMatchObject({ code: "incomplete-evidence" });
    await f.evidence("release", "chibi", "consumer-adoption", "chibi/tech");
    await expect(
      f.send({
        evidenceIds: [...partial, "chibi", "red"],
        id: "release",
        reason: "Failed evidence included",
        type: "close",
      }),
    ).rejects.toMatchObject({ code: "incomplete-evidence" });
    await f.send({
      evidenceIds: [...partial, "chibi"],
      id: "release",
      reason: "All outcomes proved",
      type: "close",
    });
    expect(f.store.read("release")?.state).toBe("completed");
    await expect(
      f.send({
        dependencies: [],
        id: "release",
        reason: "Silent terminal edit",
        summary: "Changed",
        targets: f.store.read("release")!.targets,
        type: "amend",
      }),
    ).rejects.toMatchObject({ code: "invalid-transition" });
  });

  it("rejects dropping failed requirements without an explicit evidence-bound reopen", async () => {
    const f = fixture();
    await f.register(request("work", ["check", "artifact"]));
    await f.evidence("work", "failed-check", "check", null, "failed");
    const amend: LedgerCommand = {
      dependencies: [],
      id: "work",
      reason: "Deliberate revised scope",
      summary: "Artifact only",
      targets: request("work").targets,
      type: "amend",
    };
    await expect(f.send(amend)).rejects.toMatchObject({ code: "scope-reopen-required" });
    await f.send({
      evidenceRef: "owner:revised-requirement",
      id: "work",
      reason: "Owner reviewed changed scope",
      type: "reopen",
    });
    await f.send(amend);
    expect(f.store.read("work")?.evidence[0]?.outcome).toBe("failed");
    expect(f.store.history("work").map((e) => e.command.type)).toEqual([
      "register",
      "evidence",
      "reopen",
      "amend",
    ]);
  });

  it("keeps cancelled questions visible and does not let withdrawal satisfy an unchanged dependency", async () => {
    const f = fixture();
    await f.register(request("dependency"));
    await f.register({ ...request("parent"), dependencies: ["dependency"] });
    const question = {
      native: NATIVE,
      options: null,
      resolutionRef: null,
      status: "unknown" as const,
      text: null,
    };
    await f.register({ ...request("clause"), parentId: "parent", question });
    await f.evidence("parent", "parent-artifact");
    await expect(
      f.send({
        evidenceIds: ["parent-artifact"],
        id: "parent",
        reason: "Child still open",
        type: "close",
      }),
    ).rejects.toMatchObject({ code: "unresolved-children" });
    await expect(
      f.send({
        authorityRef: "user:cancel-scope",
        descendants: [],
        id: "parent",
        reason: "Omitted child",
        type: "cancel",
      }),
    ).rejects.toMatchObject({ code: "cancellation-scope-mismatch" });
    await f.send({
      authorityRef: "user:withdraw-clause",
      descendants: [],
      id: "clause",
      reason: "Explicit withdrawal",
      type: "cancel",
    });
    await f.send({
      authorityRef: "user:withdraw-dependency",
      descendants: [],
      id: "dependency",
      reason: "Explicit withdrawal",
      type: "cancel",
    });
    await expect(
      f.send({
        evidenceIds: ["parent-artifact"],
        id: "parent",
        reason: "Cancelled dependency is not fulfilment",
        type: "close",
      }),
    ).rejects.toMatchObject({ code: "unresolved-dependency" });
    expect(f.store.read("clause")?.question).toEqual(question);
    expect(f.store.report({ at: AT }).protectedQuestions).toEqual(["clause"]);
    await f.send({
      evidenceRef: "user:scope-change",
      id: "parent",
      reason: "Review dependency removal",
      type: "reopen",
    });
    await f.send({
      dependencies: [],
      id: "parent",
      reason: "Dependency explicitly removed",
      summary: "Remaining parent outcome",
      targets: request("parent").targets,
      type: "amend",
    });
    await f.send({
      evidenceIds: ["parent-artifact"],
      id: "parent",
      reason: "Remaining outcome proved",
      type: "close",
    });
    expect(f.store.read("parent")?.state).toBe("completed");
  });

  it("requires completed replacements and protects completed dependents", async () => {
    const f = fixture();
    await f.register(request("old"));
    await f.register(request("replacement"));
    await f.register({ ...request("dependent"), dependencies: ["old"] });
    await f.send({
      authorityRef: "owner:replacement",
      id: "old",
      reason: "Exact replacement",
      replacementId: "replacement",
      type: "supersede",
    });
    await f.evidence("dependent", "dependent-artifact");
    await expect(
      f.send({
        evidenceIds: ["dependent-artifact"],
        id: "dependent",
        reason: "Replacement not complete",
        type: "close",
      }),
    ).rejects.toMatchObject({ code: "unresolved-dependency" });
    await f.evidence("replacement", "replacement-artifact");
    await f.send({
      evidenceIds: ["replacement-artifact"],
      id: "replacement",
      reason: "Replacement complete",
      type: "close",
    });
    await f.send({
      evidenceIds: ["dependent-artifact"],
      id: "dependent",
      reason: "Dependencies fulfilled",
      type: "close",
    });
    await expect(
      f.send({
        authorityRef: "user:cancel",
        descendants: [],
        id: "replacement",
        reason: "Would invalidate dependent",
        type: "cancel",
      }),
    ).rejects.toMatchObject({ code: "reopen-dependent-first" });
    await expect(
      f.send({
        evidenceRef: "owner:regression",
        id: "replacement",
        reason: "Would invalidate dependent",
        type: "reopen",
      }),
    ).rejects.toMatchObject({ code: "reopen-dependent-first" });
    expect(f.store.read("replacement")?.state).toBe("completed");
  });

  it("checks fresh owners and protects exact question metadata", async () => {
    let current = ASSIGNMENT;
    let changeDuringRead = false;
    let calls = 0;
    const f = fixture((expected) => {
      calls++;
      const result = current;
      if (changeDuringRead) {
        current = { ...expected, nativeId: "00000000-0000-4000-8000-000000000099" };
      }
      return result;
    });
    const input = {
      ...request("question", ["answer"]),
      assignment: ASSIGNMENT,
      question: {
        native: NATIVE,
        options: null,
        resolutionRef: null,
        status: "unknown" as const,
        text: null,
      },
    };
    await expect(
      new LedgerStore({ directory: f.directory }).apply(
        f.transaction({ request: input, type: "register" }),
      ),
    ).rejects.toMatchObject({ code: "owner-unavailable" });
    await f.register(input);
    expect(calls).toBe(2);
    const enriched = {
      ...input.question,
      options: ["Continue", "Wait"],
      status: "pending" as const,
      text: "Proceed with the scoped action?",
    };
    await expect(
      f.send(
        { evidenceRef: "other:assertion", id: "question", question: enriched, type: "question" },
        "game-coordinator",
      ),
    ).rejects.toMatchObject({ code: "actor-not-owner" });
    await f.send({
      evidenceRef: "owner:observed-card",
      id: "question",
      question: enriched,
      type: "question",
    });
    await expect(
      f.send({
        evidenceRef: "owner:rewrite",
        id: "question",
        question: { ...enriched, text: "Different question" },
        type: "question",
      }),
    ).rejects.toMatchObject({ code: "question-guarded" });
    await f.evidence("question", "answer", "answer");
    await expect(
      f.send({
        evidenceIds: ["answer"],
        id: "question",
        reason: "Question not answered",
        type: "close",
      }),
    ).rejects.toMatchObject({ code: "question-guarded" });
    const answered = {
      ...enriched,
      resolutionRef: "owner:exact-answer",
      status: "answered" as const,
    };
    await expect(
      f.send({
        evidenceRef: "owner:exact-answer",
        id: "question",
        question: answered,
        type: "question",
      }),
    ).rejects.toMatchObject({ code: "question-guarded" });
    await f.send(
      { evidenceRef: "owner:exact-answer", id: "question", question: answered, type: "question" },
      undefined,
      { ...SOURCE, native: { ...NATIVE, itemId: "answer-item" } },
    );
    await f.send({
      evidenceIds: ["answer"],
      id: "question",
      reason: "Scoped answer recorded",
      type: "close",
    });
    expect(f.store.report({ at: AT }).protectedQuestions).toEqual([]);
    await f.register({ ...request("route"), assignment: ASSIGNMENT });
    const revision = f.store.read().revision;
    changeDuringRead = true;
    await expect(
      f.send({
        id: "route",
        reason: "Route moves during resolution",
        requiredOwner: "delivery-kit",
        nextBoundary: "review",
        state: "started",
        type: "progress",
      }),
    ).rejects.toMatchObject({ code: "owner-changed" });
    expect(f.store.read().revision).toBe(revision);
    changeDuringRead = false;
    await expect(
      f.send({ assignment: current, id: "route", type: "assign" }),
    ).rejects.toMatchObject({ code: "owner-changed" });
    const worker: LedgerAssignment = {
      ...ASSIGNMENT,
      nativeId: "00000000-0000-4000-8000-000000000002",
      worker: {
        id: "00000000-0000-4000-8000-000000000002",
        parentNativeId: ASSIGNMENT.nativeId!,
        parentRole: "delivery-kit",
        verificationRef: "supported-lineage:receipt",
      },
    };
    const unavailable = fixture(() => null);
    await expect(
      unavailable.register({ ...request("worker"), assignment: worker }),
    ).rejects.toMatchObject({ code: "owner-unavailable" });
  });

  it("reports explicit unavailable coverage independently of request closure", async () => {
    const f = fixture();
    const incomplete = {
      gaps: [{ from: null, reason: "Claude native history unavailable", through: null }],
      id: "claude-history",
      nextBoundary: "owner audit",
      ownerRole: "delivery-kit",
      range: { from: null, through: null },
      source: UNKNOWN,
      state: "unavailable" as const,
    };
    await f.send({ coverage: incomplete, type: "coverage" });
    expect(f.store.report({ at: AT })).toMatchObject({
      coverageState: "incomplete",
      initialized: true,
      open: [],
    });
    await expect(
      f.send({ coverage: { ...incomplete, gaps: [], state: "covered" }, type: "coverage" }),
    ).rejects.toMatchObject({ code: "invalid-coverage" });
    await f.send({
      coverage: {
        ...incomplete,
        gaps: [],
        range: { from: "audit-start", through: "audit-end" },
        source: SOURCE,
        state: "covered",
      },
      type: "coverage",
    });
    expect(f.store.report({ at: AT }).coverageState).toBe("declared-complete");
    expect(f.store.coverage("game-coordinator")).toEqual([]);
  });

  it("refuses corrupt or redirected journals while ignoring only uncommitted durable temporary files", async () => {
    const f = fixture();
    await f.register(request("durable"));
    const events = join(f.directory, "events");
    writeFileSync(
      join(events, ".000000000002.json.123.abcdef012345.tmp"),
      "incomplete transaction",
    );
    expect(new LedgerStore(f.options).read().revision).toBe(1);
    const redirect = join(mkdtempSync(join(tmpdir(), "accounting-link-")), "accounting");
    symlinkSync(f.directory, redirect);
    expect(() => new LedgerStore({ directory: redirect }).report({ at: AT })).toThrow(
      "corrupt-ledger",
    );
    const dangling = join(mkdtempSync(join(tmpdir(), "accounting-link-")), "accounting");
    symlinkSync(join(dangling, "missing"), dangling);
    expect(() => new LedgerStore({ directory: dangling }).read()).toThrow("corrupt-ledger");
    const original = readFileSync(join(events, "000000000001.json"), "utf8");
    writeFileSync(
      join(events, "000000000001.json"),
      original.replace("Scoped non-secret request", "Different request"),
    );
    expect(() => new LedgerStore(f.options).read()).toThrow("corrupt-ledger");
    mkdirSync(join(f.directory, "ignored-snapshot"));
    expect(() => f.store.history()).toThrow("corrupt-ledger");
  });
});
