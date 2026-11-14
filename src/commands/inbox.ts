// `delivery-kit inbox snapshot` and `inbox ack` for a registered recipient or a verified
// Codex worker with one registered parent. Registered recipients default to reports.recipient.
import { parseArgs } from "node:util";

import { listingOrNull } from "../adapters/claude/agents.ts";
import { unblockDir } from "../adapters/claude/spool.ts";
import { codexAdapter } from "../adapters/codex/index.ts";
import type { WorkerBinding } from "../adapters/codex/workerInbox.ts";
import { canonicalUuid, isCanonicalUuid } from "../adapters/shared/ids.ts";
import { pyJsonDumps, sameJson } from "../adapters/shared/pyjson.ts";
import {
  type ActiveScope,
  readRoleRoute,
  routeRecipient,
  routeScope,
} from "../adapters/shared/route.ts";
import type { Disposition } from "../adapters/types.ts";
import { loadProjectConfig } from "../config.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { type GameLayout, gameLayout, type Layout, loadLayout } from "../layout.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import type { Harness, Registry } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import { acknowledge, ackSucceeded, DISPOSITIONS } from "../review/ack.ts";
import { adapterFor } from "../review/harnesses.ts";
import {
  captureClaude,
  captureCodex,
  captureMixed,
  TransportUnavailable,
} from "../review/snapshot.ts";
import { type Json, locked, persist, readRecord, snapshotPath } from "../review/store.ts";
import { SPECS } from "./spec.ts";

const UNAVAILABLE_OUTPUT = {
  reason: "inspect local inbox state and retry explicit reconciliation",
  status: "unavailable",
};

interface Scope {
  readonly layout: Layout;
  readonly game: GameLayout;
  readonly registry: Registry;
  readonly recipient: string;
  readonly harness: Harness;
  readonly harnesses: Readonly<Record<string, Harness>>;
  readonly parents: string[];
  readonly worker: WorkerBinding | null;
  /**
   * Recipient and peers of an active route; null when a declared route is not active;
   * undefined when no route is declared, which leaves collection unscoped.
   */
  readonly members: readonly string[] | null | undefined;
}

class UsageError extends Error {}

/** The active route's members, null when it is not active, undefined without a route. */
function codexMembers(layout: Layout, registry: Registry): string[] | null | undefined {
  try {
    const route = readRoleRoute(layout);
    if (route === null) {
      return undefined;
    }
    const active = routeScope(registry, routeRecipient(layout, route), route);
    return active === null ? null : [active.recipient, ...active.peers];
  } catch {
    return null;
  }
}

/**
 * A canonical conversation UUID registered for the active harness is used as given; anything
 * else is a role name for the registry.
 */
