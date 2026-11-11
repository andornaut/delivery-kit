// Bounded read-only child failure evidence for explicitly scoped parents, and
// the review's worker_health wrapper. This module performs no delivery,
// persistence, scheduling or lifecycle mutation.
import { performance } from "node:perf_hooks";

import { isCanonicalUuid } from "../../shared/ids.ts";
import { isRecord, sameJson } from "../../shared/pyjson.ts";
import { NativeTimeout, type RpcClient } from "../rpc.ts";

export const ERROR_CLASSES: Readonly<Record<string, string>> = {
  contextWindowExceeded: "context_exhaustion",
  flexUnavailable: "flex_capacity",
  modelNotFound: "model_unavailable",
  policyCapacityUnavailable: "model_capacity",
  rateLimitExceeded: "rate_limit",
  serverOverloaded: "server_capacity",
  sessionBudgetExceeded: "session_budget_exhaustion",
  usageLimitExceeded: "usage_limit",
};
const THREAD_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "idle",
  "notLoaded",
  "systemError",
]);
const TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "inProgress",
  "interrupted",
]);
const HEALTH_STATUSES: readonly unknown[] = ["complete", "partial", "unavailable"];
const PAGE_SIZE = 50;
const MAX_CHILDREN = 100;
export const MAX_CALLS = 256;

type Metadata = { status: { type: string }; updatedAt: number };

type Turn = { error_code: string | null; id: string; status: string };

type BudgetMetadata = {
  calls_used: number;
  exhausted: boolean;
  max_calls: number;
  reason_code: string | null;
};

type Inventory = { complete: boolean; diagnostics: string[]; pages: number; status: string };

type ChildHealth = {
  child_id: string;
  classification: string;
  complete: boolean;
  diagnostics: string[];
  error_code: string | null;
  lineage_verified: boolean;
  observed_at: string;
  parent_id: string;
  provenance: string;
  requires_parent_action: boolean;
  status: string;
  thread_status: string | null;
  turn_id: string | null;
  turn_status: string | null;
};

type ParentHealth = {
  budget?: BudgetMetadata;
  children: ChildHealth[];
  complete: boolean;
  counts: { discovered: number; observed: number; omitted: number; validated: number };
  diagnostics: string[];
  inventories: Record<string, Inventory>;
  observed_at: string;
  provenance: string;
  schema_status: string;
  status: string;
};

type ParentState = {
  children: Map<string, Metadata | null>;
  health: ParentHealth;
  parent: string;
  rejected: Set<string>;
};

type Stream = {
  archived: boolean;
  cursor: string | null;
  cursors: Set<string>;
  inventory: Inventory;
  state: ParentState;
};

class BudgetExhausted extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "BudgetExhausted";
    this.reason = reason;
  }
}

/**
 * One call budget shared by every parent, plus the client's optional `deadline` (a
 * performance.now() value, as connectControl takes) that the caller has already reserved.
 */
class Budget {
  readonly client: RpcClient;
  readonly maxCalls: number;
  callsUsed = 0;
  reason: string | null = null;

  constructor(client: RpcClient, maxCalls: number) {
    this.client = client;
    this.maxCalls = maxCalls;
  }

  check(): void {
    const { deadline } = this.client as RpcClient & { readonly deadline?: unknown };
    if (
      typeof deadline === "number" &&
      Number.isFinite(deadline) &&
      performance.now() >= deadline
    ) {
      this.reason = "native_deadline_exhausted";
    }
    if (this.reason === null && this.callsUsed >= this.maxCalls) {
      this.reason = "native_call_budget_exhausted";
    }
    if (this.reason !== null) {
      throw new BudgetExhausted(this.reason);
    }
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.check();
    this.callsUsed += 1;
    try {
      return await this.client.call(method, params);
    } catch (error) {
      if (error instanceof NativeTimeout) {
        this.reason = "native_timeout";
        throw new BudgetExhausted(this.reason);
      }
      // A failure that arrives after the deadline reports the exhausted budget instead.
      this.check();
      throw error;
    }
  }

  metadata(): BudgetMetadata {
    return {
      calls_used: this.callsUsed,
      exhausted: this.reason !== null,
      max_calls: this.maxCalls,
      reason_code: this.reason,
    };
  }
}

/**
 * Python `value in set`: a dict or list value raises TypeError (unhashable), which the callers
 * report as an unavailable read.
 */
function member(values: ReadonlySet<string>, value: unknown): value is string {
  if (typeof value === "object" && value !== null) {
    throw new TypeError("unhashable type");
  }
  return typeof value === "string" && values.has(value);
}

