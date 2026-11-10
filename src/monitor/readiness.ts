// Read-only adapter and conversation readiness for a target harness or each role's selection.
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

import { listingOrNull } from "../adapters/claude/agents.ts";
import { connectControl } from "../adapters/codex/rpc.ts";
import { readRoleRoute } from "../adapters/shared/route.ts";
import type { Layout } from "../layout.ts";
import { resolveHarness, resolveRole } from "../registry/resolve.ts";
import type { Harness, Registry } from "../registry/schema.ts";
import { type HarnessSelection, resolveSelectedRoles } from "../registry/selection.ts";
import { MONITOR_ROLE } from "./wake.ts";

export interface RoleReadiness {
  readonly role: string;
  readonly conversation: string | null;
  readonly status: "resolved" | "unavailable";
  readonly current_harness?: Harness;
  readonly probed_harness?: Harness;
}

export type ReadinessScope = Pick<HarnessSelection, "games" | "roles">;

interface SelectedRoleReadiness extends RoleReadiness {
  readonly current_harness: Harness;
  readonly probed_harness: Harness;
}

export interface Readiness {
  readonly harness: Harness;
  readonly adapter: {
    readonly status: "available" | "unavailable";
    readonly reason: string | null;
  };
  readonly roles: readonly RoleReadiness[];
  readonly ready: boolean;
}

export interface EffectiveReadiness {
  readonly harness: "mixed";
  readonly adapters: Readonly<Partial<Record<Harness, Readiness["adapter"]>>>;
  readonly roles: readonly SelectedRoleReadiness[];
  readonly ready: boolean;
}

const PROBE_MS = 5000;

async function codexAdapterStatus(env: NodeJS.ProcessEnv): Promise<string | null> {
  const socket = env.CODEX_CONTROL_SOCKET;
  try {
    if (socket === undefined || !isAbsolute(socket) || !statSync(socket).isSocket()) {
      return "set CODEX_CONTROL_SOCKET to an available absolute Codex control socket path";
    }
  } catch {
    return "set CODEX_CONTROL_SOCKET to an available absolute Codex control socket path";
  }
  try {
    (await connectControl(performance.now() + PROBE_MS, socket)).close();
    return null;
  } catch {
    return "the Codex control socket refused the connection";
  }
}

function adapterStatus(env: NodeJS.ProcessEnv, harness: Harness): Promise<string | null> {
  if (harness === "codex") {
    return codexAdapterStatus(env);
  }
  return Promise.resolve(
    listingOrNull(env) === null ? "claude agents --json is unavailable" : null,
  );
}

/**
 * The monitor first, then each route target; without a route, the monitor duty alone. Null for
 * an invalid route, which is never ready.
 */
function routeRoles(layout: Layout, registry: Registry): string[] | null {
  try {
    const route = readRoleRoute(layout);
    return route === null
      ? [resolveRole(registry, MONITOR_ROLE)]
      : [route.monitor, ...route.targets];
  } catch {
    return null;
  }
}

export async function harnessReadiness(
  env: NodeJS.ProcessEnv,
  layout: Layout,
  registry: Registry,
  harness: Harness,
  scope?: ReadinessScope,
): Promise<Readiness> {
  const names =
    scope === undefined
      ? routeRoles(layout, registry)
      : resolveSelectedRoles(layout, registry, scope);
  const reason = await adapterStatus(env, harness);
  const roles = (names ?? []).map((role): RoleReadiness => {
    const conversation = registry.roles[role]?.conversations[harness] ?? null;
    return {
      conversation,
      ...(scope === undefined
        ? {}
        : { current_harness: resolveHarness(registry, role), probed_harness: harness }),
      role,
      status: conversation === null ? "unavailable" : "resolved",
    };
  });
  return {
    adapter: { reason, status: reason === null ? "available" : "unavailable" },
    harness,
    ready: reason === null && names !== null && roles.every((role) => role.status === "resolved"),
    roles,
  };
}

/** Current role selections, with one adapter probe per required harness and no sends. */
export async function effectiveReadiness(
  env: NodeJS.ProcessEnv,
  layout: Layout,
  registry: Registry,
  scope?: ReadinessScope,
): Promise<EffectiveReadiness> {
  const names =
    scope === undefined
      ? routeRoles(layout, registry)
      : resolveSelectedRoles(layout, registry, scope);
  const roles = (names ?? []).map((role): SelectedRoleReadiness => {
    const harness = resolveHarness(registry, role);
    const conversation = registry.roles[role]?.conversations[harness] ?? null;
    return {
      conversation,
      current_harness: harness,
      probed_harness: harness,
      role,
      status: conversation === null ? "unavailable" : "resolved",
    };
  });
  const harnesses = [...new Set(roles.map((role) => role.probed_harness))].sort();
  const entries = await Promise.all(
    harnesses.map(async (harness) => {
      const reason = await adapterStatus(env, harness);
      return [harness, { reason, status: reason === null ? "available" : "unavailable" }] as const;
    }),
  );
  const adapters = Object.fromEntries(entries);
  return {
    adapters,
    harness: "mixed",
    ready:
      names !== null &&
      roles.every((role) => role.status === "resolved") &&
      entries.every(([, adapter]) => adapter.status === "available"),
    roles,
  };
}
