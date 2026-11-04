// Bounded read-only question references and exact owner-attested pending proof
// (question_state.py).
//
// Rendered questions expose title/options only. Tool arguments and outputs remain opaque. History
// cannot establish exact unresolved requests, cancellation or UI visibility. This collector never
// clears guards, answers or reissues questions.
import { performance } from "node:perf_hooks";

import { NATIVE_ITEM_TYPES } from "../guard.ts";
import { isCanonicalUuid, isRecord, sameJson } from "../json.ts";
import { NativeTimeout, type RpcClient } from "../rpc.ts";

const MAX_CALLS = 256;
const PAGE_SIZE = 100;
const MAX_QUESTIONS = 100;
const MAX_TITLE_BYTES = 4096;
const MAX_OPTIONS = 32;
const MAX_QUESTION_BYTES = 16384;
/** Exact normalized names, unlike the substring match of guard.ts questionItem(). */
const QUESTION_TOOLS: ReadonlySet<string> = new Set([
  "askuserquestion",
  "elicitation",
  "requestuserinput",
  "requestuserinputasync",
]);
const RESOLUTION_FIELDS = [
  "question_turn_id",
  "question_item_id",
  "answer_turn_id",
  "answer_item_id",
] as const;
const PAGE_DIAGNOSTICS: ReadonlySet<string> = new Set([
  "duplicate_item",
  "incomplete_page",
  "item_recipient_or_turn_mismatch",
  "item_schema_unavailable",
  "malformed_page",
  "page_bound_exceeded",
  "pagination_invalid",
]);

export interface QuestionStateOptions {
  /** Shared native call budget; defaults to 256. */
  readonly maxCalls?: number;
  /** Clock compared with `client.deadline`, a performance.now() value as rpc.ts sets it. */
  readonly monotonic?: () => number;
  /** Wall-clock seconds since the epoch, for attestation freshness. */
  readonly time?: () => number;
}

interface Clock {
  readonly maxCalls: number;
  readonly monotonic: () => number;
  readonly time: () => number;
}

type QuestionRow = {
  item_id: string;
  kind: "question_tool" | "rendered_prompt";
  options: string[] | null;
  proof_complete?: boolean;
  proof_refs: Record<string, unknown>[];
  proof_scope?: string;
  question_index: number | null;
  state: string;
  title: string | null;
  turn_id: string;
};

type Capture = {
  complete: boolean;
  diagnostics: string[];
  omitted_questions: number;
  questions: QuestionRow[];
  status: string;
};

type HistoryResult = Capture & {
  budget?: Record<string, unknown>;
  cancelled_status: string;
  latest_turn_proof?: Record<string, unknown>;
  pending_status: string;
  ui_visibility: string;
};

/** Native order of one (turn, item) identity; positions count from the newest item. */
interface Position {
  readonly kind: string;
  readonly position: number;
  readonly turnId: string;
}

type Positions = Map<string, Position>;

/** (question turn, latest turn updatedAt, activeFlags), as _pending_context() returns it. */
type PendingContext = readonly [turnId: string, updatedAt: number, activeFlags: unknown[]];

interface Attestation {
  readonly confirmed_at: string;
  readonly options: string[] | null;
  readonly question_index: number;
  readonly question_item_id: string;
  readonly question_turn_id: string;
  readonly title: string;
}

type Resolution = Readonly<Record<(typeof RESOLUTION_FIELDS)[number], string>>;

type Records = Readonly<Record<string, Record<string, unknown> | null>>;

class BudgetExhausted extends Error {}

/** A locally selected page diagnostic; any other failure reports native_history_unavailable. */
class PageError extends Error {}

class Reader {
  calls = 0;
  reason: string | null = null;
  readonly client: RpcClient;
  readonly clock: Clock;

