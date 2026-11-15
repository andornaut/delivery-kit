// Safe delivery diagnostics are finite metadata, never native messages or context.
export const DIAGNOSTIC_METHODS = [
  "initialize",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "thread/queue/add",
  "turn/start",
  "turn/steer",
] as const;
const STAGES = ["local", "connection", "question-guard", "native-send", "receipt"] as const;
const CATEGORIES = [
  "owner-unavailable",
  "decision-clearance",
  "input-unavailable",
  "pending-question",
  "question-resolution",
  "history-unavailable",
  "compaction-unproven",
  "state-unavailable",
  "rpc-refusal",
  "direct-input-not-allowed",
  "stale-turn",
  "transport-unavailable",
  "binding-mismatch",
  "unknown",
] as const;
const CLASSIFICATIONS = ["guarded", "native-rejected", "outcome-unknown", "unavailable"] as const;
const RPC_CODES = [-32700, -32600, -32601, -32602, -32603, -32000] as const;
export type NativeRpcCode = (typeof RPC_CODES)[number];
export type DeliveryDiagnostic = {
  readonly stage: (typeof STAGES)[number];
  readonly category: (typeof CATEGORIES)[number];
  readonly classification: (typeof CLASSIFICATIONS)[number];
  readonly method?: (typeof DIAGNOSTIC_METHODS)[number];
  readonly rpcCode?: NativeRpcCode;
};
export function safeRpcCode(value: unknown): NativeRpcCode | undefined {
  return RPC_CODES.includes(value as NativeRpcCode) ? (value as NativeRpcCode) : undefined;
}
/** Project only explicitly allowed fields; unknown native codes and methods are omitted. */
export function safeDeliveryDiagnostic(value: unknown): DeliveryDiagnostic | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    !STAGES.includes(record.stage as DeliveryDiagnostic["stage"]) ||
    !CATEGORIES.includes(record.category as DeliveryDiagnostic["category"]) ||
    !CLASSIFICATIONS.includes(record.classification as DeliveryDiagnostic["classification"])
  ) {
    return undefined;
  }
  const method = DIAGNOSTIC_METHODS.includes(
    record.method as NonNullable<DeliveryDiagnostic["method"]>,
  )
    ? (record.method as NonNullable<DeliveryDiagnostic["method"]>)
    : undefined;
  const rpcCode = safeRpcCode(record.rpcCode);
  return {
    category: record.category as DeliveryDiagnostic["category"],
    classification: record.classification as DeliveryDiagnostic["classification"],
    stage: record.stage as DeliveryDiagnostic["stage"],
    ...(method === undefined ? {} : { method }),
    ...(rpcCode === undefined ? {} : { rpcCode }),
  };
}

// Harness adapter contract shared by the Claude and Codex implementations.
export type DeliveryStatus =
  | "unavailable"
  | "accepted"
  | "ambiguous"
  | "blocked"
  | "busy"
  | "deduplicated"
  | "deferred"
  | "rejected"
  | "sending"
  | "unchanged";

export interface DeliveryReceipt {
  readonly diagnostic?: DeliveryDiagnostic;
  readonly status: DeliveryStatus;
  readonly requestId: string;
  readonly reason?: string;
}

export interface Availability {
  readonly status: "available" | "busy" | "blocked" | "missing" | "unavailable";
  readonly reason?: string;
}

export interface InventoryEntry {
  readonly queueId: string;
  readonly payload: string;
  readonly clientUserMessageId?: string;
}

export interface Inventory {
  readonly status: "available" | "unavailable";
  readonly entries: readonly InventoryEntry[];
  readonly reason?: string;
}

export type CollectorRecord = Readonly<Record<string, unknown>>;

/** What a snapshot asks the harness collectors for. */
export interface CollectRequest {
  /** The bus unblock directory holding recipient decisions. */
  readonly unblockDir: string;
  readonly recipients: readonly string[];
  readonly parents: readonly string[];
  readonly slot: number | null;
  readonly historyCursor: string | null;
  /**
   * The active review route's recipient and peers, or null when no active route declares
   * them. Question and process collection never reaches outside it.
   */
  readonly routeMembers?: readonly string[] | null;
}

/** Snapshot capabilities, keyed by the snapshot record field names. */
export interface Collected {
  readonly history: CollectorRecord;
  readonly question_state: CollectorRecord;
  readonly worker_health: CollectorRecord;
  readonly collection_budget: CollectorRecord;
}

/** Native history, question, worker and process collection over one harness connection. */
export interface HarnessCollectors {
  collect(request: CollectRequest): Promise<Collected>;
}

export type Disposition = "handled" | "retained" | "superseded";

export interface HarnessAdapter {
  readonly harness: "claude" | "codex";
  /** Absent when the harness has no native collectors: every capability is then unavailable. */
  readonly collectors?: HarnessCollectors;
  status(conversationId: string): Promise<Availability>;
  deliver(
    receiptPath: string,
    requestId: string,
    conversationId: string,
    text: string,
  ): Promise<DeliveryReceipt>;
  inventory(conversationId: string): Promise<Inventory>;
  ack(
    conversationId: string,
    queueId: string,
    payload: string,
    disposition: Disposition,
    reason?: string,
  ): Promise<DeliveryReceipt>;
}
