// The runner's append-only event log, bus/events.jsonl: O_APPEND single-write lines with fsync,
// at most once per (type, key), rotation after ingest and torn-tail repair at startup. The runner
// process is the only writer. A failed append is logged and never stops a departure. The schema
// is src/events.ts.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  type Stats,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { fsyncDirectory } from "@andornaut/coordination-kit/build/shared";

import {
  cleanDetail,
  completesDeploy,
  cursorRefersTo,
  EVENT_TYPES,
  type EventCursor,
  eventId,
  EVENTS_FILE,
  type EventType,
  formatLine,
  isoSeconds,
  LINE_LIMIT,
  type LogIdentity,
  makeEvent,
  parseCursor,
  parseLine,
  ROTATE_BYTES,
  ROTATED_FILE,
  type RunnerEvent,
  WORK_FILE,
  workStatus,
} from "../events.ts";
import { type BusPaths, readText, readTrimmed, writeLines } from "./state.ts";

const SHA40 = /^[0-9a-f]{40}$/u;
const GIT_TIMEOUT_MS = 10_000;

export interface EventLogOptions {
  readonly paths: BusPaths;
  readonly game: string;
  /** The game checkout, for the work range. */
  readonly repo: string;
  /** Epoch seconds. */
  readonly now: () => number;
  /** One runner log line. */
  readonly log: (line: string) => void;
}