  constructor(clock: Clock, client: RpcClient) {
    this.clock = clock;
    this.client = client;
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const deadline = "deadline" in this.client ? this.client.deadline : undefined;
    if (
      typeof deadline === "number" &&
      Number.isFinite(deadline) &&
      this.clock.monotonic() >= deadline
    ) {
      this.reason = "native_deadline_exhausted";
    }
    if (this.calls >= this.clock.maxCalls && this.reason === null) {
      this.reason = "native_call_budget_exhausted";
    }
    if (this.reason !== null) {
      throw new BudgetExhausted();
    }
    this.calls += 1;
    try {
      return await this.client.call(method, params);
    } catch (error) {
      if (error instanceof NativeTimeout) {
        this.timedOut();
        throw new BudgetExhausted();
      }
      throw error;
    }
  }

  timedOut(): void {
    this.reason = "native_timeout";
  }

  metadata(): Record<string, unknown> {
    return {
      calls_used: this.calls,
      exhausted: this.reason !== null,
      max_calls: this.clock.maxCalls,
      reason_code: this.reason,
    };
  }
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** Python truthiness of a parsed JSON value. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && (value as unknown[]).every((option) => typeof option === "string");
}

function sameOptions(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.length === right.length && left.every((option, index) => option === right[index]);
}

function identityKey(turnId: string, itemId: string): string {
  return JSON.stringify([turnId, itemId]);
}

function questionKey(turnId: string, itemId: string, index: number | null): string {
  return JSON.stringify([turnId, itemId, index]);
}

function own(record: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return Object.hasOwn(record, key) ? record[key] : fallback;
}

function recordFor(records: Records, recipient: string): unknown {
  return isRecord(records) && Object.hasOwn(records, recipient) ? records[recipient] : undefined;
}

function resolutionsFor(records: Records, recipient: string): Resolution[] | null {
  const record = recordFor(records, recipient);
  if (
    !isRecord(record) ||
    record.thread_id !== recipient ||
    (record.state !== "clear" && record.state !== "pending")
  ) {
    return null;
  }
  const resolutions = own(record, "resolutions", []);
  if (!Array.isArray(resolutions)) {
    return null;
  }
  const seen = new Set<string>();
  for (const resolution of resolutions as unknown[]) {
    if (
      !isRecord(resolution) ||
      !RESOLUTION_FIELDS.every((field) => identifier(resolution[field]))
    ) {
      return null;
    }
    const identity = identityKey(
      resolution.question_turn_id as string,
      resolution.question_item_id as string,
    );
    if (seen.has(identity)) {
      return null;
    }
    seen.add(identity);
  }
  return resolutions as Resolution[];
}

/** UTF-8 size; null where Python's str.encode('utf-8') raises on a lone surrogate. */
function utf8Size(value: string): number | null {
  return value.isWellFormed() ? Buffer.byteLength(value, "utf8") : null;
}

function boundedContent(title: string, options: readonly string[] | null): boolean {
  const titleSize = utf8Size(title);
  if (titleSize === null || titleSize > MAX_TITLE_BYTES) {
    return false;
  }
  if (options === null) {
    return true;
  }
  if (options.length > MAX_OPTIONS) {
    return false;
  }
  let total = titleSize;
  for (const option of options) {
    const size = utf8Size(option);
    if (size === null) {
      return false;
    }
    total += size;
  }
  return total <= MAX_QUESTION_BYTES;
}

function questionRows(turnId: string, item: Record<string, unknown>): [QuestionRow[], string[]] {
  const base = (): QuestionRow => ({
    item_id: item.id as string,
    kind: "question_tool",
    options: null,
    proof_refs: [],
    question_index: null,
    state: "unknown",
    title: null,
    turn_id: turnId,
  });
  if (item.type === "agentMessage") {
    const questions = item.questions;
    if (questions == null || (Array.isArray(questions) && questions.length === 0)) {
      return [[], []];
    }
    if (!Array.isArray(questions)) {
      return [[{ ...base(), kind: "rendered_prompt" }], ["question_schema_unavailable"]];
    }
    const rows: QuestionRow[] = [];
    const diagnostics: string[] = [];
    if (questions.length > MAX_QUESTIONS) {
      diagnostics.push("rendered_question_bound_exceeded");
    }
    for (const [index, question] of (questions.slice(0, MAX_QUESTIONS) as unknown[]).entries()) {
      const row: QuestionRow = { ...base(), kind: "rendered_prompt", question_index: index };
      if (isRecord(question) && question.isSecret === true) {
        diagnostics.push("sensitive_question_omitted");
      } else if (
        !isRecord(question) ||
        typeof question.title !== "string" ||
        Object.keys(question).some((key) => key !== "title" && key !== "options") ||
        (question.options != null && !stringList(question.options))
      ) {
        diagnostics.push("question_schema_unavailable");
      } else {
        const options = (question.options ?? null) as string[] | null;
        if (boundedContent(question.title, options)) {
          row.title = question.title;
          row.options = options;
        } else {
          diagnostics.push("question_content_bound_exceeded");
        }
      }
      rows.push(row);
    }
    return [rows, diagnostics];
  }
  if (item.type === "dynamicToolCall" || item.type === "functionCallOutput") {
    const tool = item.type === "dynamicToolCall" ? item.tool : item.name;
    if (typeof tool === "string" && QUESTION_TOOLS.has(tool.toLowerCase().replaceAll("_", ""))) {
      return [[base()], ["question_tool_payload_untyped"]];
    }
  }
  return [[], []];
}

