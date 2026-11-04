// Snapshot-bound acknowledgements.
// Each invocation re-reads the current inventory: a changed payload is `changed_payload`, an
// absent entry `confirmed_absent`, `retained` binds an active retention to the exact payload,
// and `handled` or `superseded` removes the entry through the adapter (`deleted`). A durable
// operation records every attempt; an interrupted removal becomes `ambiguous` first.
/* eslint-disable require-atomic-updates -- every operation runs under monitor.lock, one item at a time */
import type { Disposition, HarnessAdapter, InventoryEntry } from "../adapters/types.ts";
import {
  ackPath,
  type Json,
  locked,
  payloadSignature,
  persist,
  type QueueEntry,
  queueEntry,
  readRecord,
  retentionPath,
  snapshotPath,
} from "./store.ts";

export class AckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AckError";
  }
}

export interface AckResult {
  readonly queue_id: string;
  readonly state: string;
}

const NATIVE_OUTCOMES: ReadonlySet<string> = new Set([
  "ambiguous",
  "changed_payload",
  "confirmed_absent",
  "deleted",
  "not_deleted",
]);

export const DISPOSITIONS: readonly Disposition[] = ["handled", "retained", "superseded"];

/** Exit nonzero unless every item ended deleted, confirmed absent or retained. */
export function ackSucceeded(results: readonly AckResult[]): boolean {
  return results.every((row) => ["confirmed_absent", "deleted", "retained"].includes(row.state));
}

interface AckRequest {
  readonly recipient: string;
  readonly snapshotId: string;
  readonly queueIds: readonly string[];
  readonly disposition: Disposition;
  readonly reason?: string | undefined;
}

function history(operation: Json): Json[] {
  if (!Array.isArray(operation.history)) {
    operation.history = [];
  }
  return operation.history as Json[];
}

function attempts(operation: Json): Json[] {
  if (!Array.isArray(operation.attempts)) {
    operation.attempts = [];
  }
  return operation.attempts as Json[];
}

/**
 * A Codex entry keeps its native client message ID as its signature input, so the digest matches
 * the acknowledgement and retention records already in game state.
 */
export function nativeEntry(entry: InventoryEntry): QueueEntry {
  return {
    ...queueEntry(entry.queueId, entry.payload),
    clientUserMessageId: entry.clientUserMessageId ?? entry.queueId,
  };
}

async function current(
  adapter: HarnessAdapter,
  recipient: string,
): Promise<Map<string, QueueEntry>> {
  const inventory = await adapter.inventory(recipient);
  if (inventory.status !== "available") {
    throw new AckError(inventory.reason ?? "inventory unavailable");
  }
  return new Map(inventory.entries.map((entry) => [entry.queueId, nativeEntry(entry)]));
}

function deactivate(path: string, state: string, snapshotId: string): void {
  const retention = readRecord(path);
  if (retention !== undefined) {
    retention.active = false;
    const rows = Array.isArray(retention.history) ? (retention.history as Json[]) : [];
    rows.push({ snapshot_id: snapshotId, state });
    retention.history = rows;
    persist(path, retention);
  }
}

