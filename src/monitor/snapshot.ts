// Monitor review snapshots. The inventory comes
// from the active harness adapter; every capability the harness cannot report is `unavailable`,
// which is never clearance.
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";

import { type AgentEntry, roleDiagnostics } from "../adapters/claude/agents.ts";
import { deliveredEntries } from "../adapters/claude/index.ts";
import { spoolDir } from "../adapters/claude/spool.ts";
import { unavailableCollected } from "../adapters/codex/collect.ts";
import { SOCKET_MISSING_OUTPUT, TRANSPORT_UNAVAILABLE } from "../adapters/codex/index.ts";
import type { ActiveScope } from "../adapters/shared/route.ts";
import type { CollectRequest, HarnessAdapter } from "../adapters/types.ts";
import type { Harness } from "../registry/schema.ts";
import { nativeEntry } from "./ack.ts";
import {
  type Json,
  persist,
  type QueueEntry,
  queueEntry,
  retentionStatus,
  snapshotPath,
} from "./store.ts";

const UNAVAILABLE: Readonly<Json> = Object.freeze({
  reason_code: "claude_no_native_api",
  status: "unavailable",
});

export interface SnapshotContext {
  readonly busDir: string;
  readonly unblock: string;
}

/** The spool's pending entries; an absent spool has none, any other read failure is an error. */
function channelPending(busDir: string): { entries: Json[]; error?: string } {
  let names: string[];
  try {
    names = readdirSync(spoolDir(busDir));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { entries: [] }
      : { entries: [], error: `channel spool unreadable (${code ?? "error"})` };
  }
  const pick = (suffix: string, state: string): Json[] =>
    names
      .filter((name) => name.endsWith(suffix))
      .sort()
      .map((name) => ({ request_id: name.slice(0, -suffix.length), state }));
  return { entries: [...pick(".json", "spooled"), ...pick(".claimed", "claimed")] };
}

/** Claude snapshot: delivered channel entries plus session-reported diagnostics. */
export function captureClaude(
  context: SnapshotContext,
  listing: readonly AgentEntry[] | null,
  route: ActiveScope,
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
  const queue = entries.map((entry) => {
    const status = retentionStatus(context.unblock, "claude", recipient, entry);
    return { ...entry, retained: status === "retained", retention_status: status };
  });
  const roles = [recipient, ...route.peers];
  const pending = channelPending(context.busDir);
  const record: Json = {
    channel_pending: pending.entries,
    errors: pending.error === undefined ? {} : { channel_pending: pending.error },
    harness: "claude",
    history: Object.fromEntries(roles.map((role) => [role, { ...UNAVAILABLE }])),
    native_queues: Object.fromEntries(roles.map((role) => [role, { ...UNAVAILABLE }])),
    question_state: Object.fromEntries(
      roleDiagnostics(listing, roles).map((row) => [row.session_id, row]),
    ),
    queue_sources: { [recipient]: "local_channel_delivered" },
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

/** The Codex control socket is missing or refused the connection; `message` is the reason. */
export class TransportUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TransportUnavailable";
  }
}

export interface CodexCaptureOptions {
  readonly slot?: number | null;
  readonly historyCursor?: string | null;
  /** The active route's members, or null for a declared route that is not active. */
  readonly routeMembers?: readonly string[] | null;
}

/**
 * Codex snapshot: the adapter's native queue inventory for each recipient, then the history,
 * question and worker collectors when the adapter provides them.
 */
async function collectCodex(
  context: SnapshotContext,
  adapter: HarnessAdapter,
  recipients: readonly string[],
  parents: readonly string[],
  options: CodexCaptureOptions = {},
): Promise<Json> {
  const slot = options.slot ?? null;
  const queues: Json = {};
  const errors: Json = {};
  const inventories = await Promise.all(
    recipients.map((recipient) => adapter.inventory(recipient)),
  );
  // A socket that is missing or refuses the connection stops the snapshot before it is
  // recorded; an inventory read that fails after connecting is a per-recipient error.
  const refused = inventories.find(
    (inventory) =>
      inventory.status === "unavailable" &&
      (inventory.reason === SOCKET_MISSING_OUTPUT || inventory.reason === TRANSPORT_UNAVAILABLE),
  );
  if (refused?.reason !== undefined) {
    throw new TransportUnavailable(refused.reason);
  }
  recipients.forEach((recipient, index) => {
    const inventory = inventories[index];
    if (inventory === undefined || inventory.status !== "available") {
      errors[recipient] =
        "queue inventory unavailable or incomplete; retry snapshot before reconciliation";
      return;
    }
    queues[recipient] = inventory.entries.map((entry) => nativeEntry(entry));
  });
  const request: CollectRequest = {
    historyCursor: options.historyCursor ?? null,
    ...(options.routeMembers === undefined ? {} : { routeMembers: options.routeMembers }),
    parents,
    recipients,
    slot,
    unblockDir: context.unblock,
  };
  const collectors = adapter.collectors;
  const collected =
    collectors === undefined
      ? unavailableCollected("collector_not_ported", request)
      : await collectors.collect(request);
  const record: Json = {
    collection_budget: collected.collection_budget,
    errors,
    harness: "codex",
    history: collected.history,
    question_state: collected.question_state,
    queues,
    snapshot_id: randomUUID(),
    worker_health: collected.worker_health,
  };
  if (slot !== null) {
    record.slot = slot;
  }
  return record;
}