/** Records one page into `result` and `positions`; false when it taints a clean capture. */
function readPage(
  result: HistoryResult,
  positions: Positions,
  recipient: string,
  turnId: string | null,
  data: readonly unknown[],
): boolean {
  let clean = true;
  for (const entry of data) {
    if (
      !isRecord(entry) ||
      !identifier(entry.turnId) ||
      (Object.hasOwn(entry, "threadId") && entry.threadId !== recipient) ||
      (turnId !== null && entry.turnId !== turnId)
    ) {
      throw new PageError("item_recipient_or_turn_mismatch");
    }
    const item = entry.item;
    if (!isRecord(item) || !identifier(item.id)) {
      throw new PageError("item_schema_unavailable");
    }
    if (typeof item.type === "object" && item.type !== null) {
      // An unhashable type raises TypeError in the Python set lookup (question_state.py:158).
      throw new TypeError("unhashable item type");
    }
    if (typeof item.type !== "string" || !NATIVE_ITEM_TYPES.has(item.type)) {
      throw new PageError("item_schema_unavailable");
    }
    const identity = identityKey(entry.turnId, item.id);
    if (positions.has(identity)) {
      throw new PageError("duplicate_item");
    }
    positions.set(identity, { kind: item.type, position: positions.size, turnId: entry.turnId });
    if (item.type === "agentMessage" && Array.isArray(item.questions)) {
      result.omitted_questions += Math.max(0, item.questions.length - MAX_QUESTIONS);
    }
    const [rows, diagnostics] = questionRows(entry.turnId, item);
    result.questions.push(...rows);
    result.diagnostics.push(...diagnostics);
    if (diagnostics.length > 0) {
      clean = false;
    }
    if (item.type === "contextCompaction") {
      result.diagnostics.push("context_compaction");
      clean = false;
    }
    if (item.type === "mcpToolCall" && item.status !== "completed") {
      result.diagnostics.push("native_tool_incomplete");
      clean = false;
    }
  }
  return clean;
}

