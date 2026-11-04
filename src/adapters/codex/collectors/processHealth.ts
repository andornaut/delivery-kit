// Read-only health for optional, nonsecret, exact owner-registered jobs, and
// the monitor's bounded manifest reader around it.
//
// The owner manifest supplies runtime identity and progress attestations. Scoped native command
// metadata corroborates invocation references, never host liveness. Only owners close resources:
// no process getter, host probe or lifecycle mutation is used. All identifiers and evidence codes
// must be nonsecret tokens.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

import { isCanonicalUuid } from "../../shared/ids.ts";
import { utcStamp } from "../../shared/isoformat.ts";
import { dumpsJson, isRecord, type PyJson, sameJson } from "../../shared/pyjson.ts";
import { NativeTimeout, type RpcClient } from "../rpc.ts";

const MAX_BYTES = 1048576;
const MAX_JOBS = 100;
const MAX_CALLS = 256;
const MAX_AGE = 1800;
const MAX_SAMPLE_BYTES = 8192;
const KINDS: ReadonlySet<string> = new Set(["browser_job", "container", "process"]);
const STATES: ReadonlySet<string> = new Set([
  "blocked",
  "running",
  "service",
  "terminal",
  "unknown",
  "waiting_on_user",
]);
const CLOSURES: ReadonlySet<string> = new Set([
  "ambiguous",
  "blocked",
  "delivery_accepted",
  "reported_closed",
  "requested",
  "retained",
  "verified_closed",
]);
const BLOCKS: ReadonlySet<string> = new Set([
  "deadlock",
  "dependency_failure",
  "owner_confirmed_block",
  "unresponsive",
]);
const COMMAND_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "declined",
  "failed",
  "inProgress",
]);
/** Closure states that still need the owner to act on a confirmed stall. */
const OWNER_ACTION: ReadonlySet<string> = new Set([
  "ambiguous",
  "delivery_accepted",
  "none",
  "requested",
]);
const COLLECTOR_STATUSES: ReadonlySet<string> = new Set(["complete", "partial", "unavailable"]);
const MANIFEST_CODES: ReadonlySet<string> = new Set([
  "process_manifest_not_regular",
  "process_manifest_path_invalid",
  "process_manifest_schema_unavailable",
  "process_manifest_size_exceeded",
  "process_route_unavailable",
]);
const IDENTITY = [
  "owner_parent_id",
  "worker_id",
  "kind",
  "job_id",
  "start_identity",
  "invocation",
] as const;
/** IDENTITY without the invocation: one job, whatever command launched it. */
const JOB_KEY = ["owner_parent_id", "worker_id", "kind", "job_id", "start_identity"] as const;
/** IDENTITY without the worker: a closure receipt binds the owner's job, not the child. */
const CLOSURE_KEY = ["owner_parent_id", "kind", "job_id", "start_identity", "invocation"] as const;
const SAMPLE_KEYS: ReadonlySet<string> = new Set([
  "collected_at",
  "invocation",
  "job_id",
  "kind",
  "owner_evidence",
  "owner_parent_id",
  "protected",
  "provenance",
  "slot",
  "start_identity",
  "worker_id",
]);
const SAMPLE_EVIDENCE_KEYS: ReadonlySet<string> = new Set([
  "blocked_condition",
  "confirmed_at",
  "confirmed_by",
  "confirmed_stalled",
  "episode_id",
  "identity_verified",
  "progress",
  "provenance",
  "state",
]);
/** A symlink, FIFO or device never becomes the manifest, and opening one never blocks. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The datetime.fromisoformat extended calendar form, restricted to a UTC offset. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Injectable clocks and bounds. The defaults are the production values. */
export type ProcessHealthOptions = {
  /** The native call budget. */
  readonly maxCalls?: number;
  /** Monotonic milliseconds on the scale of a client's `deadline` (performance.now()). */
  readonly monotonic?: () => number;
  /** Wall-clock seconds since the epoch (time.time()). */
  readonly now?: () => number;
};

type Reference = {
  item_id: string;
  thread_id: string;
  turn_id: string;
};

type Identity = {
  invocation: Reference;
  job_id: string;
  kind: string;
  owner_parent_id: string;
  start_identity: string;
  worker_id: string | null;
};