interface CommitProgress {
  push: boolean;
  ci: boolean;
  deploy: boolean;
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch (error) {
    if (errno(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Read `length` bytes at `position`. */
function readAt(path: string, position: number, length: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** The bytes after the last newline of a non-empty file, or undefined when it ends in one. */
export function tornTail(path: string): Buffer | undefined {
  const size = sizeOf(path);
  if (size === undefined || size === 0) {
    return undefined;
  }
  const window = Math.min(size, LINE_LIMIT * 2);
  const tail = readAt(path, size - window, window);
  if (tail.at(-1) === 0x0a) {
    return undefined;
  }
  const newline = tail.lastIndexOf(0x0a);
  return tail.subarray(newline + 1);
}

/** The cursor, undefined when absent, "invalid" when present but unusable. */
export function readCursor(path: string): EventCursor | "invalid" | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return errno(error) === "ENOENT" ? undefined : "invalid";
  }
  return parseCursor(text) ?? "invalid";
}

/** The ID of the file's first complete line, null when it has none, undefined when absent. */
export function firstLineId(path: string): string | null | undefined {
  let head: Buffer;
  try {
    head = readAt(path, 0, LINE_LIMIT);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const end = head.indexOf(0x0a);
  return end === -1 ? null : (parseLine(head.subarray(0, end).toString("utf8"))?.id ?? null);
}

/** The identity a cursor names a log by, or undefined when the file does not exist. */
export function logIdentity(path: string): LogIdentity | undefined {
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return { dev: stat.dev, firstId: firstLineId(path) ?? null, inode: stat.ino };
}

/** Which file the cursor refers to: the live log, a rotated one still present, or neither. */
export function cursorTarget(
  context: {
    readonly dir: string;
    readonly live: LogIdentity | undefined;
    readonly rotated: readonly string[];
  },
  cursor: EventCursor,
): "live" | "rotated" | "unmatched" {
  if (context.live !== undefined && cursorRefersTo(cursor, context.live)) {
    return "live";
  }
  const rotated = context.rotated.some((name) => {
    try {
      const identity = logIdentity(join(context.dir, name));
      return identity !== undefined && cursorRefersTo(cursor, identity);
    } catch {
      return false;
    }
  });
  return rotated ? "rotated" : "unmatched";
}

/** Rotated logs awaiting ingest, oldest first. */
export function rotatedLogs(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => ROTATED_FILE.test(name))
    .sort((a, b) => Number(ROTATED_FILE.exec(a)?.[1]) - Number(ROTATED_FILE.exec(b)?.[1]));
}

function git(repo: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
  return result.status === 0 ? result.stdout : undefined;
}

/**
 * The work IDs whose docs/work/<id>.md front matter is `status: done` at `sha` but was not at
 * `base`, sorted; null when either commit or the diff is unavailable.
 */
export function workDone(repo: string, base: string, sha: string): string[] | null {
  const diff = git(repo, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    base,
    sha,
    "--",
    "docs/work/",
  ]);
  if (diff === undefined) {
    return null;
  }
  const done: string[] = [];
  for (const path of diff.split("\0").filter(Boolean)) {
    const id = WORK_FILE.exec(path)?.[1];
    if (id === undefined) {
      continue;
    }
    const after = git(repo, ["show", `${sha}:${path}`]);
    if (after === undefined || workStatus(after) !== "done") {
      continue;
    }
    const before = git(repo, ["show", `${base}:${path}`]);
    if (before === undefined || workStatus(before) !== "done") {
      done.push(id);
    }
  }
  return done.sort();
}

/** The runner's event log writer. */
export class EventLog {
  readonly #options: EventLogOptions;
  readonly #ids = new Set<string>();
  readonly #commits = new Map<string, CommitProgress>();
  #opened = false;
  /** Check the tail before the next append: at startup and after a failed append. */
  #tailSuspect = true;
  #lastComplete: string | undefined;

  constructor(options: EventLogOptions) {
    this.#options = options;
  }

  #fail(message: string): void {
    const line = `bus: ${message}; operator review required`;
    this.#options.log(line);
    process.stderr.write(`${line}\n`);
  }

  /**
   * Prepare the log at runner start, before any append: terminate a torn last line, rebuild the
   * dedupe set and commit progress from the unrotated log.
   */
  open(): void {
    if (this.#opened) {
      return;
    }
    const { paths } = this.#options;
    this.#lastComplete = readTrimmed(paths.lastCompleteSha) || undefined;
    try {
      this.#repairTail();
      const text = readText(paths.eventsLog) ?? "";
      let rebuilt: string | undefined;
      for (const line of text.split("\n").slice(0, -1)) {
        const event = parseLine(line);
        if (event !== undefined) {
          this.#ids.add(event.id);
          rebuilt = this.#fold(event) ?? rebuilt;
        }
      }
      if (rebuilt !== undefined && rebuilt !== this.#lastComplete) {
        this.#recordComplete(rebuilt);
      }
    } catch (error) {
      this.#fail(`events.jsonl not read at startup (${String(error)})`);
    }
    this.#opened = true;
  }

  /**
   * A last line without its newline can only come from a writer that stopped mid-append: the
   * runner holds runner.lock, so nothing else will finish it. Terminate it with a newline so the
   * next append starts a line of its own. A fragment that is valid JSON is the whole event minus
   * its newline and becomes a normal line; any other fragment becomes a malformed line that
   * ingest quarantines. Leaving it would merge the next event into it.
   */
  #repairTail(): void {
    const { eventsLog } = this.#options.paths;
    const fragment = tornTail(eventsLog);
    if (fragment !== undefined) {
      this.#write("\n");
      const event = parseLine(fragment.toString("utf8"));
      this.#options.log(
        event === undefined
          ? "bus: terminated a torn last line in events.jsonl; ingest quarantines it"
          : `bus: completed the torn last line of events.jsonl (${event.type} ${event.key})`,
      );
    }
    this.#tailSuspect = false;
  }

  /** One write() under O_APPEND, then fsync; a new file also syncs its directory. */
  #write(text: string): void {
    const { dir, eventsLog } = this.#options.paths;
    const created = !existsSync(eventsLog);
    const bytes = Buffer.from(text, "utf8");
    const fd = openSync(
      eventsLog,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
      0o644,
    );
    try {
      const written = writeSync(fd, bytes);
      if (written !== bytes.length) {
        throw new Error(`short write: ${written} of ${bytes.length} bytes`);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (created) {
      fsyncDirectory(dir);
    }
  }

  /** Rename a fully ingested log above ROTATE_BYTES to events.<epoch>.jsonl. */
  #rotate(): void {
    const { dir, eventsCursor, eventsLog } = this.#options.paths;
    const size = sizeOf(eventsLog);
    if (size === undefined || size <= ROTATE_BYTES) {
      return;
    }
    const cursor = readCursor(eventsCursor);
    if (cursor === undefined || cursor === "invalid" || cursor.offset !== size) {
      return;
    }
    // The offset counts only for the file the cursor names.
    const live = logIdentity(eventsLog);
    if (live === undefined || !cursorRefersTo(cursor, live)) {
      return;
    }
    const name = `events.${this.#options.now()}.jsonl`;
    if (existsSync(join(dir, name))) {
      return;
    }
    renameSync(eventsLog, join(dir, name));
    fsyncDirectory(dir);
    this.#options.log(`bus: rotated ${EVENTS_FILE} (${size} bytes, ingested) to ${name}`);
  }

  /** Fold one event into commit progress; the SHA when it completes a commit. */
  #fold(event: RunnerEvent): string | undefined {
    const { sha, status } = event;
    if (sha === null || status === null) {
      return undefined;
    }
    const progress = this.#commits.get(sha) ?? { ci: false, deploy: false, push: false };
    if (event.kind === "push") {
      progress.push = status === "ok";
    } else if (event.kind === "ci") {
      progress.ci = status === "ok";
    } else if (event.kind === "deploy") {
      progress.deploy = status === "ok" || status === "skipped";
    } else {
      return undefined;
    }
    this.#commits.set(sha, progress);
    return progress.push && progress.ci && progress.deploy ? sha : undefined;
  }

  #recordComplete(sha: string): void {
    this.#lastComplete = sha;
    try {
      writeLines(this.#options.paths.lastCompleteSha, sha);
    } catch (error) {
      this.#fail(`last-complete.sha not written (${String(error)})`);
    }
  }

  #append(event: RunnerEvent): void {
    this.#rotate();
    if (this.#tailSuspect) {
      this.#repairTail();
    }
    this.#write(formatLine(event));
    this.#ids.add(event.id);
    const completed = this.#fold(event);
    if (completed !== undefined && completed !== this.#lastComplete) {
      this.#recordComplete(completed);
    }
  }

  #at(): string {
    return isoSeconds(this.#options.now() * 1000);
  }

  /** The work range of a deploy event that can complete `sha`: null when the base is unknown. */
  #work(type: EventType, sha: string | null): string[] | null {
    if (!completesDeploy(EVENT_TYPES[type]) || sha === null || this.#lastComplete === undefined) {
      return null;
    }
    return workDone(this.#options.repo, this.#lastComplete, sha);
  }

  /** Append one event at most once per (type, key); false when it was a duplicate or failed. */
  append(
    type: EventType,
    key: string,
    detail: string,
    sha = SHA40.test(key) ? key : null,
  ): boolean {
    try {
      this.open();
      const { game } = this.#options;
      if (this.#ids.has(eventId(game, type, key))) {
        return false;
      }
      const event = makeEvent(
        { at: this.#at(), detail: cleanDetail(detail), game, sha, work: this.#work(type, sha) },
        type,
        key,
      );
      this.#append(event);
      return true;
    } catch (error) {
      this.#tailSuspect = true;
      this.#fail(`event ${type} ${key} not appended to ${EVENTS_FILE} (${String(error)})`);
      return false;
    }
  }
}