async function capture(
  reader: Reader,
  recipient: string,
  maxPages: number,
  turnId: string | null = null,
): Promise<[HistoryResult, Positions]> {
  const result: HistoryResult = {
    cancelled_status: "unavailable",
    complete: false,
    diagnostics: ["exact_unresolved_request_unavailable"],
    omitted_questions: 0,
    pending_status: "unavailable",
    questions: [],
    status: "unavailable",
    ui_visibility: "unknown",
  };
  const positions: Positions = new Map();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let clean = true;
  try {
    let bounded = true;
    for (let index = 0; index < maxPages; index += 1) {
      const params: Record<string, unknown> = {
        limit: PAGE_SIZE,
        sortDirection: "desc",
        threadId: recipient,
      };
      if (turnId !== null) {
        params.turnId = turnId;
      }
      if (cursor !== null) {
        params.cursor = cursor;
      }
      // Pages follow their cursor in order.
      // eslint-disable-next-line no-await-in-loop
      const page = await reader.call("thread/items/list", params);
      if (!isRecord(page) || !Array.isArray(page.data)) {
        throw new PageError("malformed_page");
      }
      pages += 1;
      if (page.data.length > PAGE_SIZE) {
        throw new PageError("page_bound_exceeded");
      }
      clean = readPage(result, positions, recipient, turnId, page.data as unknown[]) && clean;
      if (truthy(page.truncated) || truthy(page.hasMore)) {
        throw new PageError("incomplete_page");
      }
      const next: unknown = page.nextCursor;
      if (next == null) {
        result.complete = clean;
        bounded = false;
        break;
      }
      if (!identifier(next) || cursors.has(next)) {
        throw new PageError("pagination_invalid");
      }
      cursors.add(next);
      cursor = next;
    }
    if (bounded) {
      result.diagnostics.push("page_bound_reached");
    }
  } catch (error) {
    if (error instanceof BudgetExhausted) {
      result.diagnostics.push(reader.reason ?? "native_history_unavailable");
    } else if (error instanceof PageError && PAGE_DIAGNOSTICS.has(error.message)) {
      result.diagnostics.push(error.message);
    } else {
      result.diagnostics.push("native_history_unavailable");
    }
  }
  if (result.complete) {
    result.status = "complete";
  } else {
    result.status = pages > 0 ? "partial" : "unavailable";
  }
  return [result, positions];
}

async function pendingContext(reader: Reader, recipient: string): Promise<PendingContext | null> {
  try {
    const read = await reader.call("thread/read", { includeTurns: false, threadId: recipient });
    const thread = isRecord(read) ? read.thread : null;
    if (!isRecord(thread) || thread.id !== recipient || !Number.isInteger(thread.updatedAt)) {
      return null;
    }
    const status = thread.status;
    if (
      !isRecord(status) ||
      status.type !== "active" ||
      !Array.isArray(status.activeFlags) ||
      !(status.activeFlags as unknown[]).includes("waitingOnUserInput")
    ) {
      return null;
    }
    const listed = await reader.call("thread/turns/list", {
      itemsView: "notLoaded",
      limit: 1,
      sortDirection: "desc",
      threadId: recipient,
    });
    const turns = isRecord(listed) ? listed.data : null;
    if (
      !isRecord(listed) ||
      !Array.isArray(turns) ||
      turns.length !== 1 ||
      !isRecord(turns[0]) ||
      !identifier(turns[0].id) ||
      turns[0].status !== "inProgress" ||
      truthy(listed.truncated) ||
      truthy(listed.hasMore)
    ) {
      return null;
    }
    return [turns[0].id, thread.updatedAt as number, status.activeFlags as unknown[]];
  } catch {
    return null;
  }
}

function sameContext(left: PendingContext, right: PendingContext): boolean {
  return left[0] === right[0] && left[1] === right[1] && sameJson(left[2], right[2]);
}

function pendingAttestations(records: Records, recipient: string): unknown {
  const record = recordFor(records, recipient);
  if (!isRecord(record) || record.thread_id !== recipient || record.state !== "pending") {
    return [];
  }
  return own(record, "pending_questions", []);
}

function digit(character: string | undefined): boolean {
  return character !== undefined && character.length === 1 && character >= "0" && character <= "9";
}

function digitsAt(chars: readonly string[], start: number, count: number): number {
  let value = 0;
  for (let index = start; index < start + count; index += 1) {
    const character = chars[index];
    if (!digit(character)) {
      throw new RangeError("invalid isoformat digits");
    }
    value = value * 10 + Number(character);
  }
  return value;
}

/** _find_isoformat_datetime_separator(); `chars` has at least 7 code points. */
function separatorIndex(chars: readonly string[]): number {
  const length = chars.length;
  if (length === 7) {
    return 7;
  }
  if (chars[4] === "-") {
    if (chars[5] !== "W") {
      return 10;
    }
    if (length > 8 && chars[8] === "-") {
      if (length === 9) {
        throw new RangeError("invalid isoformat week");
      }
      return length > 10 && digit(chars[10]) ? 8 : 10;
    }
    return 8;
  }
  if (chars[4] === "W") {
    let index = 7;
    while (index < length && digit(chars[index])) {
      index += 1;
    }
    if (index < 9) {
      return index;
    }
    return index % 2 === 0 ? 7 : 8;
  }
  return 8;
}

function leapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar. */
function epochDays(year: number, month: number, day: number): number {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** ISO weekday, Monday 1 to Sunday 7. */
function isoWeekday(days: number): number {
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

const FIRST_DAY = epochDays(1, 1, 1);
const LAST_DAY = epochDays(9999, 12, 31);

/** _isoweek_to_gregorian(), as epoch days. */
function isoWeekDays(year: number, week: number, weekday: number): number {
  if (year < 1 || year > 9999) {
    throw new RangeError("isoformat year out of range");
  }
  if (week < 1 || week > 53) {
    throw new RangeError("invalid isoformat week");
  }
  if (week === 53) {
    const first = isoWeekday(epochDays(year, 1, 1));
    if (!(first === 4 || (first === 3 && leapYear(year)))) {
      throw new RangeError("invalid isoformat week");
    }
  }
  if (weekday < 1 || weekday > 7) {
    throw new RangeError("invalid isoformat weekday");
  }
  const january4 = epochDays(year, 1, 4);
  const days = january4 - (isoWeekday(january4) - 1) + (week - 1) * 7 + (weekday - 1);
  if (days < FIRST_DAY || days > LAST_DAY) {
    throw new RangeError("isoformat year out of range");
  }
  return days;
}

/** The C parse_isoformat_date(), as epoch days. */
function dateDays(chars: readonly string[]): number {
  const year = digitsAt(chars, 0, 4);
  const dashed = chars[4] === "-";
  let position = dashed ? 5 : 4;
  if (chars[position] === "W") {
    position += 1;
    const week = digitsAt(chars, position, 2);
    position += 2;
    let weekday = 1;
    if (position < chars.length) {
      if (dashed) {
        if (chars[position] !== "-") {
          throw new RangeError("inconsistent isoformat separator");
        }
        position += 1;
      }
      weekday = digitsAt(chars, position, 1);
    }
    return isoWeekDays(year, week, weekday);
  }
  const month = digitsAt(chars, position, 2);
  position += 2;
  if (dashed) {
    if (chars[position] !== "-") {
      throw new RangeError("inconsistent isoformat separator");
    }
    position += 1;
  }
  const day = digitsAt(chars, position, 2);
  const lengths = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > (lengths[month - 1] ?? 0)) {
    throw new RangeError("isoformat date out of range");
  }
  return epochDays(year, month, day);
}

interface ClockFields {
  /** C `*p != '\0'`: characters remain after the parsed fields. */
  readonly rest: boolean;
  readonly values: readonly [number, number, number, number];
}

/** The C parse_hh_mm_ss_ff(): HH[:?MM[:?SS]][{.,}f+], reading `chars` as a NUL-ended buffer. */
function clockFields(chars: readonly string[], start: number, end: number): ClockFields {
  const values: [number, number, number, number] = [0, 0, 0, 0];
  let position = start;
  let separated = true;
  for (let index = 0; index < 3; index += 1) {
    values[index] = digitsAt(chars, position, 2);
    position += 2;
    const character = chars[position] ?? "";
    position += 1;
    if (index === 0) {
      separated = character === ":";
    }
    if (position >= end) {
      return { rest: character !== "", values };
    }
    if (separated && character === ":") {
      continue;
    }
    if (character === "." || character === ",") {
      break;
    }
    if (separated) {
      throw new RangeError("invalid isoformat time separator");
    }
    position -= 1;
  }
  const count = Math.min(end - position, 6);
  values[3] = digitsAt(chars, position, count) * 10 ** (6 - count);
  position += count;
  while (digit(chars[position])) {
    position += 1;
  }
  return { rest: position < chars.length, values };
}

/** Seconds of the day for a UTC time part, or null for a naive or non-UTC one. */
function utcSeconds(chars: readonly string[], start: number): number | null {
  let zone = start;
  for (;;) {
    const character = chars[zone];
    if (character === "Z" || character === "+" || character === "-") {
      break;
    }
    zone += 1;
    if (zone >= chars.length) {
      break;
    }
  }
  const time = clockFields(chars, start, zone);
  if (zone >= chars.length) {
    return null;
  }
  if (chars[zone] === "Z") {
    if (zone + 1 !== chars.length) {
      throw new RangeError("invalid isoformat zone");
    }
  } else {
    const offset = clockFields(chars, zone + 1, chars.length);
    if (offset.rest) {
      throw new RangeError("invalid isoformat zone");
    }
    if (offset.values.some((value) => value !== 0)) {
      return null;
    }
  }
  const [hour, minute, second, microsecond] = time.values;
  if (hour > 23 || minute > 59 || second > 59) {
    throw new RangeError("isoformat time out of range");
  }
  return (hour * 3600 + minute * 60 + second) * 1_000_000 + microsecond;
}

/**
 * datetime.fromisoformat(value).timestamp() when the value parses with a zero UTC offset, else
 * null. Follows the CPython 3.12 C parser: any single code point separates date and time.
 */
function utcTimestamp(value: string): number | null {
  const chars = Array.from(value);
  if (chars.length < 7) {
    return null;
  }
  try {
    const separator = separatorIndex(chars);
    const days = dateDays(chars.slice(0, separator));
    if (separator + 1 >= chars.length) {
      return null;
    }
    const micros = utcSeconds(chars, separator + 1);
    if (micros === null) {
      return null;
    }
    return (days * 86400 * 1_000_000 + micros) / 1_000_000;
  } catch {
    return null;
  }
}

function freshAttestation(now: number, attestation: unknown): attestation is Attestation {
  if (
    !isRecord(attestation) ||
    attestation.confirmed_pending !== true ||
    !identifier(attestation.question_turn_id) ||
    !identifier(attestation.question_item_id) ||
    !identifier(attestation.confirmed_at) ||
    !Number.isInteger(attestation.question_index) ||
    (attestation.question_index as number) < 0 ||
    typeof attestation.title !== "string" ||
    !Object.hasOwn(attestation, "options") ||
    (attestation.options !== null && !stringList(attestation.options))
  ) {
    return false;
  }
  if (!boundedContent(attestation.title, attestation.options as string[] | null)) {
    return false;
  }
  const value = attestation.confirmed_at;
  if (!value.endsWith("Z") && !value.endsWith("+00:00")) {
    return false;
  }
  const confirmed = utcTimestamp(value.replaceAll("Z", "+00:00"));
  return confirmed !== null && now - confirmed >= 0 && now - confirmed <= 1800;
}

/** The newer-turn and later-reply proof for one exact attested question. */
function pendingConflict(
  latestPositions: Positions,
  historyPositions: Positions,
  identity: string,
  turnId: string,
): string | null {
  const historical = historyPositions.get(identity);
  if (
    historical !== undefined &&
    [...historyPositions.values()].some(
      (reference) => reference.turnId !== turnId && reference.position < historical.position,
    )
  ) {
    return "owner_pending_newer_turn_ambiguity";
  }
  const latest = latestPositions.get(identity);
  if (
    latest !== undefined &&
    [...latestPositions.values()].some(
      (reference) => reference.kind === "userMessage" && reference.position < latest.position,
    )
  ) {
    return "owner_pending_later_reply";
  }
  return null;
}

function applyPending(
  clock: Clock,
  result: HistoryResult,
  latestPositions: Positions,
  recipient: string,
  attestations: unknown,
  contexts: readonly [PendingContext | null, PendingContext | null],
  resolutions: readonly Resolution[] | null,
  latestProof: Capture,
  historyPositions: Positions,
): void {
  if (!truthy(attestations)) {
    return;
  }
  if (!Array.isArray(attestations)) {
    result.diagnostics.push("owner_pending_attestation_invalid");
    return;
  }
  const now = clock.time();
  const seen = new Set<string>();
  const candidates = new Map<string, Attestation>();
  for (const attestation of attestations as unknown[]) {
    if (!freshAttestation(now, attestation)) {
      result.diagnostics.push("owner_pending_attestation_stale_or_invalid");
      continue;
    }
    const key = questionKey(
      attestation.question_turn_id,
      attestation.question_item_id,
      attestation.question_index,
    );
    if (seen.has(key)) {
      result.diagnostics.push("owner_pending_attestation_duplicate");
      candidates.delete(key);
      continue;
    }
    seen.add(key);
    candidates.set(key, attestation);
  }
  const [before, after] = contexts;
  if (
    !latestProof.complete ||
    resolutions === null ||
    before === null ||
    after === null ||
    !sameContext(before, after)
  ) {
    result.diagnostics.push("owner_pending_native_proof_unavailable");
    return;
  }
  const matched = new Set<string>();
  for (const question of result.questions) {
    const key = questionKey(question.turn_id, question.item_id, question.question_index);
    const attestation = candidates.get(key);
    if (attestation === undefined) {
      continue;
    }
    matched.add(key);
    const identity = identityKey(question.turn_id, question.item_id);
    if (
      !latestPositions.has(identity) ||
      question.kind !== "rendered_prompt" ||
      question.title === null ||
      attestation.title !== question.title ||
      !sameOptions(attestation.options, question.options) ||
      after[0] !== question.turn_id
    ) {
      result.diagnostics.push("owner_pending_attestation_mismatch");
      continue;
    }
    if (
      resolutions.some(
        (resolution) =>
          identityKey(resolution.question_turn_id, resolution.question_item_id) === identity,
      )
    ) {
      result.diagnostics.push("owner_pending_resolution_conflict");
      continue;
    }
    const conflict = pendingConflict(latestPositions, historyPositions, identity, question.turn_id);
    if (conflict !== null) {
      result.diagnostics.push(conflict);
      continue;
    }
    question.state = "pending";
    question.proof_complete = true;
    question.proof_scope = "latest_turn";
    question.proof_refs = [
      {
        confirmed_at: attestation.confirmed_at,
        kind: "owner_pending_attestation",
        question_index: attestation.question_index,
        question_item_id: question.item_id,
        question_turn_id: question.turn_id,
        recipient,
      },
    ];
  }
  if ([...candidates.keys()].some((key) => !matched.has(key))) {
    result.diagnostics.push("owner_pending_attestation_mismatch");
  }
}

/** Marks rendered questions answered where an owner resolution has exact native reply order. */
function applyResolutions(
  result: HistoryResult,
  positions: Positions,
  recipient: string,
  resolutions: readonly Resolution[],
): void {
  for (const question of result.questions) {
    if (question.kind !== "rendered_prompt" || question.title === null) {
      continue;
    }
    const identity = identityKey(question.turn_id, question.item_id);
    for (const resolution of resolutions) {
      if (identityKey(resolution.question_turn_id, resolution.question_item_id) !== identity) {
        continue;
      }
      const reply = identityKey(resolution.answer_turn_id, resolution.answer_item_id);
      const answer = positions.get(reply);
      const asked = positions.get(identity);
      if (
        answer !== undefined &&
        asked !== undefined &&
        answer.kind === "userMessage" &&
        answer.position < asked.position
      ) {
        question.state = "answered";
        question.proof_refs = [
          {
            answer_item_id: resolution.answer_item_id,
            answer_turn_id: resolution.answer_turn_id,
            question_item_id: resolution.question_item_id,
            question_turn_id: resolution.question_turn_id,
            recipient,
          },
        ];
      } else {
        result.diagnostics.push("owner_resolution_proof_unavailable");
      }
    }
  }
}

/** Replaces history rows with their latest-turn rows, carrying a matching answered proof. */
function mergeLatest(result: HistoryResult, latest: Capture): void {
  const current = new Map<string, QuestionRow>();
  for (const question of latest.questions) {
    current.set(questionKey(question.turn_id, question.item_id, question.question_index), question);
  }
  result.questions = result.questions.map((question) => {
    const key = questionKey(question.turn_id, question.item_id, question.question_index);
    const replacement = current.get(key);
    if (replacement === undefined) {
      return question;
    }
    current.delete(key);
    if (
      question.state === "answered" &&
      question.title === replacement.title &&
      sameOptions(question.options, replacement.options)
    ) {
      replacement.state = "answered";
      replacement.proof_refs = question.proof_refs;
    }
    return replacement;
  });
  result.questions.push(...current.values());
}

async function collectOne(
  clock: Clock,
  reader: Reader,
  records: Records,
  maxPages: number,
  recipient: string,
): Promise<HistoryResult> {
  const attestations = pendingAttestations(records, recipient);
  const fresh =
    Array.isArray(attestations) &&
    (attestations as unknown[]).some((attestation) => freshAttestation(clock.time(), attestation));
  const before = fresh ? await pendingContext(reader, recipient) : null;
  let latest: Capture = {
    complete: false,
    diagnostics: ["latest_turn_proof_unavailable"],
    omitted_questions: 0,
    questions: [],
    status: "unavailable",
  };
  let latestPositions: Positions = new Map();
  if (before !== null) {
    [latest, latestPositions] = await capture(reader, recipient, maxPages, before[0]);
  }
  const [result, positions] = await capture(reader, recipient, maxPages);
  const after = fresh ? await pendingContext(reader, recipient) : null;
  result.latest_turn_proof = {
    complete: latest.complete,
    diagnostics: latest.diagnostics,
    omitted_questions: latest.omitted_questions,
    status: latest.status,
    turn_id: before === null ? null : before[0],
  };
  const resolutions = resolutionsFor(records, recipient);
  if (resolutions === null) {
    result.diagnostics.push("owner_resolution_record_unavailable");
  } else if (result.complete) {
    applyResolutions(result, positions, recipient, resolutions);
  }
  mergeLatest(result, latest);
  applyPending(
    clock,
    result,
    latestPositions,
    recipient,
    attestations,
    [before, after],
    resolutions,
    latest,
    positions,
  );
  result.pending_status = result.questions.some((question) => question.state === "pending")
    ? "owner_attested"
    : "unavailable";
  result.diagnostics = [...new Set(result.diagnostics)].sort();
  result.budget = reader.metadata();
  return result;
}

/**
 * Collect exact-recipient safe references and explicitly attested lifecycle states.
 *
 * Native pending and cancelled lifecycle is unavailable. Optional exact owner pending_questions
 * attestations require fresh UTC confirmation, matching rendered title/options/index, a stable
 * current waitingOnUserInput latest turn, complete latest-turn proof and no later reply or
 * resolution conflict. Owner resolution attestations must identify exact question and reply items
 * on the recipient, with native descending history proving the reply follows the question.
 * Partial, compacted or unknown history cannot establish an answered state. Tool results remain
 * opaque.
 *
 * `maxPages` bounds each recipient's thread history and the separate latest-turn proof. All
 * recipients share one call budget and the client's `deadline`, which is never changed. Uses
 * thread/items/list, and thread/read plus thread/turns/list only when exact owner pending
 * attestations are supplied. No persistence or mutation occurs.
 */
export async function collectQuestionState(
  client: RpcClient,
  decisionRecords: Readonly<Record<string, Record<string, unknown> | null>>,
  recipients: readonly string[],
  maxPages = 10,
  options: QuestionStateOptions = {},
): Promise<Record<string, Record<string, unknown>>> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new Error("invalid_max_pages");
  }
  if (!Array.isArray(recipients)) {
    throw new Error("invalid_recipient_scope");
  }
  for (const recipient of recipients) {
    if (!isCanonicalUuid(recipient)) {
      throw new Error("canonical_recipient_required");
    }
  }
  if (new Set(recipients).size !== recipients.length) {
    throw new Error("duplicate_recipient");
  }
  const clock: Clock = {
    maxCalls: options.maxCalls ?? MAX_CALLS,
    monotonic: options.monotonic ?? (() => performance.now()),
    time: options.time ?? (() => Date.now() / 1000),
  };
  const reader = new Reader(clock, client);
  const output: Record<string, Record<string, unknown>> = {};
  for (const recipient of recipients) {
    // Recipients share one call budget and deadline, so they are read in order.
    // eslint-disable-next-line no-await-in-loop
    output[recipient] = await collectOne(clock, reader, decisionRecords, maxPages, recipient);
  }
  return output;
}
