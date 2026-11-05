// Durable operator-authorized one-off request receipts. A request departs the local main HEAD
// it captured, under the same rules as a scheduled departure; it never admits queue entries.
// Every operation holds requests/requests.lock.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { dumpsJson } from "../adapters/shared/pyjson.ts";
import { fsyncDirectory, writeDurable } from "../durable.ts";
import { holdLockAsync } from "../lock.ts";
import type { Exec } from "./exec.ts";
import { type BusPaths, ensureDir } from "./state.ts";
import { mainHead, skipReason } from "./trunk.ts";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type RequestState = "finished" | "interrupted" | "pending" | "rejected" | "started";

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

/** Mark the first pending request started and return its ID. */
export function claimRequest(store: RequestStore): Promise<string | undefined> {
  return withRequests(store, () => {
    for (const path of recordFiles(store)) {
      const record = readRecord(path);
      if (record.state === "pending") {
        record.state = "started";
        writeRecord(path, record);
        return record.id;
      }
    }
    return undefined;
  });
}

/** A request left started by a stopped runner becomes interrupted and is never resumed. */
export function recoverRequests(store: RequestStore): Promise<void> {
  return withRequests(store, () => {
    for (const path of recordFiles(store)) {
      const record = readRecord(path);
      if (record.state === "started") {
        record.state = "interrupted";
        writeRecord(path, record);
      }
    }
  });
}

/** Called under departure.lock. A main HEAD that moved since capture rejects the request. */
export function validateRequest(store: RequestStore, id: string): Promise<boolean> {
  return withRequests(store, async () => {
    const path = recordPath(store, id);
    const record = readRecord(path);
    let matches: boolean;
    try {
      matches = (await mainHead(store.exec, store.repo, store.main)) === record.head;
    } catch {
      matches = false;
    }
    if (!matches) {
      record.state = "rejected";
      record.reason = "main moved since the request";
      writeRecord(path, record);
    }
    return matches;
  });
}

export function finishRequest(store: RequestStore, id: string, exit: number): Promise<void> {
  return withRequests(store, () => {
    const path = recordPath(store, id);
    const record = readRecord(path);
    if (record.state === "started") {
      Object.assign(record, {
        completion: "departure flow only; consult exact-commit CI and deployment state",
        departure_exit: exit,
        state: "finished",
      });
      writeRecord(path, record);
    }
  });
}
