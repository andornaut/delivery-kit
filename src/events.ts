// Bus events: durable enqueue with sha256(kind:key) dedupe and bounded delivery.
//
// emitEvent records an event once under events/state.lock and tracks per-SHA CI and deployment
// state, adding a `complete` event when a pushed commit has CI success and a finished deployment.
// flushEvents delivers unsent events in creation order under the non-blocking dispatch.lock,
// through the recipient's selected adapter, and marks an event sent only after its delivery is
// accepted. The first event not accepted stops the flush; a later flush resumes there.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { claudeAdapter } from "./adapters/claude/index.ts";
import { codexAdapter, type ReceiptSeed } from "./adapters/codex/index.ts";
import { eventRequestId, isCanonicalUuid, SHA_PATTERN } from "./adapters/shared/ids.ts";
import { dumpsJson, isRecord, type PyJson } from "./adapters/shared/pyjson.ts";
import { readRoleRoute, type RoleRoute } from "./adapters/shared/route.ts";
import type { DeliveryReceipt, HarnessAdapter } from "./adapters/types.ts";
import { loadProjectConfig } from "./config.ts";
import { readJson, writeDurable } from "./durable.ts";
import { type GameLayout, type Layout, loadLayout } from "./layout.ts";
import { holdLock, LockBusy, type LockHandle } from "./lock.ts";
import { resolveConversation, resolveHarness, resolveRole } from "./registry/resolve.ts";
import type { Harness } from "./registry/schema.ts";
import { readRegistry } from "./registry/store.ts";

export interface EmitOptions {
  readonly project: string;
}

/** Progress kinds that never notify; flush marks any already queued as suppressed. */
const QUIET_KINDS: ReadonlySet<string> = new Set([
  "ci_pending",
  "ci_running",
  "deploy_pending",
  "deploy_retry",
]);

/** Delivered text, suffix included, stays within this many UTF-8 bytes. */
export const DELIVERY_BUDGET = 900;
const CLEAN_LIMIT = 1800;

export interface BusEvent {
  [key: string]: PyJson | undefined;
  created: bigint;
  id: string;
  kind: string;
  key: string;
  message: string;
  sent: boolean;
  suppressed?: boolean;
}

interface CommitState {
  [key: string]: PyJson | undefined;
  ci: string;
  deploy: string;
  pushed?: boolean;
}

export function eventsDir(game: GameLayout): string {
  return join(game.busDir, "events");
}

/** Every blocked-* kind shares one identity, so a changed block reason does not repeat. */
export function eventId(kind: string, key: string): string {
  const identityKind = kind.startsWith("blocked-") ? "blocked" : kind;
  return createHash("sha256").update(`${identityKind}:${key}`, "utf8").digest("hex");
}

/** Control characters become spaces; at most 1800 code points are kept. */
export function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return Array.from(value.replace(/[\x00-\x1f\x7f]/g, " "))
    .slice(0, CLEAN_LIMIT)
    .join("");
}

