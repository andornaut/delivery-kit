// The guarded Codex monitor route (codex_adapter.py:53-85). Reading it infers no ownership and
// makes no native connection; an invalid route defers monitoring rather than falling back.
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { readJson } from "../../durable.ts";
import { isCanonicalUuid, isRecord } from "./json.ts";

export type RouteScope =
  | { readonly status: "nonhost" }
  | { readonly status: "held" }
  | { readonly status: "active"; readonly coordinator: string; readonly peers: readonly string[] };

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

/** Path.resolve(): symlinks resolved where the path exists, lexical otherwise. */
function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function canonical(value: unknown): string {
  if (!isCanonicalUuid(value)) {
    throw new RouteError("canonical thread UUID required");
  }
  return value;
}

/** Validate a version 1 Codex route and return this project's scope within it. */
export function resolveRoute(projectRoot: string, routeFile: string): RouteScope {
  if (!isAbsolute(routeFile) || !isAbsolute(projectRoot)) {
    throw new RouteError("absolute monitor route and project root paths required");
  }
  const route: unknown = readJson(routeFile);
  if (
    !isRecord(route) ||
    route.version !== 1 ||
    route.harness !== "codex" ||
    (route.state !== "active" && route.state !== "held") ||
    typeof route.host_project_root !== "string" ||
    !isAbsolute(route.host_project_root) ||
    !Array.isArray(route.targets) ||
    !("monitor_thread_id" in route)
  ) {
    throw new RouteError("invalid monitor route schema");
  }
  const hostRoot = route.host_project_root;
  const coordinator = route.monitor_thread_id === null ? null : canonical(route.monitor_thread_id);
  const identities = new Map<string, string>();
  for (const target of route.targets as unknown[]) {
    const ownership = isRecord(target) ? target.ownership : undefined;
    if (!isRecord(target) || (ownership !== "active" && ownership !== "held")) {
      throw new RouteError("invalid target ownership");
    }
    const identity = canonical(target.thread_id);
    const known = identities.get(identity);
    if (known !== undefined && known !== ownership) {
      throw new RouteError("conflicting target ownership");
    }
    identities.set(identity, ownership);
  }
  if (route.state === "active" && coordinator !== null && identities.has(coordinator)) {
    throw new RouteError("active monitor identity must be distinct from every target");
  }
  const peers = [...identities].filter(([, ownership]) => ownership === "active").map(([id]) => id);
  if (route.state === "active" && (coordinator === null || peers.length === 0)) {
    throw new RouteError("active route requires monitor identity and active targets");
  }
  if (resolved(hostRoot) !== resolved(projectRoot)) {
    return { status: "nonhost" };
  }
  if (route.state === "held" || coordinator === null) {
    return { status: "held" };
  }
  return { coordinator, peers, status: "active" };
}
