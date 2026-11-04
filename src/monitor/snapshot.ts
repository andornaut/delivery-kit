// Monitor review snapshots (monitor.py:capture, claude_monitor.py:capture). The inventory comes
// from the active harness adapter; every capability the harness cannot report is `unavailable`,
// which is never clearance.
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";

import { type AgentEntry, roleDiagnostics } from "../adapters/claude/agents.ts";
import { deliveredEntries } from "../adapters/claude/index.ts";
import type { ResolvedRoute } from "../adapters/claude/route.ts";
import { spoolDir } from "../adapters/claude/spool.ts";
import type { HarnessAdapter } from "../adapters/types.ts";
import {
  type Json,
  persist,
  type QueueEntry,
  queueEntry,
  retained,
  snapshotPath,
} from "./store.ts";

export const UNAVAILABLE: Readonly<Json> = Object.freeze({
  reason_code: "claude_no_native_api",
  status: "unavailable",
});

/** Collectors this build does not provide for the Codex harness (see the port report). */
export const NOT_PORTED: Readonly<Json> = Object.freeze({
  reason_code: "collector_not_ported",
  status: "unavailable",
});

export interface SnapshotContext {
  readonly busDir: string;
  readonly unblock: string;
}

function channelPending(busDir: string): Json[] {
  let names: string[];
  try {
    names = readdirSync(spoolDir(busDir));
  } catch {
    return [];
  }
  const pick = (suffix: string, state: string): Json[] =>
    names
      .filter((name) => name.endsWith(suffix))
      .sort()
      .map((name) => ({ request_id: name.slice(0, -suffix.length), state }));
  return [...pick(".json", "spooled"), ...pick(".claimed", "claimed")];
}

/** Claude snapshot: delivered channel entries plus session-reported diagnostics. */
export function captureClaude(
  context: SnapshotContext,
  listing: readonly AgentEntry[] | null,
  route: Extract<ResolvedRoute, { status: "active" }>,
  recipient: string,
  parents: readonly string[],
): Json {
  const entries: QueueEntry[] = [...deliveredEntries(context.busDir, recipient).values()].map(
    (entry) =>
      queueEntry(entry.requestId, entry.text, {
        acceptedAt: entry.acceptedAt,
        kind: entry.kind,
        receipt_status: entry.receiptStatus,
      }),
  );
  const queue = entries.map((entry) => ({
    ...entry,
    retained: retained(context.unblock, recipient, entry),
  }));
  const roles = [recipient, ...route.peers];
  const record: Json = {
    channel_pending: channelPending(context.busDir),
    errors: {},
    harness: "claude",
    history: Object.fromEntries(roles.map((role) => [role, { ...UNAVAILABLE }])),
    process_health: {},
    process_health_source: { ...UNAVAILABLE },
    question_state: Object.fromEntries(
      roleDiagnostics(listing, roles).map((row) => [row.session_id, row]),
    ),
    queues: { [recipient]: queue },
    snapshot_id: randomUUID(),
    target_queues: Object.fromEntries(
      route.targets.map((target) => [target.sessionId, { ...UNAVAILABLE, name: target.name }]),
    ),
    worker_health: Object.fromEntries(parents.map((parent) => [parent, { ...UNAVAILABLE }])),
  };
  persist(snapshotPath(context.unblock, record.snapshot_id as string), record);
  return record;
}

/** Codex snapshot: the adapter's native queue inventory for each recipient. */
export async function captureCodex(
  context: SnapshotContext,
  adapter: HarnessAdapter,
  recipients: readonly string[],
  parents: readonly string[],
): Promise<Json> {
  const queues: Json = {};
  const errors: Json = {};
  const inventories = await Promise.all(
    recipients.map((recipient) => adapter.inventory(recipient)),
  );
  recipients.forEach((recipient, index) => {
    const inventory = inventories[index];
    if (inventory === undefined || inventory.status !== "available") {
      errors[recipient] =
        "queue inventory unavailable or incomplete; retry snapshot before reconciliation";
      return;
    }
    queues[recipient] = inventory.entries.map((entry) => queueEntry(entry.queueId, entry.payload));
  });
  const record: Json = {
    errors,
    harness: "codex",
    history: Object.fromEntries(recipients.map((recipient) => [recipient, { ...NOT_PORTED }])),
    process_health: {},
    process_health_source: { ...NOT_PORTED },
    question_state: Object.fromEntries(
      recipients.map((recipient) => [recipient, { ...NOT_PORTED }]),
    ),
    queues,
    snapshot_id: randomUUID(),
    worker_health: Object.fromEntries(parents.map((parent) => [parent, { ...NOT_PORTED }])),
  };
  persist(snapshotPath(context.unblock, record.snapshot_id as string), record);
  return record;
}
