// Version 2 Claude monitor route.
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { readJson } from "../../durable.ts";
import { isCanonicalUuid } from "../shared/ids.ts";

export type RouteHarness = "claude" | "codex";

export interface RouteTarget {
  readonly sessionId: string;
  readonly name: string;
}

export type ResolvedRoute =
  | { readonly status: "held" | "nonhost" }
  | {
      readonly status: "active";
      readonly coordinator: string;
      readonly monitorName: string;
      readonly peers: readonly string[];
      readonly targets: readonly RouteTarget[];
    };

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

interface Endpoint {
  readonly session_id: string | null;
  readonly name: string;
  readonly ownership: "active" | "held";
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;
const ROUTE_KEYS = ["harness", "host_project_root", "monitor", "state", "targets", "version"];
const ENDPOINT_KEYS = ["name", "ownership", "session_id"];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

/** Select the resolver by declared schema; anything else is unsupported. */
export function routeHarness(value: unknown): RouteHarness {
  const route = record(value);
  if (route !== undefined && Number.isInteger(route.version)) {
    if (route.version === 1 && route.harness === "codex") {
      return "codex";
    }
    if (route.version === 2 && route.harness === "claude") {
      return "claude";
    }
  }
  throw new RouteError("unsupported monitor route schema");
}

function endpoint(value: unknown, monitor: boolean): Endpoint {
  const entry = record(value);
  if (
    entry === undefined ||
    !sameKeys(entry, ENDPOINT_KEYS) ||
    (entry.ownership !== "active" && entry.ownership !== "held") ||
    typeof entry.name !== "string" ||
    !NAME.test(entry.name)
  ) {
    throw new RouteError("invalid route endpoint");
  }
  if (!(monitor && entry.session_id === null) && !isCanonicalUuid(entry.session_id)) {
    throw new RouteError("canonical session UUID required");
  }
  return entry as unknown as Endpoint;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function resolveRouteV2(routeFile: string, projectRoot: string): ResolvedRoute {
  if (!isAbsolute(routeFile) || !isAbsolute(projectRoot)) {
    throw new RouteError("absolute monitor route and project root paths required");
  }
  const route = record(readJson(routeFile));
  if (
    route === undefined ||
    routeHarness(route) !== "claude" ||
    !sameKeys(route, ROUTE_KEYS) ||
    (route.state !== "active" && route.state !== "held") ||
    typeof route.host_project_root !== "string" ||
    !isAbsolute(route.host_project_root) ||
    !Array.isArray(route.targets)
  ) {
    throw new RouteError("invalid monitor route schema");
  }
  const monitor = endpoint(route.monitor, true);
  const targets = new Map<string, Endpoint>();
  for (const value of route.targets) {
    const target = endpoint(value, false);
    const sessionId = target.session_id as string;
    const previous = targets.get(sessionId);
    if (
      previous !== undefined &&
      (previous.name !== target.name || previous.ownership !== target.ownership)
    ) {
      throw new RouteError("conflicting target ownership or name");
    }
    targets.set(sessionId, target);
  }
  const coordinator = monitor.session_id;
  if (route.state === "active") {
    if (coordinator === null || monitor.ownership !== "active") {
      throw new RouteError("active route requires an active monitor identity");
    }
    if (targets.has(coordinator)) {
      throw new RouteError("active monitor identity must be distinct from every target");
    }
  }
  const peers = [...targets.values()].filter((target) => target.ownership === "active");
  if (route.state === "active" && peers.length === 0) {
    throw new RouteError("active route requires active targets");
  }
  if (canonicalPath(route.host_project_root) !== canonicalPath(projectRoot)) {
    return { status: "nonhost" };
  }
  if (route.state === "held" || coordinator === null) {
    return { status: "held" };
  }
  return {
    coordinator,
    monitorName: monitor.name,
    peers: peers.map((target) => target.session_id as string),
    status: "active",
    targets: peers.map((target) => ({ name: target.name, sessionId: target.session_id as string })),
  };
}
