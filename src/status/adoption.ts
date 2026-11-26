// Observer adoption from the runner's own start record. Every start appends `runner.started` with
// its identity token; the observer has adopted the running runner once that line is ingested and
// the coordinator CLI that ingested it is in range. Read-only, and only from bus/: no coordinator
// store, no work protocol and no registry reads. Departures, reviews and ingest never consult it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { errnoCode } from "../lib/files.ts";
import { logIdentity, readCursor, rotatedLogs } from "../state/eventlog.ts";
import { cursorRefersTo, type EventCursor, parseLine } from "../state/events.ts";
import type { BusPaths } from "../state/paths.ts";
import { coordinatorCliReport } from "../state/seam.ts";

type ObserverAdoption = "current" | "stale" | "unknown";
type ObserverAdoptionReason =
  | "runner_not_current"
  | "log_unreadable"
  | "no_runner_started"
  | "token_differs"
  | "cli_unseen"
  | "cli_out_of_range"
  | "not_ingested";

interface ObserverAdoptionReport {
  readonly status: ObserverAdoption;
  /** Null only when current. */
  readonly reason: ObserverAdoptionReason | null;
}

/** The latest `runner.started` line: its file, the byte offset after it and its token. */
interface StartRecord {
  readonly file: string;
  readonly end: number;
  readonly token: string | null;
}

/** The file's bytes; undefined when it does not exist. */
function readLog(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** The token a `runner.started` detail carries, or null when it carries none. */
function startedToken(detail: unknown): string | null {
  if (typeof detail !== "string") {
    return null;
  }
  try {
    const value = JSON.parse(detail) as unknown;
    const token =
      typeof value === "object" && value !== null ? (value as { token?: unknown }).token : null;
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    return null;
  }
}

/** The last complete `runner.started` line in one log's bytes. */
function lastStarted(file: string, bytes: Buffer): StartRecord | undefined {
  let found: StartRecord | undefined;
  let at = 0;
  for (;;) {
    const newline = bytes.indexOf(0x0a, at);
    if (newline === -1) {
      return found;
    }
    const line = bytes.toString("utf8", at, newline);
    at = newline + 1;
    // A JSON string can spell this ASCII value with Unicode escapes, so those lines still
    // need parsing even when they do not contain the literal value.
    if (!line.includes('"runner.started"') && !line.includes("\\u")) {
      continue;
    }
    const event = parseLine(line);
    if (event?.type === "runner.started") {
      found = { end: at, file, token: startedToken(event.detail) };
    }
  }
}

/**
 * The latest `runner.started` in events.jsonl, or in the newest rotated log when events.jsonl has
 * none; null when neither holds one. Throws when a log or the directory cannot be read.
 */
export function latestStart(paths: BusPaths): StartRecord | null {
  const live = readLog(paths.eventsLog);
  const inLive = live === undefined ? undefined : lastStarted(paths.eventsLog, live);
  if (inLive !== undefined) {
    return inLive;
  }
  const newest = rotatedLogs(paths.dir).at(-1);
  if (newest === undefined) {
    return null;
  }
  const path = join(paths.dir, newest);
  const rotated = readLog(path);
  return (rotated === undefined ? undefined : lastStarted(path, rotated)) ?? null;
}

/** Whether the cursor names the record's file and has consumed the record's line. */
function ingested(cursor: EventCursor | "invalid" | undefined, start: StartRecord): boolean {
  if (cursor === undefined || cursor === "invalid" || cursor.offset < start.end) {
    return false;
  }
  try {
    const identity = logIdentity(start.file);
    return identity !== undefined && cursorRefersTo(cursor, identity);
  } catch {
    return false;
  }
}

/** What adoption is decided from: the latest start record and the last seen coordinator CLI. */
interface AdoptionFacts {
  /** The token of a running runner with a current identity, or null. */
  readonly runnerToken: string | null;
  readonly start: StartRecord | null | "unreadable";
  /** Whether bus/seam.json's last seen coordinator CLI is in range; null when none was seen. */
  readonly supported: boolean | null;
  /** Whether the cursor shows the start record's line ingested. */
  readonly ingested: boolean;
}

/**
 * `current` when the latest `runner.started` carries the running runner's token, the cursor shows
 * that line ingested and the last seen coordinator CLI is in range; `stale` when its token differs
 * from the running runner's; otherwise `unknown`, with the cause as the reason.
 */
export function adoption(facts: AdoptionFacts): ObserverAdoptionReport {
  const { runnerToken, start, supported } = facts;
  if (runnerToken === null || runnerToken === "") {
    return { reason: "runner_not_current", status: "unknown" };
  }
  if (start === "unreadable") {
    return { reason: "log_unreadable", status: "unknown" };
  }
  if (start === null) {
    return { reason: "no_runner_started", status: "unknown" };
  }
  if (start.token !== runnerToken) {
    return { reason: "token_differs", status: "stale" };
  }
  if (supported === null) {
    return { reason: "cli_unseen", status: "unknown" };
  }
  if (!supported) {
    return { reason: "cli_out_of_range", status: "unknown" };
  }
  if (!facts.ingested) {
    return { reason: "not_ingested", status: "unknown" };
  }
  return { reason: null, status: "current" };
}

/** Observer adoption of the running runner, read only from bus/. */
export function observerAdoption(
  paths: BusPaths,
  runnerToken: string | null,
  supported = coordinatorCliReport(paths.seam).supported,
): ObserverAdoptionReport {
  let start: StartRecord | null | "unreadable";
  try {
    start = latestStart(paths);
  } catch {
    start = "unreadable";
  }
  return adoption({
    ingested:
      start !== null && start !== "unreadable" && ingested(readCursor(paths.eventsCursor), start),
    runnerToken,
    start,
    supported,
  });
}