/** datetime.now(timezone.utc).isoformat(), at the millisecond precision Date carries. */
function isoformat(date: Date): string {
  const seconds = date.toISOString().slice(0, 19);
  const milliseconds = date.getUTCMilliseconds();
  if (milliseconds === 0) {
    return `${seconds}+00:00`;
  }
  return `${seconds}.${String(milliseconds * 1000).padStart(6, "0")}+00:00`;
}

function uniqueSorted(codes: readonly string[]): string[] {
  return [...new Set(codes)].sort();
}

function lineage(parent: string, row: unknown): row is Record<string, unknown> {
  if (!isRecord(row) || row.parentThreadId !== parent) {
    return false;
  }
  const { source } = row;
  if (isRecord(source) && Object.hasOwn(source, "subAgent")) {
    const subagent = source.subAgent;
    if (!isRecord(subagent) || !Object.hasOwn(subagent, "thread_spawn")) {
      return false;
    }
    const spawn = subagent.thread_spawn;
    if (!isRecord(spawn) || spawn.parent_thread_id !== parent) {
      return false;
    }
  }
  return true;
}

function statusOf(row: Record<string, unknown>): string | null {
  const { status } = row;
  const type = isRecord(status) ? status.type : undefined;
  return member(THREAD_STATUSES, type) ? type : null;
}

function metadataOf(row: Record<string, unknown>): Metadata | null {
  const status = statusOf(row);
  const stamp = row.updatedAt;
  if (status === null || typeof stamp !== "number" || !Number.isInteger(stamp)) {
    return null;
  }
  return { status: { type: status }, updatedAt: stamp };
}

async function readThread(budget: Budget, parent: string, child: string): Promise<Metadata | null> {
  const response = await budget.call("thread/read", { includeTurns: false, threadId: child });
  const row = isRecord(response) ? response.thread : null;
  if (!isRecord(row) || row.id !== child || !lineage(parent, row)) {
    return null;
  }
  return metadataOf(row);
}

/** The newest turn: [turn, null], [null, null] for an empty history, or [null, diagnostic]. */
async function latestTurn(budget: Budget, child: string): Promise<[Turn | null, string | null]> {
  const response = await budget.call("thread/turns/list", {
    itemsView: "notLoaded",
    limit: 1,
    sortDirection: "desc",
    threadId: child,
  });
  if (!isRecord(response) || !Array.isArray(response.data)) {
    return [null, "turn_schema_unavailable"];
  }
  const turns: unknown[] = response.data;
  if (turns.length > 1) {
    return [null, "turn_bound_exceeded"];
  }
  if (turns.length === 0) {
    return [null, response.nextCursor == null ? null : "latest_turn_unavailable"];
  }
  const [turn] = turns;
  if (!isRecord(turn) || !isCanonicalUuid(turn.id) || !member(TURN_STATUSES, turn.status)) {
    return [null, "turn_schema_unavailable"];
  }
  const { error } = turn;
  const code = isRecord(error) ? error.codexErrorInfo : null;
  const known = typeof code === "string" && Object.hasOwn(ERROR_CLASSES, code);
  return [{ error_code: known ? code : null, id: turn.id, status: turn.status }, null];
}

async function childHealth(
  budget: Budget,
  observed: string,
  parent: string,
  child: string,
  row: Metadata | null,
): Promise<[ChildHealth, boolean]> {
  const result: ChildHealth = {
    child_id: child,
    classification: "unknown",
    complete: false,
    diagnostics: [],
    error_code: null,
    lineage_verified: true,
    observed_at: observed,
    parent_id: parent,
    provenance: "native_protocol",
    requires_parent_action: false,
    status: "unavailable",
    thread_status: null,
    turn_id: null,
    turn_status: null,
  };
  let observedTurn = false;
  try {
    if (row === null) {
      result.diagnostics.push("thread_schema_unavailable");
      return [result, false];
    }
    result.thread_status = statusOf(row);
    const [turn, diagnostic] = await latestTurn(budget, child);
    if (diagnostic !== null) {
      result.diagnostics.push(diagnostic);
      return [result, false];
    }
    observedTurn = true;
    if (turn !== null) {
      result.turn_id = turn.id;
      result.turn_status = turn.status;
      result.error_code = turn.error_code;
    }
    // Noncandidates retain an observation, never a clearance or recovery claim.
    if (
      turn === null ||
      turn.status !== "failed" ||
      turn.error_code === null ||
      result.thread_status === "active"
    ) {
      result.status = "complete";
      result.complete = true;
      return [result, observedTurn];
    }
    // Only a typed failed candidate needs fresh lineage and resumption checks.
    const fresh = await readThread(budget, parent, child);
    const [latest, changed] = await latestTurn(budget, child);
    if (fresh === null) {
      result.lineage_verified = false;
    }
    if (!sameJson(fresh, row) || changed !== null || !sameJson(latest, turn)) {
      result.status = "partial";
      result.diagnostics = ["observation_changed"];
      result.error_code = null;
      if (fresh !== null) {
        result.thread_status = statusOf(fresh);
      }
      if (latest !== null) {
        result.turn_id = latest.id;
        result.turn_status = latest.status;
        result.error_code = latest.error_code;
      }
      return [result, observedTurn];
    }
    result.status = "complete";
    result.complete = true;
    result.classification = ERROR_CLASSES[turn.error_code] ?? "unknown";
    result.requires_parent_action = true;
  } catch (error) {
    result.status = observedTurn ? "partial" : "unavailable";
    result.diagnostics = [
      error instanceof BudgetExhausted ? error.reason : "native_read_unavailable",
    ];
  }
  return [result, observedTurn];
}

