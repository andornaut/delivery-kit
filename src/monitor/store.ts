// Monitor state shared by snapshots and acknowledgements, under a game's bus `unblock/`
// directory with the 0.9.x file names (monitor.py:17-46, 608-618).
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { digest } from "../adapters/shared/pyjson.ts";
import { readJsonIfExists, writeJsonDurable } from "../durable.ts";
import { withLock } from "../lock.ts";

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

/** Durable write with 0600 files and 0700 directories, as monitor.py:persist. */
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

/** Serialize monitor state changes on `<unblock>/monitor.lock`. */
export function locked<T>(unblock: string, fn: () => T): T {
  mkdirSync(unblock, { recursive: true });
  return withLock(join(unblock, "monitor.lock"), fn);
}
