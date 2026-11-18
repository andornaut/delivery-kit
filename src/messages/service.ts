// Durable local delivery is independent of native admission. Only explicit dispatch consults
// current registered ownership and the existing recipient guards.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

import { captureAccounting } from "../accounting/boundary.ts";
import { recipientReady } from "../adapters/claude/agents.ts";
import type { MessageChannelGuard } from "../adapters/claude/channel.ts";
import { clearanceUnchanged } from "../adapters/codex/guard.ts";
import { connectControl, type RpcClient, RpcError } from "../adapters/codex/rpc.ts";
import { deliverReceipt, selectTarget } from "../adapters/codex/steer.ts";
import { decisionClear, decisionRecord } from "../adapters/shared/decisions.ts";
import { resolveCodexControlSocket } from "../adapters/shared/endpoints.ts";
import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { isRecord } from "../adapters/shared/pyjson.ts";
import { readRoleRoute } from "../adapters/shared/route.ts";
import { type DeliveryDiagnostic, safeDeliveryDiagnostic } from "../adapters/types.ts";
import { readJsonIfExists } from "../durable.ts";
import { gameLayout, type Layout } from "../layout.ts";
import { resolveConversation, resolveHarness, resolveRole } from "../registry/resolve.ts";
import { readRegistry } from "../registry/store.ts";
import { messageChannelStateDir } from "./paths.ts";
import { MessageError, messageExpectation, MessageStore } from "./store.ts";
import {
  adapterTransportReceipt,
  claudeMessageTransport,
  codexQueueTransport,
  type MessageTransport,
  type NativeMessage,
  type TransportReceipt,
} from "./transports.ts";
import type {
  MessageAttemptIndexEntry,
  MessageAttemptSource,
  MessageEnvelope,
  MessageOwner,
  MessageRecord,
  MessageRetention,
  MessageStatus,
} from "./types.ts";

export interface MessageChannelInput {
  readonly requestId: string;
  readonly recipient: string;
  readonly text: string;
}

export interface MessageClearance {
  readonly status: "clear" | "blocked" | "unavailable";
}

type MessageAttemptIndex = ReadonlyMap<string, readonly MessageAttemptIndexEntry[]>;

/** Resolve the current registered owner without probing a session or manufacturing lineage. */
export function currentMessageOwner(
  layout: Layout,
  envelope: MessageEnvelope,
): MessageOwner | null {
  try {
    const registry = readRegistry(layout);
    const role = resolveRole(registry, envelope.toRole);
    const record = registry.roles[role]!;
    if (
      record.ownership !== "active" ||
      record.phase === "held" ||
      record.phase === "source-held"
    ) {
      return null;
    }
    const harness = resolveHarness(registry, role);
    const nativeId = resolveConversation(registry, role);
    if (nativeId === null) {
      return null;
    }
    if (envelope.workerId !== undefined) {
      if (harness !== "codex" || envelope.parentRole !== role) {
        return null;
      }
      return { harness, nativeId: envelope.workerId, parentBinding: { nativeId, role } };
    }
    return { harness, nativeId, parentBinding: null };
  } catch {
    return null;
  }
}

/** Existing game/route recipient decision directory; never create a message-specific permit. */
export function messageGuardDirectory(layout: Layout, role: string): string | null {
  try {
    const game = role.split("/")[0]!;
    if (role.includes("/") && Object.hasOwn(layout.config.games, game)) {
      return join(gameLayout(layout, game).busDir, "unblock");
    }
    const route = readRoleRoute(layout);
    return route?.state === "active"
      ? join(gameLayout(layout, route.host).busDir, "unblock")
      : null;
  } catch {
    return null;
  }
}

export function messageNativeRecipient(source: MessageAttemptSource): string {
  return source.hop === "parent" ? source.owner.parentBinding!.nativeId : source.owner.nativeId;
}

