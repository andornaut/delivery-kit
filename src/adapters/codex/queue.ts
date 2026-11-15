import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { readJsonIfExists, writeJsonDurable } from "../../durable.ts";
import { holdLockAsync } from "../../lock.ts";
import type { NativeMessage, TransportReceipt } from "../../messages/transports.ts";
import { isCanonicalUuid } from "../shared/ids.ts";
import { isRecord } from "../shared/pyjson.ts";
import { type DeliveryDiagnostic, safeDeliveryDiagnostic } from "../types.ts";
import { acknowledgeEntry, queueEntries, type QueueEntry } from "./inventory.ts";
import { type RpcClient, RpcError } from "./rpc.ts";

/** Queue add may wake a loaded idle thread. Unknown clearance never permits native mutation. */
export type QueueClearance = {
  readonly diagnostic?: DeliveryDiagnostic;
  readonly status: "clear" | "blocked" | "unavailable";
};
export interface QueueGuards {
  /** Must check owner HOLD, local decisions, and nativeQuestionsClear on this same connection. */
  readonly beforeAdd: (client: RpcClient, message: NativeMessage) => Promise<QueueClearance>;
}

function bound(value: unknown, message: NativeMessage): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.recipient === message.recipient &&
    value.clientUserMessageId === message.requestId &&
    value.text === message.text
  );
}

function valid(message: NativeMessage): boolean {
  return (
    isCanonicalUuid(message.recipient) &&
    /^[A-Za-z0-9_-]+$/.test(message.requestId) &&
    typeof message.text === "string"
  );
}

function exact(value: unknown, message: NativeMessage): value is QueueEntry {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id === "" ||
    value.clientUserMessageId !== message.requestId ||
    !Array.isArray(value.input) ||
    value.input.length !== 1
  ) {
    return false;
  }
  const item: unknown = value.input[0];
  // Installed 0.169 UserInput schema defaults omitted text_elements to []. No other normalization.
  return (
    isRecord(item) &&
    item.type === "text" &&
    item.text === message.text &&
    Object.keys(item).every((key) => ["type", "text", "text_elements"].includes(key)) &&
    (item.text_elements === undefined ||
      (Array.isArray(item.text_elements) && item.text_elements.length === 0))
  );
}

async function rootRecipient(client: RpcClient, recipient: string): Promise<boolean> {
  const read = await client.call("thread/read", { includeTurns: false, threadId: recipient });
  const thread = isRecord(read) ? read.thread : null;
  if (!isRecord(thread) || thread.id !== recipient || thread.parentThreadId != null) {
    return false;
  }
  const source = thread.source;
  return typeof source === "string" && ["cli", "vscode", "exec", "appServer"].includes(source);
}

function result(
  message: NativeMessage,
  status: TransportReceipt["status"],
  reason?: string,
  queueId?: string,
  diagnostic?: unknown,
): TransportReceipt {
  const safe = safeDeliveryDiagnostic(diagnostic);
  return {
    ...(safe === undefined ? {} : { diagnostic: safe }),
    requestId: message.requestId,
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(queueId === undefined ? {} : { queueId }),
  };
}

function rejected(error: unknown): TransportReceipt["status"] {
  return error instanceof RpcError
    ? error.code === -32601
      ? "unsupported"
      : "rejected"
    : "ambiguous";
}

async function reconcile(
  client: RpcClient,
  path: string,
  message: NativeMessage,
  state: Record<string, unknown>,
): Promise<TransportReceipt> {
  let entries: QueueEntry[];
  try {
    entries = await queueEntries(client, message.recipient);
  } catch {
    return result(message, "ambiguous", "queue reconciliation unavailable; do not resend");
  }
  const matches = entries.filter((entry) => entry.clientUserMessageId === message.requestId);
  const entry = matches[0];
  if (matches.length === 1 && exact(entry, message)) {
    writeJsonDurable(path, { ...state, queueId: entry.id, status: "accepted" });
    return result(message, "accepted", undefined, entry.id);
  }
  writeJsonDurable(path, { ...state, status: "ambiguous" });
  return result(
    message,
    "ambiguous",
    matches.length
      ? "queue binding or payload mismatch; do not resend"
      : "queue absence does not prove non-acceptance; do not resend",
  );
}

