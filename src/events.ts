// The runner event log schema (coordination-kit 2.0): one JSON object per line in
// var/games/<g>/bus/events.jsonl, the ingest cursor in bus/events.cursor, and the table that maps
// every event type the runner appends to its family and status. The runner is the only writer of
// the log; coordination-kit's `events ingest` is the only writer of the cursor. Every schema detail
// lives here so a contract change touches one module.
import { createHash } from "node:crypto";

export const EVENT_SCHEMA = 1;
export const EVENTS_FILE = "events.jsonl";
export const CURSOR_FILE = "events.cursor";
export const QUARANTINE_FILE = "events.quarantine.jsonl";
/** The legacy 6.0 outbox directory is renamed to this prefix plus epoch seconds when imported. */
export const IMPORTED_PREFIX = "events.imported-";
/** Each line, its newline included, is one write() of fewer than this many bytes. */
export const LINE_LIMIT = 4096;
/** The runner rotates a fully ingested log larger than this. */
export const ROTATE_BYTES = 1024 * 1024;
/** A rotated log: `events.<epoch seconds>.jsonl`. Ingest deletes it; the runner never does. */
export const ROTATED_FILE = /^events\.(\d+)\.jsonl$/u;
export const TRUNCATED = " [truncated]";

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export type EventKind = "attempt" | "ci" | "deploy" | "gate" | "push" | "runner";
export type EventStatus = "blocked" | "failed" | "ok" | "skipped" | "timeout";

export interface EventFamily {
  readonly kind: EventKind;
  readonly status: EventStatus | null;
}

/** The departure stage a `blocked-<stage>` event names. */
export type BlockedStage = "fetch" | "full-gate" | "gate" | "install" | "load" | "main" | "push";

/**
 * Every event type the runner appends, with its family and status. `blocked-full-gate` and
 * `blocked-install` are failed gates (the SHA is never gated again); `blocked-gate` is a gate that
 * could not run. A null status is progress or a notice, not an outcome.
 */
export const EVENT_TYPES = {
  attempt: { kind: "attempt", status: null },
  "blocked-fetch": { kind: "attempt", status: "blocked" },
  "blocked-full-gate": { kind: "gate", status: "failed" },
  "blocked-gate": { kind: "gate", status: "blocked" },
  "blocked-install": { kind: "gate", status: "failed" },
  "blocked-load": { kind: "attempt", status: "blocked" },
  "blocked-main": { kind: "attempt", status: "blocked" },
  "blocked-push": { kind: "push", status: "blocked" },
  ci_auth_failed: { kind: "ci", status: "blocked" },
  ci_failure: { kind: "ci", status: "failed" },
  ci_pending: { kind: "ci", status: null },
  ci_success: { kind: "ci", status: "ok" },
  ci_timeout: { kind: "ci", status: "timeout" },
  deploy_disabled: { kind: "deploy", status: "skipped" },
  deploy_failure: { kind: "deploy", status: "failed" },
  deploy_retry: { kind: "deploy", status: null },
  deploy_skipped: { kind: "deploy", status: "skipped" },
  deploy_success: { kind: "deploy", status: "ok" },
  gate_passed: { kind: "gate", status: "ok" },
  gate_skipped: { kind: "gate", status: "skipped" },
  "pin-mismatch": { kind: "runner", status: null },
  push: { kind: "push", status: "ok" },
  "runner.started": { kind: "runner", status: null },
  "scheduled-status": { kind: "runner", status: null },
} as const satisfies Record<`blocked-${BlockedStage}` | (string & {}), EventFamily>;

export type EventType = keyof typeof EVENT_TYPES;

/**
 * 6.x kinds the runner no longer appends; migration keeps them as `type`. `runner.started`, appended
 * on every start, replaces `resident-identity-changed`.
 */
const LEGACY_TYPES: Readonly<Record<string, EventFamily>> = {
  complete: { kind: "runner", status: "ok" },
  "resident-identity-changed": { kind: "runner", status: null },
};

/** The family of any type: a current one, a legacy outbox kind, or an unknown legacy kind. */
export function familyOf(type: string): EventFamily {
  if (Object.hasOwn(EVENT_TYPES, type)) {
    return EVENT_TYPES[type as EventType];
  }
  if (Object.hasOwn(LEGACY_TYPES, type)) {
    return LEGACY_TYPES[type] as EventFamily;
  }
  return type.startsWith("blocked-")
    ? { kind: "attempt", status: "blocked" }
    : { kind: "runner", status: null };
}

/** A deploy event that can complete its commit carries the `work` array. */
export function completesDeploy(family: EventFamily): boolean {
  return family.kind === "deploy" && (family.status === "ok" || family.status === "skipped");
}

/** At most one event per (game, type, key). */
export function eventId(game: string, type: string, key: string): string {
  return createHash("sha256").update(`${game}\n${type}\n${key}`, "utf8").digest("hex");
}

export interface RunnerEvent {
  readonly schema: typeof EVENT_SCHEMA;
  readonly id: string;
  readonly game: string;
  readonly kind: EventKind;
  readonly type: string;
  readonly key: string;
  readonly at: string;
  readonly sha: string | null;
  readonly status: EventStatus | null;
  readonly detail: string;
  readonly work: readonly string[] | null;
}

