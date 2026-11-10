// Scheduled monitor wake for a due slot. The adapter follows the monitor's selected harness; the monitor and
// worker parents are role names resolved through the registry. The result is the one-line JSON
// status the runner logs, or an empty string when this project does not dispatch the slot.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";

import { claudeAdapter } from "../adapters/claude/index.ts";
import { spoolMonitorBrief, unblockDir } from "../adapters/claude/spool.ts";
import { collectAll, unavailableCollected } from "../adapters/codex/collect.ts";
import { SOCKET_MISSING } from "../adapters/codex/index.ts";
import { queueEntries, queuePayload } from "../adapters/codex/inventory.ts";
import { connectControl, type RpcClient } from "../adapters/codex/rpc.ts";
import { persistSlot, previousSlot, SlotInterrupted } from "../adapters/codex/slot.ts";
import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { isRecord, pyJsonDumps } from "../adapters/shared/pyjson.ts";
import {
  type ActiveScope,
  activeScope,
  readRoleRoute,
  roleConversation,
  type RoleRoute,
  RouteError,
  sendRoute,
} from "../adapters/shared/route.ts";
import type { HarnessAdapter, Inventory } from "../adapters/types.ts";
import { loadProjectConfig } from "../config.ts";
import { readJson } from "../durable.ts";
import { emitEvent } from "../events.ts";
import type { GameLayout, Layout } from "../layout.ts";
import { holdLock, LockBusy, type LockHandle } from "../lock.ts";
import { resolveRole } from "../registry/resolve.ts";
import type { Harness } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import { type HealthEmit, recordHealth } from "./health.ts";
import { reconcileSlot } from "./reconcile.ts";
import { captureMixed } from "./snapshot.ts";
import { type Json, locked, snapshotPath } from "./store.ts";

export const MONITOR_ROLE = "monitor";
const PRINTED = [
  "status",
  "previousStatus",
  "reason",
  "snapshot_id",
  "snapshot_path",
  "history_status",
  "worker_health_status",
  "question_state_status",
  "monitor_status",
  "monitor_reason",
  "recipient",
  "backlog_slots",
  "deferral_slots",
  "monitor_session_status",
] as const;

function line(outcome: Readonly<Record<string, unknown>>): string {
  const printed: Record<string, unknown> = {};
  for (const key of PRINTED) {
    if (Object.hasOwn(outcome, key)) {
      printed[key] = outcome[key];
    }
  }
  return pyJsonDumps(printed);
}

/** A runner log line for a wake the runner defers before any helper runs. */
export const DEFERRED_PREFIX = "bus: monitor deferred: ";

const PARENTS_INVALID =
  "worker parents must resolve through var/registry.json roles to distinct canonical UUIDs " +
  "in the active var/route.json";
const CONNECT_MS = 25_000;
const ROUTE_UNAVAILABLE =
  "monitor route is unavailable or invalid; its owner must verify identities and ownership";

function socketAvailable(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

/** Serializes calls: the connection matches one outstanding response at a time. */
class SerialClient implements RpcClient {
  readonly #client: RpcClient;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(client: RpcClient) {
    this.#client = client;
  }

  call(method: string, params: unknown): Promise<unknown> {
    const run = this.#tail.then(() => this.#client.call(method, params));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.#client.close();
  }
}

function unsupported(): never {
  throw new Error("snapshot adapter only reads inventory and collectors");
}