async function operate(
  admission: { started: boolean },
  client: RpcClient | null,
  path: string,
  message: NativeMessage,
  reconciliationOnly: boolean,
  guards?: QueueGuards,
): Promise<TransportReceipt> {
  if (!valid(message)) {
    return result(message, "blocked", "invalid message binding");
  }
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const lock = await holdLockAsync(`${path}.lock`);
  try {
    const previous = readJsonIfExists(path);
    if (previous !== undefined && !bound(previous, message)) {
      return result(message, "blocked", "receipt binding or payload mismatch");
    }
    if (
      isRecord(previous) &&
      previous.status === "accepted" &&
      typeof previous.queueId === "string"
    ) {
      return result(message, "accepted", undefined, previous.queueId);
    }
    const uncertain =
      isRecord(previous) && (previous.status === "sending" || previous.status === "ambiguous");
    admission.started = uncertain;
    if (uncertain && previous.status === "sending") {
      previous.status = "ambiguous";
      writeJsonDurable(path, previous);
    }
    const guarded = (
      status: "blocked" | "unavailable",
      reason: string,
      diagnostic?: DeliveryDiagnostic,
    ): TransportReceipt =>
      result(
        message,
        uncertain ? "ambiguous" : status,
        uncertain ? "previous send outcome unknown; reconciliation guarded; do not resend" : reason,
        undefined,
        uncertain
          ? {
              ...(safeDeliveryDiagnostic(previous.diagnostic) ?? {
                category: "unknown",
                stage: "receipt",
              }),
              classification: "outcome-unknown",
            }
          : (diagnostic ?? {
              category: "decision-clearance",
              classification: "guarded",
              stage: "local",
            }),
      );
    if (isRecord(previous) && !uncertain) {
      return result(
        message,
        previous.status === "unsupported" ? "unsupported" : "rejected",
        "previous native refusal; do not resend",
        undefined,
        previous.diagnostic,
      );
    }
    if (guards === undefined || client === null) {
      return guarded("blocked", "explicit queue clearance required; keep queued locally");
    }
    try {
      const clearance = await guards.beforeAdd(client, message);
      if (clearance.status !== "clear") {
        return guarded(
          clearance.status,
          "queue clearance unavailable; keep queued locally",
          clearance.diagnostic,
        );
      }
    } catch (error) {
      return guarded(
        "blocked",
        "queue clearance unavailable; keep queued locally",
        error instanceof RpcError
          ? { ...error.diagnostic, stage: "question-guard" }
          : { category: "unknown", classification: "guarded", stage: "question-guard" },
      );
    }
    try {
      if (!(await rootRecipient(client, message.recipient))) {
        return guarded("blocked", "worker parent required or recipient binding unavailable", {
          category: "binding-mismatch",
          classification: "guarded",
          method: "thread/read",
          stage: "question-guard",
        });
      }
    } catch (error) {
      return guarded(
        "unavailable",
        "recipient binding unavailable",
        error instanceof RpcError
          ? { ...error.diagnostic, stage: "question-guard" }
          : {
              category: "history-unavailable",
              classification: "unavailable",
              method: "thread/read",
              stage: "question-guard",
            },
      );
    }
    if (isRecord(previous)) {
      return await reconcile(client, path, message, previous);
    }
    if (reconciliationOnly) {
      return result(message, "ambiguous", "receipt unavailable; do not resend");
    }
    try {
      const clearance = await guards.beforeAdd(client, message);
      if (clearance.status !== "clear") {
        return guarded(
          clearance.status,
          "queue clearance unavailable; keep queued locally",
          clearance.diagnostic,
        );
      }
    } catch (error) {
      return guarded(
        "blocked",
        "queue clearance unavailable; keep queued locally",
        error instanceof RpcError
          ? { ...error.diagnostic, stage: "question-guard" }
          : { category: "unknown", classification: "guarded", stage: "question-guard" },
      );
    }
    const state = {
      clientUserMessageId: message.requestId,
      recipient: message.recipient,
      status: "sending",
      text: message.text,
    };
    writeJsonDurable(path, state);
    admission.started = true;
    let response: unknown;
    try {
      response = await client.call("thread/queue/add", {
        clientUserMessageId: message.requestId,
        input: [{ text: message.text, text_elements: [], type: "text" }],
        threadId: message.recipient,
      });
    } catch (error) {
      const status = rejected(error);
      const diagnostic: DeliveryDiagnostic =
        error instanceof RpcError
          ? { ...error.diagnostic, method: "thread/queue/add", stage: "native-send" }
          : {
              category: "transport-unavailable",
              classification: "outcome-unknown",
              method: "thread/queue/add",
              stage: "native-send",
            };
      writeJsonDurable(path, { ...state, diagnostic, status });
      return result(
        message,
        status,
        status === "ambiguous"
          ? "response unavailable; do not resend"
          : "native queue request refused",
        undefined,
        diagnostic,
      );
    }
    const entry = isRecord(response) ? response.queuedSubmission : undefined;
    if (!exact(entry, message)) {
      writeJsonDurable(path, { ...state, status: "ambiguous" });
      return result(
        message,
        "ambiguous",
        "queue response binding or payload mismatch; do not resend",
      );
    }
    writeJsonDurable(path, { ...state, queueId: entry.id, status: "accepted" });
    return result(message, "accepted", undefined, entry.id);
  } finally {
    lock.release();
  }
}

export function queueMessage(
  client: RpcClient | null,
  path: string,
  message: NativeMessage,
  guards?: QueueGuards,
): Promise<TransportReceipt> {
  const admission = { started: true };
  return operate(admission, client, path, message, false, guards).catch(() =>
    result(
      message,
      admission.started ? "ambiguous" : "unavailable",
      admission.started
        ? "receipt or transport unavailable; do not resend"
        : "receipt preparation unavailable",
    ),
  );
}

export function reconcileQueueMessage(
  client: RpcClient,
  path: string,
  message: NativeMessage,
  guards?: QueueGuards,
): Promise<TransportReceipt> {
  return operate({ started: true }, client, path, message, true, guards).catch(() =>
    result(message, "ambiguous", "receipt or transport unavailable; do not resend"),
  );
}

/** Preserve the existing inventory helper's exact payload representation for acknowledgement. */
export { acknowledgeEntry, queueEntries };
