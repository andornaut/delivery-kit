// Slot briefs and bus events for a Claude monitor go through a spool that the monitor's own
// channel consumer drains (claude_adapter.py). The receipt is always written at `sending`
// before its spool entry, so an interruption between the two is never resent.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { readJsonIfExists, writeJsonDurable } from "../../durable.ts";
import { holdLock, LockBusy } from "../../lock.ts";
import { decisionClear } from "../shared/decisions.ts";
import { eventRequestId, slotRequestId } from "../shared/ids.ts";
import { pyJsonDumps } from "../shared/pyjson.ts";
import { type AgentEntry, listingOrNull, monitorReady, roleDiagnostics } from "./agents.ts";
import type { ResolvedRoute } from "./route.ts";

export const UNBLOCK = "unblock";
export const SPOOL = "claude-spool";
export const DELIVERED = "claude-delivered";
export const LOCK_FILE = "unblock.lock";

export type EntryKind = "event" | "monitor";

/** The receipt field that carries the request ID, per entry kind. */
export const RECEIPT_KEYS: Readonly<Record<EntryKind, string>> = {
  event: "clientUserMessageId",
  monitor: "requestId",
};

export interface SpoolEntry {
  readonly kind: EntryKind;
  readonly requestId: string;
  readonly recipient: string;
  /** Receipt path relative to the bus directory (STATE). */
  readonly receipt: string;
  readonly text: string;
  readonly slot?: number;
  readonly event_id?: string;
}

export type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

export function unblockDir(busDir: string): string {
  return join(busDir, UNBLOCK);
}

export function spoolDir(busDir: string): string {
  return join(busDir, UNBLOCK, SPOOL);
}

export function deliveredDir(busDir: string): string {
  return join(busDir, UNBLOCK, DELIVERED);
}

function listNames(directory: string, suffix: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(suffix))
      .sort();
  } catch {
    return [];
  }
}