type Progress = {
  contract_id: string;
  counter: number;
  epoch: string;
  expected_to_advance: boolean;
};

type Blocked = {
  code: string;
  confirmed: true;
  evidence_id: string;
};

type Evidence = {
  blocked_condition?: Blocked;
  confirmed_at: string;
  confirmed_by: string;
  confirmed_stalled?: boolean;
  episode_id?: string;
  identity_verified: true;
  progress?: Progress;
  provenance: "owner_attested";
  state: string;
};

type EvidenceRef = {
  blocked_condition: { code: string; evidence_id: string } | null;
  confirmed_at: string;
  confirmed_by: string;
  episode_id: string | null;
};

type Command = {
  exit_code: number | null;
  native_status: string;
};

type ClosureOutcome = {
  diagnostics: string[];
  provenance: string | null;
  reference: Reference | null;
  status: string;
};

type Budget = {
  calls_used: number;
  exhausted: boolean;
  max_calls: number;
  reason_code: string | null;
};

type Row = Identity & {
  closure_evidence_id: unknown;
  closure_next_review_slot: unknown;
  closure_provenance: string | null;
  closure_reason_code: unknown;
  closure_result_ref: Reference | null;
  closure_status: string;
  diagnostics: string[];
  exit_code: number | null;
  identity_provenance: "owner_attested";
  invocation_verified: boolean;
  lineage_verified: boolean;
  native_status: string | null;
  owner_evidence_ref: EvidenceRef | null;
  progress_provenance: "owner_attested";
  protected: boolean;
  requires_owner_action: boolean;
  stall_episode: string | null;
  state: string;
};

type Observation = Identity & {
  collected_at: string;
  owner_evidence: Evidence;
  protected: boolean;
  provenance: "owner_attested";
  slot: number;
};

type ParentHealth = {
  budget?: Budget;
  complete: boolean;
  diagnostics: string[];
  jobs: Row[];
  observations: Observation[];
  omitted_jobs: number;
  status: string;
};

type NativeOutcome =
  | { readonly closure: ClosureOutcome; readonly command: Command; readonly failure: null }
  | { readonly failure: string; readonly lineage: boolean };

function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

