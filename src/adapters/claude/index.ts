// Claude harness adapter: spool and channel transport, session-reported availability, and the
// delivered-entry inventory. Claude exposes no native queue, question or history API.
import { readdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

import { readJsonIfExists } from "../../durable.ts";
import type { GameLayout } from "../../layout.ts";
import type {
  Availability,
  DeliveryReceipt,
  DeliveryStatus,
  Disposition,
  HarnessAdapter,
  Inventory,
  InventoryEntry,
} from "../types.ts";
import { listingOrNull, monitorAvailability } from "./agents.ts";
import { eventRequestId } from "./ids.ts";
import { deliveredDir, type Json, readEntry, spoolEvent } from "./spool.ts";

const STATUSES: readonly DeliveryStatus[] = [
  "accepted",
  "ambiguous",
  "blocked",
  "busy",
  "deduplicated",
  "deferred",
  "rejected",
  "sending",
  "unchanged",
];

export interface DeliveredEntry {
  readonly requestId: string;
  readonly kind: unknown;
  readonly text: string;
  readonly acceptedAt: unknown;
  readonly receiptStatus: unknown;
}

/** Delivered channel entries for `recipient`, keyed by request ID (claude_monitor.py:delivered). */
export function deliveredEntries(busDir: string, recipient: string): Map<string, DeliveredEntry> {
  const directory = deliveredDir(busDir);
  const entries = new Map<string, DeliveredEntry>();
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return entries;
  }
  for (const name of names) {
    const entry = readEntry(join(directory, name));
    if (
      entry === undefined ||
      entry.recipient !== recipient ||
      name !== `${String(entry.requestId)}.json` ||
      typeof entry.text !== "string" ||
      typeof entry.receipt !== "string"
    ) {
      continue;
    }
    let receipt: Json | undefined;
    try {
      receipt = readJsonIfExists(join(busDir, entry.receipt)) as Json | undefined;
    } catch {
      continue;
    }
    if (receipt === undefined) {
      continue;
    }
    const requestId = entry.requestId as string;
    entries.set(requestId, {
      acceptedAt: entry.acceptedAt,
      kind: entry.kind,
      receiptStatus: receipt.status,
      requestId,
      text: entry.text,
    });
  }
  return entries;
}

function receiptStatus(path: string): DeliveryStatus | undefined {
  try {
    const status = (readJsonIfExists(path) as Json | undefined)?.status;
    return STATUSES.includes(status as DeliveryStatus) ? (status as DeliveryStatus) : undefined;
  } catch {
    return undefined;
  }
}

export function claudeAdapter(env: NodeJS.ProcessEnv, game: GameLayout): HarnessAdapter {
  return {
    ack(
      conversationId: string,
      queueId: string,
      payload: string,
      disposition: Disposition,
    ): Promise<DeliveryReceipt> {
      const current = deliveredEntries(game.busDir, conversationId).get(queueId);
      if (current === undefined) {
        return Promise.resolve({
          reason: "confirmed absent",
          requestId: queueId,
          status: "unchanged",
        });
      }
      if (current.text !== payload) {
        return Promise.resolve({
          reason: "changed payload",
          requestId: queueId,
          status: "rejected",
        });
      }
      if (disposition === "retained") {
        return Promise.resolve({
          reason: "retention is recorded by the monitor",
          requestId: queueId,
          status: "unchanged",
        });
      }
      unlinkSync(join(deliveredDir(game.busDir), `${queueId}.json`));
      return Promise.resolve({ requestId: queueId, status: "accepted" });
    },

    /**
     * Bus-event delivery through the spool. The receipt is
     * `events/native/<eventId>-<conversationId>.json`; `accepted` arrives only after the consumer
     * has delivered the entry, so callers retry on later flushes and never resend.
     */
    deliver(
      receiptPath: string,
      requestId: string,
      conversationId: string,
      text: string,
    ): Promise<DeliveryReceipt> {
      const suffix = `-${conversationId}.json`;
      const name = basename(receiptPath);
      const eventId = name.endsWith(suffix) ? name.slice(0, -suffix.length) : "";
      if (eventId === "" || eventRequestId(eventId, conversationId) !== requestId) {
        return Promise.resolve({
          reason: "request identity mismatch",
          requestId,
          status: "rejected",
        });
      }
      const accepted = spoolEvent(env, game.busDir, receiptPath, conversationId, eventId, text);
      const status = accepted ? "accepted" : (receiptStatus(receiptPath) ?? "busy");
      return Promise.resolve({ requestId, status });
    },

    harness: "claude",

    inventory(conversationId: string): Promise<Inventory> {
      const entries: InventoryEntry[] = [
        ...deliveredEntries(game.busDir, conversationId).values(),
      ].map((entry) => ({ payload: entry.text, queueId: entry.requestId }));
      return Promise.resolve({ entries, status: "available" });
    },

    status(conversationId: string): Promise<Availability> {
      const listing = listingOrNull(env);
      if (listing === null) {
        return Promise.resolve({
          reason: "claude agents listing unavailable",
          status: "unavailable",
        });
      }
      const availability = monitorAvailability(listing, conversationId);
      if (availability.status !== null) {
        return Promise.resolve({ status: availability.status === "idle" ? "available" : "busy" });
      }
      if (availability.reason.includes("missing")) {
        return Promise.resolve({ reason: availability.reason, status: "missing" });
      }
      if (availability.reason.includes("blocked")) {
        return Promise.resolve({ reason: availability.reason, status: "blocked" });
      }
      return Promise.resolve({ reason: availability.reason, status: "unavailable" });
    },
  };
}

export {
  agentsListing,
  listingOrNull,
  monitorAvailability,
  roleDiagnostics,
  sessionStatus,
} from "./agents.ts";
export { channelNotification, initializeResult } from "./protocol.ts";
export { type ResolvedRoute, resolveRouteV2, RouteError, routeHarness } from "./route.ts";
export { DELIVERED, pendingEntries, SPOOL, spoolEvent, spoolMonitorBrief } from "./spool.ts";
