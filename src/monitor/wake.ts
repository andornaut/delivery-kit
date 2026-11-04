// Scheduled monitor wake for a due slot (bus-common.sh:bus_monitor_due_ticks, unblock.py and
// claude_adapter.py:run). The adapter follows the registry's active harness; the monitor and
// worker parents are role names resolved through the registry. The result is the one-line JSON
// status the runner logs, or an empty string when this project does not dispatch the slot.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { slotRequestId } from "../adapters/claude/ids.ts";
import { pyJsonDumps } from "../adapters/claude/pyjson.ts";
import { resolveRouteV2, routeHarness } from "../adapters/claude/route.ts";
import { spoolMonitorBrief, unblockDir } from "../adapters/claude/spool.ts";
import { resolveRoute, type RouteScope } from "../adapters/codex/route.ts";
import { loadProjectConfig } from "../config.ts";
import { readJson } from "../durable.ts";
import type { GameLayout, Layout } from "../layout.ts";
import { resolveConversation } from "../registry/resolve.ts";
import { readRegistry } from "../registry/store.ts";
import { decisionClear } from "./decisions.ts";
import { codexAdapter } from "./harnesses.ts";
import { readRecord } from "./store.ts";

export const MONITOR_ROLE = "monitor";
const PRINTED = ["status", "previousStatus", "reason", "monitor_session_status"] as const;

function line(outcome: Readonly<Record<string, unknown>>): string {
  const printed: Record<string, unknown> = {};
  for (const key of PRINTED) {
    if (Object.hasOwn(outcome, key)) {
      printed[key] = outcome[key];
    }
  }
  return pyJsonDumps(printed);
}

function reminder(slot: number, queues: Readonly<Record<string, readonly string[]>>): string {
  const inventory = Object.entries(queues)
    .map(([thread, ids]) => `${thread}: ${ids.length > 0 ? ids.join(",") : "none"}`)
    .join("\n");
  return (
    `Scheduled monitoring review, slot ${slot}. Review recent Art, Gameplay and Tech activity ` +
    "and these persisted queue IDs. Reconcile already handled IDs; prioritize actual user replies " +
    "and dependency unblockers. Use native live steering only for confirmed unblockers. Remove an " +
    "original only after confirmed delivery or reconciliation. Preserve unanswered questions and " +
    "independent work; silence is not a decision. Resolve reciprocal waits with the smallest owner " +
    "question. Report only new or unresolved blockers. This is a triage reminder, not permission " +
    `to interrupt turns, answer questions, restart work, or duplicate deliveries.\n${inventory}`
  );
}

async function codexWake(
  layout: Layout,
  game: GameLayout,
  peers: readonly string[],
  monitor: string,
  slot: number,
): Promise<string> {
  const unblock = unblockDir(game.busDir);
  const receipt = join(unblock, `${monitor}-${slot}.json`);
  const previous = existsSync(receipt) ? readRecord(receipt) : undefined;
  if (previous !== undefined) {
    return line({
      previousStatus: previous.status,
      reason: previous.reason ?? null,
      status: "deduplicated",
    });
  }
  if (!decisionClear(unblock, monitor)) {
    return line({
      reason: "recipient-bound user-decision clearance missing, invalid or pending",
      status: "deferred",
    });
  }
  const adapter = codexAdapter(layout);
  const recipients = [monitor, ...peers];
  const inventories = await Promise.all(
    recipients.map((recipient) => adapter.inventory(recipient)),
  );
  const queues: Record<string, string[]> = {};
  for (const [index, recipient] of recipients.entries()) {
    const inventory = inventories[index];
    if (inventory?.status !== "available") {
      return line({
        reason: "queue inventory incomplete; inspect snapshot and retry reconciliation",
        status: "deferred",
      });
    }
    queues[recipient] = inventory.entries.map((entry) => entry.queueId);
  }
  const result = await adapter.deliver(
    receipt,
    slotRequestId(monitor, slot),
    monitor,
    reminder(slot, queues),
  );
  return line({
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    status: result.status,
  });
}

/** Full version 1 route validation before any native call (bus-common.sh:264-268). */
async function codexScope(
  layout: Layout,
  game: GameLayout,
  monitor: string,
  slot: number,
): Promise<string> {
  let scope: RouteScope;
  try {
    scope = resolveRoute(game.repo, layout.routeFile);
  } catch {
    return line({
      reason:
        "monitor route is unavailable or invalid; its owner must verify identities and ownership",
      status: "deferred",
    });
  }
  if (scope.status !== "active") {
    return "";
  }
  if (scope.coordinator !== monitor) {
    return line({
      reason: "monitor route identity differs from the registry monitor",
      status: "deferred",
    });
  }
  return codexWake(layout, game, scope.peers, monitor, slot);
}

export async function deliverScheduledWake(
  layout: Layout,
  game: GameLayout,
  slot: number,
): Promise<string> {
  try {
    const registry = readRegistry(layout);
    const monitor = resolveConversation(registry, MONITOR_ROLE);
    if (monitor === null) {
      return line({
        reason: "monitor has no conversation for the active harness",
        status: "deferred",
      });
    }
    const route = readJson(layout.routeFile);
    if (routeHarness(route) !== registry.harness) {
      return line({
        reason: "monitor route harness differs from the registry harness",
        status: "deferred",
      });
    }
    if (registry.harness === "codex") {
      return await codexScope(layout, game, monitor, slot);
    }
    const resolved = resolveRouteV2(layout.routeFile, game.repo);
    if (resolved.status !== "active") {
      return "";
    }
    if (resolved.coordinator !== monitor) {
      return line({
        reason: "monitor route identity differs from the registry monitor",
        status: "deferred",
      });
    }
    const parents = loadProjectConfig(game.configFile).reports.workerParents.map((role) =>
      resolveConversation(registry, role),
    );
    if (parents.some((parent) => parent === null)) {
      return line({
        reason: "worker parents require conversations for the active harness",
        status: "deferred",
      });
    }
    return line(
      spoolMonitorBrief(process.env, game.busDir, resolved, slot, [
        ...new Set(parents as string[]),
      ]) as unknown as Record<string, unknown>,
    );
  } catch {
    return line({ reason: "monitor route or state unavailable", status: "blocked" });
  }
}