async function acknowledgeOne(
  adapter: HarnessAdapter,
  unblock: string,
  request: AckRequest,
  original: QueueEntry,
): Promise<AckResult> {
  const { disposition, reason, recipient, snapshotId } = request;
  const identity = original.id;
  const path = ackPath(unblock, recipient, snapshotId, identity);
  const operation: Json = readRecord(path) ?? {
    attempt: 0,
    attempts: [],
    disposition,
    harness: adapter.harness,
    history: [],
    queue_id: identity,
    recipient,
    snapshot_id: snapshotId,
  };
  if (operation.disposition !== disposition) {
    throw new AckError("acknowledgement disposition differs from durable operation");
  }
  const attempt = (): number => (typeof operation.attempt === "number" ? operation.attempt : 0);
  if (operation.state === "deleting") {
    operation.state = "ambiguous";
    const last = attempts(operation).at(-1);
    if (last !== undefined) {
      last.state = "ambiguous";
    }
    history(operation).push({ attempt: attempt(), state: "ambiguous" });
    persist(path, operation);
  }
  const retentionFile = retentionPath(unblock, recipient, identity);
  if (disposition !== "retained") {
    deactivate(retentionFile, "invalidated", snapshotId);
  }
  if (operation.state === "deleted" || operation.state === "confirmed_absent") {
    return { queue_id: identity, state: operation.state };
  }
  const now = (await current(adapter, recipient)).get(identity);
  if (now === undefined) {
    operation.state = "confirmed_absent";
    if (disposition === "retained") {
      const retention = readRecord(retentionFile);
      if (
        retention?.active === true &&
        retention.recipient === recipient &&
        retention.queue_id === identity &&
        retention.payload_signature === payloadSignature(original)
      ) {
        deactivate(retentionFile, "confirmed_absent", snapshotId);
      }
    }
  } else if (payloadSignature(now) !== payloadSignature(original)) {
    operation.state = "changed_payload";
  } else if (disposition === "retained") {
    const retention = readRecord(retentionFile) ?? { history: [] };
    const rows = Array.isArray(retention.history) ? (retention.history as Json[]) : [];
    rows.push({ snapshot_id: snapshotId, state: "retained" });
    Object.assign(retention, {
      active: true,
      history: rows,
      payload_signature: payloadSignature(original),
      queue_id: identity,
      reason,
      recipient,
      snapshot_id: snapshotId,
    });
    persist(retentionFile, retention);
    Object.assign(operation, { reason, state: "retained" });
  } else {
    operation.attempt = attempt() + 1;
    operation.state = "deleting";
    operation.payload_signature = payloadSignature(original);
    attempts(operation).push({ attempt: operation.attempt, state: "deleting" });
    persist(path, operation);
    let state: string;
    try {
      const receipt = await adapter.ack(
        recipient,
        identity,
        original.input[0]?.text ?? "",
        disposition,
        reason,
      );
      // An adapter that knows the exact native outcome reports it as the reason.
      state = NATIVE_OUTCOMES.has(receipt.reason ?? "")
        ? (receipt.reason as string)
        : receipt.status === "accepted"
          ? "deleted"
          : receipt.status === "unchanged"
            ? "confirmed_absent"
            : receipt.status === "rejected"
              ? "changed_payload"
              : "ambiguous";
    } catch {
      state = "ambiguous";
    }
    operation.state = state;
    const last = attempts(operation).at(-1);
    if (last !== undefined) {
      last.state = state;
    }
  }
  history(operation).push({ attempt: attempt(), state: operation.state });
  persist(path, operation);
  return { queue_id: identity, state: operation.state as string };
}

export function acknowledge(
  adapter: HarnessAdapter,
  unblock: string,
  request: AckRequest,
): Promise<AckResult[]> {
  const { disposition, queueIds, reason, recipient, snapshotId } = request;
  if (!DISPOSITIONS.includes(disposition) || queueIds.length === 0) {
    return Promise.reject(new AckError("explicit disposition and queue IDs required"));
  }
  if (disposition === "retained" && (reason === undefined || reason.trim() === "")) {
    return Promise.reject(new AckError("retention requires a nonempty reason"));
  }
  return locked(unblock, async () => {
    const snapshot = readRecord(snapshotPath(unblock, snapshotId));
    const queues = snapshot?.queues as Json | undefined;
    if (
      snapshot?.snapshot_id !== snapshotId ||
      snapshot.harness !== adapter.harness ||
      queues === undefined ||
      !Object.hasOwn(queues, recipient)
    ) {
      throw new AckError("snapshot recipient mismatch");
    }
    const originals = new Map(
      (queues[recipient] as QueueEntry[]).map((entry) => [entry.id, entry] as const),
    );
    const unique = [...new Set(queueIds)];
    if (unique.some((identity) => !originals.has(identity))) {
      throw new AckError("queue ID not present in recipient snapshot");
    }
    const results: AckResult[] = [];
    for (const identity of unique) {
      const original = originals.get(identity) as QueueEntry;
      // Items are acknowledged in order so each durable operation precedes the next.
      // eslint-disable-next-line no-await-in-loop
      const result = await acknowledgeOne(adapter, unblock, request, original);
      results.push(result);
    }
    return results;
  });
}
