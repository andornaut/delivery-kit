// Callers authorize inbox reads, attempts and evidence. This store performs no transport or
// question lifecycle operations; native acceptance and explicit recipient handling are distinct.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual as same } from "node:util";

import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { isRecord } from "../adapters/shared/pyjson.ts";
import { type DeliveryDiagnostic, safeDeliveryDiagnostic } from "../adapters/types.ts";
import { fsyncDirectory, readJsonIfExists, writeJsonDurable } from "../durable.ts";
import { holdLockAsync, type LockHandle } from "../lock.ts";
import { ID_PATTERN } from "../validate.ts";
import type {
  MessageAttempt,
  MessageAttemptLease,
  MessageAttemptSource,
  MessageCompletion,
  MessageContext,
  MessageEnvelope,
  MessageEvidence,
  MessageExpectation,
  MessageInput,
  MessageOwner,
  MessageReason,
  MessageRecord,
  MessageRetention,
  MessageStatus,
  MessageSummary,
} from "./types.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const STATES = new Set([
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
]);
const REASONS = new Set([
  "owner-unavailable",
  "guarded",
  "transport-unavailable",
  "transport-pending",
  "worker-parent-required",
  "refused",
  "lost-response",
  "interrupted",
  "retained",
  "explicit-hold",
]);
const ATTEMPT_STATES = new Set(["sending", "accepted", "blocked", "ambiguous", "parent-required"]);
const EVIDENCE = new Set(["accepted", "not-delivered", "handled", "superseded", "retained"]);

export class MessageError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`message: ${code}`);
    this.code = code;
    this.name = "MessageError";
  }
}

function requireThat(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new MessageError(code);
  }
}

function role(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.split("/").length <= 2 &&
    value.split("/").every((part) => ID_PATTERN.test(part))
  );
}

function stamp(value: unknown): value is string {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function messageEnvelope(input: MessageInput): MessageEnvelope {
  requireThat(
    isRecord(input) &&
      input.schema === 1 &&
      typeof input.id === "string" &&
      ID.test(input.id) &&
      role(input.fromRole) &&
      role(input.toRole) &&
      (input.intent === "queue" || input.intent === "unblock") &&
      typeof input.body === "string" &&
      stamp(input.created),
    "invalid-envelope",
  );
  const { body, created, fromRole, id, intent, schema, toRole } = input;
  const { parentRole, workerId } = input;
  const worker = parentRole !== undefined || workerId !== undefined;
  let target: Pick<MessageInput, "parentRole" | "workerId"> = {};
  if (worker) {
    requireThat(
      isCanonicalUuid(workerId) && role(parentRole) && toRole === parentRole,
      "invalid-worker-target",
    );
    target = { parentRole, workerId };
  }
  const payloadHash = hash(
    JSON.stringify([
      schema,
      id,
      fromRole,
      toRole,
      intent,
      body,
      created,
      workerId ?? null,
      parentRole ?? null,
    ]),
  );
  return { body, created, fromRole, id, intent, ...target, payloadHash, schema, toRole };
}

function ownerValid(owner: unknown): owner is MessageOwner {
  return (
    isRecord(owner) &&
    (owner.harness === "codex" || owner.harness === "claude") &&
    isCanonicalUuid(owner.nativeId) &&
    (owner.parentBinding === null ||
      (owner.harness === "codex" &&
        isRecord(owner.parentBinding) &&
        role(owner.parentBinding.role) &&
        isCanonicalUuid(owner.parentBinding.nativeId) &&
        owner.parentBinding.nativeId !== owner.nativeId))
  );
}

function sourceValid(source: unknown): source is MessageAttemptSource {
  return (
    isRecord(source) &&
    ownerValid(source.owner) &&
    isCanonicalUuid(source.requestId) &&
    (source.hop === "recipient" || (source.hop === "parent" && source.owner.parentBinding !== null))
  );
}

function retentionValid(value: unknown): value is MessageRetention {
  return (
    isRecord(value) &&
    role(value.ownerRole) &&
    typeof value.reason === "string" &&
    value.reason.trim() !== "" &&
    typeof value.nextBoundary === "string" &&
    value.nextBoundary.trim() !== ""
  );
}

function reasonValid(value: unknown): boolean {
  return value === null || (typeof value === "string" && REASONS.has(value));
}

function evidenceValid(value: unknown): value is MessageEvidence {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    EVIDENCE.has(value.kind) &&
    typeof value.ref === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(value.ref) &&
    (value.source === null || sourceValid(value.source)) &&
    (value.kind === "retained" ? retentionValid(value.retention) : value.retention === null)
  );
}