/** Inventory and collectors over one connection, or every capability unavailable without one. */
function snapshotAdapter(client: RpcClient | null, deadline: number): HarnessAdapter {
  return {
    ack: unsupported,
    collectors: {
      collect: (request) =>
        client === null
          ? Promise.resolve(unavailableCollected("collector_unavailable", request))
          : collectAll(client, deadline, request).catch(() =>
              unavailableCollected("collector_unavailable", request),
            ),
    },
    deliver: unsupported,
    harness: "codex",
    async inventory(conversationId: string): Promise<Inventory> {
      try {
        if (client === null) {
          throw new Error(SOCKET_MISSING);
        }
        const entries = await queueEntries(client, conversationId);
        return {
          entries: entries.map((entry) => ({
            clientUserMessageId: entry.clientUserMessageId,
            payload: queuePayload(entry),
            queueId: entry.id,
          })),
          status: "available",
        };
      } catch {
        return {
          entries: [],
          reason: "queue inventory unavailable or incomplete; retry snapshot before reconciliation",
          status: "unavailable",
        };
      }
    },
    status: unsupported,
  };
}

interface Wake {
  readonly claude: HarnessAdapter;
  readonly harnesses: Readonly<Record<string, Harness>>;
  readonly unblock: string;
  readonly busDir: string;
  readonly coordinator: string;
  readonly peers: readonly string[];
  readonly parents: readonly string[];
  readonly slot: number;
  readonly socket: string;
  readonly emit: HealthEmit;
  readonly signal?: AbortSignal | undefined;
}

function capture(wake: Wake, client: RpcClient | null, deadline: number): Promise<Json> {
  const recipients = [...new Set([wake.coordinator, ...wake.peers])];
  return locked(wake.unblock, () =>
    captureMixed(
      { busDir: wake.busDir, unblock: wake.unblock },
      { claude: wake.claude, codex: snapshotAdapter(client, deadline) },
      wake.harnesses,
      recipients,
      wake.parents,
      { routeMembers: recipients, slot: wake.slot },
    ),
  );
}

/** One slot under the non-blocking unblock lock, over one native connection. */
async function runSlot(wake: Wake): Promise<Json> {
  const { coordinator, slot, unblock } = wake;
  const health = { emit: wake.emit, unblock };
  if (
    wake.parents.some((parent) => !isCanonicalUuid(parent)) ||
    new Set(wake.parents).size !== wake.parents.length
  ) {
    return { reason: PARENTS_INVALID, status: "deferred" };
  }
  mkdirSync(unblock, { recursive: true });
  const path = join(unblock, `${coordinator}-${slot}.json`);
  let lock: LockHandle;
  try {
    lock = holdLock(join(unblock, "unblock.lock"), { nonBlocking: true });
  } catch (error) {
    if (error instanceof LockBusy) {
      return { status: "busy" };
    }
    throw error;
  }
  let client: RpcClient | null = null;
  let snapshot: Json | undefined;
  try {
    try {
      if (!socketAvailable(wake.socket)) {
        snapshot = await capture(wake, null, 0);
        const state: Json = { reason: SOCKET_MISSING, status: "deferred" };
        Object.assign(state, recordHealth(health, coordinator, slot, snapshot, state));
        state.snapshot_path = snapshotPath(unblock, String(snapshot.snapshot_id));
        return state;
      }
      const deadline = performance.now() + CONNECT_MS;
      client = new SerialClient(await connectControl(deadline, wake.socket));
      // Stopping closes the connection so an unresolved send ends now, still `sending`.
      const open = client;
      wake.signal?.addEventListener("abort", () => open.close(), { once: true });
      // Inventory precedes decision guards and reminder deduplication.
      snapshot = await capture(wake, client, deadline);
      const previous = previousSlot(path);
      let state: Json;
      let outcome: Json;
      if (previous === undefined) {
        state = await reconcileSlot(
          client,
          { coordinator, signal: wake.signal, slot, unblock },
          snapshot,
        );
        outcome = state;
      } else {
        state = { previousStatus: previous.status, status: "deduplicated" };
        outcome = { ...state, reason: previous.reason ?? null };
      }
      Object.assign(state, recordHealth(health, coordinator, slot, snapshot, outcome));
      state.snapshot_id = snapshot.snapshot_id;
      state.snapshot_path = snapshotPath(unblock, String(snapshot.snapshot_id));
      return state;
    } catch (error) {
      if (error instanceof SlotInterrupted) {
        throw error;
      }
      // Never log queue contents, native error messages or transport data.
      let state: Json;
      const stored = existsSync(path) ? readJson(path) : undefined;
      if (isRecord(stored)) {
        state = stored;
        if (state.status === "sending") {
          state.status = "ambiguous";
          state.reason = "send outcome unavailable; do not resend";
        }
      } else {
        state = { reason: "native metadata unavailable", slot, status: "blocked" };
      }
      persistSlot(path, state);
      snapshot ??= await capture(wake, null, 0);
      Object.assign(state, recordHealth(health, coordinator, slot, snapshot, state));
      state.snapshot_path = snapshotPath(unblock, String(snapshot.snapshot_id));
      return state;
    }
  } finally {
    client?.close();
    lock.release();
  }
}