function conversation(registry: Registry, role: string): { id: string; harness: Harness } {
  try {
    if (isCanonicalUuid(role)) {
      const holders = Object.keys(registry.roles).filter(
        (key) => resolveConversation(registry, key) === role,
      );
      if (holders.length !== 1) {
        throw new UsageError("recipient UUID must identify exactly one active registered role");
      }
      return { harness: resolveHarness(registry, holders[0] as string), id: role };
    }
    const harness = resolveHarness(registry, role);
    const id = resolveConversation(registry, role);
    if (id === null) {
      throw new UsageError(`${role} has no ${harness} conversation`);
    }
    return { harness, id };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function scope(
  root: string,
  game: string | undefined,
  recipient: string | undefined,
  parents: string[],
): Scope {
  if (game === undefined) {
    throw new UsageError("--game is required");
  }
  const layout = loadLayout(root);
  const registry = readRegistry(layout);
  const entry = gameLayout(layout, game);
  const resolvedParents = parents.map((parent) => conversation(registry, parent).id);
  if (new Set(resolvedParents).size !== resolvedParents.length) {
    throw new UsageError("duplicate parent");
  }
  const members = codexMembers(layout, registry);
  const workerRecipient =
    recipient !== undefined &&
    isCanonicalUuid(recipient) &&
    !Object.keys(registry.roles).some((role) => resolveConversation(registry, role) === recipient);
  let worker: WorkerBinding | null = null;
  if (workerRecipient) {
    const parent = parents[0];
    if (parents.length !== 1 || parent === undefined || isCanonicalUuid(parent)) {
      throw new UsageError(
        "recipient UUID must identify exactly one active registered role or provide one registered --parent role",
      );
    }
    const resolved = conversation(registry, parent);
    conversation(registry, resolved.id);
    if (resolved.harness !== "codex" || members == null || !members.includes(resolved.id)) {
      throw new UsageError(
        "worker parent must be a current Codex member of the active review route",
      );
    }
    worker = {
      harness: "codex",
      parent: resolved.id,
      worker: recipient,
    };
  }
  const resolvedRecipient =
    worker === null
      ? conversation(registry, recipient ?? loadProjectConfig(entry.configFile).reports.recipient)
      : { harness: worker.harness, id: worker.worker };
  // Worker parents must belong to the active route before any native call.
  if (
    resolvedRecipient.harness === "codex" &&
    resolvedParents.length > 0 &&
    (members == null || resolvedParents.some((parent) => !members.includes(parent)))
  ) {
    throw new UsageError("worker parents require membership in the active review route");
  }
  const harnesses: Record<string, Harness> = {};
  for (const role of Object.keys(registry.roles)) {
    const id = resolveConversation(registry, role);
    if (id === null) {
      continue;
    }
    const harness = resolveHarness(registry, role);
    if (Object.hasOwn(harnesses, id) && harnesses[id] !== harness) {
      throw new UsageError("active conversation UUID has ambiguous harness bindings");
    }
    harnesses[id] = harness;
  }
  return {
    game: entry,
    harness: resolvedRecipient.harness,
    harnesses,
    layout,
    members,
    parents: resolvedParents,
    recipient: resolvedRecipient.id,
    registry,
    worker,
  };
}

/** The recipient must be the active route's recipient, resolved for the active harness now. */
function claudeRoute(layout: Layout, registry: Registry, recipient: string): ActiveScope {
  const route = readRoleRoute(layout);
  const active = route === null ? null : routeScope(registry, routeRecipient(layout, route), route);
  if (active === null || active.recipient !== recipient) {
    throw new Error("recipient must be the active route's recipient");
  }
  return active;
}

/**
 * Snapshot output keys keep this fixed order, which consumers parse; an object literal would be
 * rewritten by the sort-keys lint rule.
 */
function ordered(pairs: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  return Object.fromEntries(pairs);
}

function statusMap(value: unknown, field: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value as Record<string, Record<string, unknown>>).map(([key, row]) => [
      key,
      row[field],
    ]),
  );
}

/** Local channel stdout exposes inventory references only; original payloads stay in the snapshot. */
function channelSummary(record: Json): Json {
  const queues = record.channel_queues as Record<string, { id: string }[]>;
  return Object.fromEntries(
    Object.entries(record.queue_sources as Record<string, string>)
      .filter(
        ([, source]) =>
          source === "local_channel_delivered" || source === "local_channel_unavailable",
      )
      .map(([recipient]) => {
        const entries = queues[recipient];
        return [
          recipient,
          {
            count: entries?.length ?? null,
            queue_ids: entries?.map((entry) => entry.id) ?? null,
            status: entries === undefined ? "unavailable" : "available",
          },
        ];
      }),
  );
}