function attemptValid(value: unknown): value is MessageAttempt {
  return (
    isRecord(value) &&
    sourceValid(value.source) &&
    typeof value.state === "string" &&
    ATTEMPT_STATES.has(value.state) &&
    stamp(value.started) &&
    (value.state === "sending" ? value.completed === null : stamp(value.completed)) &&
    reasonValid(value.reason) &&
    (value.diagnostic === undefined || safeDeliveryDiagnostic(value.diagnostic) !== undefined)
  );
}

function validRecord(value: unknown): asserts value is MessageRecord {
  requireThat(
    isRecord(value) &&
      value.schema === 1 &&
      Number.isSafeInteger(value.revision) &&
      (value.revision as number) > 0 &&
      isRecord(value.envelope) &&
      typeof value.state === "string" &&
      STATES.has(value.state) &&
      Array.isArray(value.attempts) &&
      value.attempts.every(attemptValid) &&
      Array.isArray(value.evidence) &&
      value.evidence.every(evidenceValid) &&
      (value.retention === null || retentionValid(value.retention)) &&
      reasonValid(value.reason) &&
      (value.diagnostic === undefined || safeDeliveryDiagnostic(value.diagnostic) !== undefined),
    "invalid-record",
  );
  requireThat(
    same(messageEnvelope(value.envelope as unknown as MessageInput), value.envelope),
    "invalid-record",
  );
  const last = value.attempts.at(-1) as MessageAttempt | undefined;
  requireThat(
    (value.state !== "sending" || last?.state === "sending") &&
      (value.state !== "accepted" ||
        (last?.state === "accepted" && last.source.hop === "recipient")) &&
      (value.state !== "retained" || value.retention !== null) &&
      new Set(value.attempts.map((attempt: MessageAttempt) => attempt.source.requestId)).size ===
        value.attempts.length,
    "invalid-record",
  );
}

function sourceOf(record: MessageRecord): MessageAttemptSource | null {
  return record.attempts.at(-1)?.source ?? null;
}

function guard(record: MessageRecord, expected: MessageExpectation): void {
  requireThat(
    same(record.envelope, expected.envelope) &&
      record.revision === expected.revision &&
      same(sourceOf(record), expected.source),
    "binding-conflict",
  );
}

export function messageExpectation(record: MessageRecord): MessageExpectation {
  return {
    envelope: clone(record.envelope),
    revision: record.revision,
    source: clone(sourceOf(record)),
  };
}

function terminal(record: MessageRecord): boolean {
  return record.state === "handled" || record.state === "superseded";
}

function withoutDiagnostic(record: MessageRecord): MessageRecord {
  const copy = { ...record };
  delete copy.diagnostic;
  return copy;
}

function publicStatus(record: MessageRecord): MessageStatus {
  const { created, fromRole, id, intent, toRole } = record.envelope;
  return {
    ...(safeDeliveryDiagnostic(record.diagnostic) === undefined
      ? {}
      : { diagnostic: safeDeliveryDiagnostic(record.diagnostic)! }),
    attempts: record.attempts.length,
    created,
    fromRole,
    id,
    intent,
    nextBoundary: record.retention?.nextBoundary ?? null,
    outbox: record.attempts.map(({ diagnostic, source, state }) => ({
      ...(safeDeliveryDiagnostic(diagnostic) === undefined
        ? {}
        : { diagnostic: safeDeliveryDiagnostic(diagnostic)! }),
      hop: source.hop,
      requestId: source.requestId,
      state,
    })),
    ownerRole: record.retention?.ownerRole ?? null,
    ...(record.envelope.workerId === undefined
      ? {}
      : {
          parentRole: record.envelope.parentRole!,
          workerId: record.envelope.workerId,
        }),
    reason: record.reason,
    revision: record.revision,
    state: record.state,
    toRole,
  };
}

/** Read-only operational inventory for the existing review pass; creates no state or wake. */
export function messageSummary(layout: MessageContext["layout"]): MessageSummary {
  return new MessageStore({ layout, resolveOwner: () => null }).summary();
}

