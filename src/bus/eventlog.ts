// The runner's append-only event log, bus/events.jsonl: O_APPEND single-write lines with fsync,
// at most once per (type, key), rotation after ingest, torn-tail repair at startup and the one-time
// import of the 6.0 outbox. The runner process is the only writer. A failed append is logged and
// never stops a departure. The schema is src/events.ts.
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
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { fsyncDirectory } from "@andornaut/coordination-kit/build/shared";

import {
  cleanDetail,
  completesDeploy,
  type EventCursor,
  eventId,
  EVENTS_FILE,
  type EventType,
  familyOf,
  formatLine,
  IMPORTED_PREFIX,
  isoSeconds,
  LINE_LIMIT,
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

/** One legacy outbox event in creation order. */
interface LegacyEvent {
  readonly created: bigint;
  readonly name: string;
  readonly kind: string;
  readonly key: string;
  readonly message: string;
}

function legacyEvent(directory: string, name: string): LegacyEvent | null | undefined {
  const text = readFileSync(join(directory, name), "utf8");
  const value = JSON.parse(text) as Record<string, unknown>;
  if (value.sent === true || value.suppressed === true) {
    return undefined;
  }
  const { key, kind, message } = value;
  if (typeof kind !== "string" || typeof key !== "string" || typeof message !== "string") {
    return null;
  }
  const created = /"created":\s*(-?\d+)\b/u.exec(text)?.[1];
  return { created: BigInt(created ?? 0), key, kind, message, name };
}

/** The legacy `<sha>.state` that completed most recently, by modification time. */
function legacyComplete(directory: string, names: readonly string[]): string | undefined {
  let best: { sha: string; at: number } | undefined;
  for (const name of names) {
    const sha = name.slice(0, -".state".length);
    if (!name.endsWith(".state") || !SHA40.test(sha)) {
      continue;
    }
    try {
      const path = join(directory, name);
      const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const complete =
        state.pushed === true &&
        state.ci === "success" &&
        (state.deploy === "success" || state.deploy === "skipped");
      const at = statSync(path).mtimeMs;
      if (complete && (best === undefined || at > best.at)) {
        best = { at, sha };
      }
    } catch {
      // An unreadable state file names no completion.
    }
  }
  return best?.sha;
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
   * dedupe set and commit progress from the unrotated log, then import the 6.0 outbox. Failures
   * are logged; the runner starts either way.
   */
  open(): void {
    this.#ensureOpen();
    try {
      this.#importLegacy();
    } catch (error) {
      this.#tailSuspect = true;
      this.#fail(
        `legacy event outbox not imported (${String(error)}); it is retried at the next start`,
      );
    }
  }

  #ensureOpen(): void {
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
  #work(type: string, sha: string | null): string[] | null {
    if (!completesDeploy(familyOf(type)) || sha === null || this.#lastComplete === undefined) {
      return null;
    }
    return workDone(this.#options.repo, this.#lastComplete, sha);
  }

  /** Append one event at most once per (type, key); false when it was a duplicate or failed. */
  append(type: EventType, key: string, detail: string): boolean {
    try {
      this.#ensureOpen();
      const { game } = this.#options;
      const sha = SHA40.test(key) ? key : null;
      if (this.#ids.has(eventId(game, type, key))) {
        return false;
      }
      const event = makeEvent(
        { at: this.#at(), detail: cleanDetail(detail), game, work: this.#work(type, sha) },
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

  /**
   * Append the 6.0 outbox's unsent events in creation order, keeping each kind as `type`, then
   * rename bus/events to events.imported-<epoch>. Duplicates by ID are skipped, so an interrupted
   * import repeats safely; `<sha>.state` files stay in the renamed directory.
   */
  #importLegacy(): void {
    const { dir, legacyOutbox } = this.#options.paths;
    let names: string[];
    try {
      names = readdirSync(legacyOutbox).sort();
    } catch (error) {
      if (errno(error) === "ENOENT") {
        return;
      }
      throw error;
    }
    const events: LegacyEvent[] = [];
    let unreadable = 0;
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      try {
        const event = legacyEvent(legacyOutbox, name);
        if (event === null) {
          unreadable += 1;
        } else if (event !== undefined) {
          events.push(event);
        }
      } catch {
        unreadable += 1;
      }
    }
    events.sort((a, b) =>
      a.created === b.created ? (a.name < b.name ? -1 : 1) : a.created < b.created ? -1 : 1,
    );
    let imported = 0;
    const { game } = this.#options;
    for (const legacy of events) {
      const event = makeEvent(
        {
          at: isoSeconds(Number(legacy.created / 1_000_000n)),
          detail: cleanDetail(legacy.message),
          game,
        },
        legacy.kind,
        legacy.key,
      );
      if (!this.#ids.has(event.id)) {
        this.#append(event);
        imported += 1;
      }
    }
    if (this.#lastComplete === undefined) {
      const seed = legacyComplete(legacyOutbox, names);
      if (seed !== undefined) {
        this.#recordComplete(seed);
      }
    }
    let epoch = this.#options.now();
    while (existsSync(join(dir, `${IMPORTED_PREFIX}${epoch}`))) {
      epoch += 1;
    }
    const target = `${IMPORTED_PREFIX}${epoch}`;
    renameSync(legacyOutbox, join(dir, target));
    fsyncDirectory(dir);
    this.#options.log(
      `bus: imported ${imported} unsent legacy outbox events into ${EVENTS_FILE}; bus/events is now ` +
        `${target}${unreadable > 0 ? ` (${unreadable} unreadable, kept there)` : ""}`,
    );
  }
}

/** The read-only `events` status field. */
export interface EventLogReport {
  readonly file: string;
  /** Bytes in events.jsonl; 0 when it does not exist, null when unreadable. */
  readonly size: number | null;
  /** The cursor's offset; null when absent or invalid. */
  readonly cursorOffset: number | null;
  /** Rotated logs awaiting ingest, oldest first. */
  readonly rotated: string[];
  /** The last line has no newline yet. */
  readonly torn: boolean;
  /** Ingest has consumed every complete line and no rotated log remains. */
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
  try {
    size = sizeOf(paths.eventsLog) ?? 0;
    torn = tornTail(paths.eventsLog) !== undefined;
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
  const offset = cursor === undefined || cursor === "invalid" ? null : cursor.offset;
  if (size !== null && cursor !== "invalid") {
    const consumed = offset ?? 0;
    if (consumed < size) {
      blockers.push(`events_uningested:${size - consumed}`);
    } else if (consumed > size && rotated.length === 0) {
      blockers.push("events_cursor_ahead");
    }
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
      cursorOffset: offset,
      drained: blockers.length === 0,
      file: paths.eventsLog,
      rotated,
      size,
      torn,
    },
  };
}