export async function captureCodex(
  context: SnapshotContext,
  adapter: HarnessAdapter,
  recipients: readonly string[],
  parents: readonly string[],
  options: CodexCaptureOptions = {},
): Promise<Json> {
  const record = await collectCodex(context, adapter, recipients, parents, options);
  persist(snapshotPath(context.unblock, record.snapshot_id as string), record);
  return record;
}

/**
 * Capture each endpoint through its effective harness. Claude inventory is local delivered
 * channel work only; unavailable native capabilities never become empty native queues.
 * The caller supplies adapters so a scheduled review can reuse its existing Codex connection.
 */
export async function captureMixed(
  context: SnapshotContext,
  adapters: Partial<Record<Harness, HarnessAdapter>>,
  harnesses: Readonly<Record<string, Harness>>,
  recipients: readonly string[],
  parents: readonly string[],
  options: CodexCaptureOptions = {},
): Promise<Json> {
  const endpoints = [...new Set([...recipients, ...parents, ...(options.routeMembers ?? [])])];
  if (recipients.length === 0) {
    throw new Error("mixed snapshot requires a recipient");
  }
  for (const id of endpoints) {
    const harness = harnesses[id];
    if (harness !== "claude" && harness !== "codex") {
      throw new Error("snapshot endpoint harness missing or invalid");
    }
    if (adapters[harness] !== undefined && adapters[harness]?.harness !== harness) {
      throw new Error("snapshot adapter harness mismatch");
    }
  }
  const selected = (harness: Harness, ids: readonly string[]): string[] =>
    [...new Set(ids)].filter((id) => harnesses[id] === harness);
  const codexRecipients = selected("codex", recipients);
  const codexParents = selected("codex", parents);
  const codexMembers =
    options.routeMembers == null ? options.routeMembers : selected("codex", options.routeMembers);
  let record: Json;
  if (codexRecipients.length > 0 || codexParents.length > 0) {
    if (adapters.codex === undefined) {
      throw new TransportUnavailable("Codex snapshot adapter unavailable");
    }
    record = await collectCodex(context, adapters.codex, codexRecipients, codexParents, {
      ...options,
      ...(codexMembers === undefined ? {} : { routeMembers: codexMembers }),
    });
  } else {
    record = {
      collection_budget: {},
      errors: {},
      history: {},
      question_state: {},
      queues: {},
      snapshot_id: randomUUID(),
      worker_health: {},
    };
  }
  const claudeRecipients = selected("claude", recipients);
  const claudeParents = selected("claude", parents);
  const claudeMembers = selected("claude", endpoints);
  const history = record.history as Json;
  const questions = record.question_state as Json;
  const workers = record.worker_health as Json;
  const errors = record.errors as Json;
  const queues = record.queues as Record<string, QueueEntry[]>;
  for (const [recipient, entries] of Object.entries(queues)) {
    queues[recipient] = entries.map((entry) => {
      const status = retentionStatus(context.unblock, "codex", recipient, entry);
      return {
        ...entry,
        harness: "codex",
        retained: status === "retained",
        retention_status: status,
      };
    });
  }
  const nativeQueues: Json = Object.fromEntries(
    codexRecipients.map((id) => [
      id,
      { status: Object.hasOwn(queues, id) ? "available" : "unavailable" },
    ]),
  );
  const channelQueues: Json = {};
  const sources: Json = Object.fromEntries(codexRecipients.map((id) => [id, "native_queue"]));
  for (const id of claudeMembers) {
    history[id] = { ...UNAVAILABLE };
    nativeQueues[id] = { ...UNAVAILABLE };
  }
  for (const row of roleDiagnostics(null, claudeMembers)) {
    questions[row.session_id] = row;
  }
  for (const id of claudeParents) {
    workers[id] = { ...UNAVAILABLE };
  }
  for (const recipient of claudeRecipients) {
    sources[recipient] = "local_channel_delivered";
    if (adapters.claude === undefined) {
      sources[recipient] = "local_channel_unavailable";
      continue;
    }
    // Each local inventory remains bound to its Claude recipient.
    // eslint-disable-next-line no-await-in-loop
    const inventory = await adapters.claude.inventory(recipient);
    if (inventory.status !== "available") {
      errors[recipient] = "local delivered channel inventory unavailable";
      continue;
    }
    channelQueues[recipient] = inventory.entries.map((value) => {
      const entry = nativeEntry(value);
      const status = retentionStatus(context.unblock, "claude", recipient, entry);
      return {
        ...entry,
        harness: "claude",
        retained: status === "retained",
        retention_status: status,
      };
    });
  }
  Object.assign(record, {
    channel_queues: channelQueues,
    harness: harnesses[recipients[0] as string],
    harnesses: Object.fromEntries(endpoints.map((id) => [id, harnesses[id]])),
    native_complete: recipients.every(
      (id) => harnesses[id] === "codex" && Object.hasOwn(queues, id),
    ),
    native_queues: nativeQueues,
    queue_sources: sources,
  });
  if (options.slot != null) {
    record.slot = options.slot;
  }
  persist(snapshotPath(context.unblock, record.snapshot_id as string), record);
  return record;
}
