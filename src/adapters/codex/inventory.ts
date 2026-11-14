// Native queue inventory (thread/queue/list), history references (thread/items/list) and the
// native half of an explicit acknowledgement (thread/queue/delete).
// Durable acknowledgement and retention records stay with the inbox that owns the snapshot.
import { dumpsJson, isRecord, type PyJson, sameJson } from "../shared/pyjson.ts";
import type { DeliveryReceipt } from "../types.ts";
import { NATIVE_ITEM_TYPES, questionItem } from "./guard.ts";
import { NativeTimeout, type RpcClient, RpcError } from "./rpc.ts";

export interface QueueEntry {
  readonly id: string;
  readonly clientUserMessageId: string;
  readonly input: readonly PyJson[];
  readonly [key: string]: unknown;
}

function queuePage(page: unknown, entries: Map<string, QueueEntry>): unknown {
  if (!isRecord(page) || !Array.isArray(page.data) || page.truncated || page.hasMore) {
    throw new Error("queue inventory incomplete");
  }
  for (const entry of page.data as unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id === "" ||
      typeof entry.clientUserMessageId !== "string" ||
      !Array.isArray(entry.input)
    ) {
      throw new Error("unknown queued submission shape");
    }
    const known = entries.get(entry.id);
    const same = known === undefined || sameJson(known, entry);
    if (!same) {
      throw new Error("queue changed during pagination");
    }
    entries.set(entry.id, entry as unknown as QueueEntry);
  }
  return page.nextCursor ?? null;
}

/** Every queued submission for `recipient`, failing on any incomplete or inconsistent page. */
export async function queueEntries(client: RpcClient, recipient: string): Promise<QueueEntry[]> {
  const entries = new Map<string, QueueEntry>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const params: Record<string, unknown> = { limit: 100, threadId: recipient };
    if (cursor !== null) {
      params.cursor = cursor;
    }
    // Pages follow their cursor in order.
    // eslint-disable-next-line no-await-in-loop
    const next = queuePage(await client.call("thread/queue/list", params), entries);
    if (next === null) {
      return [...entries.values()];
    }
    if (typeof next !== "string" || next === "" || cursors.has(next)) {
      throw new Error("queue pagination did not advance");
    }
    cursors.add(next);
    cursor = next;
  }
}

/**
 * The inventory payload: the text of a single plain text input, which with the client message ID
 * rebuilds the exact payload signature input; any other input shape as its Python JSON form.
 */
export function queuePayload(entry: QueueEntry): string {
  const [first, ...rest] = entry.input;
  if (
    rest.length === 0 &&
    isRecord(first) &&
    first.type === "text" &&
    typeof first.text === "string" &&
    Object.keys(first).length === 2
  ) {
    return first.text;
  }
  return dumpsJson(entry.input);
}

export interface HistoryReference {
  readonly turn_id: string;
  readonly item_id: string;
  readonly kind?: "question_tool" | "rendered_prompt";
}

export interface HistoryRefs {
  status: "complete" | "partial" | "unavailable";
  complete: boolean;
  cursor: string | null;
  nextCursor: string | null;
  question_refs: HistoryReference[];
  user_reply_refs: HistoryReference[];
  reason_code: string;
  category: string;
}

type Diagnostic = readonly [reasonCode: string, category: string];

function failureDiagnostic(error: unknown): Diagnostic {
  if (error instanceof SyntaxError) {
    return ["json_parse_failure", "json"];
  }
  if (error instanceof RpcError) {
    return ["native_rpc_failure", "native_rpc"];
  }
  if (error instanceof NativeTimeout || (isRecord(error) && typeof error.code === "string")) {
    return ["transport_failure", "transport"];
  }
  return ["metadata_failure", "metadata"];
}

