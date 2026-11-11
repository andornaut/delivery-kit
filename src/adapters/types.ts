// Harness adapter contract shared by the Claude and Codex implementations.
export type DeliveryStatus =
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