async function snapshot(io: Io, context: Scope, historyCursor?: string): Promise<number> {
  const unblock = unblockDir(context.game.busDir);
  const { parents, recipient } = context;
  if (context.worker !== null) {
    const binding = context.worker;
    const adapter = codexAdapter(context.layout, { env: io.env });
    const record = await locked(unblock, () =>
      adapter.withWorkerInbox(binding, async (workerAdapter) => {
        const captured = await captureCodex(
          { busDir: context.game.busDir, unblock },
          workerAdapter,
          [recipient],
          [],
        );
        captured.worker_binding = workerSnapshotBinding(binding);
        persist(snapshotPath(unblock, captured.snapshot_id as string), captured);
        return captured;
      }),
    );
    const queues = record.queues as Record<string, { id: string }[]>;
    const complete = Object.keys(record.errors as Json).length === 0;
    io.out(
      `${pyJsonDumps({
        complete,
        harness: "codex",
        path: snapshotPath(unblock, record.snapshot_id as string),
        question_state_status: statusMap(record.question_state, "status"),
        queue_ids: (queues[recipient] ?? []).map((entry) => entry.id),
        snapshot_id: record.snapshot_id,
        worker_binding: record.worker_binding,
      })}\n`,
    );
    return complete ? EXIT_OK : EXIT_INVALID;
  }
  if (context.harness === "claude") {
    const route = claudeRoute(context.layout, context.registry, recipient);
    const members = new Set([recipient, ...route.peers]);
    if (parents.some((parent) => !members.has(parent))) {
      throw new Error("parent outside active route");
    }
  }
  const endpoints = [...new Set([recipient, ...parents, ...(context.members ?? [])])];
  const selected = new Set(endpoints.map((id) => context.harnesses[id]));
  if (selected.size > 1) {
    const adapters = Object.fromEntries(
      [...selected].map((harness) => [
        harness,
        adapterFor(io.env, context.layout, context.game, harness as Harness),
      ]),
    );
    const record = await locked(unblock, () =>
      captureMixed(
        { busDir: context.game.busDir, unblock },
        adapters,
        context.harnesses,
        [recipient],
        parents,
        {
          historyCursor: historyCursor ?? null,
          ...(context.members === undefined ? {} : { routeMembers: context.members }),
        },
      ),
    );
    const id = record.snapshot_id as string;
    const complete = Object.keys(record.errors as Record<string, unknown>).length === 0;
    const queues = (context.harness === "claude" ? record.channel_queues : record.queues) as
      Record<string, { id: string }[]> | undefined;
    io.out(
      `${pyJsonDumps({
        channel_queues: channelSummary(record),
        collection_budget: record.collection_budget,
        complete,
        harness: context.harness,
        harnesses: record.harnesses,
        history: record.history,
        native_complete: record.native_complete,
        native_queues: record.native_queues,
        path: snapshotPath(unblock, id),
        question_state_status: statusMap(record.question_state, "status"),
        queue_ids: (queues?.[recipient] ?? []).map((entry) => entry.id),
        queue_sources: record.queue_sources,
        snapshot_id: id,
        worker_health: record.worker_health,
      })}\n`,
    );
    return complete ? EXIT_OK : EXIT_INVALID;
  }
  if (context.harness === "claude") {
    const route = claudeRoute(context.layout, context.registry, recipient);
    const members = new Set([recipient, ...route.peers]);
    if (parents.some((parent) => !members.has(parent))) {
      throw new Error("parent outside active route");
    }
    const listing = listingOrNull(io.env);
    const record = locked(unblock, () =>
      captureClaude({ busDir: context.game.busDir, unblock }, listing, route, recipient, parents),
    );
    const id = record.snapshot_id as string;
    const queue = (record.queues as Record<string, { id: string }[]>)[recipient] ?? [];
    const complete = Object.keys(record.errors as Record<string, unknown>).length === 0;
    io.out(
      `${pyJsonDumps(
        ordered([
          ["snapshot_id", id],
          ["path", snapshotPath(unblock, id)],
          ["queue_ids", queue.map((entry) => entry.id)],
          ["complete", complete],
          ["harness", "claude"],
          ["history", record.history],
          ["worker_health", record.worker_health],
          ["question_state_status", statusMap(record.question_state, "status")],
          ["session_status", statusMap(record.question_state, "session_status")],
          ["target_queue_status", statusMap(record.target_queues, "status")],
          ["channel_pending", record.channel_pending],
        ]),
      )}\n`,
    );
    return complete ? EXIT_OK : EXIT_INVALID;
  }
  const adapter = adapterFor(io.env, context.layout, context.game, context.harness);
  const record = await locked(unblock, () =>
    captureCodex({ busDir: context.game.busDir, unblock }, adapter, [recipient], parents, {
      historyCursor: historyCursor ?? null,
      ...(context.members === undefined ? {} : { routeMembers: context.members }),
    }),
  );
  const id = record.snapshot_id as string;
  const errors = record.errors as Record<string, unknown>;
  const queue = (record.queues as Record<string, { id: string }[]> | undefined)?.[recipient] ?? [];
  io.out(
    `${pyJsonDumps(
      ordered([
        ["snapshot_id", id],
        ["path", snapshotPath(unblock, id)],
        ["queue_ids", queue.map((entry) => entry.id)],
        ["complete", Object.keys(errors).length === 0],
        ["history", record.history],
        ["worker_health", record.worker_health],
        ["question_state_status", statusMap(record.question_state, "status")],
        ["collection_budget", record.collection_budget],
      ]),
      false,
      true,
    )}\n`,
  );
  return Object.keys(errors).length === 0 ? EXIT_OK : EXIT_INVALID;
}

