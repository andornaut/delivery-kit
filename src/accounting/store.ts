import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { fsyncDirectory, writeJsonDurable } from "../durable.ts";
import { holdLockAsync, LockBusy, type LockHandle } from "../lock.ts";
import type {
  LedgerAssignment,
  LedgerCommand,
  LedgerCoverage,
  LedgerEvent,
  LedgerEvidence,
  LedgerProjection,
  LedgerQuestion,
  LedgerReport,
  LedgerReportOptions,
  LedgerRequest,
  LedgerRequestInput,
  LedgerSource,
  LedgerStoreOptions,
  LedgerTransaction,
  NativeReference,
} from "./types.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const ROLE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/u;
const KINDS = ["unknown", "request", "question", "suggestion", "approval", "cancellation"];
const PROGRESS = [
  "open",
  "started",
  "blocked",
  "waiting",
  "ready",
  "checked",
  "integrated",
  "delivered",
];
const EVIDENCE = [
  "implementation",
  "check",
  "integration",
  "publication",
  "consumer-adoption",
  "delivery",
  "deployment",
  "acceptance",
  "answer",
  "artifact",
  "review",
];
const TERMINAL = new Set(["completed", "cancelled", "superseded"]);
const TX_KEYS = ["schema", "commandId", "expectedRevision", "actor", "at", "source", "command"];

export class LedgerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`accounting: ${code}`);
    this.name = "LedgerError";
    this.code = code;
  }
}

function demand(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new LedgerError(code);
  }
}

function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
  );
}

function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 16_384 && !value.includes("\0")
  );
}

