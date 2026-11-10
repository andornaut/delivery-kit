// The role-name monitor route, var/route.json schema 1. It names roles only; every send resolves
// them through var/registry.json for each role's selected harness at that moment.
import { existsSync } from "node:fs";

import { readJson } from "../../durable.ts";
import { type GameDevConfig, type Layout, roleKeys } from "../../layout.ts";
import {
  AmbiguousRole,
  resolveConversation,
  resolveHarness,
  UnknownRole,
} from "../../registry/resolve.ts";
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

/** Validate a schema 1 route against config.json; throws RouteError when it is not one. */
export function validateRoleRoute(config: GameDevConfig, value: unknown): RoleRoute {
  const roles = new Set(roleKeys(config));
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !== ROUTE_KEYS.join() ||
    value.schema !== 1 ||
    (value.state !== "active" && value.state !== "held") ||
    typeof value.host !== "string" ||
    !Object.hasOwn(config.games, value.host) ||
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
  return validateRoleRoute(layout.config, value);
}

export interface RouteEndpoint {
  readonly role: string;
  readonly harness: Harness;
  /** The role's conversation for its selected harness, or null when it has none. */
  readonly conversation: string | null;
}

export type SendRoute =
  | { readonly status: "held" | "nonhost" }
  | {
      readonly status: "active";
      /** Transport of the monitor, independently of each target's transport. */
      readonly harness: Harness;
      readonly monitor: RouteEndpoint;
      readonly targets: readonly RouteEndpoint[];
    };

/** roles.<role>.conversations.<harness>, read from the registry snapshot given. */
export function roleConversation(registry: Registry, role: string): string | null {
  try {
    return resolveConversation(registry, role);
  } catch (error) {
    if (error instanceof UnknownRole || error instanceof AmbiguousRole) {
      return null;
    }
    throw error;
  }
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
    harness: Object.hasOwn(registry.roles, role)
      ? resolveHarness(registry, role)
      : registry.harness,
    role,
  });
  const monitor = endpoint(route.monitor);
  return {
    harness: monitor.harness,
    monitor,
    status: "active",
    targets: route.targets.map(endpoint),
  };
}

/** The distinct resolved target conversations other than the monitor's. */
function peerConversations(route: Extract<SendRoute, { status: "active" }>): string[] {
  const monitor = route.monitor.conversation;
  const peers = route.targets
    .map((target) => target.conversation)
    .filter((id): id is string => id !== null && id !== monitor);
  return [...new Set(peers)];
}

export interface ActiveScope {
  readonly status: "active";
  readonly harness?: Harness;
  /** Includes the monitor and every resolved recipient; absent in older fixtures. */
  readonly harnesses?: Readonly<Record<string, Harness>>;
  readonly coordinator: string;
  readonly monitorName: string;
  readonly peers: readonly string[];
  readonly targets: readonly {
    readonly sessionId: string;
    readonly name: string;
    readonly harness?: Harness;
  }[];
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
  const harnesses = new Map<string, Harness>();
  for (const endpoint of [route.monitor, ...route.targets]) {
    if (endpoint.conversation !== null) {
      const existing = harnesses.get(endpoint.conversation);
      if (existing !== undefined && existing !== endpoint.harness) {
        return null;
      }
      harnesses.set(endpoint.conversation, endpoint.harness);
    }
  }
  return {
    coordinator,
    harness: route.harness,
    harnesses: Object.fromEntries(harnesses),
    monitorName: route.monitor.role,
    peers: peerConversations(route),
    status: "active",
    targets: route.targets
      .filter((target) => target.conversation !== null && target.conversation !== coordinator)
      .map((target) => ({
        harness: target.harness,
        name: target.role,
        sessionId: target.conversation as string,
      })),
  };
}

/** The route's scope regardless of host, for commands run from any game's checkout. */
export function routeScope(registry: Registry, route: RoleRoute): ActiveScope | null {
  const send = sendRoute(registry, route, route.host);
  return send.status === "active" ? activeScope(send) : null;
}
