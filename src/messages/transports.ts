import { dirname } from "node:path";

import { spoolMessage } from "../adapters/claude/spool.ts";
import { type QueueGuards, queueMessage } from "../adapters/codex/queue.ts";
import type { RpcClient } from "../adapters/codex/rpc.ts";
import type { HarnessAdapter } from "../adapters/types.ts";

/** The service resolves ownership and parent hops before selecting a transport. */
export interface NativeMessage {
  readonly requestId: string;
  readonly recipient: string;
  readonly text: string;
}

export interface TransportReceipt {
  readonly requestId: string;
  readonly status:
    | "accepted"
    | "queued"
    | "ambiguous"
    | "blocked"
    | "busy"
    | "deferred"
    | "rejected"
    | "unsupported"
    | "unavailable";
  readonly reason?: string;
  readonly queueId?: string;
}

export type QueueCapability = "guard-required" | "guarded";

export interface MessageTransport {
  send(receiptPath: string, message: NativeMessage): Promise<TransportReceipt>;
}

/** The caller supplies existing connectControl routing, never a new frontend. */
export function codexQueueTransport(ports: {
  readonly connect: () => Promise<RpcClient>;
  readonly guards?: QueueGuards;
  /** Local owner/HOLD and decision check before connecting. No native probes here. */
  readonly canConnect?: (message: NativeMessage) => boolean;
}): MessageTransport & { readonly capability: QueueCapability } {
  return {
    capability:
      ports.guards === undefined || ports.canConnect === undefined ? "guard-required" : "guarded",
    async send(path, message) {
      let locallyClear = false;
      try {
        locallyClear = ports.guards !== undefined && ports.canConnect?.(message) === true;
      } catch {
        // Unknown owner or HOLD state leaves the message local.
      }
      if (!locallyClear) {
        return {
          reason: "explicit queue clearance required; keep queued locally",
          requestId: message.requestId,
          status: "blocked",
        };
      }
      let client: RpcClient;
      try {
        client = await ports.connect();
      } catch {
        return {
          reason: "transport unavailable",
          requestId: message.requestId,
          status: "unavailable",
        };
      }
      try {
        return await queueMessage(client, path, message, ports.guards);
      } finally {
        client.close();
      }
    },
  };
}

/** The public channel state directory is directly beneath its generic bus directory. */
export function claudeMessageTransport(ports: {
  readonly messageChannelStateDir: string;
}): MessageTransport {
  return {
    send(path, message) {
      return Promise.resolve(spoolMessage(dirname(ports.messageChannelStateDir), path, message));
    },
  };
}

/** Unblock uses the service's existing guarded adapter without duplicating its guards. */
export function guardedMessageTransport(adapter: HarnessAdapter): MessageTransport {
  return {
    async send(path, message) {
      try {
        const result = await adapter.deliver(
          path,
          message.requestId,
          message.recipient,
          message.text,
        );
        const status = result.status === "sending" ? "ambiguous" : result.status;
        return {
          requestId: message.requestId,
          status: status === "unchanged" || status === "deduplicated" ? "blocked" : status,
        };
      } catch {
        return {
          reason: "guarded delivery unavailable",
          requestId: message.requestId,
          status: "ambiguous",
        };
      }
    },
  };
}
