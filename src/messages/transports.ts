import { dirname } from "node:path";

import { spoolMessage } from "../adapters/claude/spool.ts";
import { type QueueGuards, queueMessage } from "../adapters/codex/queue.ts";
import { type RpcClient, RpcError } from "../adapters/codex/rpc.ts";
import {
  type DeliveryDiagnostic,
  type HarnessAdapter,
  safeDeliveryDiagnostic,
} from "../adapters/types.ts";

/** The service resolves ownership and parent hops before selecting a transport. */
export interface NativeMessage {
  readonly requestId: string;
  readonly recipient: string;
  readonly text: string;
}

export interface TransportReceipt {
  readonly diagnostic?: DeliveryDiagnostic;
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
        return queueMessage(null, path, message);
      }
      let client: RpcClient;
      try {
        client = await ports.connect();
      } catch (error) {
        const previous = await queueMessage(null, path, message);
        return previous.status === "blocked"
          ? {
              diagnostic:
                error instanceof RpcError
                  ? { ...error.diagnostic, stage: "connection" as const }
                  : {
                      category: "transport-unavailable" as const,
                      classification: "unavailable" as const,
                      stage: "connection" as const,
                    },
              reason: "transport unavailable",
              requestId: message.requestId,
              status: "unavailable",
            }
          : previous;
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
          ...(safeDeliveryDiagnostic(result.diagnostic) === undefined
            ? {}
            : { diagnostic: safeDeliveryDiagnostic(result.diagnostic)! }),
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