/** Parent requests preserve the full original payload and logical child target. */
export function messageTransportText(record: MessageRecord, source: MessageAttemptSource): string {
  if (source.hop === "recipient") {
    return record.envelope.body;
  }
  return JSON.stringify({
    body: record.envelope.body,
    fromRole: record.envelope.fromRole,
    id: record.envelope.id,
    instruction:
      "Parent request only. Verify this worker using your supported parent tools " +
      "and preserve its questions and holds. Parent acceptance is not child delivery.",
    parentRole: record.envelope.parentRole,
    schema: 1,
    workerId: record.envelope.workerId,
  });
}

function bindingCurrent(
  layout: Layout,
  record: MessageRecord,
  source: MessageAttemptSource,
): boolean {
  return isDeepStrictEqual(currentMessageOwner(layout, record.envelope), source.owner);
}

function terminalState(state: MessageRecord["state"]): boolean {
  return state === "handled" || state === "superseded";
}

/**
 * Generic channel consumption uses exact durable source and fresh supported guards. `drain()`
 * opens one store index for a consumer drain; calling the guard directly opens a fresh index.
 */
export function messageConsumeGuard(layout: Layout, env: NodeJS.ProcessEnv): MessageChannelGuard {
  // A terminal record never takes another attempt, so its latest request ID stays undeliverable.
  const terminalRequests = new Set<string>();
  const drain = () => {
    let view: { readonly store: MessageStore; readonly index: MessageAttemptIndex } | null = null;
    let opened = false;
    const open = () => {
      if (!opened) {
        opened = true;
        try {
          const store = new MessageStore({
            layout,
            resolveOwner: (_role, envelope) => currentMessageOwner(layout, envelope),
          });
          view = { index: store.attemptIndex(), store };
        } catch {
          view = null;
        }
      }
      return view;
    };
    return async (message: MessageChannelInput): Promise<MessageClearance> => {
      try {
        if (!isCanonicalUuid(message.requestId) || !isCanonicalUuid(message.recipient)) {
          return { status: "blocked" };
        }
        if (terminalRequests.has(message.requestId)) {
          return { status: "blocked" };
        }
        const current = open();
        if (current === null) {
          return { status: "unavailable" };
        }
        const { store } = current;
        const matches = (current.index.get(message.requestId) ?? []).filter((item) => item.latest);
        if (matches.some((item) => terminalState(item.state))) {
          terminalRequests.add(message.requestId);
          return { status: "blocked" };
        }
        if (matches.length !== 1) {
          return { status: "blocked" };
        }
        const snapshot = matches[0]!;
        const record = store.read(snapshot.id);
        const source = record?.attempts.at(-1)?.source;
        if (
          record === undefined ||
          record.revision !== snapshot.revision ||
          source === undefined ||
          source.requestId !== message.requestId ||
          source.owner.harness !== "claude" ||
          !["sending", "ambiguous"].includes(record.state) ||
          messageNativeRecipient(source) !== message.recipient ||
          messageTransportText(record, source) !== message.text ||
          !bindingCurrent(layout, record, source)
        ) {
          return { status: "blocked" };
        }
        const directory = messageGuardDirectory(layout, record.envelope.toRole);
        if (directory === null) {
          return { status: "unavailable" };
        }
        const route = record.envelope.toRole.includes("/") ? null : readRoleRoute(layout);
        const marker = decisionRecord(directory, message.recipient);
        if (!decisionClear(directory, message.recipient)) {
          return { status: "blocked" };
        }
        if (recipientReady(env, message.recipient).status === null) {
          return { status: "unavailable" };
        }
        const latest = store.read(record.envelope.id);
        return {
          status:
            latest?.revision === snapshot.revision &&
            latest.attempts.at(-1)?.source.requestId === message.requestId &&
            isDeepStrictEqual(latest.attempts.at(-1)?.source, source) &&
            bindingCurrent(layout, record, source) &&
            messageGuardDirectory(layout, record.envelope.toRole) === directory &&
            (route === null || isDeepStrictEqual(route, readRoleRoute(layout))) &&
            decisionClear(directory, message.recipient) &&
            isDeepStrictEqual(marker, decisionRecord(directory, message.recipient))
              ? "clear"
              : "blocked",
        };
      } catch {
        return { status: "unavailable" };
      }
    };
  };
  return Object.assign((message: MessageChannelInput) => drain()(message), { drain });
}

