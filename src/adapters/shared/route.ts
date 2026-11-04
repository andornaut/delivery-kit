// The role-name monitor route, var/route.json schema 1. It names roles only; every send resolves
// them through var/registry.json for its active harness at that moment, so a harness handoff is
// one registry change with no route edit, restart or migration.
import { existsSync } from "node:fs";

import { readJson } from "../../durable.ts";
import { type Layout, roleKeys } from "../../layout.ts";
import type { Harness, Registry } from "../../registry/schema.ts";
import { isRecord } from "./pyjson.ts";

export interface RoleRoute {
  readonly schema: 1;
  readonly state: "active" | "held";
  /** The game whose runner dispatches the scheduled wake. */
  readonly host: string;
  readonly monitor: string;
  readonly targets: readonly string[];
}

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

const ROUTE_KEYS = ["host", "monitor", "schema", "state", "targets"];

/** Read and validate var/route.json against config.json; null when no route is declared. */
export function readRoleRoute(layout: Layout): RoleRoute | null {
  if (!existsSync(layout.routeFile)) {
    return null;
  }
  let value: unknown;
  try {
    value = readJson(layout.routeFile);
  } catch {
    throw new RouteError("monitor route is unreadable");
  }
  const roles = new Set(roleKeys(layout.config));
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !== ROUTE_KEYS.join() ||
    value.schema !== 1 ||
    (value.state !== "active" && value.state !== "held") ||
    typeof value.host !== "string" ||
    !Object.hasOwn(layout.config.games, value.host) ||
    typeof value.monitor !== "string" ||
    !roles.has(value.monitor) ||
    !Array.isArray(value.targets)
  ) {
    throw new RouteError("invalid monitor route schema");
  }
  const targets = value.targets as unknown[];
  if (targets.some((target) => typeof target !== "string" || !roles.has(target))) {
    throw new RouteError("every route target must be a role in config.json");
  }
  const names = targets as string[];
  if (new Set(names).size !== names.length) {
    throw new RouteError("route targets must be distinct");
  }
  if (value.state === "active" && (names.length === 0 || names.includes(value.monitor))) {
    throw new RouteError("an active route needs targets distinct from its monitor");
  }
  return {
    host: value.host,
    monitor: value.monitor,
    schema: 1,
    state: value.state,
    targets: names,
  };
}

export interface RouteEndpoint {
  readonly role: string;
  /** The role's conversation for the active harness, or null when it has none. */
  readonly conversation: string | null;
}

export type SendRoute =
  | { readonly status: "held" | "nonhost" }
  | {
      readonly status: "active";
      readonly harness: Harness;
      readonly monitor: RouteEndpoint;
      readonly targets: readonly RouteEndpoint[];
    };

/** roles.<role>.conversations.<harness>, read from the registry snapshot given. */
export function roleConversation(registry: Registry, role: string): string | null {
  return registry.roles[role]?.conversations[registry.harness] ?? null;
}

/** The route for `game`'s runner, resolved through `registry` at send time. */
export function sendRoute(registry: Registry, route: RoleRoute, game: string): SendRoute {
  if (route.host !== game) {
    return { status: "nonhost" };
  }
  if (route.state === "held") {
    return { status: "held" };
  }
  const endpoint = (role: string): RouteEndpoint => ({
    conversation: roleConversation(registry, role),
    role,
  });
  return {
    harness: registry.harness,
    monitor: endpoint(route.monitor),
    status: "active",
    targets: route.targets.map(endpoint),
  };
}

/** The distinct resolved target conversations other than the monitor's. */
export function peerConversations(route: Extract<SendRoute, { status: "active" }>): string[] {
  const monitor = route.monitor.conversation;
  const peers = route.targets
    .map((target) => target.conversation)
    .filter((id): id is string => id !== null && id !== monitor);
  return [...new Set(peers)];
}

export interface ActiveScope {
  readonly status: "active";
  readonly coordinator: string;
  readonly monitorName: string;
  readonly peers: readonly string[];
  readonly targets: readonly { readonly sessionId: string; readonly name: string }[];
}

/**
 * The resolved conversations of an active route: the monitor's as coordinator and each target
 * with a conversation for this harness. Null when the monitor itself has none.
 */
export function activeScope(route: Extract<SendRoute, { status: "active" }>): ActiveScope | null {
  const coordinator = route.monitor.conversation;
  if (coordinator === null) {
    return null;
  }
  return {
    coordinator,
    monitorName: route.monitor.role,
    peers: peerConversations(route),
    status: "active",
    targets: route.targets
      .filter((target) => target.conversation !== null && target.conversation !== coordinator)
      .map((target) => ({ name: target.role, sessionId: target.conversation as string })),
  };
}

/** The route's scope regardless of host, for commands run from any game's checkout. */
export function routeScope(registry: Registry, route: RoleRoute): ActiveScope | null {
  const send = sendRoute(registry, route, route.host);
  return send.status === "active" ? activeScope(send) : null;
}