/** The Codex slot: socket and parent checks, then one budgeted connection for the whole slot. */
async function codexSlot(
  game: GameLayout,
  scope: ActiveScope,
  parents: readonly string[],
  project: string,
  slot: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const socket = process.env.CODEX_CONTROL_SOCKET;
  if (socket === undefined || !isAbsolute(socket)) {
    return `${DEFERRED_PREFIX}provide CODEX_CONTROL_SOCKET and the installed unblock helper`;
  }
  const state = await runSlot({
    busDir: game.busDir,
    claude: claudeAdapter(process.env, game),
    coordinator: scope.coordinator,
    emit: (kind, key, message) => emitEvent(game, { project }, kind, key, message),
    harnesses:
      scope.harnesses ??
      Object.fromEntries(
        [scope.coordinator, ...scope.peers, ...parents].map((id) => [id, "codex" as const]),
      ),
    parents,
    peers: scope.peers,
    signal,
    slot,
    socket,
    unblock: unblockDir(game.busDir),
  });
  return line(state);
}

/**
 * Resolve the role-name route and the worker parents through the registry as it is now. A
 * route this runner does not host, a held route or no route returns "" before any native call.
 */
export async function deliverScheduledWake(
  layout: Layout,
  game: GameLayout,
  slot: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    let route: RoleRoute | null;
    try {
      route = readRoleRoute(layout);
    } catch (error) {
      if (error instanceof RouteError) {
        return `${DEFERRED_PREFIX}${ROUTE_UNAVAILABLE}`;
      }
      throw error;
    }
    if (route === null) {
      return "";
    }
    const registry = readRegistry(layout);
    const send = sendRoute(registry, route, game.id);
    if (send.status !== "active") {
      return "";
    }
    const scope = activeScope(send);
    if (scope === null) {
      return line({
        reason: "monitor has no conversation for the active harness",
        status: "deferred",
      });
    }
    const config = loadProjectConfig(game.configFile);
    const members = new Set([route.monitor, ...route.targets]);
    const parentRoles = config.reports.workerParents.map((role) => resolveRole(registry, role));
    if (parentRoles.some((role) => !members.has(role))) {
      // The Codex observer reports a scope deferral on its own line; the Claude helper as status.
      return send.harness === "codex"
        ? `${DEFERRED_PREFIX}workerParents requires parents in the active monitor route`
        : line({
            reason: "worker parents must be in the active monitor route",
            status: "deferred",
          });
    }
    const parents = parentRoles.map((role) => roleConversation(registry, role));
    if (parents.some((parent) => parent === null)) {
      return line({
        reason: "worker parents require conversations for the active harness",
        status: "deferred",
      });
    }
    const unique = [...new Set(parents as string[])];
    if (send.harness === "codex") {
      return await codexSlot(game, scope, unique, config.reports.project, slot, signal);
    }
    return line(
      spoolMonitorBrief(process.env, game.busDir, scope, slot, unique) as unknown as Record<
        string,
        unknown
      >,
    );
  } catch (error) {
    if (error instanceof SlotInterrupted) {
      return "";
    }
    return line({ reason: "monitor route or state unavailable", status: "blocked" });
  }
}