/** The read-only `events` status field. */
export interface EventLogReport {
  readonly file: string;
  /** Bytes in events.jsonl; 0 when it does not exist, null when unreadable. */
  readonly size: number | null;
  /** The cursor's offset in the file it names; null when absent or invalid. */
  readonly cursorOffset: number | null;
  /** Rotated logs awaiting ingest, oldest first. */
  readonly rotated: string[];
  /** The last line has no newline yet. */
  readonly torn: boolean;
  /**
   * The cursor names the live log and has consumed every complete line, no rotated log remains
   * and the last line is complete.
   */
  readonly drained: boolean;
}

/** The `events` status field and its reporter blockers, reading only bus/. */
export function eventLogReport(paths: BusPaths): {
  readonly report: EventLogReport;
  readonly blockers: string[];
} {
  const blockers: string[] = [];
  let size: number | null;
  let torn = false;
  let live: LogIdentity | undefined;
  try {
    size = sizeOf(paths.eventsLog) ?? 0;
    torn = tornTail(paths.eventsLog) !== undefined;
    live = logIdentity(paths.eventsLog);
  } catch {
    size = null;
    blockers.push("events_unreadable");
  }
  let rotated: string[] = [];
  try {
    rotated = rotatedLogs(paths.dir);
  } catch {
    blockers.push("events_dir_unreadable");
  }
  const cursor = readCursor(paths.eventsCursor);
  if (cursor === "invalid") {
    blockers.push("events_cursor_invalid");
  }
  const valid = cursor === undefined || cursor === "invalid" ? undefined : cursor;
  const target = valid && cursorTarget({ dir: paths.dir, live, rotated }, valid);
  if (size !== null && live !== undefined && cursor !== "invalid") {
    // Only a cursor that names the live log counts toward it.
    const consumed = target === "live" ? (valid?.offset ?? 0) : 0;
    if (consumed < size) {
      blockers.push(`events_uningested:${size - consumed}`);
    } else if (consumed > size) {
      blockers.push("events_cursor_ahead");
    }
  }
  if (target === "rotated") {
    blockers.push("events_cursor_rotated");
  } else if (target === "unmatched" && live !== undefined) {
    blockers.push("events_cursor_unmatched");
  }
  if (rotated.length > 0) {
    blockers.push(`events_rotated:${rotated.length}`);
  }
  if (torn) {
    blockers.push("events_torn");
  }
  return {
    blockers,
    report: {
      cursorOffset: valid?.offset ?? null,
      drained: blockers.length === 0,
      file: paths.eventsLog,
      rotated,
      size,
      torn,
    },
  };
}