export function readEntry(path: string): Json | undefined {
  try {
    return record(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

/** Spooled entries the consumer has not yet claimed. Accepted entries leave the spool. */
export function pendingEntries(busDir: string, kind: EntryKind, recipient: string): string[] {
  const spool = spoolDir(busDir);
  return listNames(spool, ".json")
    .map((name) => join(spool, name))
    .filter((path) => {
      const entry = readEntry(path);
      return entry?.kind === kind && entry.recipient === recipient;
    });
}

/** Hold unblock.lock without waiting; null means another holder has it. */
function tryUnblockLock(busDir: string): { release(): void } | null {
  const directory = unblockDir(busDir);
  mkdirSync(directory, { recursive: true });
  try {
    return holdLock(join(directory, LOCK_FILE), { nonBlocking: true });
  } catch (error) {
    if (error instanceof LockBusy) {
      return null;
    }
    throw error;
  }
}

function persist(path: string, value: unknown): void {
  writeJsonDurable(path, value);
}

function writeSpoolEntry(busDir: string, entry: SpoolEntry): void {
  mkdirSync(spoolDir(busDir), { mode: 0o700, recursive: true });
  persist(join(spoolDir(busDir), `${entry.requestId}.json`), entry);
}

export interface Diagnostic {
  readonly [key: string]: string;
}

function ordered(pairs: readonly (readonly [string, string])[]): Diagnostic {
  return Object.fromEntries(pairs);
}

export function brief(
  slot: number,
  route: Extract<ResolvedRoute, { status: "active" }>,
  diagnostics: readonly Diagnostic[],
): string {
  const targets = route.targets.map((target) => `${target.name}: ${target.sessionId}`).join("\n");
  return (
    `Scheduled monitoring review, slot ${slot}. Review recent activity of these active route ` +
    "targets and relay only confirmed unblockers through your own cross-session messaging. " +
    "Preserve unanswered questions and independent work; silence is not a decision. Report only " +
    "new or unresolved blockers. This is a triage reminder, not permission to interrupt turns, " +
    "answer questions, restart work or duplicate deliveries. Channel acceptance is delivery only; " +
    `record handling separately.\n${targets}` +
    `\nCapability diagnostics (unavailable is never clearance): ${pyJsonDumps(diagnostics)}`
  );
}

export interface SlotOutcome {
  readonly status: string;
  readonly previousStatus?: string;
  readonly reason?: string | null;
  readonly monitor_session_status?: string;
  readonly requestId?: string;
  readonly diagnostics?: readonly Diagnostic[];
}

function unavailableDiagnostics(
  parents: readonly string[],
  entries: readonly AgentEntry[] | null,
  peers: readonly string[],
): Diagnostic[] {
  return [
    ...["queue_inventory", "question_history"].map((kind) =>
      ordered([
        ["kind", kind],
        ["status", "unavailable"],
        ["reason_code", "claude_no_native_api"],
      ]),
    ),
    ...parents.map((parent) =>
      ordered([
        ["kind", "worker_health"],
        ["parent", parent],
        ["status", "unavailable"],
        ["reason_code", "claude_no_native_api"],
      ]),
    ),
    ...(roleDiagnostics(entries, peers) as unknown as Diagnostic[]),
  ];
}

/** One brief per monitor slot (claude_adapter.py:run). */
export function spoolMonitorBrief(
  env: NodeJS.ProcessEnv,
  busDir: string,
  route: Extract<ResolvedRoute, { status: "active" }>,
  slot: number,
  parents: readonly string[] = [],
): SlotOutcome {
  const { coordinator } = route;
  const unblock = unblockDir(busDir);
  const path = join(unblock, `${coordinator}-${slot}.json`);
  const requestId = slotRequestId(coordinator, slot);
  const lock = tryUnblockLock(busDir);
  if (lock === null) {
    return { status: "busy" };
  }
  try {
    const previous = record(readJsonIfExists(path));
    if (previous !== undefined) {
      // The consumer holds this lock while claiming, so an absent spool entry is final.
      const pending = join(spoolDir(busDir), `${String(previous.requestId)}.json`);
      if (previous.status === "sending" && !existsSync(pending)) {
        Object.assign(previous, {
          reason: "previous send interrupted; do not resend",
          status: "ambiguous",
        });
        persist(path, previous);
      }
      return {
        previousStatus: previous.status as string,
        reason: (previous.reason as string | undefined) ?? null,
        status: "deduplicated",
      };
    }
    const state: Json = { coordinator, harness: "claude", requestId, slot };
    const defer = (reason: string): SlotOutcome => {
      Object.assign(state, { reason, status: "deferred" });
      persist(path, state);
      return state as unknown as SlotOutcome;
    };
    const members = new Set([coordinator, ...route.peers]);
    if (parents.some((parent) => !members.has(parent))) {
      return defer("worker parents require membership in the active monitor route");
    }
    if (!decisionClear(unblock, coordinator)) {
      return defer("recipient-bound user-decision clearance missing, invalid or pending");
    }
    // One unclaimed brief bounds the spool while the consumer is not running.
    if (pendingEntries(busDir, "monitor", coordinator).length > 0) {
      return defer("channel consumer has not claimed an earlier monitor brief");
    }
    const entries = listingOrNull(env);
    const availability = monitorReady(env, coordinator, entries);
    if (availability.status === null) {
      return defer(availability.reason);
    }
    const diagnostics = unavailableDiagnostics(parents, entries, route.peers);
    const entry: SpoolEntry = {
      kind: "monitor",
      receipt: `${UNBLOCK}/${basename(path)}`,
      recipient: coordinator,
      requestId,
      slot,
      text: brief(slot, route, diagnostics),
    };
    Object.assign(state, {
      diagnostics,
      method: "claude-channel",
      monitor_session_status: availability.status,
      spool: join(spoolDir(busDir), `${requestId}.json`),
      status: "sending",
    });
    persist(path, state);
    writeSpoolEntry(busDir, entry);
    return state as unknown as SlotOutcome;
  } finally {
    lock.release();
  }
}

/**
 * event_native.deliver semantics with the spool as transport (claude_adapter.py:spool_event).
 * True only once the consumer has recorded `accepted`; the outbox marks the event sent then.
 */
export function spoolEvent(
  env: NodeJS.ProcessEnv,
  busDir: string,
  receiptPath: string,
  recipient: string,
  eventId: string,
  message: string,
): boolean {
  const unblock = unblockDir(busDir);
  const requestId = eventRequestId(eventId, recipient);
  mkdirSync(dirname(receiptPath), { recursive: true });
  const lock = tryUnblockLock(busDir);
  if (lock === null) {
    return false;
  }
  try {
    let state: Json = {
      attempts: [],
      clientUserMessageId: requestId,
      event_id: eventId,
      recipient,
    };
    const previous = record(readJsonIfExists(receiptPath));
    const attempts = (): Json[] => state.attempts as Json[];
    if (previous !== undefined) {
      state = previous;
      if (
        state.event_id !== eventId ||
        state.recipient !== recipient ||
        state.clientUserMessageId !== requestId ||
        !Array.isArray(state.attempts)
      ) {
        return false;
      }
      if (state.status === "accepted") {
        return true;
      }
      if (state.status === "sending") {
        if (existsSync(join(spoolDir(busDir), `${requestId}.json`))) {
          return false;
        }
        const last = attempts().at(-1);
        if (last !== undefined) {
          last.status = "ambiguous";
        }
        state.status = "ambiguous";
        persist(receiptPath, state);
        return false;
      }
      if (state.status === "ambiguous" || state.status === "rejected" || attempts().length >= 2) {
        return false;
      }
    }
    if (!decisionClear(unblock, recipient) || monitorReady(env, recipient).status === null) {
      state.status = "deferred";
      persist(receiptPath, state);
      return false;
    }
    attempts().push({ method: "claude-channel", status: "sending" });
    state.status = "sending";
    persist(receiptPath, state);
    writeSpoolEntry(busDir, {
      event_id: eventId,
      kind: "event",
      receipt: `${basename(dirname(dirname(receiptPath)))}/${basename(dirname(receiptPath))}/${basename(receiptPath)}`,
      recipient,
      requestId,
      text: message,
    });
    return false;
  } finally {
    lock.release();
  }
}