export interface MessageSendInput {
  readonly fromRole: string;
  readonly recipient: string;
  readonly id: string;
  readonly body: string;
  readonly intent?: "queue" | "unblock";
  readonly parent?: string;
}

export interface MessageServiceContext {
  readonly layout: Layout;
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly connect?: () => Promise<RpcClient>;
  /** A transport test port; explicit dispatch still requires current local recipient guards. */
  readonly transport?: (
    record: MessageRecord,
    source: MessageAttemptSource,
    directory: string,
  ) => MessageTransport;
}

export interface MessageView extends MessageStatus {
  readonly body?: string;
  readonly retention?: MessageRetention | null;
}

/** Stable local inbox and explicit guarded dispatch. Construction never probes a provider. */
export class MessageService {
  readonly store: MessageStore;
  private readonly context: MessageServiceContext;

  constructor(context: MessageServiceContext) {
    this.context = context;
    this.store = new MessageStore({
      layout: context.layout,
      resolveOwner: (_role, envelope) => currentMessageOwner(context.layout, envelope),
      ...(context.now === undefined ? {} : { now: context.now }),
    });
  }

  private record(id: string): MessageRecord {
    const record = this.store.read(id);
    if (record === undefined) {
      throw new MessageError("missing");
    }
    return record;
  }

  view(record: MessageRecord, includeBody = false, includeRetention = false): MessageView {
    const status = this.store.status(record.envelope.id);
    if (status === undefined || status.revision !== record.revision) {
      throw new MessageError("binding-conflict");
    }
    return {
      ...status,
      ...(includeBody ? { body: record.envelope.body } : {}),
      ...(includeRetention ? { retention: structuredClone(record.retention) } : {}),
    };
  }

  async send(input: MessageSendInput): Promise<MessageRecord> {
    const registry = readRegistry(this.context.layout);
    resolveRole(registry, input.fromRole);
    if (!isCanonicalUuid(input.id)) {
      throw new MessageError("invalid-id");
    }
    let toRole: string;
    if (input.parent !== undefined) {
      if (!isCanonicalUuid(input.recipient) || isCanonicalUuid(input.parent)) {
        throw new MessageError("invalid-worker-target");
      }
      toRole = resolveRole(registry, input.parent);
    } else if (isCanonicalUuid(input.recipient)) {
      const holders = Object.keys(registry.roles).filter(
        (role) => resolveConversation(registry, role) === input.recipient,
      );
      if (holders.length !== 1) {
        throw new MessageError("recipient-unavailable");
      }
      toRole = holders[0]!;
    } else {
      toRole = resolveRole(registry, input.recipient);
    }
    const prior = this.store.read(input.id);
    const original = this.store.original(input.fromRole, input.id);
    const record = await this.store.enqueue({
      body: input.body,
      created:
        original?.created ??
        prior?.envelope.created ??
        this.context.now?.() ??
        new Date().toISOString(),
      fromRole: input.fromRole,
      id: input.id,
      intent: input.intent ?? "queue",
      ...(input.parent === undefined ? {} : { parentRole: toRole, workerId: input.recipient }),
      schema: 1,
      toRole,
    });
    const accounting = await captureAccounting(
      this.context.layout,
      { message_id: record.envelope.id },
      "review",
      "message",
    );
    if (accounting.status !== "available") {
      // The original is retained and the same message ID can safely retry local accounting.
      throw new MessageError("accounting-unavailable");
    }
    return record;
  }