/** Local role inbox, independent of optional notifications or native transport availability. */
export class MessageStore {
  private readonly context: MessageContext;
  private readonly directory: string;

  constructor(context: MessageContext) {
    this.context = context;
    this.directory = join(context.layout.reviewDir, "messages");
  }

  private now(): string {
    const value = this.context.now?.() ?? new Date().toISOString();
    requireThat(stamp(value), "invalid-clock");
    return value;
  }

  private path(id: string): string {
    requireThat(typeof id === "string" && ID.test(id), "invalid-id");
    return join(this.directory, `${hash(id)}.json`);
  }

  private async lock(id: string): Promise<LockHandle> {
    this.path(id);
    mkdirSync(this.directory, { mode: 0o700, recursive: true });
    chmodSync(this.directory, 0o700);
    fsyncDirectory(dirname(this.directory));
    return holdLockAsync(join(this.directory, `${hash(id)}.lock`), { nonBlocking: true });
  }

  private save(record: MessageRecord): MessageRecord {
    const next = { ...record, revision: record.revision + 1 };
    validRecord(next);
    writeJsonDurable(this.path(next.envelope.id), next);
    return clone(next);
  }

  private existing(expected: MessageExpectation): MessageRecord {
    const record = this.read(expected.envelope.id);
    requireThat(record !== undefined, "missing");
    guard(record, expected);
    return record;
  }

  /** Private payload read. Public callers must deliberately opt into authorized inbox access. */
  read(id: string): MessageRecord | undefined {
    let record: unknown;
    try {
      record = readJsonIfExists(this.path(id));
    } catch {
      throw new MessageError("unreadable-record");
    }
    if (record === undefined) {
      return undefined;
    }
    validRecord(record);
    requireThat(record.envelope.id === id, "binding-conflict");
    return clone(record);
  }

  /** Explicit recipient inbox read returns full original payloads, never abbreviated bodies. */
  inbox(toRole: string): readonly MessageRecord[] {
    requireThat(role(toRole), "invalid-role");
    return this.records().filter((record) => record.envelope.toRole === toRole);
  }

