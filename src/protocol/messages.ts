// Sender publications and recipient receipts are distinct from native transport observations.
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { messageEnvelope } from "../messages/envelope.ts";
import type {
  MessageEnvelope,
  MessageInput,
  MessageRetention,
  MessageState,
} from "../messages/types.ts";
import { protocolRole, ProtocolStore } from "./core.ts";
import type {
  ArtifactRef,
  ProtocolObject,
  ProtocolState,
  ProtocolTransaction,
  ProtocolValue,
  ProtocolWriter,
} from "./types.ts";
export type MessageWriter = Omit<ProtocolTransaction, "mutations">;
/** Canonical sender object identity. Hash covers the whole immutable publication, not only its body. */
export interface OriginalRef {
  readonly senderRole: string;
  readonly messageId: string;
  readonly revision: number;
  readonly hash: string;
}
export interface ProtocolMessageLinks {
  readonly requestIds: readonly string[];
  readonly clauseIds: readonly string[];
  readonly workIds: readonly string[];
  readonly messageIds: readonly string[];
}
/** Observed metadata only. These fields never authorize native delivery or question mutation. */
export interface ProtocolMessageGuards {
  readonly question: "unknown" | "pending" | "clear" | "unavailable";
  readonly hold: "unknown" | "held" | "clear" | "unavailable";
  readonly references: readonly string[];
  readonly artifacts: readonly ArtifactRef[];
}
export interface LegacyOriginalImport {
  readonly legacyRecord: ArtifactRef;
  readonly evidenceRef: string;
}
export interface PublishOriginal {
  readonly envelope: MessageInput;
  readonly links: ProtocolMessageLinks;
  readonly guards: ProtocolMessageGuards;
  readonly imported?: LegacyOriginalImport;
}
/** read(ref) returns this object; envelope is the only current original authority. */
export interface ProtocolMessageOriginal {
  readonly schema: 1;
  readonly kind: "message-original";
  readonly senderRole: string;
  readonly envelope: MessageEnvelope;
  readonly links: ProtocolMessageLinks;
  readonly guards: ProtocolMessageGuards;
  readonly imported: LegacyOriginalImport | null;
}
export interface ProtocolReceiptInput {
  readonly id: string;
  readonly original: OriginalRef;
  readonly disposition: "handled" | "superseded" | "retained";
  readonly evidence: readonly ArtifactRef[];
  readonly retention: MessageRetention | null;
  readonly guards: ProtocolMessageGuards;
}
export interface ProtocolReceipt extends ProtocolReceiptInput {
  readonly schema: 1;
  readonly kind: "message-receipt";
  readonly recipientRole: string;
}
export interface ProtocolTransportInput {
  readonly id: string;
  readonly original: OriginalRef;
  readonly record: ArtifactRef;
  readonly guards: ProtocolMessageGuards;
}
export interface ProtocolTransport extends ProtocolTransportInput {
  readonly schema: 1;
  readonly kind: "message-transport";
  readonly state: MessageState | "unknown";
}
export interface ProtocolWithdrawalInput {
  readonly id: string;
  readonly original: OriginalRef;
  readonly reason: string;
  readonly evidenceRef: string;
  readonly guards: ProtocolMessageGuards;
}
export interface ProtocolWithdrawal extends ProtocolWithdrawalInput {
  readonly schema: 1;
  readonly kind: "message-withdrawal";
  readonly status: "requested";
  readonly recall: "cannot-recall" | "not-proven";
  readonly observedRecipientRole: string | null;
  readonly observedRecipientRevision: number | null;
}
export interface ProtocolMessageRef {
  readonly role: string;
  readonly id: string;
  readonly revision: number;
  readonly hash: string;
}
export interface ProtocolInboxEntry {
  readonly reference: OriginalRef;
  readonly original: Omit<ProtocolMessageOriginal, "envelope"> & {
    readonly envelope: Omit<MessageEnvelope, "body"> & {
      readonly body?: string;
    };
  };
  readonly receipts: readonly {
    readonly reference: ProtocolMessageRef;
    readonly value: ProtocolReceipt;
  }[];
  readonly transport: readonly {
    readonly reference: ProtocolMessageRef;
    readonly value: ProtocolTransport;
  }[];
  readonly withdrawals: readonly {
    readonly reference: ProtocolMessageRef;
    readonly value: ProtocolWithdrawal;
  }[];
}
export interface ProtocolInbox {
  readonly scope: "published-only";
  readonly senderRoles: readonly string[];
  readonly messages: readonly ProtocolInboxEntry[];
}
export class ProtocolMessageError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
function demand(value: unknown, code: string): asserts value {
  if (!value) {
    throw new ProtocolMessageError(code);
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function shape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (object(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function json(value: unknown): ProtocolValue {
  return JSON.parse(JSON.stringify(value)) as ProtocolValue;
}
function namespace(role: string): string {
  return role === "coordinator" || role.startsWith("kits/") || role.startsWith("games/")
    ? role
    : protocolRole(role);
}
function key(kind: string, value: unknown): string {
  return `${kind}-${digest(value)}`;
}
function originalKey(id: string): string {
  return key("original", id);
}
function receiptKey(ref: OriginalRef): string {
  return key("receipt", [ref.senderRole, ref.messageId, ref.revision, ref.hash]);
}
function artifact(value: unknown): value is ArtifactRef {
  return (
    shape(value, ["hash", "size"]) &&
    typeof value.hash === "string" &&
    /^[a-f0-9]{64}$/u.test(value.hash) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) >= 0
  );
}
function validGuards(value: unknown): value is ProtocolMessageGuards {
  return (
    shape(value, ["question", "hold", "references", "artifacts"]) &&
    ["unknown", "pending", "clear", "unavailable"].includes(String(value.question)) &&
    ["unknown", "held", "clear", "unavailable"].includes(String(value.hold)) &&
    Array.isArray(value.references) &&
    value.references.every(text) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(artifact)
  );
}
function validLinks(value: unknown): value is ProtocolMessageLinks {
  return (
    object(value) &&
    Object.keys(value).sort().join(",") === "clauseIds,messageIds,requestIds,workIds" &&
    Object.values(value).every(
      (ids) => Array.isArray(ids) && ids.every(text) && new Set(ids).size === ids.length,
    )
  );
}
function originalReference(role: string, entry: ProtocolObject): OriginalRef {
  demand(
    object(entry.value) && object(entry.value.envelope) && text(entry.value.envelope.id),
    "corrupt-message",
  );
  return {
    hash: digest(entry.value),
    messageId: entry.value.envelope.id,
    revision: entry.revision,
    senderRole: role,
  };
}
function publicationReference(role: string, entry: ProtocolObject): ProtocolMessageRef {
  return { hash: digest(entry.value), id: entry.id, revision: entry.revision, role };
}
/** No method starts a frontend, dispatches transport, acknowledges a queue or changes a question. */
export class ProtocolMessages {
  readonly #store: ProtocolStore;
  #view: Map<string, ProtocolState> | null = null;
  #parents: readonly string[] | null = null;
  #allRoles: readonly string[] | null = null;
  constructor(options: { readonly store: ProtocolStore }) {
    this.#store = options.store;
  }
  /** Synchronous operation-local filesystem view, never a current route or native guard cache. */
  withReadView<T>(action: () => T): T {
    if (this.#view !== null) {
      return action();
    }
    this.#view = new Map();
    try {
      const value = action();
      demand(!(value instanceof Promise), "invalid-message-read-view");
      return value;
    } finally {
      this.#view = null;
      this.#parents = null;
      this.#allRoles = null;
    }
  }
  #roles(includeWorkers = false): readonly string[] {
    if (this.#view === null) {
      return this.#store.listRoles({ includeWorkers });
    }
    if (includeWorkers) {
      return (this.#allRoles ??= this.#store.listRoles({ includeWorkers: true }));
    }
    return (this.#parents ??= this.#store.listRoles());
  }
  #state(role: string): ProtocolState {
    const previous = this.#view?.get(role);
    if (previous !== undefined) {
      return previous;
    }
    const state = this.#store.read(role);
    this.#view?.set(role, state);
    return state;
  }
  #artifact(ref: ArtifactRef): Uint8Array {
    demand(artifact(ref), "invalid-artifact");
    const bytes = this.#store.readArtifact(ref.hash);
    demand(bytes.byteLength === ref.size, "artifact-size-mismatch");
    return bytes;
  }
  #guards(guards: ProtocolMessageGuards): void {
    demand(validGuards(guards), "invalid-message-guards");
    for (const ref of guards.artifacts) {
      this.#artifact(ref);
    }
  }
  #legacy(ref: ArtifactRef, envelope: MessageEnvelope): Record<string, unknown> {
    const bytes = this.#artifact(ref);
    demand(isUtf8(bytes), "invalid-legacy-record");
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new ProtocolMessageError("invalid-legacy-record");
    }
    demand(object(value) && object(value.envelope), "invalid-legacy-record");
    const decoded = messageEnvelope(value.envelope as unknown as MessageInput);
    demand(
      isDeepStrictEqual(decoded, envelope) && value.envelope.payloadHash === envelope.payloadHash,
      "legacy-original-mismatch",
    );
    return value;
  }
  #original(ref: OriginalRef): {
    entry: ProtocolObject;
    value: ProtocolMessageOriginal;
  } {
    demand(
      shape(ref, ["senderRole", "messageId", "revision", "hash"]) &&
        text(ref.senderRole) &&
        text(ref.messageId) &&
        Number.isSafeInteger(ref.revision) &&
        ref.revision === 1 &&
        /^[a-f0-9]{64}$/u.test(ref.hash),
      "invalid-original-reference",
    );
    const entry = this.#state(ref.senderRole).objects.find(
      (row) => row.collection === "messages" && row.id === originalKey(ref.messageId),
    );
    demand(entry !== undefined, "message-missing");
    demand(
      entry.revision === ref.revision && digest(entry.value) === ref.hash && object(entry.value),
      "original-reference-mismatch",
    );
    const value = entry.value as unknown as ProtocolMessageOriginal;
    demand(
      shape(value, ["schema", "kind", "senderRole", "envelope", "links", "guards", "imported"]) &&
        value.schema === 1 &&
        value.kind === "message-original" &&
        value.senderRole === ref.senderRole &&
        object(value.envelope) &&
        value.envelope.id === ref.messageId &&
        isDeepStrictEqual(messageEnvelope(value.envelope), value.envelope) &&
        protocolRole(value.envelope.fromRole) === ref.senderRole &&
        validLinks(value.links),
      "corrupt-message",
    );
    this.#guards(value.guards);
    if (value.imported !== null) {
      demand(
        shape(value.imported, ["legacyRecord", "evidenceRef"]) && text(value.imported.evidenceRef),
        "corrupt-message",
      );
      this.#legacy(value.imported.legacyRecord, value.envelope);
    }
    return { entry, value };
  }
  read(ref: OriginalRef): ProtocolMessageOriginal {
    return structuredClone(this.#original(ref).value);
  }
  find(senderRole: string, messageId: string): OriginalRef | null {
    demand(text(senderRole) && text(messageId), "invalid-original-reference");
    const role = namespace(senderRole);
    const entry = this.#state(role).objects.find(
      (row) => row.collection === "messages" && row.id === originalKey(messageId),
    );
    if (entry === undefined) {
      return null;
    }
    const ref = originalReference(role, entry);
    this.#original(ref);
    return ref;
  }
  async #write(
    writer: MessageWriter,
    collection: "messages" | "receipts",
    id: string,
    value: unknown,
    immutable = true,
  ): Promise<ProtocolMessageRef> {
    demand(this.#view === null, "message-read-view-write-refused");
    const normalized = json(value);
    const prior = this.#store
      .history(writer.role)
      .find((event) => event.type === "transaction" && event.transaction.id === writer.id);
    if (prior?.type === "transaction") {
      const { mutations, ...context } = prior.transaction;
      demand(
        isDeepStrictEqual(context, writer) &&
          mutations.length === 1 &&
          mutations[0]!.collection === collection &&
          mutations[0]!.id === id &&
          isDeepStrictEqual(mutations[0]!.value, normalized),
        "message-command-conflict",
      );
      await this.#store.transact(prior.transaction);
      return {
        hash: digest(normalized),
        id,
        revision: mutations[0]!.expectedRevision + 1,
        role: writer.role,
      };
    }
    const current = this.#store
      .read(writer.role)
      .objects.find((row) => row.collection === collection && row.id === id);
    if (current !== undefined && immutable) {
      demand(isDeepStrictEqual(current.value, normalized), "message-conflict");
      return this.#store.withWriter(
        { binding: writer.binding, epoch: writer.epoch, role: writer.role },
        () => publicationReference(writer.role, current),
      );
    }
    await this.#store.transact({
      ...writer,
      mutations: [{ collection, expectedRevision: current?.revision ?? 0, id, value: normalized }],
    });
    return {
      hash: digest(normalized),
      id,
      revision: (current?.revision ?? 0) + 1,
      role: writer.role,
    };
  }
  async publish(writer: MessageWriter, input: PublishOriginal): Promise<OriginalRef> {
    demand(this.#view === null && object(input), "invalid-message");
    demand(
      shape(
        input,
        input.imported === undefined
          ? ["envelope", "links", "guards"]
          : ["envelope", "links", "guards", "imported"],
      ),
      "invalid-message",
    );
    const envelope = messageEnvelope(input.envelope);
    demand(writer.role === protocolRole(envelope.fromRole), "message-sender-mismatch");
    demand(validLinks(input.links), "invalid-message-links");
    this.#guards(input.guards);
    if (input.imported !== undefined) {
      demand(
        shape(input.imported, ["legacyRecord", "evidenceRef"]) && text(input.imported.evidenceRef),
        "invalid-legacy-record",
      );
      this.#legacy(input.imported.legacyRecord, envelope);
    }
    const value: ProtocolMessageOriginal = {
      envelope,
      guards: structuredClone(input.guards),
      imported: input.imported ?? null,
      kind: "message-original",
      links: structuredClone(input.links),
      schema: 1,
      senderRole: writer.role,
    };
    const entry = await this.#write(writer, "messages", originalKey(envelope.id), value);
    demand(entry.revision === 1, "corrupt-message");
    return {
      hash: entry.hash,
      messageId: envelope.id,
      revision: entry.revision,
      senderRole: writer.role,
    };
  }
  #recipientRoles(original: ProtocolMessageOriginal): string[] {
    const parent = protocolRole(original.envelope.toRole);
    if (original.envelope.workerId === undefined) {
      return [parent];
    }
    return this.#roles(true)
      .filter((role) => {
        const state = this.#state(role);
        return (
          state.parent?.role === parent && state.parent.workerId === original.envelope.workerId
        );
      })
      .sort((left, right) => this.#state(right).parent!.epoch - this.#state(left).parent!.epoch);
  }
  #isRecipient(writer: ProtocolWriter, original: ProtocolMessageOriginal): boolean {
    if (original.envelope.workerId === undefined) {
      return writer.role === protocolRole(original.envelope.toRole);
    }
    const state = this.#state(writer.role);
    return (
      state.parent?.role === protocolRole(original.envelope.toRole) &&
      state.parent.workerId === original.envelope.workerId &&
      writer.binding.nativeId === original.envelope.workerId
    );
  }
  latestRecipientReceipt(ref: OriginalRef): {
    readonly reference: ProtocolMessageRef;
    readonly value: ProtocolReceipt;
  } | null {
    const original = this.read(ref);
    for (const role of this.#recipientRoles(original)) {
      const row = this.#state(role).objects.find(
        (entry) => entry.collection === "receipts" && entry.id === receiptKey(ref),
      );
      if (row === undefined) {
        continue;
      }
      const value = row.value as unknown as ProtocolReceipt;
      this.#checkReceipt(value, ref, role, original);
      return { reference: publicationReference(role, row), value: structuredClone(value) };
    }
    return null;
  }
  #checkReceipt(
    value: ProtocolReceipt,
    ref: OriginalRef,
    role: string,
    original: ProtocolMessageOriginal,
  ): void {
    demand(
      shape(value, [
        "schema",
        "kind",
        "recipientRole",
        "id",
        "original",
        "disposition",
        "evidence",
        "retention",
        "guards",
      ]) &&
        value.schema === 1 &&
        value.kind === "message-receipt" &&
        value.recipientRole === role &&
        isDeepStrictEqual(value.original, ref) &&
        text(value.id) &&
        ["handled", "superseded", "retained"].includes(value.disposition),
      "invalid-message-receipt",
    );
    const state = this.#state(role);
    demand(
      original.envelope.workerId === undefined
        ? role === protocolRole(original.envelope.toRole)
        : state.parent?.role === protocolRole(original.envelope.toRole) &&
            state.parent.workerId === original.envelope.workerId,
      "message-recipient-mismatch",
    );
    demand(
      Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.every(artifact),
      "invalid-message-receipt",
    );
    for (const evidence of value.evidence) {
      this.#artifact(evidence);
    }
    this.#guards(value.guards);
    if (value.disposition === "retained") {
      demand(
        shape(value.retention, ["ownerRole", "reason", "nextBoundary"]) &&
          text(value.retention.ownerRole) &&
          text(value.retention.reason) &&
          text(value.retention.nextBoundary),
        "message-retention-required",
      );
    } else {
      demand(value.retention === null, "invalid-message-receipt");
    }
  }
  async receipt(writer: MessageWriter, input: ProtocolReceiptInput): Promise<ProtocolMessageRef> {
    demand(this.#view === null, "message-read-view-write-refused");
    demand(
      shape(input, ["id", "original", "disposition", "evidence", "retention", "guards"]),
      "invalid-message-receipt",
    );
    const original = this.read(input.original);
    demand(this.#isRecipient(writer, original), "message-recipient-mismatch");
    const value: ProtocolReceipt = {
      ...structuredClone(input),
      kind: "message-receipt",
      recipientRole: writer.role,
      schema: 1,
    };
    this.#checkReceipt(value, input.original, writer.role, original);
    for (const event of this.#store.history(writer.role)) {
      if (event.type !== "transaction") {
        continue;
      }
      for (const mutation of event.transaction.mutations) {
        if (
          mutation.collection !== "receipts" ||
          mutation.id !== receiptKey(input.original) ||
          !object(mutation.value) ||
          mutation.value.id !== input.id
        ) {
          continue;
        }
        demand(isDeepStrictEqual(mutation.value, json(value)), "message-conflict");
        return this.#store.withWriter(
          { binding: writer.binding, epoch: writer.epoch, role: writer.role },
          () => ({
            hash: digest(mutation.value),
            id: mutation.id,
            revision: mutation.expectedRevision + 1,
            role: writer.role,
          }),
        );
      }
    }
    return this.#write(writer, "receipts", receiptKey(input.original), value, false);
  }
  async observeTransport(
    writer: MessageWriter,
    input: ProtocolTransportInput,
  ): Promise<ProtocolMessageRef> {
    demand(shape(input, ["id", "original", "record", "guards"]), "invalid-message-transport");
    demand(writer.role === input.original.senderRole && text(input.id), "message-sender-mismatch");
    const original = this.read(input.original);
    const legacy = this.#legacy(input.record, original.envelope);
    this.#guards(input.guards);
    const states = [
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
    ];
    const state = states.includes(String(legacy.state))
      ? (legacy.state as MessageState)
      : "unknown";
    return this.#write(writer, "messages", key("transport", [input.original.messageId, input.id]), {
      ...structuredClone(input),
      kind: "message-transport",
      schema: 1,
      state,
    } satisfies ProtocolTransport);
  }
  #senderRecords<T>(
    ref: OriginalRef,
    kind: string,
  ): {
    reference: ProtocolMessageRef;
    value: T;
  }[] {
    return this.#state(ref.senderRole)
      .objects.filter(
        (row) =>
          row.collection === "messages" &&
          object(row.value) &&
          row.value.kind === kind &&
          isDeepStrictEqual(row.value.original, ref),
      )
      .map((row) => ({
        reference: publicationReference(ref.senderRole, row),
        value: structuredClone(row.value) as unknown as T,
      }));
  }
  async withdraw(
    writer: MessageWriter,
    input: ProtocolWithdrawalInput,
  ): Promise<ProtocolMessageRef> {
    demand(
      shape(input, ["id", "original", "reason", "evidenceRef", "guards"]),
      "invalid-message-withdrawal",
    );
    demand(
      writer.role === input.original.senderRole &&
        text(input.id) &&
        text(input.reason) &&
        text(input.evidenceRef),
      "invalid-message-withdrawal",
    );
    const original = this.read(input.original);
    this.#guards(input.guards);
    const observed = this.#senderRecords<ProtocolTransport>(
      input.original,
      "message-transport",
    ).map((row) => this.#legacy(row.value.record, original.envelope));
    if (original.imported !== null) {
      observed.push(this.#legacy(original.imported.legacyRecord, original.envelope));
    }
    const cannotRecall = observed.some(
      (record) =>
        ["sending", "accepted", "ambiguous"].includes(String(record.state)) ||
        (Array.isArray(record.attempts) &&
          record.attempts.some(
            (attempt) =>
              object(attempt) &&
              ["sending", "accepted", "ambiguous"].includes(String(attempt.state)),
          )),
    );
    const role = this.#recipientRoles(original)[0] ?? null;
    const value: ProtocolWithdrawal = {
      ...structuredClone(input),
      kind: "message-withdrawal",
      observedRecipientRevision: role === null ? null : this.#state(role).revision,
      observedRecipientRole: role,
      recall: cannotRecall ? "cannot-recall" : "not-proven",
      schema: 1,
      status: "requested",
    };
    return this.#write(
      writer,
      "messages",
      key("withdrawal", [input.original.messageId, input.id]),
      value,
    );
  }
  inbox(options: {
    readonly recipientRole: string;
    readonly senders?: readonly string[];
    readonly includeBody?: boolean;
  }): ProtocolInbox {
    return this.withReadView(() => this.#inbox(options));
  }
  #inbox(options: {
    readonly recipientRole: string;
    readonly senders?: readonly string[];
    readonly includeBody?: boolean;
  }): ProtocolInbox {
    const recipient = namespace(options.recipientRole);
    this.#state(recipient);
    const senders = [...new Set(options.senders?.map(namespace) ?? this.#roles())].sort();
    const messages: ProtocolInboxEntry[] = [];
    for (const role of senders) {
      for (const entry of this.#state(role).objects) {
        if (
          entry.collection !== "messages" ||
          !object(entry.value) ||
          entry.value.kind !== "message-original"
        ) {
          continue;
        }
        const reference = originalReference(role, entry);
        const original = this.read(reference);
        if (
          protocolRole(original.envelope.toRole) !== recipient &&
          !this.#recipientRoles(original).includes(recipient)
        ) {
          continue;
        }
        const { body, ...metadata } = original.envelope;
        const receipt = this.latestRecipientReceipt(reference);
        messages.push({
          original: {
            ...original,
            envelope: { ...metadata, ...(options.includeBody === true ? { body } : {}) },
          },
          receipts: receipt === null ? [] : [receipt],
          reference,
          transport: this.#senderRecords<ProtocolTransport>(reference, "message-transport"),
          withdrawals: this.#senderRecords<ProtocolWithdrawal>(reference, "message-withdrawal"),
        });
      }
    }
    return {
      messages: messages.sort((a, b) =>
        canonical(a.reference).localeCompare(canonical(b.reference)),
      ),
      scope: "published-only",
      senderRoles: senders,
    };
  }
}
