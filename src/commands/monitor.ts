// `delivery-kit monitor-snapshot` and `monitor-ack` for one game. The recipient is a role name
// (default: the monitor duty) resolved through the registry for its active harness.
import { parseArgs } from "node:util";

import { listingOrNull } from "../adapters/claude/agents.ts";
import { resolveRouteV2 } from "../adapters/claude/route.ts";
import { unblockDir } from "../adapters/claude/spool.ts";
import { canonicalUuid } from "../adapters/shared/ids.ts";
import { pyJsonDumps } from "../adapters/shared/pyjson.ts";
import type { Disposition } from "../adapters/types.ts";
import { readJson } from "../durable.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { type GameLayout, gameLayout, type Layout, loadLayout } from "../layout.ts";
import { acknowledge, ackSucceeded, DISPOSITIONS } from "../monitor/ack.ts";
import { adapterFor } from "../monitor/harnesses.ts";
import { captureClaude, captureCodex } from "../monitor/snapshot.ts";
import { locked, snapshotPath } from "../monitor/store.ts";
import { MONITOR_ROLE } from "../monitor/wake.ts";
import { resolveConversation } from "../registry/resolve.ts";
import type { Registry } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";

const UNAVAILABLE_OUTPUT = {
  reason: "inspect local monitor state and retry explicit reconciliation",
  status: "unavailable",
};

interface Scope {
  readonly layout: Layout;
  readonly game: GameLayout;
  readonly registry: Registry;
  readonly recipient: string;
  readonly parents: string[];
}

class UsageError extends Error {}

function conversation(registry: Registry, role: string): string {
  const id = resolveConversation(registry, role);
  if (id === null) {
    throw new UsageError(`${role} has no ${registry.harness} conversation`);
  }
  return id;
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
  const resolvedParents = parents.map((parent) => conversation(registry, parent));
  if (new Set(resolvedParents).size !== resolvedParents.length) {
    throw new UsageError("duplicate parent");
  }
  return {
    game: gameLayout(layout, game),
    layout,
    parents: resolvedParents,
    recipient: conversation(registry, recipient ?? MONITOR_ROLE),
    registry,
  };
}

/** The recipient must be the active route monitor (claude_monitor.py:scope). */
function claudeRoute(
  layout: Layout,
  recipient: string,
): Extract<ReturnType<typeof resolveRouteV2>, { status: "active" }> {
  const declared = readJson(layout.routeFile) as { host_project_root?: unknown };
  if (typeof declared.host_project_root !== "string") {
    throw new Error("invalid monitor route schema");
  }
  const route = resolveRouteV2(layout.routeFile, declared.host_project_root);
  if (route.status !== "active" || route.coordinator !== recipient) {
    throw new Error("recipient must be the active Claude route monitor");
  }
  return route;
}

/** CLI output keeps the 0.9.x key order, which sort-keys would otherwise rewrite. */
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

async function snapshot(io: Io, context: Scope): Promise<number> {
  const unblock = unblockDir(context.game.busDir);
  const { parents, recipient } = context;
  if (context.registry.harness === "claude") {
    const route = claudeRoute(context.layout, recipient);
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
    io.out(
      `${pyJsonDumps(
        ordered([
          ["snapshot_id", id],
          ["path", snapshotPath(unblock, id)],
          ["queue_ids", queue.map((entry) => entry.id)],
          ["complete", true],
          ["harness", "claude"],
          ["history", record.history],
          ["worker_health", record.worker_health],
          ["question_state_status", statusMap(record.question_state, "status")],
          ["session_status", statusMap(record.question_state, "session_status")],
          ["target_queue_status", statusMap(record.target_queues, "status")],
          ["process_health_source", record.process_health_source],
          ["channel_pending", record.channel_pending],
        ]),
      )}\n`,
    );
    return EXIT_OK;
  }
  const adapter = adapterFor(io.env, context.layout, context.game, context.registry.harness);
  const record = await locked(unblock, () =>
    captureCodex({ busDir: context.game.busDir, unblock }, adapter, [recipient], parents),
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
        ["harness", "codex"],
        ["history", record.history],
        ["worker_health", record.worker_health],
        ["question_state_status", statusMap(record.question_state, "status")],
        ["process_health_source", record.process_health_source],
      ]),
    )}\n`,
  );
  return Object.keys(errors).length === 0 ? EXIT_OK : EXIT_INVALID;
}

const COMMON = {
  game: { type: "string" },
  parent: { multiple: true, type: "string" },
  recipient: { type: "string" },
} as const;

async function guarded(io: Io, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`delivery-kit: ${error.message}\n`);
      return EXIT_USAGE;
    }
    io.out(`${pyJsonDumps(UNAVAILABLE_OUTPUT)}\n`);
    return EXIT_INVALID;
  }
}

export const monitorSnapshot: Handler = (io, root, args) => {
  const { values } = parseArgs({ args, options: COMMON, strict: true });
  return guarded(io, () =>
    snapshot(io, scope(root, values.game, values.recipient, values.parent ?? [])),
  );
};

export const monitorAck: Handler = (io, root, args) => {
  const { values } = parseArgs({
    args,
    options: {
      ...COMMON,
      disposition: { type: "string" },
      "queue-id": { multiple: true, type: "string" },
      reason: { type: "string" },
      snapshot: { type: "string" },
    },
    strict: true,
  });
  const queueIds = values["queue-id"] ?? [];
  const disposition = values.disposition as Disposition | undefined;
  if (values.snapshot === undefined || queueIds.length === 0 || disposition === undefined) {
    io.err("delivery-kit: monitor-ack requires --snapshot, --queue-id and --disposition\n");
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
    if (context.registry.harness === "claude") {
      claudeRoute(context.layout, context.recipient);
    }
    const adapter = adapterFor(io.env, context.layout, context.game, context.registry.harness);
    const results = await acknowledge(adapter, unblockDir(context.game.busDir), {
      disposition,
      queueIds,
      reason: values.reason,
      recipient: context.recipient,
      snapshotId,
    });
    io.out(`${pyJsonDumps({ results })}\n`);
    return ackSucceeded(results) ? EXIT_OK : EXIT_INVALID;
  });
};