  private records(): readonly MessageRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw new MessageError("unreadable-inbox");
    }
    return names
      .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
      .map((name) => {
        let record: unknown;
        try {
          record = readJsonIfExists(join(this.directory, name));
        } catch {
          throw new MessageError("unreadable-record");
        }
        validRecord(record);
        requireThat(
          this.path(record.envelope.id) === join(this.directory, name),
          "binding-conflict",
        );
        return record;
      })
      .sort(
        (a, b) =>
          a.envelope.created.localeCompare(b.envelope.created) ||
          a.envelope.id.localeCompare(b.envelope.id),
      );
  }

  status(id: string): MessageStatus | undefined {
    const record = this.read(id);
    if (record === undefined) {
      return undefined;
    }
    return publicStatus(record);
  }

  summary(): MessageSummary {
    try {
      const messages = this.records().map(publicStatus);
      const counts = Object.fromEntries([...STATES].map((state) => [state, 0])) as Record<
        MessageRecord["state"],
        number
      >;
      for (const message of messages) {
        counts[message.state]++;
      }
      return { counts, messages, schema: 1, status: "available" };
    } catch {
      return {
        counts: null,
        messages: null,
        reason: "unreadable-inbox",
        schema: 1,
        status: "unavailable",
      };
    }
  }

  async enqueue(input: MessageInput): Promise<MessageRecord> {
    const envelope = messageEnvelope(input);
    const existing = this.read(envelope.id);
    if (existing !== undefined) {
      requireThat(same(existing.envelope, envelope), "id-conflict");
      return existing;
    }
    const lock = await this.lock(envelope.id);
    try {
      const previous = this.read(envelope.id);
      if (previous !== undefined) {
        requireThat(same(previous.envelope, envelope), "id-conflict");
        return previous;
      }
      return this.save({
        attempts: [],
        envelope,
        evidence: [],
        reason: null,
        retention: null,
        revision: 0,
        schema: 1,
        state: "queued",
      });
    } finally {
      lock.release();
    }
  }

  private interrupted(record: MessageRecord): MessageRecord {
    const last = record.attempts.at(-1);
    requireThat(last?.state === "sending", "invalid-transition");
    return this.save({
      ...record,
      attempts: [
        ...record.attempts.slice(0, -1),
        {
          ...last,
          completed: this.now(),
          reason: "interrupted",
          state: "ambiguous",
        },
      ],
      reason: "interrupted",
      state: "ambiguous",
    });
  }

  async recover(expected: MessageExpectation): Promise<MessageRecord> {
    const lock = await this.lock(expected.envelope.id);
    try {
      const record = this.existing(expected);
      return record.state === "sending" ? this.interrupted(record) : record;
    } finally {
      lock.release();
    }
  }

  /** A qualified pre-dispatch refusal does not create a native attempt or release a hold. */
  async block(
    expected: MessageExpectation,
    reason: MessageReason,
    diagnostic?: DeliveryDiagnostic,
  ): Promise<MessageRecord> {
    requireThat(reasonValid(reason) && reason !== null, "invalid-reason");
    const lock = await this.lock(expected.envelope.id);
    try {
      const record = this.existing(expected);
      const last = record.attempts.at(-1);
      requireThat(
        ["queued", "blocked", "parent-required"].includes(record.state) &&
          (last === undefined || ["blocked", "parent-required"].includes(last.state)),
        "retry-not-permitted",
      );
      return this.save({
        ...withoutDiagnostic(record),
        ...(safeDeliveryDiagnostic(diagnostic) === undefined
          ? {}
          : { diagnostic: safeDeliveryDiagnostic(diagnostic)! }),
        reason,
        state: "blocked",
      });
    } finally {
      lock.release();
    }
  }

  async beginAttempt(
    expected: MessageExpectation,
    hop: "recipient" | "parent" = "recipient",
  ): Promise<MessageAttemptLease> {
    const lock = await this.lock(expected.envelope.id);
    try {
      const record = this.existing(expected);
      if (record.state === "sending") {
        this.interrupted(record);
        throw new MessageError("ambiguous-attempt");
      }
      const last = record.attempts.at(-1);
      requireThat(
        ["queued", "blocked", "parent-required"].includes(record.state) &&
          (last === undefined || ["blocked", "parent-required"].includes(last.state)),
        "retry-not-permitted",
      );
      requireThat(hop === "recipient" || hop === "parent", "invalid-hop");
      let owner: MessageOwner | null;
      try {
        owner = await this.context.resolveOwner(record.envelope.toRole, clone(record.envelope));
      } catch {
        owner = null;
      }
      const workerId = record.envelope.workerId;
      if (
        !ownerValid(owner) ||
        (workerId !== undefined &&
          (owner.harness !== "codex" ||
            owner.nativeId !== workerId ||
            owner.parentBinding?.role !== record.envelope.parentRole))
      ) {
        this.save({ ...record, reason: "owner-unavailable", state: "blocked" });
        throw new MessageError("owner-unavailable");
      }
      requireThat(hop !== "parent" || owner.parentBinding !== null, "parent-binding-required");
      const binding: MessageOwner = {
        harness: owner.harness,
        nativeId: owner.nativeId,
        parentBinding:
          owner.parentBinding === null
            ? null
            : {
                nativeId: owner.parentBinding.nativeId,
                role: owner.parentBinding.role,
              },
      };
      const parentRequired = record.attempts.some(
        (attempt) =>
          attempt.state === "parent-required" &&
          attempt.source.hop === "recipient" &&
          same(attempt.source.owner, binding),
      );
      requireThat(!parentRequired || hop === "parent", "parent-hop-required");
      const source: MessageAttemptSource = { hop, owner: binding, requestId: randomUUID() };
      const attempt: MessageAttempt = {
        completed: null,
        reason: null,
        source,
        started: this.now(),
        state: "sending",
      };
      const sending = this.save({
        ...withoutDiagnostic(record),
        attempts: [...record.attempts, attempt],
        reason: null,
        state: "sending",
      });
      return this.lease(lock, sending, source);
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  private lease(
    lock: LockHandle,
    record: MessageRecord,
    source: MessageAttemptSource,
  ): MessageAttemptLease {
    let open = true;
    const expected = messageExpectation(record);
    return {
      close: () => {
        if (open) {
          try {
            this.interrupted(this.existing(expected));
          } finally {
            open = false;
            lock.release();
          }
        }
      },
      complete: (receipt: MessageCompletion) => {
        requireThat(open, "closed-attempt");
        requireThat(same(receipt.source, source), "binding-conflict");
        requireThat(
          ["accepted", "blocked", "ambiguous", "parent-required"].includes(receipt.state) &&
            reasonValid(receipt.reason) &&
            (receipt.state === "accepted" || receipt.reason !== null),
          "invalid-receipt",
        );
        const current = this.existing(expected);
        const state =
          receipt.state === "accepted" && source.hop === "parent"
            ? "parent-required"
            : receipt.state;
        const result = this.save({
          ...withoutDiagnostic(current),
          attempts: [
            ...current.attempts.slice(0, -1),
            {
              ...current.attempts.at(-1)!,
              ...(safeDeliveryDiagnostic(receipt.diagnostic) === undefined
                ? {}
                : { diagnostic: safeDeliveryDiagnostic(receipt.diagnostic)! }),
              completed: this.now(),
              reason: receipt.reason,
              state: receipt.state,
            },
          ],
          ...(safeDeliveryDiagnostic(receipt.diagnostic) === undefined
            ? {}
            : { diagnostic: safeDeliveryDiagnostic(receipt.diagnostic)! }),
          reason: receipt.reason,
          state,
        });
        open = false;
        lock.release();
        return result;
      },
      envelope: clone(record.envelope),
      source: clone(source),
    };
  }

  async reconcile(expected: MessageExpectation, evidence: MessageEvidence): Promise<MessageRecord> {
    requireThat(evidenceValid(evidence), "invalid-evidence");
    const lock = await this.lock(expected.envelope.id);
    try {
      const record = this.existing(expected);
      requireThat(same(evidence.source, expected.source), "binding-conflict");
      if (same(record.evidence.at(-1), evidence)) {
        return record;
      }
      requireThat(!terminal(record) && record.state !== "sending", "invalid-transition");
      let state: MessageRecord["state"] =
        evidence.kind === "not-delivered" ? "queued" : evidence.kind;
      let attempts = record.attempts;
      if (evidence.kind === "not-delivered" || evidence.kind === "accepted") {
        const last = attempts.at(-1);
        requireThat(last?.state !== "parent-required", "parent-hop-required");
        requireThat(
          last !== undefined &&
            last.state !== "accepted" &&
            (evidence.kind !== "accepted" || last.state === "ambiguous"),
          "invalid-transition",
        );
        attempts = [
          ...attempts.slice(0, -1),
          {
            ...last,
            completed: this.now(),
            reason: evidence.kind === "not-delivered" ? "refused" : null,
            state: evidence.kind === "not-delivered" ? "blocked" : "accepted",
          },
        ];
        if (evidence.kind === "accepted" && last.source.hop === "parent") {
          state = "parent-required";
        }
      }
      const preserveHold =
        (record.state === "held" || record.state === "retained") &&
        (evidence.kind === "not-delivered" || evidence.kind === "accepted");
      return this.save({
        ...record,
        attempts,
        evidence: [...record.evidence, clone(evidence)],
        reason: preserveHold ? record.reason : evidence.kind === "retained" ? "retained" : null,
        retention: preserveHold ? record.retention : evidence.retention,
        state: preserveHold ? record.state : state,
      });
    } finally {
      lock.release();
    }
  }

  async hold(expected: MessageExpectation, retention: MessageRetention): Promise<MessageRecord> {
    requireThat(retentionValid(retention), "invalid-retention");
    const lock = await this.lock(expected.envelope.id);
    try {
      const record = this.existing(expected);
      requireThat(!terminal(record) && record.state !== "sending", "invalid-transition");
      return this.save({
        ...record,
        reason: "explicit-hold",
        retention: clone(retention),
        state: "held",
      });
    } finally {
      lock.release();
    }
  }

  async release(expected: MessageExpectation): Promise<MessageRecord> {
    const lock = await this.lock(expected.envelope.id);
    try {
      const record = this.existing(expected);
      requireThat(record.state === "held" || record.state === "retained", "invalid-transition");
      const last = record.attempts.at(-1);
      const state =
        last?.state === "accepted"
          ? last.source.hop === "parent"
            ? "parent-required"
            : "accepted"
          : last?.state === "ambiguous"
            ? "ambiguous"
            : last?.state === "parent-required"
              ? "parent-required"
              : "queued";
      return this.save({ ...record, reason: null, retention: null, state });
    } finally {
      lock.release();
    }
  }
}
