// Durable operator-authorized one-off request receipts. A request departs the local main HEAD
// it captured, under the same rules as a scheduled departure; it never admits queue entries.
// Every operation holds requests/requests.lock.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  dumpsJson,
  fsyncDirectory,
  holdLockAsync,
  writeDurable,
} from "@andornaut/coordination-kit/build/shared";

import type { Exec } from "../lib/exec.ts";
import { ensureDir, errnoCode } from "../lib/files.ts";
import { type BusPaths } from "../state/paths.ts";
import { mainHead, skipReason } from "./trunk.ts";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

type RequestState = "finished" | "interrupted" | "pending" | "rejected" | "started";

export interface RequestRecord {
  id: string;
  state: RequestState;
  /** The exact local main SHA captured at request time. */
  head: string;
  reason?: string;
  departure_exit?: number;
  completion?: string;
}

class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}

export interface RequestStore {
  readonly exec: Exec;
  readonly paths: BusPaths;
  /** The canonical game checkout whose main HEAD is captured. */
  readonly repo: string;
  readonly main: string;
}

function recordPath(store: RequestStore, id: string): string {
  if (!REQUEST_ID_PATTERN.test(id)) {
    throw new RequestError("request ID must be 1-64 ASCII letters, digits, underscores or hyphens");
  }
  return join(store.paths.requestsDir, `${id}.json`);
}

function writeRecord(path: string, record: RequestRecord): void {
  writeDurable(path, `${dumpsJson(record)}\n`, { mode: 0o644 });
}

function readRecord(path: string): RequestRecord {
  return JSON.parse(readFileSync(path, "utf8")) as RequestRecord;
}

function recordFiles(store: RequestStore): string[] {
  return readdirSync(store.paths.requestsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(store.paths.requestsDir, name));
}

async function withRequests<T>(store: RequestStore, fn: () => Promise<T> | T): Promise<T> {
  ensureDir(store.paths.requestsDir);
  // Persist the requests directory entry before acknowledging any captured receipt.
  fsyncDirectory(store.paths.dir);
  const lock = await holdLockAsync(store.paths.requestsLock);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/**
 * Capture the current local main HEAD. Repeating an ID returns its existing receipt text. A HEAD
 * with nothing new (already pushed) or whose gate already failed is refused.
 */
export function captureRequest(store: RequestStore, id: string): Promise<string> {
  ensureDir(store.paths.dir);
  return withRequests(store, async () => {
    const path = recordPath(store, id);
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const head = await mainHead(store.exec, store.repo, store.main);
    const skip = skipReason(store.paths, head);
    if (skip === "pushed") {
      throw new RequestError(`main ${head} is already pushed; nothing new to depart`);
    }
    if (skip === "gate-failed") {
      throw new RequestError(`the gate already failed for main ${head}; merge a fix first`);
    }
    const record: RequestRecord = { head, id, state: "pending" };
    writeRecord(path, record);
    return `${dumpsJson(record)}\n`;
  });
}

/** The pending record started, or undefined when it is not pending. */
export function startedRecord(record: RequestRecord): RequestRecord | undefined {
  return record.state === "pending" ? { ...record, state: "started" } : undefined;
}

/** The started record interrupted, or undefined when it is not started. */
export function interruptedRecord(record: RequestRecord): RequestRecord | undefined {
  return record.state === "started" ? { ...record, state: "interrupted" } : undefined;
}

/** The record rejected because main moved from its captured HEAD, or undefined when it matches. */
export function rejectedRecord(head: string, record: RequestRecord): RequestRecord | undefined {
  return head === record.head
    ? undefined
    : { ...record, reason: "main moved since the request", state: "rejected" };
}

/** The started record finished with the departure's exit, or undefined when it is not started. */
export function finishedRecord(exit: number, record: RequestRecord): RequestRecord | undefined {
  return record.state === "started"
    ? {
        ...record,
        completion: "departure flow only; consult exact-commit CI and deployment state",
        departure_exit: exit,
        state: "finished",
      }
    : undefined;
}

/** Whether a request receipt is pending; read without the lock, since claiming re-reads under it. */
export function hasPendingRequest(paths: BusPaths): boolean {
  try {
    return readdirSync(paths.requestsDir).some((name) => {
      if (!name.endsWith(".json")) {
        return false;
      }
      return readRecord(join(paths.requestsDir, name)).state === "pending";
    });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Mark the first pending request started and return its ID. */
export function claimRequest(store: RequestStore): Promise<string | undefined> {
  return withRequests(store, () => {
    for (const path of recordFiles(store)) {
      const started = startedRecord(readRecord(path));
      if (started !== undefined) {
        writeRecord(path, started);
        return started.id;
      }
    }
    return undefined;
  });
}

/** A request left started by a stopped runner becomes interrupted and is never resumed. */
export function recoverRequests(store: RequestStore): Promise<void> {
  return withRequests(store, () => {
    for (const path of recordFiles(store)) {
      const interrupted = interruptedRecord(readRecord(path));
      if (interrupted !== undefined) {
        writeRecord(path, interrupted);
      }
    }
  });
}

/** Called under departure.lock with the exact main SHA selected for this departure. */
export function validateRequest(store: RequestStore, id: string, head: string): Promise<boolean> {
  return withRequests(store, () => {
    const path = recordPath(store, id);
    const rejected = rejectedRecord(head, readRecord(path));
    if (rejected !== undefined) {
      writeRecord(path, rejected);
    }
    return rejected === undefined;
  });
}

export function finishRequest(store: RequestStore, id: string, exit: number): Promise<void> {
  return withRequests(store, () => {
    const path = recordPath(store, id);
    const finished = finishedRecord(exit, readRecord(path));
    if (finished !== undefined) {
      writeRecord(path, finished);
    }
  });
}
