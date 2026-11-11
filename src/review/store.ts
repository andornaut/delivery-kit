// Inbox state shared by snapshots and acknowledgements, under a game's bus `unblock/`
// directory. File names and record keys are persisted game state.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { digest } from "../adapters/shared/pyjson.ts";
import { readJsonIfExists, writeJsonDurable } from "../durable.ts";
import { withLock } from "../lock.ts";
import type { Harness } from "../registry/schema.ts";

export interface QueueEntry {
  readonly id: string;
  readonly clientUserMessageId: string;
  readonly input: readonly { readonly type: "text"; readonly text: string }[];
  readonly [key: string]: unknown;
}

export type Json = Record<string, unknown>;

/** The normalized snapshot entry for one queue item; its signature binds the exact payload. */
export function queueEntry(id: string, text: string, extra: Json = {}): QueueEntry {
  return { ...extra, clientUserMessageId: id, id, input: [{ text, type: "text" }] };
}

export function payloadSignature(entry: QueueEntry): string {
  return digest([entry.clientUserMessageId, entry.input]);
}

export function retentionPath(unblock: string, recipient: string, identity: string): string {
  return join(unblock, "retentions", `${digest([recipient, identity])}.json`);
}

export function ackPath(
  unblock: string,
  recipient: string,
  snapshotId: string,
  identity: string,
): string {
  return join(unblock, "acks", `${digest([recipient, snapshotId, identity])}.json`);
}

export function snapshotPath(unblock: string, snapshotId: string): string {
  return join(unblock, "snapshots", `${snapshotId}.json`);
}

/** Durable write with 0600 files and 0700 directories. */
export function persist(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { mode: 0o700, recursive: true });
  writeJsonDurable(path, value);
}

export function readRecord(path: string): Json | undefined {
  const value = readJsonIfExists(path);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

export function retained(unblock: string, recipient: string, entry: QueueEntry): boolean {
  let record: Json | undefined;
  try {
    record = readRecord(retentionPath(unblock, recipient, entry.id));
  } catch {
    return false;
  }
  return (
    record?.active === true &&
    record.recipient === recipient &&
    record.queue_id === entry.id &&
    record.payload_signature === payloadSignature(entry)
  );
}

/** A mixed snapshot requires its exact recipient binding; legacy snapshots use their harness. */
export function snapshotHarness(snapshot: Json | undefined, recipient: string): Harness | null {
  const bindings = snapshot?.harnesses;
  const selected =
    bindings === undefined
      ? snapshot?.harness
      : typeof bindings === "object" && bindings !== null && !Array.isArray(bindings)
        ? (bindings as Json)[recipient]
        : null;
  return selected === "claude" || selected === "codex" ? selected : null;
}

export type RetentionStatus =
  "absent" | "conflicting_harness" | "inactive" | "not_retained" | "retained" | "unknown";

/** Recover legacy retention transport from its original durable snapshot, never current selection. */
function retentionHarness(unblock: string, record: Json): Harness | null {
  if (record.harness !== undefined) {
    return record.harness === "claude" || record.harness === "codex" ? record.harness : null;
  }
  if (typeof record.snapshot_id !== "string" || typeof record.recipient !== "string") {
    return null;
  }
  const snapshot = readRecord(snapshotPath(unblock, record.snapshot_id));
  return snapshot?.snapshot_id === record.snapshot_id
    ? snapshotHarness(snapshot, record.recipient)
    : null;
}

/** Exact payload retention under a proven transport; unknown or conflicting bindings never clear work. */
export function retentionStatus(
  unblock: string,
  harness: Harness,
  recipient: string,
  entry: QueueEntry,
): RetentionStatus {
  const path = retentionPath(unblock, recipient, entry.id);
  try {
    const record = readRecord(path);
    if (record === undefined) {
      return existsSync(path) ? "unknown" : "absent";
    }
    const binding = retentionHarness(unblock, record);
    if (binding === null) {
      return "unknown";
    }
    if (binding !== harness) {
      return "conflicting_harness";
    }
    if (record.recipient !== recipient || record.queue_id !== entry.id) {
      return "unknown";
    }
    if (record.active === false) {
      return "inactive";
    }
    if (record.active !== true) {
      return "unknown";
    }
    return record.payload_signature === payloadSignature(entry) ? "retained" : "not_retained";
  } catch {
    return "unknown";
  }
}

/** Serialize inbox state changes on `<unblock>/inbox.lock`. */
export function locked<T>(unblock: string, fn: () => T): T {
  mkdirSync(unblock, { recursive: true });
  return withLock(join(unblock, "inbox.lock"), fn);
}