function workerSnapshotBinding(binding: WorkerBinding): Json {
  return { harness: binding.harness, parent: binding.parent, worker: binding.worker };
}

async function guarded(io: Io, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`delivery-kit: ${error.message}\n`);
      return EXIT_USAGE;
    }
    // stdout keeps the JSON consumers parse; stderr names the cause for the operator.
    io.err(`delivery-kit: ${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof TransportUnavailable) {
      io.out(`${pyJsonDumps({ reason: error.message, status: "unavailable" })}\n`);
      return EXIT_INVALID;
    }
    io.out(`${pyJsonDumps(UNAVAILABLE_OUTPUT)}\n`);
    return EXIT_INVALID;
  }
}

export const inboxSnapshot: Handler = (io, root, args) => {
  const { values } = parseArgs({
    args,
    options: SPECS["inbox snapshot"].options,
    strict: true,
  });
  return guarded(io, () =>
    snapshot(
      io,
      scope(root, values.game, values.recipient, values.parent ?? []),
      values["history-cursor"],
    ),
  );
};

export const inboxAck: Handler = (io, root, args) => {
  const { values } = parseArgs({
    args,
    options: SPECS["inbox ack"].options,
    strict: true,
  });
  const queueIds = values["queue-id"] ?? [];
  const disposition = values.disposition as Disposition | undefined;
  if (values.snapshot === undefined || queueIds.length === 0 || disposition === undefined) {
    io.err("delivery-kit: inbox ack requires --snapshot, --queue-id and --disposition\n");
    return EXIT_USAGE;
  }
  if (!DISPOSITIONS.includes(disposition)) {
    io.err("delivery-kit: --disposition must be handled, superseded or retained\n");
    return EXIT_USAGE;
  }
  if (disposition === "retained" && (values.reason === undefined || values.reason.trim() === "")) {
    io.err("delivery-kit: retained requires --reason\n");
    return EXIT_USAGE;
  }
  let snapshotId: string;
  try {
    snapshotId = canonicalUuid(values.snapshot);
  } catch {
    io.err("delivery-kit: --snapshot must be a canonical UUID\n");
    return EXIT_USAGE;
  }
  return guarded(io, async () => {
    const context = scope(root, values.game, values.recipient, values.parent ?? []);
    if (context.harness === "claude") {
      claudeRoute(context.layout, context.registry, context.recipient);
    }
    const unblock = unblockDir(context.game.busDir);
    const captured = readRecord(snapshotPath(unblock, snapshotId));
    const expectedBinding =
      context.worker === null ? undefined : workerSnapshotBinding(context.worker);
    if (!sameJson(captured?.worker_binding, expectedBinding)) {
      throw new Error("snapshot worker binding mismatch");
    }
    const request = {
      disposition,
      queueIds,
      reason: values.reason,
      recipient: context.recipient,
      snapshotId,
    };
    const results =
      context.worker === null
        ? await acknowledge(
            adapterFor(io.env, context.layout, context.game, context.harness),
            unblock,
            request,
          )
        : await codexAdapter(context.layout, { env: io.env }).withWorkerInbox(
            context.worker,
            (adapter) => acknowledge(adapter, unblock, request),
          );
    io.out(`${pyJsonDumps({ results })}\n`);
    return ackSucceeded(results) ? EXIT_OK : EXIT_INVALID;
  });
};
