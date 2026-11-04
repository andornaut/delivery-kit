// `status --harness <claude|codex>`: whether that harness's adapter can deliver now, before a
// handoff flips the registry. It sends nothing. The monitor and every route target must resolve
// to a conversation for the probed harness.
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

import { listingOrNull } from "../adapters/claude/agents.ts";
import { connectControl } from "../adapters/codex/rpc.ts";
import { readRoleRoute } from "../adapters/shared/route.ts";
import type { Layout } from "../layout.ts";
import { resolveRole } from "../registry/resolve.ts";
import type { Harness, Registry } from "../registry/schema.ts";

export interface RoleReadiness {
  readonly role: string;
  readonly conversation: string | null;
  readonly status: "resolved" | "unavailable";
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
    return route === null ? [resolveRole(registry, "monitor")] : [route.monitor, ...route.targets];
  } catch {
    return null;
  }
}

export async function harnessReadiness(
  env: NodeJS.ProcessEnv,
  layout: Layout,
  registry: Registry,
  harness: Harness,
): Promise<Readiness> {
  const reason = await adapterStatus(env, harness);
  const names = routeRoles(layout, registry);
  const roles = (names ?? []).map((role): RoleReadiness => {
    const conversation = registry.roles[role]?.conversations[harness] ?? null;
    return { conversation, role, status: conversation === null ? "unavailable" : "resolved" };
  });
  return {
    adapter: { reason, status: reason === null ? "available" : "unavailable" },
    harness,
    ready: reason === null && names !== null && roles.every((role) => role.status === "resolved"),
    roles,
  };
}