function requestPage(budget: Budget, stream: Stream): Promise<unknown> {
  const params: Record<string, unknown> = {
    archived: stream.archived,
    limit: PAGE_SIZE,
    parentThreadId: stream.state.parent,
    sourceKinds: ["subAgentThreadSpawn"],
    useStateDbOnly: true,
  };
  if (stream.cursor !== null) {
    params.cursor = stream.cursor;
  }
  return budget.call("thread/list", params);
}

/** Records one inventory page; true when the stream has a further page to request. */
function applyPage(stream: Stream, page: unknown): boolean {
  const { inventory, state } = stream;
  if (!isRecord(page) || !Array.isArray(page.data)) {
    inventory.diagnostics.push("inventory_schema_unavailable");
    return false;
  }
  inventory.pages += 1;
  const rows: unknown[] = page.data;
  if (rows.length > PAGE_SIZE) {
    inventory.diagnostics.push("page_bound_exceeded");
  }
  for (const row of rows.slice(0, PAGE_SIZE)) {
    const child = isRecord(row) ? row.id : null;
    if (!isCanonicalUuid(child) || child === state.parent || !lineage(state.parent, row)) {
      inventory.diagnostics.push("lineage_unverified");
      if (isCanonicalUuid(child)) {
        state.rejected.add(child);
      }
      continue;
    }
    const metadata = metadataOf(row);
    if (state.children.has(child) && !sameJson(state.children.get(child), metadata)) {
      inventory.diagnostics.push("inventory_observation_changed");
      state.children.set(child, null);
    } else {
      state.children.set(child, metadata);
    }
  }
  const cursor = page.nextCursor;
  if (cursor == null) {
    return false;
  }
  if (typeof cursor !== "string" || cursor === "" || stream.cursors.has(cursor)) {
    inventory.diagnostics.push("pagination_invalid");
    return false;
  }
  stream.cursors.add(cursor);
  stream.cursor = cursor;
  return true;
}

/**
 * Safe worker health keyed by canonical exact parent UUID.
 *
 * Round-robin inventory pages cover active and archived direct children only. Validated inventory
 * metadata supplies each child's initial observation. One newest-turn read observes a child; only
 * typed failed candidates receive a fresh metadata read and newest-turn reread before becoming
 * actionable. Round-robin child visits inspect at most 100 children per parent. maxPages bounds
 * each inventory stream (50 rows/page), with maxCalls (256) calls overall and the client's optional
 * deadline. The caller bounds transport time.
 *
 * counts.discovered counts unique verified listed IDs, excluding conflicting lineage; it never
 * counts unknown unlisted children. counts.observed counts successful newest-turn observations,
 * including empty turns. counts.validated counts actionable matched candidates only. omitted =
 * discovered - observed. Completeness covers these bounded observations, never full historical
 * turns, decision clearance, recovery or handling. The caller owns slot/delivery dedup by
 * parent_id, child_id, turn_id and error_code. No state is persisted here.
 */
