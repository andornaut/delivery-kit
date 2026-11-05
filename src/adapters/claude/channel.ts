// Channel consumer: a stdio MCP server started by the monitor session itself.
// It delivers each spooled entry once, records `accepted` (delivery, not handling) or
// `ambiguous` on a failed write, and never resends.
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { readJsonIfExists, writeJsonDurable } from "../../durable.ts";
import { holdLockAsync } from "../../lock.ts";
import { channelNotification, initializeResult } from "./protocol.ts";
import {
  deliveredDir,
  type EntryKind,
  type Json,
  LOCK_FILE,
  readEntry,
  RECEIPT_KEYS,
  spoolDir,
  type SpoolEntry,
  unblockDir,
} from "./spool.ts";

/** Writes one complete line synchronously; throws when the channel output is unusable. */
export type LineWriter = (line: string) => void;

const RECEIPT = /^(?:unblock|events\/native)\/[A-Za-z0-9_-]+\.json$/;

export function now(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

function receiptFor(busDir: string, entry: Json): string {
  const kind = entry.kind;
  const name = entry.receipt;
  if ((kind !== "event" && kind !== "monitor") || typeof name !== "string" || !RECEIPT.test(name)) {
    throw new Error("invalid receipt reference");
  }
  return join(busDir, name);
}

function matches(receipt: Json, entry: Json): boolean {
  return (
    receipt[RECEIPT_KEYS[entry.kind as EntryKind]] === entry.requestId &&
    receipt.status === "sending"
  );
}

function mark(receipt: Json, status: string, fields: Json = {}): void {
  Object.assign(receipt, fields, { status });
  const attempts = receipt.attempts;
  if (Array.isArray(attempts) && attempts.length > 0) {
    Object.assign(attempts[attempts.length - 1] as Json, { status });
  }
}

function readReceipt(path: string): Json | undefined {
  const value = readJsonIfExists(path);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function names(directory: string, suffix: string): string[] {
  try {
    // A sorted listing keeps delivery order deterministic.
    return readdirSync(directory)
      .filter((name) => name.endsWith(suffix))
      .sort();
  } catch {
    return [];
  }
}

/** A claimed entry with a sending receipt was interrupted mid-delivery; never resend it. */
function reconcileClaims(busDir: string): void {
  const spool = spoolDir(busDir);
  for (const name of names(spool, ".claimed")) {
    try {
      const entry = readEntry(join(spool, name));
      if (entry === undefined) {
        continue;
      }
      const path = receiptFor(busDir, entry);
      const receipt = readReceipt(path);
      if (receipt !== undefined && matches(receipt, entry)) {
        mark(receipt, "ambiguous", { reason: "channel delivery interrupted; do not resend" });
        writeJsonDurable(path, receipt);
      }
    } catch {
      // An unreadable claim stays in place as evidence for manual reconciliation.
    }
  }
}

function deliverLocked(write: LineWriter, busDir: string, monitor: string): boolean {
  reconcileClaims(busDir);
  const spool = spoolDir(busDir);
  for (const name of names(spool, ".json")) {
    const pending = join(spool, name);
    let claimed: string;
    let entry: Json;
    let path: string;
    let receipt: Json;
    let line: string;
    try {
      const loaded = readEntry(pending);
      if (
        loaded === undefined ||
        loaded.recipient !== monitor ||
        name !== `${String(loaded.requestId)}.json` ||
        typeof loaded.text !== "string"
      ) {
        continue;
      }
      entry = loaded;
      path = receiptFor(busDir, entry);
      const current = readReceipt(path);
      if (current === undefined || !matches(current, entry)) {
        continue;
      }
      receipt = current;
      line = JSON.stringify(channelNotification(entry as unknown as SpoolEntry));
      claimed = `${pending.slice(0, -".json".length)}.claimed`;
      renameSync(pending, claimed);
    } catch {
      continue;
    }
    try {
      write(`${line}\n`);
    } catch {
      mark(receipt, "ambiguous", { reason: "channel write failed; do not resend" });
      writeJsonDurable(path, receipt);
      return false;
    }
    const acceptedAt = now();
    // The delivered copy is the monitor's acknowledgeable inventory (monitor-ack).
    mkdirSync(deliveredDir(busDir), { mode: 0o700, recursive: true });
    writeJsonDurable(join(deliveredDir(busDir), name), { ...entry, acceptedAt });
    mark(receipt, "accepted", { acceptedAt });
    writeJsonDurable(path, receipt);
    unlinkSync(claimed);
  }
  return true;
}

/**
 * Deliver every pending entry for `monitor` in one bus directory. False once output fails. A bus
 * without a spool directory has nothing to deliver and is left as it is: nothing is created.
 */
export async function deliverPending(
  write: LineWriter,
  busDir: string,
  monitor: string,
): Promise<boolean> {
  if (!isDirectory(spoolDir(busDir))) {
    return true;
  }
  const lock = await holdLockAsync(join(unblockDir(busDir), LOCK_FILE));
  try {
    return deliverLocked(write, busDir, monitor);
  } finally {
    lock.release();
  }
}

interface Message {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

/** Answer requests; returns true once the client reports initialization. */
export function handle(write: LineWriter, message: Message): boolean {
  if (!Object.hasOwn(message, "id")) {
    return message.method === "notifications/initialized";
  }
  const { id, method, params } = message;
  let reply: Json;
  if (method === "initialize") {
    reply = { id, jsonrpc: "2.0", result: initializeResult(params) };
  } else if (method === "ping") {
    reply = { id, jsonrpc: "2.0", result: {} };
  } else {
    reply = { error: { code: -32601, message: "method not found" }, id, jsonrpc: "2.0" };
  }
  write(`${JSON.stringify(reply)}\n`);
  return false;
}

export interface ServeOptions {
  readonly pollMs: number;
}

/**
 * Serve until input ends (exit 0) or the output fails (exit 1). Entries are delivered only after
 * `notifications/initialized`, then after every message and every poll.
 */
export function serve(
  options: ServeOptions,
  input: NodeJS.ReadableStream,
  write: LineWriter,
  busDirs: readonly string[],
  monitor: string,
): Promise<number> {
  return new Promise((resolve) => {
    let initialized = false;
    let buffer = "";
    let running = false;
    let finished = false;
    const finish = (code: number): void => {
      if (!finished) {
        finished = true;
        clearInterval(timer);
        input.removeAllListeners("data");
        // Release stdin so the process can exit once the consumer stops.
        input.pause();
        (input as { destroy?: () => void }).destroy?.();
        resolve(code);
      }
    };
    const drain = async (): Promise<void> => {
      if (!initialized || running || finished) {
        return;
      }
      running = true;
      try {
        for (const busDir of busDirs) {
          // Projects are drained in order; a failed write stops the consumer.
          // eslint-disable-next-line no-await-in-loop
          if (!(await deliverPending(write, busDir, monitor))) {
            finish(1);
            return;
          }
        }
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void drain(), options.pollMs);
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof message === "object" && message !== null && !Array.isArray(message)) {
          try {
            initialized = handle(write, message as Message) || initialized;
          } catch {
            finish(1);
            return;
          }
        }
      }
      void drain();
    });
    input.once("end", () => finish(0));
    input.once("error", () => finish(1));
  });
}
