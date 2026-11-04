// The Codex harness adapter: guarded native input over the local Codex control socket.
import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import type { Layout } from "../../layout.ts";
import { NAMESPACE_URL, uuid5 } from "../shared/ids.ts";
import { isRecord, type PyJson } from "../shared/pyjson.ts";
import type {
  Availability,
  CollectRequest,
  DeliveryReceipt,
  Disposition,
  HarnessAdapter,
  HarnessCollectors,
  Inventory,
} from "../types.ts";
import { collectAll, unavailableCollected } from "./collect.ts";
import { acknowledgeEntry, type AckOutcome, queueEntries, queuePayload } from "./inventory.ts";
import { connectControl, type RpcClient } from "./rpc.ts";
import { deliverReceipt } from "./steer.ts";

export { BudgetClient, collectAll, unavailableCollected } from "./collect.ts";
export { nativeQuestionsClear, questionItem } from "./guard.ts";
export { acknowledgeEntry, historyRefs, queueEntries, queuePayload } from "./inventory.ts";
export { connectControl, RpcError } from "./rpc.ts";
export { deliverReceipt, selectTarget } from "./steer.ts";

export const SOCKET_MISSING =
  "set CODEX_CONTROL_SOCKET to an available absolute Codex control socket path";
const METADATA_UNAVAILABLE = "native metadata unavailable";
const INVENTORY_UNAVAILABLE =
  "queue inventory unavailable or incomplete; retry snapshot before reconciliation";

