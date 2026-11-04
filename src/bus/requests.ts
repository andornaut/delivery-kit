// Durable user-authorized one-off request receipts (request.py). Callers that validate hold
// bus-queue.lock; every operation also holds requests/requests.lock.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fsyncDirectory, writeDurable } from "../durable.ts";
import { holdLockAsync } from "../lock.ts";
import { type Exec, git, gitOk } from "./exec.ts";
import { readQueue } from "./queue.ts";
import { type BusPaths, ensureDir, pyDumps } from "./state.ts";

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type RequestState = "finished" | "interrupted" | "pending" | "rejected" | "started";

export interface RequestRecord {
  id: string;
  state: RequestState;
  /** Ordered [branch, exact tip] pairs captured under the queue lock. */
  entries: [string, string][];
  reason?: string;
  departure_exit?: number;
  completion?: string;
}

export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}

export interface RequestStore {
  readonly exec: Exec;
  readonly paths: BusPaths;
  /** The game repository whose branch tips are captured. */
  readonly repo: string;
}

function recordPath(store: RequestStore, id: string): string {
  if (!REQUEST_ID_PATTERN.test(id)) {
    throw new RequestError(
      "delivery-kit: request ID must be 1-64 ASCII letters, digits, underscores or hyphens",
    );
  }
  return join(store.paths.requestsDir, `${id}.json`);
}

function writeRecord(path: string, record: RequestRecord): void {
  writeDurable(path, `${pyDumps(record)}\n`, { mode: 0o644 });
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

/** The queued branches and their exact tips; throws when a name or ref is invalid. */
export async function snapshotQueue(store: RequestStore): Promise<[string, string][]> {
  const entries: [string, string][] = [];
  for (const branch of readQueue(store.paths.queue)) {
    // Sequential: the snapshot is an ordered capture of the queue.
    // eslint-disable-next-line no-await-in-loop
    if (!(await gitOk(store.exec, store.repo, ["check-ref-format", `refs/heads/${branch}`]))) {
      throw new RequestError(`delivery-kit: invalid queued branch name ${branch}`);
    }
    // eslint-disable-next-line no-await-in-loop
    const tip = await git(store.exec, store.repo, [
      "rev-parse",
      "--verify",
      `refs/heads/${branch}^{commit}`,
    ]);
    entries.push([branch, tip]);
  }
  return entries;
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

/** Capture the queue under bus-queue.lock. Repeating an ID returns its existing receipt text. */
export async function captureRequest(store: RequestStore, id: string): Promise<string> {
  ensureDir(store.paths.dir);
  const queueLock = await holdLockAsync(store.paths.queueLock);
  try {
    return await withRequests(store, async () => {
      const path = recordPath(store, id);
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      const entries = await snapshotQueue(store);
      if (entries.length === 0) {
        throw new RequestError("delivery-kit: request requires a nonempty queue");
      }
      const record: RequestRecord = { entries, id, state: "pending" };
      writeRecord(path, record);
      return `${pyDumps(record)}\n`;
    });
  } finally {
    queueLock.release();
  }
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

/** Called under bus-queue.lock. A changed queue or tip rejects the request. */
export function validateRequest(store: RequestStore, id: string): Promise<boolean> {
  return withRequests(store, async () => {
    const path = recordPath(store, id);
    const record = readRecord(path);
    let matches: boolean;
    try {
      matches = JSON.stringify(await snapshotQueue(store)) === JSON.stringify(record.entries);
    } catch {
      matches = false;
    }
    if (!matches) {
      record.state = "rejected";
      record.reason = "queue or branch tips changed";
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

/** The pinned tip of `branch` in a request record (batch.sh pinned_tip). */
export function pinnedTip(record: RequestRecord, branch: string): string {
  const tip = new Map(record.entries).get(branch);
  if (tip === undefined) {
    throw new RequestError(`delivery-kit: request ${record.id} does not pin ${branch}`);
  }
  return tip;
}

export function loadRequest(paths: BusPaths, id: string): RequestRecord {
  return readRecord(join(paths.requestsDir, `${id}.json`));
}
