// Read-only lineage proof for explicit worker inbox reconciliation.
import { isCanonicalUuid } from "../shared/ids.ts";
import { isRecord } from "../shared/pyjson.ts";
import type { HarnessAdapter } from "../types.ts";
import { acknowledgeEntry, ackStatus, queueEntries, queuePayload } from "./inventory.ts";
import type { RpcClient } from "./rpc.ts";

export interface WorkerBinding {
  readonly harness: "codex";
  readonly parent: string;
  readonly worker: string;
}

/** Fresh native identity and lineage, without loading or resuming the worker. */
export async function verifyWorker(client: RpcClient, binding: WorkerBinding): Promise<void> {
  const { parent, worker } = binding;
  if (!isCanonicalUuid(parent) || !isCanonicalUuid(worker) || parent === worker) {
    throw new Error("worker inbox identity invalid");
  }
  const read = await client.call("thread/read", { includeTurns: false, threadId: worker });
  const thread = isRecord(read) ? read.thread : null;
  if (!isRecord(thread) || thread.id !== worker || thread.parentThreadId !== parent) {
    throw new Error("worker inbox lineage unavailable or parent mismatch");
  }
  const source = thread.source;
  const subagent = isRecord(source) ? source.subAgent : null;
  const spawn = isRecord(subagent) ? subagent.thread_spawn : null;
  if (!isRecord(spawn) || spawn.parent_thread_id !== parent) {
    throw new Error("worker inbox source unavailable or inconsistent");
  }
}

/** An inbox-only adapter on one connection. No delivery or lifecycle operation is exposed. */
export function workerInboxAdapter(client: RpcClient, binding: WorkerBinding): HarnessAdapter {
  const recipientMatches = (recipient: string): void => {
    if (recipient !== binding.worker) {
      throw new Error("worker inbox recipient mismatch");
    }
  };
  return {
    async ack(recipient, queueId, payload, disposition) {
      recipientMatches(recipient);
      const outcome = await acknowledgeEntry(
        client,
        () => verifyWorker(client, binding),
        recipient,
        queueId,
        payload,
        disposition,
      );
      return {
        reason: outcome,
        requestId: queueId,
        status: ackStatus(outcome),
      };
    },
    async deliver() {
      throw new Error("worker inbox delivery unsupported");
    },
    harness: "codex",
    async inventory(recipient) {
      recipientMatches(recipient);
      await verifyWorker(client, binding);
      const entries = await queueEntries(client, recipient);
      return {
        entries: entries.map((entry) => ({
          clientUserMessageId: entry.clientUserMessageId,
          payload: queuePayload(entry),
          queueId: entry.id,
        })),
        status: "available",
      };
    },
    async status() {
      return { reason: "worker inbox status unsupported", status: "unavailable" };
    },
  };
}