function isChoice(choices: ReadonlySet<string>, value: unknown): value is string {
  return typeof value === "string" && choices.has(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** Python equality of two parsed JSON values, where a missing key reads as None. */
function same(left: unknown, right: unknown): boolean {
  return sameJson(left ?? null, right ?? null);
}

/** Epoch seconds of a UTC ISO timestamp, or null when it is not one. */
function stamp(value: unknown): number | null {
  return utcStamp(value);
}

/** datetime.fromtimestamp(seconds, timezone.utc).isoformat() */
function isoformat(seconds: number): string {
  let whole = Math.floor(seconds);
  let micro = Math.round((seconds - whole) * 1e6);
  if (micro >= 1e6) {
    whole += 1;
    micro -= 1e6;
  }
  const text = new Date(whole * 1000).toISOString().slice(0, 19);
  const fraction = micro === 0 ? "" : `.${String(micro).padStart(6, "0")}`;
  return `${text}${fraction}+00:00`;
}

function isFresh(now: number, value: unknown): value is string {
  const parsed = stamp(value);
  return parsed !== null && now - parsed >= 0 && now - parsed <= MAX_AGE;
}

function referenceOf(value: unknown): Reference | null {
  if (!isRecord(value)) {
    return null;
  }
  const { item_id, thread_id, turn_id } = value;
  if (!isCanonicalUuid(thread_id) || !isToken(turn_id) || !isToken(item_id)) {
    return null;
  }
  return { item_id, thread_id, turn_id };
}

function identityOf(value: unknown): Identity | null {
  if (!isRecord(value)) {
    return null;
  }
  const { job_id, kind, owner_parent_id: parent, start_identity } = value;
  const worker = value.worker_id ?? null;
  const invocation = referenceOf(value.invocation);
  if (!isCanonicalUuid(parent) || (worker !== null && !isCanonicalUuid(worker))) {
    return null;
  }
  if (
    worker === parent ||
    !isChoice(KINDS, kind) ||
    !isToken(job_id) ||
    !isToken(start_identity) ||
    invocation === null ||
    invocation.thread_id !== (worker ?? parent)
  ) {
    return null;
  }
  return { invocation, job_id, kind, owner_parent_id: parent, start_identity, worker_id: worker };
}

function progressOf(value: unknown): Progress | null {
  if (!isRecord(value)) {
    return null;
  }
  const { contract_id, counter, epoch, expected_to_advance } = value;
  if (
    !isToken(contract_id) ||
    !isToken(epoch) ||
    !isInt(counter) ||
    counter < 0 ||
    counter >= 2 ** 63 ||
    typeof expected_to_advance !== "boolean"
  ) {
    return null;
  }
  return { contract_id, counter, epoch, expected_to_advance };
}

function blockedOf(value: unknown): Blocked | null {
  if (!isRecord(value)) {
    return null;
  }
  const { code, confirmed, evidence_id } = value;
  if (confirmed !== true || !isChoice(BLOCKS, code) || !isToken(evidence_id)) {
    return null;
  }
  return { code, confirmed, evidence_id };
}

function evidenceOf(now: number, parent: string, value: unknown): Evidence | null {
  if (!isRecord(value)) {
    return null;
  }
  const { confirmed_at, confirmed_stalled, episode_id, state } = value;
  if (
    value.confirmed_by !== parent ||
    value.identity_verified !== true ||
    value.provenance !== "owner_attested" ||
    !isChoice(STATES, state) ||
    !isFresh(now, confirmed_at)
  ) {
    return null;
  }
  const result: Evidence = {
    confirmed_at,
    confirmed_by: parent,
    identity_verified: true,
    provenance: "owner_attested",
    state,
  };
  if (typeof confirmed_stalled === "boolean") {
    result.confirmed_stalled = confirmed_stalled;
  }
  if (isToken(episode_id)) {
    result.episode_id = episode_id;
  }
  const progress = progressOf(value.progress);
  const blocked = blockedOf(value.blocked_condition);
  if (progress !== null) {
    result.progress = progress;
  }
  if (blocked !== null) {
    result.blocked_condition = blocked;
  }
  return result;
}

/** One native call budget and deadline shared by every job in a collection. */
class Reader {
  calls = 0;
  reason: string | null = null;
  private readonly client: RpcClient;
  private readonly maxCalls: number;
  private readonly monotonic: () => number;

  constructor(client: RpcClient, maxCalls: number, monotonic: () => number) {
    this.client = client;
    this.maxCalls = maxCalls;
    this.monotonic = monotonic;
  }

  async call(method: string, params: unknown): Promise<unknown> {
    // The collector reads the caller's deadline and never changes it.
    const { deadline } = this.client as unknown as { readonly deadline?: unknown };
    const expired =
      typeof deadline === "number" && Number.isFinite(deadline) && this.monotonic() >= deadline;
    if (expired) {
      this.reason = "native_deadline_exhausted";
    }
    if (this.calls >= this.maxCalls && this.reason === null) {
      this.reason = "native_call_budget_exhausted";
    }
    if (this.reason !== null) {
      throw new NativeTimeout("budget");
    }
    this.calls += 1;
    try {
      return await this.client.call(method, params);
    } catch (error) {
      if (error instanceof NativeTimeout) {
        this.reason = "native_timeout";
      }
      throw error;
    }
  }

  metadata(): Budget {
    return {
      calls_used: this.calls,
      exhausted: this.reason !== null,
      max_calls: this.maxCalls,
      reason_code: this.reason,
    };
  }
}

async function verifyLineage(
  reader: Reader,
  parent: string,
  worker: string | null,
): Promise<boolean> {
  if (worker === null) {
    return true;
  }
  const response = await reader.call("thread/read", { includeTurns: false, threadId: worker });
  const thread = isRecord(response) ? response.thread : undefined;
  if (!isRecord(thread) || thread.id !== worker || thread.parentThreadId !== parent) {
    return false;
  }
  const { source } = thread;
  if (isRecord(source) && Object.hasOwn(source, "subAgent")) {
    const { subAgent } = source;
    if (!isRecord(subAgent)) {
      return false;
    }
    const spawn = subAgent.thread_spawn;
    if (!isRecord(spawn) || spawn.parent_thread_id !== parent) {
      return false;
    }
  }
  return true;
}

async function readCommand(reader: Reader, reference: Reference): Promise<Command | null> {
  const response = await reader.call("thread/items/read", {
    itemIds: [reference.item_id],
    threadId: reference.thread_id,
    turnId: reference.turn_id,
  });
  const entries = isRecord(response) ? response.data : undefined;
  if (!Array.isArray(entries) || entries.length !== 1) {
    return null;
  }
  const [entry] = entries as unknown[];
  if (!isRecord(entry)) {
    return null;
  }
  const threadId = Object.hasOwn(entry, "threadId") ? entry.threadId : reference.thread_id;
  if (entry.turnId !== reference.turn_id || threadId !== reference.thread_id) {
    return null;
  }
  const { item } = entry;
  if (
    !isRecord(item) ||
    item.id !== reference.item_id ||
    item.type !== "commandExecution" ||
    !isChoice(COMMAND_STATUSES, item.status)
  ) {
    return null;
  }
  const { exitCode, status } = item;
  return {
    exit_code: isInt(exitCode) && exitCode >= -(2 ** 31) && exitCode < 2 ** 31 ? exitCode : null,
    native_status: status as string,
  };
}

function matches(
  identity: Identity,
  keys: readonly (keyof Identity)[],
  value: Record<string, unknown>,
): boolean {
  return keys.every((key) => same(value[key], identity[key]));
}

function sameJob(identity: Identity, other: Identity): boolean {
  return JOB_KEY.every((field) => other[field] === identity[field]);
}

function unavailableClosure(): ClosureOutcome {
  return {
    diagnostics: ["closure_receipt_unavailable"],
    provenance: null,
    reference: null,
    status: "unknown",
  };
}

function reportedClosure(): ClosureOutcome {
  return {
    diagnostics: ["closure_verification_unavailable"],
    provenance: "owner_attested",
    reference: null,
    status: "reported_closed",
  };
}

async function closureOutcome(
  reader: Reader,
  now: number,
  identity: Identity,
  value: unknown,
): Promise<ClosureOutcome> {
  if (value == null) {
    return { diagnostics: [], provenance: null, reference: null, status: "none" };
  }
  if (!isRecord(value)) {
    return unavailableClosure();
  }
  const { next_review_slot: nextSlot, state } = value;
  if (
    !matches(identity, CLOSURE_KEY, value) ||
    value.confirmed_by !== identity.owner_parent_id ||
    value.provenance !== "owner_attested" ||
    !isChoice(CLOSURES, state) ||
    !isToken(value.evidence_id) ||
    !isFresh(now, value.confirmed_at)
  ) {
    return unavailableClosure();
  }
  if ((state === "blocked" || state === "retained") && !isToken(value.reason_code)) {
    return unavailableClosure();
  }
  if (state === "retained" && (!isInt(nextSlot) || nextSlot < 0)) {
    return unavailableClosure();
  }
  if (state !== "verified_closed") {
    return { diagnostics: [], provenance: "owner_attested", reference: null, status: state };
  }
  const reference = referenceOf(value.native_result_ref);
  if (
    value.owner_verified !== true ||
    value.verification_succeeded !== true ||
    reference === null ||
    same(reference, identity.invocation) ||
    (reference.thread_id !== identity.owner_parent_id && reference.thread_id !== identity.worker_id)
  ) {
    return reportedClosure();
  }
  const command = await readCommand(reader, reference).catch(() => null);
  if (command === null || command.native_status !== "completed" || command.exit_code !== 0) {
    return reportedClosure();
  }
  return {
    diagnostics: [],
    provenance: "owner_verified_native_result_corroborated",
    reference,
    status: "verified_closed",
  };
}

function scheduledCapture(slot: unknown, collectedAt: number | null): boolean {
  return (
    isInt(slot) &&
    slot >= 0 &&
    slot % 60 === 0 &&
    collectedAt !== null &&
    collectedAt - slot >= 0 &&
    collectedAt - slot < 60
  );
}

/**
 * Whether a trusted prior scheduled sample shows the same expected-to-advance progress and the same
 * corroborated block under an earlier owner confirmation. Prior evidence is evaluated at its
 * original scheduled observation; the caller supplies trusted typed snapshots, not native proof.
 */
function twoSamples(
  now: number,
  slot: number | null,
  identity: Identity,
  evidence: Evidence,
  prior: readonly unknown[],
): boolean {
  if (slot === null || !scheduledCapture(slot, now)) {
    return false;
  }
  const { blocked_condition: blocked, confirmed_at: confirmedAt, episode_id, progress } = evidence;
  if (
    progress === undefined ||
    !progress.expected_to_advance ||
    blocked === undefined ||
    episode_id === undefined
  ) {
    return false;
  }
  const current = stamp(confirmedAt);
  for (const sample of prior) {
    if (
      !isRecord(sample) ||
      !matches(identity, IDENTITY, sample) ||
      sample.protected !== false ||
      sample.provenance !== "owner_attested"
    ) {
      continue;
    }
    const { slot: sampleSlot } = sample;
    if (!isInt(sampleSlot) || sampleSlot < 0 || sampleSlot >= slot) {
      continue;
    }
    const collectedAt = stamp(sample.collected_at);
    if (collectedAt === null || !scheduledCapture(sampleSlot, collectedAt) || collectedAt > now) {
      continue;
    }
    const old = evidenceOf(collectedAt, identity.owner_parent_id, sample.owner_evidence);
    const previous = old === null ? null : stamp(old.confirmed_at);
    if (
      old === null ||
      (old.state !== "running" && old.state !== "blocked") ||
      old.episode_id !== episode_id ||
      !same(old.progress, progress) ||
      !same(old.blocked_condition, blocked) ||
      previous === null ||
      current === null ||
      previous >= current
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Whether json.dumps(value, ensure_ascii=False) encodes within `limit` UTF-8 bytes. Key order does
 * not change that length, so this measures Python's unsorted encoding without producing it.
 */
function encodesWithin(limit: number, value: unknown): boolean {
  const active = new Set<object>();
  let size = 0;
  const add = (bytes: number): boolean => {
    size += bytes;
    return size <= limit;
  };
  const text = (item: string): boolean =>
    !LONE_SURROGATE.test(item) && add(Buffer.byteLength(JSON.stringify(item), "utf8"));
  const visit = (item: unknown): boolean => {
    if (item === null) {
      return add(4);
    }
    if (typeof item === "boolean") {
      return add(item ? 4 : 5);
    }
    if (typeof item === "number") {
      if (Number.isFinite(item)) {
        return add(String(item).length);
      }
      // NaN, Infinity and -Infinity, which Python writes by default.
      return add(Number.isNaN(item) ? 3 : item > 0 ? 8 : 9);
    }
    if (typeof item === "bigint") {
      return add(item.toString().length);
    }
    if (typeof item === "string") {
      return text(item);
    }
    if (typeof item !== "object" || active.has(item)) {
      return false;
    }
    active.add(item);
    let fits: boolean;
    if (Array.isArray(item)) {
      fits =
        add(2 + Math.max(0, item.length - 1) * 2) &&
        (item as unknown[]).every((entry) => visit(entry));
    } else {
      const entries = Object.entries(item);
      fits =
        add(2 + Math.max(0, entries.length - 1) * 2) &&
        entries.every(([key, entry]) => text(key) && add(2) && visit(entry));
    }
    active.delete(item);
    return fits;
  };
  try {
    return visit(value);
  } catch {
    // RangeError on deep nesting, where Python raises RecursionError.
    return false;
  }
}

function manifestJobs(value: unknown): unknown[] | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.jobs)) {
    return null;
  }
  if (!encodesWithin(MAX_BYTES, value)) {
    return null;
  }
  return value.jobs as unknown[];
}

async function inspectNative(
  reader: Reader,
  now: number,
  identity: Identity,
  closure: unknown,
): Promise<NativeOutcome> {
  let lineage = false;
  try {
    lineage = await verifyLineage(reader, identity.owner_parent_id, identity.worker_id);
    if (!lineage) {
      return { failure: "worker_lineage_unverified", lineage };
    }
    const command = await readCommand(reader, identity.invocation);
    if (command === null) {
      return { failure: "native_invocation_unavailable", lineage };
    }
    const outcome = await closureOutcome(reader, now, identity, closure);
    return { closure: outcome, command, failure: null };
  } catch {
    return { failure: reader.reason ?? "native_metadata_unavailable", lineage };
  }
}

/**
 * Exact allowed-parent metadata for an optional owner-record backend.
 *
 * registrations is {version: 1, jobs: [...]}, at most 1 MiB and 100 inspected jobs. Only exact
 * scoped thread/read and thread/items/read calls are made, bounded by 256 calls and the client's
 * `deadline`, which this never changes. Runtime identity, state and progress remain owner_attested.
 * A native exit result alone proves neither runtime identity nor closure. verified_closed means
 * explicit owner verification corroborated by its successful native result reference. Output is
 * data for closure requests to the owner, never authority to mutate resources.
 *
 * A null slot is observational: it neither infers two-sample stalls nor emits scheduled
 * observations. Prior observations must have been fresh at collected_at, within the original
 * slot's 60-second minute window. No interval between distinct scheduled slots is assumed.
 */
export async function collectProcessHealth(
  client: RpcClient,
  registrations: Record<string, unknown>,
  allowedParents: readonly string[],
  slot: number | null,
  priorObservations: readonly unknown[] | null = null,
  options: ProcessHealthOptions = {},
): Promise<Record<string, Record<string, unknown>>> {
  if (
    !Array.isArray(allowedParents as unknown) ||
    !allowedParents.every((parent) => isCanonicalUuid(parent)) ||
    new Set(allowedParents).size !== allowedParents.length
  ) {
    throw new Error("invalid_parent_scope");
  }
  if (slot !== null && (!isInt(slot) || slot < 0)) {
    throw new Error("invalid_slot");
  }
  const reader = new Reader(
    client,
    options.maxCalls ?? MAX_CALLS,
    options.monotonic ?? (() => performance.now()),
  );
  const now = (options.now ?? (() => Date.now() / 1000))();
  const output = new Map<string, ParentHealth>();
  for (const parent of allowedParents) {
    output.set(parent, {
      complete: true,
      diagnostics: ["live_process_getter_unavailable"],
      jobs: [],
      observations: [],
      omitted_jobs: 0,
      status: "complete",
    });
  }
  const jobs = manifestJobs(registrations);
  if (jobs === null) {
    for (const result of output.values()) {
      result.status = "unavailable";
      result.complete = false;
      result.budget = reader.metadata();
      result.diagnostics.push("owner_manifest_unavailable");
    }
    return Object.fromEntries(output);
  }
  const prior = (Array.isArray(priorObservations) ? priorObservations : []).slice(0, MAX_JOBS * 2);
  const seen = new Map<string, Row>();
  for (const registration of jobs.slice(0, MAX_JOBS)) {
    const identity = identityOf(registration);
    const result = identity === null ? undefined : output.get(identity.owner_parent_id);
    if (!isRecord(registration) || identity === null || result === undefined) {
      for (const each of output.values()) {
        each.complete = false;
        each.diagnostics.push("registration_invalid_or_out_of_scope");
      }
      continue;
    }
    const key = JSON.stringify(JOB_KEY.map((field) => identity[field]));
    const previous = seen.get(key);
    if (previous !== undefined) {
      result.complete = false;
      result.diagnostics.push("duplicate_job_identity");
      previous.state = "unknown";
      previous.requires_owner_action = false;
      previous.stall_episode = null;
      previous.owner_evidence_ref = null;
      previous.diagnostics.push("duplicate_job_identity");
      const kept = result.observations.filter((sample) => !sameJob(identity, sample));
      result.observations = kept;
      continue;
    }
    const declared = Object.hasOwn(registration, "protected") ? registration.protected : false;
    const row: Row = {
      ...identity,
      closure_evidence_id: null,
      closure_next_review_slot: null,
      closure_provenance: null,
      closure_reason_code: null,
      closure_result_ref: null,
      closure_status: "unknown",
      diagnostics: [],
      exit_code: null,
      identity_provenance: "owner_attested",
      invocation_verified: false,
      lineage_verified: false,
      native_status: null,
      owner_evidence_ref: null,
      progress_provenance: "owner_attested",
      protected: typeof declared === "boolean" ? declared : true,
      requires_owner_action: false,
      stall_episode: null,
      state: "unknown",
    };
    seen.set(key, row);
    result.jobs.push(row);
    const evidence = evidenceOf(now, identity.owner_parent_id, registration.owner_evidence);
    if (evidence === null || typeof declared !== "boolean") {
      row.protected = true;
      row.diagnostics.push("owner_identity_or_evidence_unavailable");
      continue;
    }
    // Every job draws on one shared call budget and deadline, so reads run in manifest order.
    // eslint-disable-next-line no-await-in-loop
    const outcome = await inspectNative(reader, now, identity, registration.closure);
    if (outcome.failure !== null) {
      row.lineage_verified = outcome.lineage;
      row.diagnostics.push(outcome.failure);
      continue;
    }
    const { closure, command } = outcome;
    row.lineage_verified = true;
    row.native_status = command.native_status;
    row.exit_code = command.exit_code;
    row.invocation_verified = true;
    const blocked = evidence.blocked_condition;
    row.owner_evidence_ref = {
      blocked_condition:
        blocked === undefined ? null : { code: blocked.code, evidence_id: blocked.evidence_id },
      confirmed_at: evidence.confirmed_at,
      confirmed_by: evidence.confirmed_by,
      episode_id: evidence.episode_id ?? null,
    };
    row.closure_status = closure.status;
    row.closure_provenance = closure.provenance;
    row.closure_result_ref = closure.reference;
    row.diagnostics.push(...closure.diagnostics);
    if (closure.status !== "none" && closure.status !== "unknown") {
      const receipt = registration.closure as Record<string, unknown>;
      row.closure_evidence_id = receipt.evidence_id;
      if (closure.status === "blocked" || closure.status === "retained") {
        row.closure_reason_code = receipt.reason_code;
      }
      if (closure.status === "retained") {
        row.closure_next_review_slot = receipt.next_review_slot;
      }
    }
    const { state } = evidence;
    if (state === "waiting_on_user") {
      row.state = "blocked";
    } else if (state === "service") {
      row.state = "running";
    } else {
      row.state = state;
    }
    if (state === "waiting_on_user" || state === "service") {
      row.protected = true;
    }
    if (
      (state === "running" || state === "blocked") &&
      !row.protected &&
      evidence.episode_id !== undefined &&
      (evidence.confirmed_stalled === true || twoSamples(now, slot, identity, evidence, prior))
    ) {
      row.state = "stalled";
      row.stall_episode = evidence.episode_id;
      row.requires_owner_action = OWNER_ACTION.has(closure.status);
    }
    if (slot !== null && scheduledCapture(slot, now)) {
      result.observations.push({
        ...identity,
        collected_at: isoformat(now),
        owner_evidence: evidence,
        protected: row.protected,
        provenance: "owner_attested",
        slot,
      });
    } else if (slot !== null) {
      result.diagnostics.push("scheduled_sample_time_unavailable");
    }
  }
  for (const result of output.values()) {
    if (jobs.length > MAX_JOBS) {
      result.complete = false;
      result.omitted_jobs = jobs.length - MAX_JOBS;
      result.diagnostics.push("job_bound_exceeded");
    }
    if (result.jobs.some((job) => job.state === "unknown" || job.diagnostics.length > 0)) {
      result.complete = false;
    }
    result.status = result.complete ? "complete" : "partial";
    result.diagnostics = [...new Set(result.diagnostics)].sort();
    result.budget = reader.metadata();
  }
  return Object.fromEntries(output);
}

/** Whether a stored observation has the collector's exact safe sample shape. Never proof. */
export function processSample(allowedParents: readonly string[], sample: unknown): boolean {
  if (!isRecord(sample)) {
    return false;
  }
  const keys = Object.keys(sample);
  const { owner_evidence: evidence, owner_parent_id: parent } = sample;
  if (
    keys.length !== SAMPLE_KEYS.size ||
    !keys.every((key) => SAMPLE_KEYS.has(key)) ||
    typeof parent !== "string" ||
    !allowedParents.includes(parent) ||
    !isInt(sample.slot) ||
    sample.provenance !== "owner_attested" ||
    !isRecord(evidence) ||
    !Object.keys(evidence).every((key) => SAMPLE_EVIDENCE_KEYS.has(key)) ||
    evidence.provenance !== "owner_attested"
  ) {
    return false;
  }
  try {
    // json.dumps escapes non-ASCII, as dumpsJson does; key order does not change the length.
    return Buffer.byteLength(dumpsJson(sample as PyJson), "utf8") <= MAX_SAMPLE_BYTES;
  } catch {
    return false;
  }
}

function unavailableHealth(code: string): Record<string, unknown> {
  return {
    complete: false,
    diagnostics: [code],
    jobs: [],
    observations: [],
    omitted_jobs: 0,
    status: "unavailable",
  };
}

function unavailableFor(
  allowed: readonly string[],
  code: string,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(allowed.map((parent) => [parent, unavailableHealth(code)]));
}

/** Reads at most one byte past the bound from an open descriptor, then closes it. */
function readRegular(descriptor: number): Buffer {
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) {
      throw new Error("process_manifest_not_regular");
    }
    if (info.size > MAX_BYTES) {
      throw new Error("process_manifest_size_exceeded");
    }
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) {
        break;
      }
      length += count;
    }
    if (length > MAX_BYTES) {
      throw new Error("process_manifest_size_exceeded");
    }
    return buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