  status(selection: {
    readonly id?: string;
    readonly recipient?: string;
    readonly includeBody?: boolean;
    readonly includeRetention?: boolean;
  }): readonly MessageView[] {
    if ((selection.id === undefined) === (selection.recipient === undefined)) {
      throw new MessageError("invalid-selection");
    }
    if (selection.id !== undefined) {
      return [
        this.view(this.record(selection.id), selection.includeBody, selection.includeRetention),
      ];
    }
    const role = resolveRole(readRegistry(this.context.layout), selection.recipient!);
    return this.store
      .inbox(role)
      .map((record) => this.view(record, selection.includeBody, selection.includeRetention));
  }

  private receiptPath(source: MessageAttemptSource): string {
    return join(
      messageChannelStateDir(this.context.layout, messageNativeRecipient(source)),
      `${source.requestId}.json`,
    );
  }

  private receipt(record: MessageRecord): {
    readonly status: string;
    readonly ref: string;
    readonly diagnostic?: DeliveryDiagnostic;
  } | null {
    const source = record.attempts.at(-1)?.source;
    if (source === undefined) {
      return null;
    }
    try {
      const value = readJsonIfExists(this.receiptPath(source));
      if (
        !isRecord(value) ||
        value.recipient !== messageNativeRecipient(source) ||
        value.text !== messageTransportText(record, source) ||
        (value.requestId ?? value.clientUserMessageId) !== source.requestId ||
        typeof value.status !== "string"
      ) {
        return null;
      }
      const diagnostic = safeDeliveryDiagnostic(value.diagnostic);
      return {
        ref: source.requestId,
        status: value.status,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      };
    } catch {
      return null;
    }
  }

  /** Local accepted receipts can prove acceptance; absence or blocked guards never prove loss. */
  async reconcileReceipt(id: string): Promise<MessageRecord> {
    let record = this.record(id);
    if (record.state === "sending") {
      record = await this.store.recover(messageExpectation(record));
    }
    const receipt = this.receipt(record);
    if (
      !["ambiguous", "held", "retained"].includes(record.state) ||
      record.attempts.at(-1)?.state !== "ambiguous" ||
      receipt?.status !== "accepted"
    ) {
      return record;
    }
    return this.store.reconcile(messageExpectation(record), {
      kind: "accepted",
      ref: receipt.ref,
      retention: null,
      source: record.attempts.at(-1)!.source,
    });
  }