export async function collectChildHealth(
  client: RpcClient,
  parents: readonly string[],
  maxPages = 10,
  maxCalls = MAX_CALLS,
): Promise<Record<string, Record<string, unknown>>> {
  if (
    typeof maxPages !== "number" ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 100
  ) {
    throw new Error("invalid_max_pages");
  }
  if (!Array.isArray(parents) || !parents.every((parent) => isCanonicalUuid(parent))) {
    throw new Error("invalid_parent_scope");
  }
  const observed = isoformat(new Date());
  const budget = new Budget(client, maxCalls);
  const states: ParentState[] = [...new Set(parents)].map((parent) => ({
    children: new Map(),
    health: {
      children: [],
      complete: true,
      counts: { discovered: 0, observed: 0, omitted: 0, validated: 0 },
      diagnostics: [],
      inventories: {},
      observed_at: observed,
      provenance: "native_protocol",
      schema_status: "available",
      status: "complete",
    },
    parent,
    rejected: new Set(),
  }));
  const streams: Stream[] = [];
  for (const archived of [false, true]) {
    for (const state of states) {
      const inventory: Inventory = {
        complete: true,
        diagnostics: [],
        pages: 0,
        status: "complete",
      };
      state.health.inventories[archived ? "archived" : "active"] = inventory;
      streams.push({ archived, cursor: null, cursors: new Set(), inventory, state });
    }
  }
  for (let stream = streams.shift(); stream !== undefined; stream = streams.shift()) {
    try {
      // Every stream's first page precedes any second page under the shared call budget.
      // eslint-disable-next-line no-await-in-loop
      const page = await requestPage(budget, stream);
      if (applyPage(stream, page)) {
        if (stream.inventory.pages < maxPages) {
          streams.push(stream);
        } else {
          stream.inventory.diagnostics.push("page_bound_reached");
        }
      }
    } catch (error) {
      stream.inventory.diagnostics.push(
        error instanceof BudgetExhausted ? error.reason : "native_inventory_unavailable",
      );
    }
  }
  const visits: [ParentState, Iterator<string>][] = [];
  for (const state of states) {
    for (const child of state.rejected) {
      state.children.delete(child);
    }
    const children = [...state.children.keys()].sort();
    state.health.counts.discovered = children.length;
    if (children.length > MAX_CHILDREN) {
      state.health.diagnostics.push("child_bound_exceeded");
    }
    if (children.length > 0) {
      visits.push([state, children.slice(0, MAX_CHILDREN).values()]);
    }
  }
  for (let visit = visits.shift(); visit !== undefined; visit = visits.shift()) {
    const [state, children] = visit;
    const next = children.next();
    if (next.done) {
      continue;
    }
    const child = next.value;
    // Child visits alternate between parents one at a time under the shared call budget.
    // eslint-disable-next-line no-await-in-loop
    const [health, observedTurn] = await childHealth(
      budget,
      observed,
      state.parent,
      child,
      state.children.get(child) ?? null,
    );
    state.health.children.push(health);
    state.health.counts.observed += observedTurn ? 1 : 0;
    state.health.counts.validated += health.requires_parent_action ? 1 : 0;
    visits.push(visit);
  }
  for (const { health } of states) {
    const inventories = Object.values(health.inventories);
    for (const inventory of inventories) {
      inventory.diagnostics = uniqueSorted(inventory.diagnostics);
      if (inventory.diagnostics.length > 0) {
        inventory.status = inventory.pages > 0 ? "partial" : "unavailable";
        inventory.complete = false;
      }
    }
    const { counts } = health;
    counts.omitted = counts.discovered - counts.observed;
    const parts: (Inventory | ChildHealth)[] = [...inventories, ...health.children];
    health.complete = health.diagnostics.length === 0 && parts.every((part) => part.complete);
    if (!health.complete) {
      const unavailable = inventories.every((inventory) => inventory.status === "unavailable");
      health.status = unavailable ? "unavailable" : "partial";
      health.diagnostics = uniqueSorted([
        ...health.diagnostics,
        ...parts.flatMap((part) => part.diagnostics),
      ]);
      if (health.diagnostics.some((code) => code.includes("schema"))) {
        health.schema_status = "unavailable";
      }
    }
    if (inventories.some((inventory) => inventory.status === "unavailable")) {
      health.schema_status = "unknown";
    }
    health.budget = budget.metadata();
  }
  return Object.fromEntries(states.map((state) => [state.parent, state.health]));
}

function isHealth(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  return HEALTH_STATUSES.includes(value.status) && Array.isArray(value.children);
}

function collectorUnavailable(reasonCode: string): Record<string, unknown> {
  return {
    children: [],
    complete: false,
    diagnostics: [{ reason_code: reasonCode }],
    schema_status: "unavailable",
    status: "unavailable",
  };
}

/**
 * The review's worker health for parents the caller has already scoped, under a deadline the
 * caller has already reserved. A collector failure marks every parent unavailable, never omitted.
 */
export async function workerHealth(
  client: RpcClient,
  parents: readonly string[],
): Promise<Record<string, Record<string, unknown>>> {
  if (parents.length === 0) {
    return {};
  }
  let reasonCode = "collector_unavailable";
  let result: Record<string, unknown> = {};
  try {
    const collected: unknown = await collectChildHealth(client, parents);
    if (!isRecord(collected)) {
      throw new Error("invalid collector result");
    }
    result = collected;
  } catch (error) {
    if (error instanceof NativeTimeout) {
      reasonCode = "collector_budget_exhausted";
    }
  }
  const entries: [string, Record<string, unknown>][] = [];
  for (const parent of parents) {
    const health = Object.hasOwn(result, parent) ? result[parent] : undefined;
    entries.push([parent, isHealth(health) ? health : collectorUnavailable(reasonCode)]);
  }
  return Object.fromEntries(entries);
}