/** The message cut to the byte budget at a character boundary, then the event ID suffix. */
export function deliveryMessage(event: Pick<BusEvent, "id" | "message">): string {
  const suffix = ` [bus event ${event.id.slice(0, 12)}]`;
  const budget = DELIVERY_BUDGET - Buffer.byteLength(suffix, "utf8");
  const body = Buffer.from(event.message, "utf8");
  let end = Math.min(budget, body.length);
  // A cut inside a multi-byte sequence drops the partial character.
  while (end > 0 && end < body.length && ((body[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return `${body.subarray(0, end).toString("utf8")}${suffix}`;
}

// Wall-clock nanoseconds like time.time_ns(), but monotonic within this process so events
// emitted in sequence keep their order.
const EPOCH_OFFSET = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();

function nowNanoseconds(): bigint {
  return EPOCH_OFFSET + process.hrtime.bigint();
}

function writeState(path: string, value: PyJson): void {
  writeDurable(path, `${dumpsJson(value)}\n`);
}

function enqueue(
  directory: string,
  project: string,
  kind: string,
  key: string,
  message: string,
): void {
  if (QUIET_KINDS.has(kind)) {
    return;
  }
  const id = eventId(kind, key);
  const path = join(directory, `${id}.json`);
  if (existsSync(path)) {
    return;
  }
  const event: BusEvent = {
    created: nowNanoseconds(),
    id,
    key: clean(key),
    kind,
    message: clean(`${project} bus: ${message}`),
    sent: false,
  };
  writeState(path, event);
}

function deployFinished(state: CommitState): boolean {
  return state.deploy === "success" || state.deploy === "skipped";
}

function trackCommit(directory: string, project: string, kind: string, key: string): void {
  const path = join(directory, `${key}.state`);
  const initial = { ci: "pending", deploy: "pending" };
  const state = (existsSync(path) ? readJson(path) : initial) as CommitState;
  const quiet = QUIET_KINDS.has(kind);
  if (kind.startsWith("ci_") && !(quiet && state.ci === "success")) {
    state.ci = kind.slice(3);
  }
  if (kind.startsWith("deploy_") && !(quiet && deployFinished(state))) {
    state.deploy = kind.slice(7);
  }
  if (kind === "push") {
    state.pushed = true;
  }
  writeState(path, state);
  if (state.pushed === true && state.ci === "success" && deployFinished(state)) {
    enqueue(
      directory,
      project,
      "complete",
      key,
      `COMPLETE ${key}: full gate passed; CI success; deployment ${state.deploy}.`,
    );
  }
}

/** Record one event, at most once per identity. A 40-hex key also updates that commit's state. */
export function emitEvent(
  game: GameLayout,
  options: EmitOptions,
  kind: string,
  key: string,
  message: string,
): void {
  const directory = eventsDir(game);
  mkdirSync(directory, { recursive: true });
  const lock = holdLock(join(directory, "state.lock"));
  try {
    enqueue(directory, options.project, kind, key, message);
    if (SHA_PATTERN.test(key)) {
      trackCommit(directory, options.project, kind, key);
    }
  } finally {
    lock.release();
  }
}

/** Read an event, keeping its nanosecond `created` exact rather than as a float. */
function readEvent(path: string): BusEvent {
  const text = readFileSync(path, "utf8");
  const event = JSON.parse(text) as BusEvent;
  const created = /"created":\s*(-?\d+)\b/.exec(text)?.[1];
  event.created =
    created === undefined ? BigInt(Math.trunc(Number(event.created))) : BigInt(created);
  return event;
}

function pendingEvents(directory: string): BusEvent[] | null {
  const events: BusEvent[] = [];
  for (const name of readdirSync(directory)) {
    if (name.startsWith(".") || !name.endsWith(".json")) {
      continue;
    }
    try {
      events.push(readEvent(join(directory, name)));
    } catch {
      // One unreadable event stops the whole flush.
      return null;
    }
  }
  // Stable: equal creation times keep directory order.
  return events.sort((left, right) => {
    if (left.created === right.created) {
      return 0;
    }
    return left.created < right.created ? -1 : 1;
  });
}

/** A harness adapter whose deliver may also bind extra receipt fields. */
export interface EventAdapter extends HarnessAdapter {
  deliver(
    receiptPath: string,
    requestId: string,
    conversationId: string,
    text: string,
    seed?: ReceiptSeed,
  ): Promise<DeliveryReceipt>;
}

export type AdapterFactory = (layout: Layout, game: GameLayout) => EventAdapter;
export type AdapterFactories = Readonly<Partial<Record<Harness, AdapterFactory>>>;

/** The adapter per harness. A harness without one defers delivery. */
const DEFAULT_ADAPTERS: AdapterFactories = {
  // The Claude adapter takes the event ID from the receipt file name and ignores the seed.
  claude: (_layout, game) => claudeAdapter(process.env, game),
  codex: (layout) => codexAdapter(layout),
};

/** The lock when free; null when another flush holds it. */
function tryLock(path: string): LockHandle | null {
  try {
    return holdLock(path, { nonBlocking: true });
  } catch (error) {
    if (error instanceof LockBusy) {
      return null;
    }
    throw error;
  }
}

/** var/games/<g>/ is three levels below the game-dev root. */
function gameDevRoot(game: GameLayout): string {
  return resolve(game.stateDir, "..", "..", "..");
}

/**
 * Event routing by role. Events go only to the registry recipient through the active adapter,
 * with no queue fallback. An invalid route, or a held one for its own monitor, defers every
 * event; any other recipient, or no route at all, is delivered.
 */
function eventRouting(layout: Layout, recipientRole: string): "defer" | "deliver" {
  let route: RoleRoute | null;
  try {
    route = readRoleRoute(layout);
  } catch {
    return "defer";
  }
  return route !== null && route.monitor === recipientRole && route.state === "held"
    ? "defer"
    : "deliver";
}

interface Destination {
  readonly adapter: EventAdapter;
  readonly harness: Harness;
  readonly recipient: string;
}

function destination(adapters: AdapterFactories, game: GameLayout): Destination | null {
  try {
    const layout = loadLayout(gameDevRoot(game));
    const registry = readRegistry(layout);
    const role = loadProjectConfig(game.configFile).reports.recipient;
    const recipient = resolveConversation(registry, role);
    const harness = resolveHarness(registry, role);
    const factory = adapters[harness];
    if (recipient === null || factory === undefined) {
      return null;
    }
    if (eventRouting(layout, resolveRole(registry, role)) === "defer") {
      return null;
    }
    return { adapter: factory(layout, game), harness, recipient };
  } catch {
    // An unresolvable recipient leaves every event unsent for a later flush.
    return null;
  }
}

const STORED_EVENT_STATUSES: ReadonlySet<string> = new Set([
  "accepted",
  "ambiguous",
  "deferred",
  "rejected",
  "sending",
]);
const STORED_EVENT_METHODS: ReadonlySet<string> = new Set([
  "claude-channel",
  "turn/start",
  "turn/steer",
]);

/** Retargeting never retries a native send whose outcome is still unknown. */
function previousDelivery(
  directory: string,
  target: Destination,
  event: BusEvent,
): "accepted" | "blocked" | "none" {
  let accepted = false;
  let blocked = false;
  try {
    const names = readdirSync(directory).filter(
      (name) => name.startsWith(`${event.id}-`) && name.endsWith(".json"),
    );
    for (const name of names) {
      const value = readJson(join(directory, name));
      if (
        !isRecord(value) ||
        !isCanonicalUuid(value.recipient) ||
        name !== `${event.id}-${value.recipient}.json` ||
        value.event_id !== event.id ||
        value.clientUserMessageId !== eventRequestId(event.id, value.recipient) ||
        !Array.isArray(value.attempts) ||
        typeof value.status !== "string" ||
        !STORED_EVENT_STATUSES.has(value.status) ||
        value.attempts.some(
          (attempt) =>
            !isRecord(attempt) ||
            typeof attempt.method !== "string" ||
            !STORED_EVENT_METHODS.has(attempt.method) ||
            typeof attempt.status !== "string" ||
            attempt.status === "deferred" ||
            !STORED_EVENT_STATUSES.has(attempt.status),
        )
      ) {
        return "blocked";
      }
      if (value.status === "accepted") {
        accepted = true;
      }
      if (["sending", "ambiguous", "rejected"].includes(value.status)) {
        const methods = value.attempts.map((attempt) =>
          isRecord(attempt) ? attempt.method : null,
        );
        const otherProvider = methods.some((method) =>
          target.harness === "codex"
            ? method !== "turn/start" && method !== "turn/steer"
            : method !== "claude-channel",
        );
        blocked ||= value.recipient !== target.recipient || otherProvider;
      }
    }
  } catch {
    return "blocked";
  }
  return accepted ? "accepted" : blocked ? "blocked" : "none";
}

/** Deliver unsent events through `adapters`; the testable form of flushEvents. */
export async function flushEventsWith(adapters: AdapterFactories, game: GameLayout): Promise<void> {
  const directory = eventsDir(game);
  if (!existsSync(directory)) {
    return;
  }
  const lock = tryLock(join(directory, "dispatch.lock"));
  if (lock === null) {
    return;
  }
  try {
    if (destination(adapters, game) === null) {
      return;
    }
    const events = pendingEvents(directory);
    if (events === null) {
      return;
    }
    const receipts = join(directory, "native");
    mkdirSync(receipts, { recursive: true });
    for (const event of events) {
      if (event.suppressed === true || event.sent) {
        continue;
      }
      const path = join(directory, `${event.id}.json`);
      if (QUIET_KINDS.has(event.kind)) {
        event.suppressed = true;
        writeState(path, event);
        continue;
      }
      const target = destination(adapters, game);
      if (target === null) {
        return;
      }
      const previous = previousDelivery(receipts, target, event);
      if (previous === "blocked") {
        process.stderr.write(
          `delivery-kit: event ${event.id} held: reconcile prior native receipt before retargeting\n`,
        );
        return;
      }
      if (previous === "accepted") {
        event.sent = true;
        writeState(path, event);
        continue;
      }
      const requestId = eventRequestId(event.id, target.recipient);
      // Events deliver one at a time in creation order and stop at the first refusal.
      // eslint-disable-next-line no-await-in-loop
      const receipt = await target.adapter.deliver(
        join(receipts, `${event.id}-${target.recipient}.json`),
        requestId,
        target.recipient,
        deliveryMessage(event),
        { event_id: event.id },
      );
      if (receipt.status !== "accepted") {
        return;
      }
      event.sent = true;
      writeState(path, event);
    }
  } finally {
    lock.release();
  }
}

export function flushEvents(game: GameLayout): Promise<void> {
  return flushEventsWith(DEFAULT_ADAPTERS, game);
}