export interface CodexOptions {
  /** Overrides CODEX_CONTROL_SOCKET. */
  readonly controlSocket?: string;
  /** Bound on one adapter call's native exchange, in milliseconds. */
  readonly deadlineMs?: number;
  /** Bound on one snapshot collection, in milliseconds. */
  readonly collectDeadlineMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/** Extra receipt fields bound to the request, such as a bus event's `event_id`. */
export type ReceiptSeed = Readonly<Record<string, PyJson>>;

export interface CodexAdapter extends HarnessAdapter {
  readonly harness: "codex";
  readonly collectors: HarnessCollectors;
  deliver(
    receiptPath: string,
    requestId: string,
    conversationId: string,
    text: string,
    seed?: ReceiptSeed,
  ): Promise<DeliveryReceipt>;
}

function socketAvailable(path: string | undefined): path is string {
  if (path === undefined || !isAbsolute(path)) {
    return false;
  }
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

/**
 * The bus unblock directory that holds a receipt's recipient decisions. Scheduled receipts live
 * in `<bus>/unblock/`, event receipts in `<bus>/events/native/`; both under var/.
 */
export function unblockDirFor(layout: Layout, receiptPath: string): string | null {
  const path = resolve(receiptPath);
  const inside = relative(layout.varDir, path);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return null;
  }
  const parent = dirname(path);
  if (basename(parent) === "unblock") {
    return parent;
  }
  if (basename(parent) === "native" && basename(dirname(parent)) === "events") {
    return join(dirname(dirname(parent)), "unblock");
  }
  return null;
}

/**
 * The receipt status monitor-ack maps back to its operation state: accepted is deleted,
 * unchanged is confirmed absent (or retained), rejected is a changed payload, anything else
 * ambiguous. The exact native outcome is the receipt reason.
 */
function ackStatus(outcome: AckOutcome): DeliveryReceipt["status"] {
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

export function codexAdapter(layout: Layout, options: CodexOptions = {}): CodexAdapter {
  const env = options.env ?? process.env;
  const socket = options.controlSocket ?? env.CODEX_CONTROL_SOCKET;
  const deadlineMs = options.deadlineMs ?? 15_000;
  const collectDeadlineMs = options.collectDeadlineMs ?? 25_000;

  async function withClient<T>(
    use: (client: RpcClient, deadline: number) => Promise<T>,
    timeoutMs = deadlineMs,
  ): Promise<T> {
    if (!socketAvailable(socket)) {
      throw new Error(SOCKET_MISSING);
    }
    const deadline = performance.now() + timeoutMs;
    const client = await connectControl(deadline, socket);
    try {
      return await use(client, deadline);
    } finally {
      client.close();
    }
  }

  return {
    async ack(
      conversationId: string,
      queueId: string,
      payload: string,
      disposition: Disposition,
      reason?: string,
    ): Promise<DeliveryReceipt> {
      const requestId = uuid5(NAMESPACE_URL, `queue-ack:${conversationId}:${queueId}`);
      if (disposition === "retained" && (reason === undefined || reason.trim() === "")) {
        return { reason: "retention requires a nonempty reason", requestId, status: "rejected" };
      }
      if (!socketAvailable(socket)) {
        return { reason: SOCKET_MISSING, requestId, status: "deferred" };
      }
      try {
        const outcome = await withClient((client) =>
          acknowledgeEntry(client, conversationId, queueId, payload, disposition),
        );
        return { reason: outcome, requestId, status: ackStatus(outcome) };
      } catch {
        return { reason: "unavailable", requestId, status: "blocked" };
      }
    },

    collectors: {
      async collect(request: CollectRequest) {
        if (!socketAvailable(socket)) {
          return unavailableCollected("collector_unavailable", request);
        }
        try {
          return await withClient(
            (client, deadline) => collectAll(client, deadline, request),
            collectDeadlineMs,
          );
        } catch {
          return unavailableCollected("collector_unavailable", request);
        }
      },
    },

    async deliver(
      receiptPath: string,
      requestId: string,
      conversationId: string,
      text: string,
      seed: ReceiptSeed = {},
    ): Promise<DeliveryReceipt> {
      if (!socketAvailable(socket)) {
        return { reason: SOCKET_MISSING, requestId, status: "deferred" };
      }
      const unblockDir = unblockDirFor(layout, receiptPath);
      if (unblockDir === null) {
        return { reason: "receipt path outside a bus layout", requestId, status: "blocked" };
      }
      try {
        return await withClient((client) =>
          deliverReceipt(client, unblockDir, receiptPath, seed, requestId, conversationId, text),
        );
      } catch {
        // Transport bodies and native payloads never enter receipts or logs.
        return { reason: METADATA_UNAVAILABLE, requestId, status: "blocked" };
      }
    },

    harness: "codex",

    async inventory(conversationId: string): Promise<Inventory> {
      try {
        const entries = await withClient((client) => queueEntries(client, conversationId));
        return {
          entries: entries.map((entry) => ({
            clientUserMessageId: entry.clientUserMessageId,
            payload: queuePayload(entry),
            queueId: entry.id,
          })),
          status: "available",
        };
      } catch {
        return { entries: [], reason: INVENTORY_UNAVAILABLE, status: "unavailable" };
      }
    },

    async status(conversationId: string): Promise<Availability> {
      if (!socketAvailable(socket)) {
        return { reason: SOCKET_MISSING, status: "unavailable" };
      }
      try {
        const read = await withClient((client) =>
          client.call("thread/read", { includeTurns: false, threadId: conversationId }),
        );
        return availability(read);
      } catch {
        return { reason: METADATA_UNAVAILABLE, status: "unavailable" };
      }
    },
  };
}

/** thread/read as an Availability: the same tests selectTarget applies before any input. */
export function availability(read: unknown): Availability {
  const thread = isRecord(read) && isRecord(read.thread) ? read.thread : null;
  if (thread === null) {
    return { reason: "native thread missing", status: "missing" };
  }
  const status = isRecord(thread.status) ? thread.status : {};
  if (thread.canAcceptDirectInput !== true) {
    return { reason: "coordinator input availability unknown", status: "unavailable" };
  }
  const flags = status.activeFlags;
  if (status.type === "active" && !(Array.isArray(flags) && flags.length === 0)) {
    return { reason: "coordinator waiting on a question or approval", status: "blocked" };
  }
  if (status.type === "active") {
    return { status: "busy" };
  }
  if (status.type === "idle") {
    return { status: "available" };
  }
  return { reason: "coordinator state ambiguous or interrupted", status: "unavailable" };
}