function id(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function role(value: unknown): value is string {
  return typeof value === "string" && ROLE.test(value);
}

function member(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function nullable(value: unknown, predicate: (value: unknown) => boolean): boolean {
  return value === null || predicate(value);
}

function list(value: unknown, predicate: (value: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every(predicate);
}

function unique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

function stamp(value: unknown): value is string {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function native(value: unknown): value is NativeReference {
  return (
    object(value, ["harness", "threadId", "turnId", "itemId", "index"]) &&
    (value.harness === null || value.harness === "codex" || value.harness === "claude") &&
    nullable(value.threadId, text) &&
    nullable(value.turnId, text) &&
    nullable(value.itemId, text) &&
    nullable(value.index, (n) => Number.isSafeInteger(n) && Number(n) >= 0)
  );
}

function source(value: unknown): value is LedgerSource {
  return (
    object(value, ["origin", "reference", "native", "wordingHash"]) &&
    member(value.origin, ["native-user", "owner-attested", "relay", "unknown"]) &&
    nullable(value.reference, text) &&
    nullable(value.native, native) &&
    nullable(value.wordingHash, (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash))
  );
}

function assignment(value: unknown): value is LedgerAssignment {
  if (
    !object(value, ["ownerRole", "harness", "nativeId", "worker"]) ||
    !role(value.ownerRole) ||
    ![null, "codex", "claude"].includes(value.harness as null | string) ||
    !nullable(value.nativeId, isCanonicalUuid)
  ) {
    return false;
  }
  if (value.worker === null) {
    return true;
  }
  return (
    object(value.worker, ["id", "parentRole", "parentNativeId", "verificationRef"]) &&
    value.harness !== null &&
    value.nativeId === value.worker.id &&
    value.worker.parentRole === value.ownerRole &&
    isCanonicalUuid(value.worker.id) &&
    isCanonicalUuid(value.worker.parentNativeId) &&
    text(value.worker.verificationRef)
  );
}

function question(value: unknown): value is LedgerQuestion {
  return (
    object(value, ["native", "text", "options", "status", "resolutionRef"]) &&
    nullable(value.native, native) &&
    nullable(value.text, text) &&
    nullable(value.options, (options) => list(options, text)) &&
    member(value.status, ["unknown", "pending", "answered", "cancelled"]) &&
    nullable(value.resolutionRef, text) &&
    (!member(value.status, ["answered", "cancelled"]) || text(value.resolutionRef))
  );
}

function targets(value: unknown): boolean {
  return (
    list(value, (target) => {
      if (
        !object(target, ["id", "description", "consumers", "criteria"]) ||
        !id(target.id) ||
        !text(target.description) ||
        !list(target.consumers, role) ||
        !unique(target.consumers)
      ) {
        return false;
      }
      const consumers = target.consumers;
      return (
        list(
          target.criteria,
          (criterion) =>
            object(criterion, ["id", "description", "requiredEvidence"]) &&
            id(criterion.id) &&
            text(criterion.description) &&
            list(criterion.requiredEvidence, (kind) => member(kind, EVIDENCE)) &&
            criterion.requiredEvidence.length > 0 &&
            unique(criterion.requiredEvidence) &&
            (!criterion.requiredEvidence.includes("consumer-adoption") || consumers.length > 0),
        ) &&
        target.criteria.length > 0 &&
        unique(target.criteria.map((c) => (c as { id: string }).id))
      );
    }) && unique((value as { id: string }[]).map((t) => t.id))
  );
}

function coverage(value: unknown): value is LedgerCoverage {
  return (
    object(value, ["id", "ownerRole", "source", "range", "state", "gaps", "nextBoundary"]) &&
    id(value.id) &&
    role(value.ownerRole) &&
    source(value.source) &&
    object(value.range, ["from", "through"]) &&
    nullable(value.range.from, text) &&
    nullable(value.range.through, text) &&
    member(value.state, ["covered", "partial", "unavailable"]) &&
    list(
      value.gaps,
      (gap) =>
        object(gap, ["from", "through", "reason"]) &&
        nullable(gap.from, text) &&
        nullable(gap.through, text) &&
        text(gap.reason),
    ) &&
    nullable(value.nextBoundary, text) &&
    (value.state !== "covered" ||
      (value.gaps.length === 0 &&
        text(value.range.from) &&
        text(value.range.through) &&
        value.source.origin !== "unknown" &&
        value.source.reference !== null))
  );
}

function validateCommand(command: unknown): asserts command is LedgerCommand {
  demand(command !== null && typeof command === "object", "invalid-transaction");
  const c = command as Record<string, unknown>;
  switch (c.type) {
    case "capture": {
      demand(object(c, ["type", "requests", "coverage"]), "invalid-capture");
      demand(
        list(c.requests, (value) => {
          validateCommand({ request: value, type: "register" });
          const request = value as LedgerRequestInput;
          return (
            request.kind === "unknown" &&
            !request.reviewed &&
            request.assignment === null &&
            request.parentId === null &&
            request.dependencies.length === 0 &&
            request.targets.length === 0 &&
            (request.question === null ||
              (request.question.status === "unknown" && request.question.resolutionRef === null))
          );
        }) &&
          unique(c.requests.map((value) => (value as LedgerRequestInput).id)) &&
          list(c.coverage, coverage) &&
          unique(c.coverage.map((value) => (value as LedgerCoverage).id)),
        "invalid-capture",
      );
      return;
    }
    case "register": {
      demand(object(c, ["type", "request"]), "invalid-request");
      const r = c.request;
      demand(
        object(r, [
          "id",
          "summary",
          "kind",
          "reviewed",
          "source",
          "assignment",
          "parentId",
          "dependencies",
          "targets",
          "question",
        ]) &&
          id(r.id) &&
          text(r.summary) &&
          member(r.kind, KINDS) &&
          typeof r.reviewed === "boolean" &&
          (r.kind !== "unknown" || r.reviewed === false) &&
          source(r.source) &&
          nullable(r.assignment, assignment) &&
          nullable(r.parentId, id) &&
          list(r.dependencies, id) &&
          unique(r.dependencies) &&
          targets(r.targets) &&
          nullable(r.question, question),
        "invalid-request",
      );
      break;
    }
    case "classify":
      demand(
        object(c, ["type", "id", "kind", "reviewed", "reason"]) &&
          member(c.kind, KINDS) &&
          typeof c.reviewed === "boolean" &&
          (c.kind !== "unknown" || c.reviewed === false) &&
          text(c.reason),
        "invalid-transaction",
      );
      break;
    case "assign":
      demand(
        object(c, ["type", "id", "assignment"]) && nullable(c.assignment, assignment),
        "invalid-assignment",
      );
      break;
    case "handoff":
      demand(
        object(c, [
          "type",
          "id",
          "previousAssignment",
          "assignment",
          "sourceHoldRef",
          "targetAcceptanceRef",
          "activationRef",
        ]) &&
          assignment(c.previousAssignment) &&
          assignment(c.assignment) &&
          text(c.sourceHoldRef) &&
          text(c.targetAcceptanceRef) &&
          text(c.activationRef),
        "invalid-handoff",
      );
      break;
    case "amend":
      demand(
        object(c, ["type", "id", "summary", "targets", "dependencies", "reason"]) &&
          text(c.summary) &&
          targets(c.targets) &&
          list(c.dependencies, id) &&
          unique(c.dependencies) &&
          text(c.reason),
        "invalid-request",
      );
      break;
    case "progress":
      demand(
        object(c, ["type", "id", "state", "reason", "requiredOwner", "nextBoundary"]) &&
          member(c.state, PROGRESS) &&
          text(c.reason) &&
          nullable(c.requiredOwner, role) &&
          nullable(c.nextBoundary, text) &&
          (!member(c.state, ["started", "blocked", "waiting"]) ||
            (role(c.requiredOwner) && text(c.nextBoundary))),
        "invalid-transition",
      );
      break;
    case "evidence": {
      const e = c.evidence;
      demand(
        object(c, ["type", "id", "evidence"]) &&
          object(e, [
            "id",
            "targetId",
            "criterionId",
            "kind",
            "consumer",
            "outcome",
            "reference",
          ]) &&
          id(e.id) &&
          id(e.targetId) &&
          id(e.criterionId) &&
          member(e.kind, EVIDENCE) &&
          nullable(e.consumer, role) &&
          member(e.outcome, ["passed", "failed", "unknown"]) &&
          text(e.reference),
        "invalid-transaction",
      );
      break;
    }
    case "close":
      demand(
        object(c, ["type", "id", "evidenceIds", "reason"]) &&
          list(c.evidenceIds, id) &&
          unique(c.evidenceIds) &&
          text(c.reason),
        "invalid-transition",
      );
      break;
    case "cancel":
      demand(
        object(c, ["type", "id", "descendants", "reason", "authorityRef"]) &&
          list(c.descendants, id) &&
          unique(c.descendants) &&
          text(c.reason) &&
          text(c.authorityRef),
        "invalid-transition",
      );
      break;
    case "supersede":
      demand(
        object(c, ["type", "id", "replacementId", "reason", "authorityRef"]) &&
          id(c.replacementId) &&
          text(c.reason) &&
          text(c.authorityRef),
        "invalid-transition",
      );
      break;
    case "reopen":
      demand(
        object(c, ["type", "id", "reason", "evidenceRef"]) && text(c.reason) && text(c.evidenceRef),
        "invalid-transition",
      );
      break;
    case "question":
      demand(
        object(c, ["type", "id", "question", "evidenceRef"]) &&
          question(c.question) &&
          text(c.evidenceRef),
        "question-guarded",
      );
      break;
    case "link": {
      const link = c.link;
      demand(
        object(c, ["type", "id", "link"]) &&
          object(link, ["id", "relation", "source", "candidateId"]) &&
          id(link.id) &&
          member(link.relation, ["original", "relay", "attestation"]) &&
          source(link.source) &&
          nullable(link.candidateId, id),
        "invalid-transaction",
      );
      break;
    }
    case "coverage":
      demand(object(c, ["type", "coverage"]) && coverage(c.coverage), "invalid-coverage");
      return;
    default:
      throw new LedgerError("invalid-transaction");
  }
  if (c.type !== "register") {
    demand(id(c.id), "invalid-transaction");
  }
}

function validate(transaction: unknown): asserts transaction is LedgerTransaction {
  const keys =
    transaction !== null && typeof transaction === "object" && "writer" in transaction
      ? [...TX_KEYS, "writer"]
      : TX_KEYS;
  demand(
    object(transaction, keys) &&
      transaction.schema === 1 &&
      id(transaction.commandId) &&
      Number.isSafeInteger(transaction.expectedRevision) &&
      Number(transaction.expectedRevision) >= 0 &&
      role(transaction.actor) &&
      stamp(transaction.at) &&
      source(transaction.source),
    "invalid-transaction",
  );
  if ("writer" in transaction) {
    const writer = transaction.writer;
    demand(
      object(writer, ["harness", "nativeId", "epoch"]) &&
        (writer.harness === "codex" || writer.harness === "claude") &&
        isCanonicalUuid(writer.nativeId) &&
        Number.isSafeInteger(writer.epoch) &&
        Number(writer.epoch) > 0,
      "invalid-writer",
    );
  }
  validateCommand(transaction.command);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function attested(source: LedgerSource): boolean {
  return source.origin === "owner-attested" && source.reference !== null;
}

interface Replay {
  readonly events: LedgerEvent[];
  readonly requests: Map<string, LedgerRequest>;
  readonly coverage: Map<string, LedgerCoverage>;
}

function get(state: Replay, id: string): LedgerRequest {
  const request = state.requests.get(id);
  demand(request !== undefined, "request-missing");
  return request;
}

function owned(request: LedgerRequest, actor: string): void {
  demand((request.assignment?.ownerRole ?? request.createdBy) === actor, "actor-not-owner");
}

function mutable(request: LedgerRequest): void {
  demand(!TERMINAL.has(request.state), "invalid-transition");
}

function descendants(state: Replay, request: LedgerRequest): string[] {
  return request.children.flatMap((id) => [id, ...descendants(state, get(state, id))]).sort();
}

function fulfilled(state: Replay, id: string, visited = new Set<string>()): boolean {
  if (visited.has(id)) {
    return false;
  }
  const request = get(state, id);
  if (request.state === "completed") {
    return true;
  }
  return (
    request.state === "superseded" &&
    request.replacementId !== null &&
    fulfilled(state, request.replacementId, new Set(visited).add(id))
  );
}

function preserveClosures(state: Replay): void {
  for (const request of state.requests.values()) {
    if (request.state === "completed") {
      demand(
        request.children.every((id) => TERMINAL.has(get(state, id).state)) &&
          request.dependencies.every((id) => fulfilled(state, id)),
        "reopen-dependent-first",
      );
    }
  }
}

function retainsScope(
  before: LedgerRequest,
  command: Extract<LedgerCommand, { type: "amend" }>,
): boolean {
  return (
    before.dependencies.every((id) => command.dependencies.includes(id)) &&
    before.targets.every((target) => {
      const next = command.targets.find((t) => t.id === target.id);
      return (
        next !== undefined &&
        target.consumers.every((c) => next.consumers.includes(c)) &&
        target.criteria.every((criterion) => {
          const newer = next.criteria.find((c) => c.id === criterion.id);
          return (
            newer !== undefined &&
            criterion.requiredEvidence.every((kind) => newer.requiredEvidence.includes(kind))
          );
        })
      );
    })
  );
}

function progressEvidence(request: LedgerRequest, state: string): void {
  const kind =
    state === "checked"
      ? "check"
      : state === "integrated"
        ? "integration"
        : state === "delivered"
          ? "delivery"
          : undefined;
  if (kind === undefined) {
    return;
  }
  const latest = new Map(
    request.evidence
      .filter(
        (e) =>
          e.kind === kind &&
          request.targets.some(
            (t) =>
              t.id === e.targetId &&
              t.criteria.some((c) => c.id === e.criterionId && c.requiredEvidence.includes(e.kind)),
          ),
      )
      .map((e) => [evidenceScope(e), e]),
  );
  demand(
    latest.size > 0 && [...latest.values()].every((e) => e.outcome === "passed"),
    "incomplete-evidence",
  );
}

function enriches(before: LedgerQuestion, after: LedgerQuestion): boolean {
  const native =
    before.native === null ||
    (after.native !== null &&
      Object.entries(before.native).every(
        ([key, value]) => value === null || value === after.native?.[key as keyof NativeReference],
      ));
  return (
    native &&
    (before.text === null || before.text === after.text) &&
    (before.options === null || isDeepStrictEqual(before.options, after.options))
  );
}

function dependencies(state: Replay, owner: LedgerRequest): void {
  for (const id of owner.dependencies) {
    demand(id !== owner.id && state.requests.has(id), "invalid-dependency");
  }
  const visited = new Set<string>();
  function walk(id: string, active: Set<string>): void {
    demand(!active.has(id), "invalid-dependency");
    if (visited.has(id)) {
      return;
    }
    const next = new Set(active).add(id);
    const request = get(state, id);
    for (const child of [...request.children, ...request.dependencies]) {
      walk(child, next);
    }
    visited.add(id);
  }
  walk(owner.id, new Set());
}

function evidenceScope(evidence: LedgerEvidence): string {
  return canonical([evidence.targetId, evidence.criterionId, evidence.kind, evidence.consumer]);
}

function closeEvidence(request: LedgerRequest, selected: readonly string[]): void {
  demand(
    request.targets.length > 0 && request.reviewed && request.kind !== "unknown",
    "incomplete-evidence",
  );
  const latest = new Map(request.evidence.map((e) => [evidenceScope(e), e]));
  demand(
    selected.every((id) => {
      const proof = request.evidence.find((e) => e.id === id);
      return (
        proof?.outcome === "passed" &&
        latest.get(evidenceScope(proof))?.id === id &&
        request.targets.some(
          (t) =>
            t.id === proof.targetId &&
            t.criteria.some(
              (c) => c.id === proof.criterionId && c.requiredEvidence.includes(proof.kind),
            ),
        )
      );
    }),
    "incomplete-evidence",
  );
  for (const target of request.targets) {
    for (const criterion of target.criteria) {
      for (const kind of criterion.requiredEvidence) {
        const consumers = kind === "consumer-adoption" ? target.consumers : [null];
        for (const consumer of consumers) {
          const proof = latest.get(canonical([target.id, criterion.id, kind, consumer]));
          demand(proof?.outcome === "passed" && selected.includes(proof.id), "incomplete-evidence");
        }
      }
    }
  }
}

/** Pure replay performs the same validation as an admitted transaction, without native reads. */
function project(state: Replay, event: LedgerEvent): void {
  const c = event.command;
  if (c.type === "capture") {
    for (const request of c.requests) {
      const existing = state.requests.get(request.id);
      if (existing !== undefined) {
        demand(
          existing.createdBy === event.actor && isDeepStrictEqual(existing.source, request.source),
          "source-binding-mismatch",
        );
      } else {
        project(state, { ...event, command: { request, type: "register" } });
      }
    }
    for (const coverage of c.coverage) {
      demand(event.actor === coverage.ownerRole, "actor-not-owner");
      const current = state.coverage.get(coverage.id);
      if (
        current?.state === "covered" &&
        current.gaps.length === 0 &&
        attested(current.source) &&
        current.ownerRole === coverage.ownerRole &&
        isDeepStrictEqual(current.range, coverage.range)
      ) {
        continue;
      }
      project(state, { ...event, command: { coverage, type: "coverage" } });
    }
    return;
  }
  if (c.type === "coverage") {
    demand(event.actor === c.coverage.ownerRole, "actor-not-owner");
    state.coverage.set(c.coverage.id, structuredClone(c.coverage));
    return;
  }
  if (c.type === "register") {
    const input = c.request;
    demand(!state.requests.has(input.id), "request-exists");
    if (input.reviewed) {
      demand(attested(event.source), "unreviewed-source");
    }
    if (input.assignment !== null) {
      demand(event.actor === input.assignment.ownerRole, "actor-not-owner");
    }
    if (input.question !== null && ["answered", "cancelled"].includes(input.question.status)) {
      demand(
        input.assignment !== null &&
          attested(event.source) &&
          input.question.native?.threadId === input.assignment.nativeId &&
          input.assignment.nativeId !== null &&
          input.question.native.harness === input.assignment.harness &&
          event.source.native?.threadId === input.assignment.nativeId &&
          event.source.native.harness === input.assignment.harness,
        "question-guarded",
      );
    }
    if (input.parentId !== null) {
      const parent = get(state, input.parentId);
      owned(parent, event.actor);
      mutable(parent);
      state.requests.set(parent.id, {
        ...parent,
        children: [...parent.children, input.id].sort(),
        revision: event.revision,
        updatedAt: event.at,
      });
    }
    const request: LedgerRequest = {
      ...structuredClone(input),
      children: [],
      closureEvidenceIds: [],
      createdAt: event.at,
      createdBy: event.actor,
      evidence: [],
      nextBoundary: null,
      reason: null,
      replacementId: null,
      requiredOwner: null,
      revision: event.revision,
      sources: [],
      state: "open",
      updatedAt: event.at,
    };
    state.requests.set(request.id, request);
    dependencies(state, request);
    return;
  }
  const request = get(state, c.id);
  owned(request, event.actor);
  const next = { ...request, revision: event.revision, updatedAt: event.at };
  if (!["reopen", "question", "cancel", "handoff"].includes(c.type)) {
    mutable(request);
  }
  switch (c.type) {
    case "classify":
      demand(!c.reviewed || attested(event.source), "unreviewed-source");
      Object.assign(next, { kind: c.kind, reason: c.reason, reviewed: c.reviewed });
      break;
    case "assign":
      Object.assign(next, { assignment: structuredClone(c.assignment) });
      break;
    case "handoff":
      demand(attested(event.source), "unreviewed-source");
      demand(isDeepStrictEqual(request.assignment, c.previousAssignment), "assignment-conflict");
      Object.assign(next, { assignment: structuredClone(c.assignment) });
      break;
    case "amend":
      demand(attested(event.source), "unreviewed-source");
      if (request.evidence.length > 0 && !retainsScope(request, c)) {
        const previous = state.events.findLast(
          (e) => "id" in e.command && e.command.id === request.id,
        );
        demand(previous?.command.type === "reopen", "scope-reopen-required");
      }
      Object.assign(next, {
        dependencies: [...c.dependencies],
        reason: c.reason,
        state: "open",
        summary: c.summary,
        targets: structuredClone(c.targets),
      });
      break;
    case "progress":
      demand(
        c.state === "blocked" ||
          c.state === "waiting" ||
          (request.reviewed && request.kind !== "unknown"),
        "unreviewed-source",
      );
      progressEvidence(request, c.state);
      Object.assign(next, {
        nextBoundary: c.nextBoundary,
        reason: c.reason,
        requiredOwner: c.requiredOwner,
        state: c.state,
      });
      break;
    case "evidence": {
      demand(!request.evidence.some((e) => e.id === c.evidence.id), "evidence-exists");
      const target = request.targets.find((t) => t.id === c.evidence.targetId);
      demand(
        target?.criteria.some(
          (k) => k.id === c.evidence.criterionId && k.requiredEvidence.includes(c.evidence.kind),
        ) &&
          (c.evidence.kind === "consumer-adoption"
            ? c.evidence.consumer !== null && target.consumers.includes(c.evidence.consumer)
            : c.evidence.consumer === null),
        "incomplete-evidence",
      );
      Object.assign(next, { evidence: [...request.evidence, structuredClone(c.evidence)] });
      break;
    }
    case "close":
      demand(
        request.question === null || ["answered", "cancelled"].includes(request.question.status),
        "question-guarded",
      );
      demand(
        request.children.every((id) => TERMINAL.has(get(state, id).state)),
        "unresolved-children",
      );
      demand(
        request.dependencies.every((id) => fulfilled(state, id)),
        "unresolved-dependency",
      );
      closeEvidence(request, c.evidenceIds);
      Object.assign(next, {
        closureEvidenceIds: [...c.evidenceIds],
        nextBoundary: null,
        reason: c.reason,
        requiredOwner: null,
        state: "completed",
      });
      break;
    case "cancel": {
      demand(attested(event.source), "unreviewed-source");
      demand(
        isDeepStrictEqual([...c.descendants].sort(), descendants(state, request)),
        "cancellation-scope-mismatch",
      );
      for (const id of c.descendants) {
        const child = get(state, id);
        state.requests.set(id, {
          ...child,
          reason: c.reason,
          revision: event.revision,
          state: "cancelled",
          updatedAt: event.at,
        });
      }
      Object.assign(next, { reason: c.reason, state: "cancelled" });
      break;
    }
    case "supersede": {
      demand(attested(event.source) && c.replacementId !== request.id, "invalid-transition");
      demand(
        request.children.every((id) => TERMINAL.has(get(state, id).state)),
        "unresolved-children",
      );
      const visited = new Set([request.id]);
      let replacement: LedgerRequest | undefined = get(state, c.replacementId);
      while (replacement !== undefined) {
        demand(!visited.has(replacement.id), "invalid-transition");
        visited.add(replacement.id);
        replacement =
          replacement.replacementId === null ? undefined : get(state, replacement.replacementId);
      }
      Object.assign(next, {
        reason: c.reason,
        replacementId: c.replacementId,
        state: "superseded",
      });
      break;
    }
    case "reopen":
      demand(attested(event.source), "invalid-transition");
      Object.assign(next, {
        closureEvidenceIds: [],
        reason: c.reason,
        replacementId: null,
        state: "open",
      });
      break;
    case "question": {
      demand(request.assignment !== null && attested(event.source), "question-guarded");
      const binding = request.assignment;
      demand(
        c.question.native !== null &&
          c.question.native.threadId !== null &&
          c.question.native.threadId === binding.nativeId &&
          c.question.native.harness === binding.harness,
        "question-guarded",
      );
      if (request.question !== null && ["unknown", "pending"].includes(request.question.status)) {
        demand(enriches(request.question, c.question), "question-guarded");
      }
      if (["answered", "cancelled"].includes(c.question.status)) {
        demand(
          event.source.native?.threadId === binding.nativeId &&
            event.source.native.harness === binding.harness,
          "question-guarded",
        );
      }
      Object.assign(next, { question: structuredClone(c.question) });
      break;
    }
    case "link":
      demand(!request.sources.some((s) => s.id === c.link.id), "source-link-exists");
      if (c.link.relation === "attestation") {
        demand(attested(event.source) && attested(c.link.source), "unreviewed-source");
      }
      if (c.link.candidateId !== null) {
        const candidate = get(state, c.link.candidateId);
        demand(
          c.link.relation === "attestation" || isDeepStrictEqual(candidate.source, c.link.source),
          "source-binding-mismatch",
        );
      }
      Object.assign(next, { sources: [...request.sources, structuredClone(c.link)] });
      break;
  }
  state.requests.set(next.id, next);
  if (c.type === "amend") {
    dependencies(state, next);
  }
  preserveClosures(state);
}

function projection(state: Replay): LedgerProjection {
  return {
    coverage: structuredClone(
      [...state.coverage.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ),
    hash: state.events.at(-1)?.hash ?? null,
    initialized: state.events.length > 0,
    requests: structuredClone(
      [...state.requests.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ),
    revision: state.events.length,
  };
}

/** Append-only journal is authoritative. Projections are rebuilt on each read and transaction. */
export class LedgerStore {
  readonly #options: LedgerStoreOptions;

  constructor(options: LedgerStoreOptions) {
    demand(isAbsolute(options.directory), "invalid-directory");
    this.#options = options;
  }

  #replay(): Replay {
    this.#options.checkRead?.();
    const state: Replay = { coverage: new Map(), events: [], requests: new Map() };
    const directory = join(this.#options.directory, "events");
    try {
      const root = lstatSync(this.#options.directory, { throwIfNoEntry: false });
      demand(
        root === undefined || (root.isDirectory() && !root.isSymbolicLink()),
        "corrupt-ledger",
      );
      if (root === undefined) {
        return state;
      }
      const stat = lstatSync(directory, { throwIfNoEntry: false });
      if (stat === undefined) {
        return state;
      }
      demand(stat.isDirectory() && !stat.isSymbolicLink(), "corrupt-ledger");
      for (const file of readdirSync(directory).sort()) {
        if (/^\.\d{12}\.json\.\d+\.[a-f0-9]{12}\.tmp$/u.test(file)) {
          continue;
        }
        demand(/^\d{12}\.json$/u.test(file), "corrupt-ledger");
        const revision = state.events.length + 1;
        demand(file === `${String(revision).padStart(12, "0")}.json`, "corrupt-ledger");
        const path = join(directory, file);
        demand(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "corrupt-ledger");
        const raw = readFileSync(path, "utf8");
        const value: unknown = JSON.parse(raw);
        demand(raw === `${JSON.stringify(value, null, 2)}\n`, "corrupt-ledger");
        demand(
          object(value, [
            ...TX_KEYS,
            ...(value !== null && typeof value === "object" && "writer" in value ? ["writer"] : []),
            "revision",
            "previousHash",
            "hash",
          ]),
          "corrupt-ledger",
        );
        const { hash, previousHash, revision: eventRevision, ...transaction } = value;
        validate(transaction);
        demand(
          eventRevision === revision &&
            transaction.expectedRevision === revision - 1 &&
            previousHash === (state.events.at(-1)?.hash ?? null) &&
            hash === digest({ ...transaction, previousHash, revision }) &&
            !state.events.some((e) => e.commandId === transaction.commandId) &&
            (state.events.length === 0 ||
              Date.parse(transaction.at) >= Date.parse(state.events.at(-1)!.at)),
          "corrupt-ledger",
        );
        const event = value as unknown as LedgerEvent;
        project(state, event);
        state.events.push(event);
      }
    } catch {
      throw new LedgerError("corrupt-ledger");
    }
    return state;
  }

  read(): LedgerProjection;
  read(id: string): LedgerRequest | undefined;
  read(id?: string): LedgerProjection | LedgerRequest | undefined {
    const state = this.#replay();
    return id === undefined ? projection(state) : structuredClone(state.requests.get(id));
  }

  history(id?: string): readonly LedgerEvent[] {
    return structuredClone(
      this.#replay().events.filter((e) => {
        const c = e.command;
        if (id === undefined) {
          return true;
        }
        if (c.type === "capture") {
          return (
            c.requests.some((request) => request.id === id) ||
            c.coverage.some((coverage) => coverage.id === id)
          );
        }
        if (c.type === "register") {
          return c.request.id === id || c.request.parentId === id;
        }
        if (c.type === "coverage") {
          return c.coverage.id === id;
        }
        return c.id === id || (c.type === "cancel" && c.descendants.includes(id));
      }),
    );
  }

  coverage(owner?: string): readonly LedgerCoverage[] {
    return this.read().coverage.filter((c) => owner === undefined || c.ownerRole === owner);
  }

  report(options: LedgerReportOptions): LedgerReport {
    demand(
      stamp(options.at) &&
        (options.owner === undefined || role(options.owner)) &&
        (options.stalledAfterMs === undefined ||
          (Number.isFinite(options.stalledAfterMs) && options.stalledAfterMs >= 0)),
      "invalid-report",
    );
    const all = this.read();
    const requests = all.requests.filter(
      (r) =>
        options.owner === undefined || (r.assignment?.ownerRole ?? r.createdBy) === options.owner,
    );
    const coverage = all.coverage.filter(
      (c) => options.owner === undefined || c.ownerRole === options.owner,
    );
    const open = requests.filter((r) => !TERMINAL.has(r.state));
    const unknownSource = requests
      .filter(
        (r) =>
          (r.source.origin === "unknown" || r.source.reference === null) &&
          !r.sources.some((s) => s.relation === "attestation" && attested(s.source)),
      )
      .map((r) => r.id);
    const untriaged = requests
      .filter((r) => !TERMINAL.has(r.state) && (r.kind === "unknown" || !r.reviewed))
      .map((r) => r.id);
    return {
      ...all,
      at: options.at,
      coverage,
      coverageState:
        unknownSource.length > 0 ||
        untriaged.length > 0 ||
        coverage.some((c) => c.state !== "covered" || c.gaps.length > 0)
          ? "incomplete"
          : coverage.length === 0
            ? "unknown"
            : "declared-complete",
      open: open.map((r) => r.id),
      protectedQuestions: requests
        .filter((r) => r.question !== null && ["pending", "unknown"].includes(r.question.status))
        .map((r) => r.id),
      requests,
      stalled: open
        .filter(
          (r) =>
            Date.parse(options.at) - Date.parse(r.updatedAt) >=
            (options.stalledAfterMs ?? 3_600_000),
        )
        .map((r) => r.id),
      unassigned: open.filter((r) => r.assignment === null).map((r) => r.id),
      unknownSource,
      untriaged,
    };
  }

  async #verify(bindings: readonly LedgerAssignment[]): Promise<void> {
    for (const expected of bindings) {
      demand(this.#options.resolveOwner !== undefined, "owner-unavailable");
      let current: LedgerAssignment | null;
      try {
        // Fresh supported owner/lineage resolution is supplied by the integration owner.
        // eslint-disable-next-line no-await-in-loop
        current = await this.#options.resolveOwner(structuredClone(expected));
      } catch {
        throw new LedgerError("owner-unavailable");
      }
      demand(current !== null, "owner-unavailable");
      demand(assignment(current) && isDeepStrictEqual(current, expected), "owner-changed");
    }
  }

  async apply(input: LedgerTransaction): Promise<LedgerEvent> {
    validate(input);
    const transaction = structuredClone(input);
    if (this.#options.withWriter !== undefined) {
      return this.#options.withWriter(transaction, () => this.#apply(transaction));
    }
    return this.#apply(transaction);
  }

  async #apply(transaction: LedgerTransaction): Promise<LedgerEvent> {
    const root = this.#options.directory;
    mkdirSync(root, { mode: 0o700, recursive: true });
    demand(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), "invalid-directory");
    fsyncDirectory(dirname(root));
    const lockPath = join(root, "ledger.lock");
    const lockStat = lstatSync(lockPath, { throwIfNoEntry: false });
    demand(
      lockStat === undefined || (lockStat.isFile() && !lockStat.isSymbolicLink()),
      "invalid-directory",
    );
    let lock: LockHandle;
    try {
      lock = await holdLockAsync(lockPath, { nonBlocking: this.#options.nonBlocking ?? false });
    } catch (error) {
      if (error instanceof LockBusy) {
        throw new LedgerError("ledger-busy");
      }
      throw error;
    }
    try {
      const state = this.#replay();
      const previous = state.events.find((e) => e.commandId === transaction.commandId);
      if (previous !== undefined) {
        const original: LedgerTransaction = {
          actor: previous.actor,
          at: previous.at,
          command: previous.command,
          commandId: previous.commandId,
          expectedRevision: previous.expectedRevision,
          schema: previous.schema,
          source: previous.source,
          ...(previous.writer === undefined ? {} : { writer: previous.writer }),
        };
        demand(isDeepStrictEqual(original, transaction), "command-conflict");
        return structuredClone(previous);
      }
      demand(transaction.expectedRevision === state.events.length, "stale-revision");
      demand(
        state.events.length === 0 ||
          Date.parse(transaction.at) >= Date.parse(state.events.at(-1)!.at),
        "stale-time",
      );
      const command = transaction.command;
      if (
        command.type !== "register" &&
        command.type !== "coverage" &&
        command.type !== "capture"
      ) {
        owned(get(state, command.id), transaction.actor);
      }
      const bindings: LedgerAssignment[] = [];
      if (command.type === "register") {
        if (command.request.assignment !== null) {
          bindings.push(command.request.assignment);
        }
        if (command.request.parentId !== null) {
          const parent = get(state, command.request.parentId).assignment;
          if (parent !== null) {
            bindings.push(parent);
          }
        }
      } else if (command.type === "handoff") {
        // Only this explicit attested reconciliation verifies the new owner without the stale binding.
        bindings.push(command.assignment);
      } else if (command.type !== "coverage" && command.type !== "capture") {
        const owner = get(state, command.id).assignment;
        if (owner !== null) {
          bindings.push(owner);
        }
        if (command.type === "assign" && command.assignment !== null) {
          bindings.push(command.assignment);
        }
        if (command.type === "cancel") {
          for (const id of command.descendants) {
            const owner = get(state, id).assignment;
            if (owner !== null) {
              bindings.push(owner);
            }
          }
        }
      }
      await this.#verify(bindings);
      const base = {
        ...transaction,
        previousHash: state.events.at(-1)?.hash ?? null,
        revision: state.events.length + 1,
      };
      const event: LedgerEvent = { ...base, hash: digest(base) };
      project(state, event);
      await this.#verify(bindings);
      const directory = join(root, "events");
      mkdirSync(directory, { mode: 0o700, recursive: true });
      fsyncDirectory(root);
      const path = join(directory, `${String(event.revision).padStart(12, "0")}.json`);
      demand(!existsSync(path), "corrupt-ledger");
      writeJsonDurable(path, event);
      return structuredClone(event);
    } finally {
      lock.release();
    }
  }
}
