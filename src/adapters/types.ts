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
}

export interface Inventory {
  readonly status: "available" | "unavailable";
  readonly entries: readonly InventoryEntry[];
  readonly reason?: string;
}

export type Disposition = "handled" | "retained" | "superseded";

export interface HarnessAdapter {
  readonly harness: "claude" | "codex";
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
