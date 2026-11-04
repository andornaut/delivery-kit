// Monitor review snapshots (monitor.py:capture, claude_monitor.py:capture). The inventory comes
// from the active harness adapter; every capability the harness cannot report is `unavailable`,
// which is never clearance.
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { type AgentEntry, roleDiagnostics } from "../adapters/claude/agents.ts";
import { deliveredEntries } from "../adapters/claude/index.ts";
import type { ResolvedRoute } from "../adapters/claude/route.ts";
import { spoolDir } from "../adapters/claude/spool.ts";
import {
  type CollectRequest,
  type HarnessCollectors,
  unavailableCollected,
} from "../adapters/codex/collect.ts";
import type { HarnessAdapter } from "../adapters/types.ts";
import {
  type Json,
  persist,
  type QueueEntry,
  queueEntry,
  readRecord,
  retained,
  snapshotPath,
} from "./store.ts";

export const UNAVAILABLE: Readonly<Json> = Object.freeze({
  reason_code: "claude_no_native_api",
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

/** The process-health manifest beside a game's bus directory, when one is registered. */
function processManifest(busDir: string): string | undefined {
  const path = join(busDir, "..", "process-health.json");
  return existsSync(path) ? path : undefined;
}

/** The coordinator's prior process observations (monitor.py:372-380), or null. */
function priorProcess(
  context: SnapshotContext,
  manifest: string | undefined,
  recipients: readonly string[],
): unknown {
  const coordinator = recipients[0];
  if (manifest === undefined || coordinator === undefined) {
    return undefined;
  }
  try {
    const record = readRecord(join(context.unblock, "health", `${coordinator}.json`));
    if (record === undefined) {
      return null;
    }
    const values = record.process_observations ?? [];
    return Array.isArray(values) ? values : null;
  } catch {
    return null;
  }
}

function collectorsOf(adapter: HarnessAdapter): HarnessCollectors | undefined {
  const collectors = (adapter as { readonly collectors?: unknown }).collectors;
  return typeof collectors === "object" && collectors !== null
    ? (collectors as HarnessCollectors)
    : undefined;
}

/**
 * Codex snapshot: the adapter's native queue inventory for each recipient, then the history,
 * question, worker and process collectors when the adapter provides them.
 */
export async function captureCodex(
  context: SnapshotContext,
  adapter: HarnessAdapter,
  recipients: readonly string[],
  parents: readonly string[],
  slot: number | null = null,
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
    queues[recipient] = inventory.entries.map((entry) => ({
      ...queueEntry(entry.queueId, entry.payload),
      clientUserMessageId: entry.clientUserMessageId ?? entry.queueId,
    }));
  });
  const manifest = processManifest(context.busDir);
  const request: CollectRequest = {
    historyCursor: null,
    parents,
    recipients,
    slot,
    unblockDir: context.unblock,
    ...optional("processManifest", manifest),
    ...optional("priorProcess", priorProcess(context, manifest, recipients)),
  };
  const collectors = collectorsOf(adapter);
  const collected =
    collectors === undefined
      ? unavailableCollected("collector_not_ported", request)
      : await collectors.collect(request);
  const record: Json = {
    collection_budget: collected.collection_budget,
    errors,
    harness: "codex",
    history: collected.history,
    process_health: collected.process_health,
    process_health_source: collected.process_health_source,
    question_state: collected.question_state,
    queues,
    snapshot_id: randomUUID(),
    worker_health: collected.worker_health,
  };
  if (slot !== null) {
    record.slot = slot;
  }
  persist(snapshotPath(context.unblock, record.snapshot_id as string), record);
  return record;
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}