function readHistory(page: unknown, result: HistoryRefs): Diagnostic {
  if (!isRecord(page) || !Array.isArray(page.data)) {
    return ["malformed_page", "page"];
  }
  const raw: unknown = page.nextCursor ?? null;
  const next = typeof raw === "string" ? raw : null;
  if (raw !== null && (next === null || next === "" || next === result.cursor)) {
    return ["invalid_cursor", "pagination"];
  }
  result.nextCursor = next;
  let compacted = false;
  for (const entry of page.data as unknown[]) {
    if (!isRecord(entry) || typeof entry.turnId !== "string" || entry.turnId === "") {
      return ["malformed_row", "row"];
    }
    const item = entry.item;
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id === "" ||
      typeof item.type !== "string"
    ) {
      return ["malformed_item", "item"];
    }
    if (item.type === "contextCompaction") {
      compacted = true;
      continue;
    }
    if (!NATIVE_ITEM_TYPES.has(item.type)) {
      return ["unsupported_item_type", "unknown_item"];
    }
    if (questionItem(item)) {
      const kind = item.type === "agentMessage" ? "rendered_prompt" : "question_tool";
      result.question_refs.push({ item_id: item.id, kind, turn_id: entry.turnId });
    } else if (item.type === "userMessage") {
      result.user_reply_refs.push({ item_id: item.id, turn_id: entry.turnId });
    }
  }
  const incomplete = page.truncated === true || page.hasMore === true;
  result.complete = !(compacted || next !== null || incomplete);
  result.status = result.complete ? "complete" : "partial";
  if (compacted) {
    return ["context_compaction", "context_compaction"];
  }
  if (incomplete) {
    return ["incomplete_page", "pagination"];
  }
  return next === null ? ["complete", "history"] : ["more_history", "pagination"];
}

/** One page of safe question and reply references, with a reason code instead of any body. */
export async function historyRefs(
  client: RpcClient,
  recipient: string,
  cursor: string | null = null,
): Promise<HistoryRefs> {
  const params: Record<string, unknown> = {
    limit: 100,
    sortDirection: "desc",
    threadId: recipient,
  };
  if (cursor !== null) {
    params.cursor = cursor;
  }
  const result: HistoryRefs = {
    category: "metadata",
    complete: false,
    cursor,
    nextCursor: null,
    question_refs: [],
    reason_code: "metadata_unavailable",
    status: "unavailable",
    user_reply_refs: [],
  };
  let diagnostic: Diagnostic;
  try {
    diagnostic = readHistory(await client.call("thread/items/list", params), result);
  } catch (error) {
    diagnostic = failureDiagnostic(error);
  }
  [result.reason_code, result.category] = diagnostic;
  return result;
}

export type AckOutcome =
  | "ambiguous"
  | "changed_payload"
  | "confirmed_absent"
  | "deleted"
  | "not_deleted"
  | "retained"
  | "unavailable";

/** The exact native outcome stays in the receipt reason for durable ACK reconciliation. */
export function ackStatus(outcome: AckOutcome): DeliveryReceipt["status"] {
  switch (outcome) {
    case "deleted":
      return "accepted";
    case "confirmed_absent":
    case "retained":
      return "unchanged";
    case "changed_payload":
      return "rejected";
    case "unavailable":
      return "blocked";
    default:
      return "ambiguous";
  }
}

async function absentAfter(
  client: RpcClient,
  recipient: string,
  queueId: string,
): Promise<boolean> {
  const after = await queueEntries(client, recipient);
  return !after.some((entry) => entry.id === queueId);
}

/**
 * The native part of acknowledging one queued submission. Every call re-lists first. A changed
 * payload is never deleted; `retained` leaves the native queue untouched.
 */
export async function acknowledgeEntry(
  client: RpcClient,
  beforeDelete: (() => Promise<void>) | undefined,
  recipient: string,
  queueId: string,
  payload: string,
  disposition: "handled" | "retained" | "superseded",
): Promise<AckOutcome> {
  let current: QueueEntry | undefined;
  try {
    current = (await queueEntries(client, recipient)).find((entry) => entry.id === queueId);
  } catch {
    return "unavailable";
  }
  if (current === undefined) {
    return "confirmed_absent";
  }
  if (queuePayload(current) !== payload) {
    return "changed_payload";
  }
  if (disposition === "retained") {
    return "retained";
  }
  // A refused guard precedes deletion and is never reconciled as an attempted deletion.
  if (beforeDelete !== undefined) {
    try {
      await beforeDelete();
    } catch {
      return "unavailable";
    }
  }
  try {
    const response = await client.call("thread/queue/delete", {
      queuedSubmissionId: queueId,
      threadId: recipient,
    });
    if (!isRecord(response) || typeof response.deleted !== "boolean") {
      throw new Error("unknown deletion response");
    }
    if (response.deleted) {
      return "deleted";
    }
    return (await absentAfter(client, recipient, queueId)) ? "confirmed_absent" : "not_deleted";
  } catch {
    try {
      return (await absentAfter(client, recipient, queueId)) ? "confirmed_absent" : "ambiguous";
    } catch {
      return "ambiguous";
    }
  }
}