/** The parsed manifest, or the reason code it is unavailable. */
function readManifest(allowed: readonly string[], path: string): Record<string, unknown> | string {
  try {
    if (allowed.length === 0) {
      throw new Error("process_route_unavailable");
    }
    if (!isAbsolute(path)) {
      throw new Error("process_manifest_path_invalid");
    }
    const data = readRegular(openSync(path, OPEN_FLAGS));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    const registrations: unknown = JSON.parse(text);
    if (
      !isRecord(registrations) ||
      registrations.version !== 1 ||
      !Array.isArray(registrations.jobs) ||
      registrations.jobs.length > MAX_JOBS
    ) {
      throw new Error("process_manifest_schema_unavailable");
    }
    return registrations;
  } catch (error) {
    return error instanceof Error && MANIFEST_CODES.has(error.message)
      ? error.message
      : "process_manifest_unavailable";
  }
}

/**
 * Optional process health for already-scoped parents. An undefined manifest path is the disabled
 * feature: nothing is read or called. Manifest registration never expands the requested scope.
 * Returns the per-parent health and the source status.
 */
export async function processHealth(
  client: RpcClient,
  manifestPath: string | undefined,
  allowed: readonly string[],
  slot: number | null,
  priorObservations: unknown,
  options: ProcessHealthOptions = {},
): Promise<[Record<string, Record<string, unknown>>, Record<string, unknown>]> {
  if (manifestPath === undefined) {
    return [{}, { diagnostics: [], status: "disabled" }];
  }
  const manifest = readManifest(allowed, manifestPath);
  if (typeof manifest === "string") {
    return [unavailableFor(allowed, manifest), { diagnostics: [manifest], status: "unavailable" }];
  }
  const prior =
    isInt(slot) && Array.isArray(priorObservations)
      ? (priorObservations as unknown[]).filter((sample) => processSample(allowed, sample))
      : null;
  try {
    const collected = await collectProcessHealth(client, manifest, allowed, slot, prior, options);
    const result: Record<string, Record<string, unknown>> = {};
    for (const parent of allowed) {
      const value = Object.hasOwn(collected, parent) ? collected[parent] : undefined;
      const valid =
        isRecord(value) &&
        isChoice(COLLECTOR_STATUSES, value.status) &&
        Array.isArray(value.jobs) &&
        Array.isArray(value.observations);
      result[parent] = valid ? value : unavailableHealth("process_collector_unavailable");
    }
    return [result, { diagnostics: [], status: "available" }];
  } catch {
    const code = "process_collector_unavailable";
    return [unavailableFor(allowed, code), { diagnostics: [code], status: "unavailable" }];
  }
}