  async reconcile(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly disposition: "handled" | "superseded" | "retained" | "accepted";
    readonly evidence: string;
    readonly reason?: string;
    readonly ownerRole?: string;
    readonly nextBoundary?: string;
  }): Promise<MessageRecord> {
    const record = this.record(input.id);
    if (!["accepted", "handled", "superseded", "retained"].includes(input.disposition)) {
      throw new MessageError("invalid-disposition");
    }
    if (record.revision !== input.expectedRevision) {
      throw new MessageError("binding-conflict");
    }
    if (input.disposition === "accepted") {
      if (this.receipt(record)?.status !== "accepted") {
        throw new MessageError("acceptance-unproven");
      }
      return this.reconcileReceipt(input.id);
    }
    const retention =
      input.disposition === "retained"
        ? {
            nextBoundary: input.nextBoundary ?? "",
            ownerRole: input.ownerRole ?? record.envelope.toRole,
            reason: input.reason ?? "",
          }
        : null;
    if (retention !== null) {
      resolveRole(readRegistry(this.context.layout), retention.ownerRole);
    }
    return this.store.reconcile(messageExpectation(record), {
      kind: input.disposition,
      ref: input.evidence,
      retention,
      source: record.attempts.at(-1)?.source ?? null,
    });
  }

  private localClear(
    record: MessageRecord,
    source: MessageAttemptSource,
    directory: string,
  ): boolean {
    return (
      bindingCurrent(this.context.layout, record, source) &&
      messageGuardDirectory(this.context.layout, record.envelope.toRole) === directory &&
      decisionClear(directory, messageNativeRecipient(source))
    );
  }

  private async connect(): Promise<RpcClient> {
    if (this.context.connect !== undefined) {
      return this.context.connect();
    }
    const endpoint = resolveCodexControlSocket({ env: this.context.env });
    return connectControl(performance.now() + 15_000, endpoint.path);
  }

  private transport(
    record: MessageRecord,
    source: MessageAttemptSource,
    directory: string,
  ): MessageTransport {
    if (this.context.transport !== undefined) {
      return this.context.transport(record, source, directory);
    }
    if (source.owner.harness === "claude") {
      return claudeMessageTransport({
        messageChannelStateDir: messageChannelStateDir(
          this.context.layout,
          messageNativeRecipient(source),
        ),
      });
    }
    if (record.envelope.intent === "queue" || source.hop === "parent") {
      return codexQueueTransport({
        canConnect: () => this.localClear(record, source, directory),
        connect: () => this.connect(),
        guards: {
          beforeAdd: async (client) => {
            if (!this.localClear(record, source, directory)) {
              return { status: "blocked" };
            }
            const recipient = messageNativeRecipient(source);
            const marker = decisionRecord(directory, recipient);
            const [target, , diagnostic] = await selectTarget(client, directory, recipient);
            return {
              ...(diagnostic === undefined ? {} : { diagnostic }),
              status:
                target !== null &&
                clearanceUnchanged(directory, recipient, marker) &&
                this.localClear(record, source, directory)
                  ? "clear"
                  : "blocked",
            };
          },
        },
      });
    }
    return {
      send: async (_path, message) => {
        if (!this.localClear(record, source, directory)) {
          return {
            diagnostic: {
              category: "decision-clearance",
              classification: "guarded",
              stage: "local",
            },
            requestId: message.requestId,
            status: "blocked",
          };
        }
        let client: RpcClient;
        try {
          client = await this.connect();
        } catch (error) {
          return {
            diagnostic:
              error instanceof RpcError
                ? { ...error.diagnostic, stage: "connection" }
                : {
                    category: "transport-unavailable",
                    classification: "unavailable",
                    stage: "connection",
                  },
            requestId: message.requestId,
            status: "unavailable",
          };
        }
        try {
          // Existing guarded delivery performs native question checks and never resumes a turn.
          const boundClient: RpcClient = {
            call: async (method, params) => {
              if (
                (method === "turn/start" || method === "turn/steer") &&
                !this.localClear(record, source, directory)
              ) {
                throw new MessageError("guarded");
              }
              return client.call(method, params);
            },
            close: () => client.close(),
          };
          const receipt = await deliverReceipt(
            boundClient,
            directory,
            this.receiptPath(source),
            { messageId: record.envelope.id, text: message.text },
            message.requestId,
            message.recipient,
            message.text,
          );
          return adapterTransportReceipt(message.requestId, receipt);
        } finally {
          client.close();
        }
      },
    };
  }

  /** Dispatch is explicit. Unknown prior admission never reaches a new attempt or request ID. */
  async dispatch(id: string): Promise<MessageRecord> {
    let record = this.record(id);
    if (record.state === "sending" || record.state === "ambiguous") {
      return this.reconcileReceipt(id);
    }
    const last = record.attempts.at(-1);
    if (
      !["queued", "blocked", "parent-required"].includes(record.state) ||
      (last !== undefined && !["blocked", "parent-required"].includes(last.state))
    ) {
      return record;
    }
    const owner = currentMessageOwner(this.context.layout, record.envelope);
    if (owner === null) {
      return this.store.block(messageExpectation(record), "owner-unavailable", {
        category: "owner-unavailable",
        classification: "unavailable",
        stage: "local",
      });
    }
    const hop = record.envelope.workerId === undefined ? "recipient" : "parent";
    const recipient = hop === "parent" ? owner.parentBinding?.nativeId : owner.nativeId;
    const directory = messageGuardDirectory(this.context.layout, record.envelope.toRole);
    if (recipient === undefined || directory === null || !decisionClear(directory, recipient)) {
      return this.store.block(messageExpectation(record), "guarded", {
        category: "decision-clearance",
        classification: "guarded",
        stage: "local",
      });
    }
    if (owner.harness === "claude" && recipientReady(this.context.env, recipient).status === null) {
      return this.store.block(messageExpectation(record), "transport-unavailable", {
        category: "transport-unavailable",
        classification: "unavailable",
        stage: "local",
      });
    }
    const lease = await this.store.beginAttempt(messageExpectation(record), hop);
    try {
      record = this.record(id);
      const source = lease.source;
      if (!this.localClear(record, source, directory)) {
        return lease.complete({
          diagnostic: { category: "decision-clearance", classification: "guarded", stage: "local" },
          reason: "guarded",
          source,
          state: "blocked",
        });
      }
      const message: NativeMessage = {
        recipient: messageNativeRecipient(source),
        requestId: source.requestId,
        text: messageTransportText(record, source),
      };
      try {
        mkdirSync(dirname(this.receiptPath(source)), { mode: 0o700, recursive: true });
      } catch {
        return lease.complete({
          diagnostic: {
            category: "transport-unavailable",
            classification: "unavailable",
            stage: "receipt",
          },
          reason: "transport-unavailable",
          source,
          state: "blocked",
        });
      }
      let result: TransportReceipt;
      try {
        result = await this.transport(record, source, directory).send(
          this.receiptPath(source),
          message,
        );
      } catch {
        return lease.complete({
          diagnostic: { category: "unknown", classification: "outcome-unknown", stage: "receipt" },
          reason: "lost-response",
          source,
          state: "ambiguous",
        });
      }
      const saved = this.receipt(record);
      const diagnostic = safeDeliveryDiagnostic(saved?.diagnostic ?? result.diagnostic);
      const diagnosticFields = diagnostic === undefined ? {} : { diagnostic };
      // A durable unknown receipt dominates a later failed/blocked guard or connector result.
      if (
        result.requestId !== source.requestId ||
        saved?.status === "sending" ||
        saved?.status === "ambiguous"
      ) {
        return lease.complete({
          diagnostic:
            diagnostic === undefined
              ? { category: "unknown", classification: "outcome-unknown", stage: "receipt" }
              : { ...diagnostic, classification: "outcome-unknown" },
          reason: "lost-response",
          source,
          state: "ambiguous",
        });
      }
      if (result.status === "accepted" || saved?.status === "accepted") {
        // An accepted transport result keeps its diagnostic, such as a deduplicated delivery.
        const accepted =
          result.status === "accepted" ? safeDeliveryDiagnostic(result.diagnostic) : undefined;
        return lease.complete({
          ...(accepted === undefined ? {} : { diagnostic: accepted }),
          reason: null,
          source,
          state: "accepted",
        });
      }
      if (result.status === "ambiguous" || result.status === "queued") {
        return lease.complete({
          ...diagnosticFields,
          reason: result.status === "queued" ? "transport-pending" : "lost-response",
          source,
          state: "ambiguous",
        });
      }
      if (result.status === "busy") {
        // A busy transport wrote nothing; the blocked attempt permits a guarded re-dispatch.
        return lease.complete({
          diagnostic: diagnostic ?? {
            category: "busy",
            classification: "unavailable",
            stage: "receipt",
          },
          reason: "transport-busy",
          source,
          state: "blocked",
        });
      }
      return lease.complete({
        ...diagnosticFields,
        reason: result.status === "unavailable" ? "transport-unavailable" : "refused",
        source,
        state: "blocked",
      });
    } finally {
      lease.close();
    }
  }
}