/** ISO 8601 UTC to the second. */
export function isoSeconds(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/** Build an event; `sha` is the key when the key is a commit SHA. */
export function makeEvent(
  fields: {
    readonly game: string;
    readonly at: string;
    readonly detail: string;
    readonly work?: readonly string[] | null;
  },
  type: string,
  key: string,
): RunnerEvent {
  const family = familyOf(type);
  // The line's field order follows the contract's listing.
  /* eslint-disable sort-keys */
  return {
    schema: EVENT_SCHEMA,
    id: eventId(fields.game, type, key),
    game: fields.game,
    kind: family.kind,
    type,
    key,
    at: fields.at,
    sha: SHA40.test(key) ? key : null,
    status: family.status,
    detail: fields.detail,
    work: fields.work ?? null,
  };
  /* eslint-enable sort-keys */
}

/** Control characters, including newlines, become spaces. */
export function cleanDetail(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/gu, " ");
}

function serialize(event: RunnerEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * The event as one newline-terminated line under LINE_LIMIT bytes. A detail that does not fit is
 * cut at a character boundary and marked with TRUNCATED; the other fields are never cut.
 */
export function formatLine(event: RunnerEvent): string {
  const line = serialize(event);
  if (Buffer.byteLength(line, "utf8") < LINE_LIMIT) {
    return line;
  }
  const characters = Array.from(event.detail);
  const fits = (count: number): string | undefined => {
    const detail = `${characters.slice(0, count).join("")}${TRUNCATED}`;
    const candidate = serialize({ ...event, detail });
    return Buffer.byteLength(candidate, "utf8") < LINE_LIMIT ? candidate : undefined;
  };
  if (fits(0) === undefined) {
    throw new Error(`event ${event.type} ${event.key} exceeds ${LINE_LIMIT} bytes without detail`);
  }
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle) === undefined) {
      high = middle - 1;
    } else {
      low = middle;
    }
  }
  return fits(low) as string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One complete line (without its newline) as an event, or undefined when it is not one. */
export function parseLine(text: string): RunnerEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.schema !== EVENT_SCHEMA ||
    typeof value.id !== "string" ||
    !SHA256.test(value.id) ||
    typeof value.game !== "string" ||
    typeof value.type !== "string" ||
    typeof value.key !== "string"
  ) {
    return undefined;
  }
  return value as unknown as RunnerEvent;
}

/** bus/events.cursor, written atomically by `events ingest` and read-only for the runner. */
export interface EventCursor {
  readonly schema: typeof EVENT_SCHEMA;
  readonly file: typeof EVENTS_FILE;
  /** Bytes of the cursor's file ingest has consumed; always at a line boundary. */
  readonly offset: number;
  readonly lines: number;
  readonly lastId: string | null;
  /** The ID of the file's first line; null for a file without one, matched by inode and dev. */
  readonly firstId: string | null;
  readonly inode: number;
  readonly dev: number;
  readonly at: string;
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function idOrNull(value: unknown): boolean {
  return value === null || (typeof value === "string" && SHA256.test(value));
}

/** The cursor, or undefined when the text is not a valid cursor. */
export function parseCursor(text: string): EventCursor | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.schema !== EVENT_SCHEMA ||
    value.file !== EVENTS_FILE ||
    !count(value.offset) ||
    !count(value.lines) ||
    !idOrNull(value.lastId) ||
    !idOrNull(value.firstId) ||
    !count(value.inode) ||
    !count(value.dev) ||
    typeof value.at !== "string"
  ) {
    return undefined;
  }
  return value as unknown as EventCursor;
}

/** A log file's identity as the cursor names it. */
export interface LogIdentity {
  readonly firstId: string | null;
  readonly inode: number;
  readonly dev: number;
}

/**
 * Whether the cursor refers to the file with `identity`: the same first line ID, or, for a file
 * without one, the same inode and device.
 */
export function cursorRefersTo(cursor: EventCursor, identity: LogIdentity): boolean {
  if (cursor.firstId !== null) {
    return cursor.firstId === identity.firstId;
  }
  return (
    identity.firstId === null && cursor.inode === identity.inode && cursor.dev === identity.dev
  );
}

/** The `runner.started` detail, a JSON string. */
export interface RunnerStarted {
  readonly token: string | null;
  readonly deliveryKitVersion: string;
  readonly cliSha256: string | null;
  /** The coordinator-installed coordination-kit CLI, from the startup probe; null when unknown. */
  readonly coordinationKitVersion: string | null;
  readonly distSha256: string | null;
}

export function startedDetail(started: RunnerStarted): string {
  return JSON.stringify({
    cliSha256: started.cliSha256,
    coordinationKitVersion: started.coordinationKitVersion,
    deliveryKitVersion: started.deliveryKitVersion,
    distSha256: started.distSha256,
    token: started.token,
  });
}

/** A work file under docs/work/: `docs/work/<id>.md`. */
export const WORK_FILE = /^docs\/work\/([a-z][a-z0-9]*-\d+)\.md$/u;

/** The front matter `status` of a work file, or undefined when it has none. */
export function workStatus(text: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  const status = match?.[1]?.match(/^status:[ \t]*(.*?)[ \t]*$/mu)?.[1];
  return status?.replace(/^(["'])(.*)\1$/u, "$2");
}
