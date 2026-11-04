// CLEANUP (added 2026-11-03): remove with src/migrate/ at convergence (see tree.ts).
//
// The 0.x monitor route lives in the route host game's .claude/monitor/route.json; 1.x reads the
// fixed var/route.json in the role-name schema, checked with the runtime route validator. The
// host is the one game that has the file, and its host_project_root must name that game. Each conversation ID
// in the 0.x route (version 1 monitor_thread_id and targets[].thread_id, or version 2
// monitor.session_id and targets[].session_id) maps through the registry's conversations to
// exactly one role. The write follows the tree rules: hashed, durable, marked with the source
// digest, idempotent, then the source is made read-only.
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { type RoleRoute, validateRoleRoute } from "../adapters/shared/route.ts";
import { readJsonIfExists, writeDurable, writeJsonDurable } from "../durable.ts";
import { gameLayout, type Layout } from "../layout.ts";
import type { RoleRecord } from "../registry/schema.ts";
import type { MigrationMarker } from "./marker.ts";
import { hashFile } from "./tree.ts";

export interface RoutePlan {
  readonly kind: "copy" | "done";
  readonly game: string;
  readonly source: string;
  readonly target: string;
  readonly marker: string;
  readonly sha256: string;
  readonly mode: number;
  readonly size: number;
  /** The converted var/route.json, for a copy. */
  readonly route?: RoleRoute;
}

export const ROUTE_MARKER = "route.migrated.json";

export function legacyRouteFile(repo: string): string {
  return join(repo, ".claude", "monitor", "route.json");
}

function isRegularFile(path: string): boolean | undefined {
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function readSource(source: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(source, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The monitor ID and target IDs of a version 1 or version 2 route, in source order. */
function sourceIds(
  route: Record<string, unknown>,
): { monitor: unknown; targets: unknown[] } | string {
  const targets = route.targets;
  if (!Array.isArray(targets)) {
    return "targets must be an array";
  }
  if (route.version === 1) {
    return {
      monitor: route.monitor_thread_id,
      targets: targets.map((target) => field(target, "thread_id")),
    };
  }
  if (route.version === 2) {
    return {
      monitor: field(route.monitor, "session_id"),
      targets: targets.map((target) => field(target, "session_id")),
    };
  }
  return "version must be 1 or 2";
}

/** Every role whose conversation, for any harness, is `id`. */
function rolesFor(roles: Readonly<Record<string, RoleRecord>>, id: string): string[] {
  return Object.entries(roles)
    .filter(([, role]) => Object.values(role.conversations).includes(id))
    .map(([key]) => key);
}

/** Convert a 0.x route to schema 1, recording a problem for each ID that maps to no or many roles. */
export function convertRoute(
  layout: Layout,
  roles: Readonly<Record<string, RoleRecord>>,
  host: string,
  source: Record<string, unknown>,
  problems: string[],
): RoleRoute | undefined {
  const ids = sourceIds(source);
  if (typeof ids === "string") {
    problems.push(`route: ${ids}`);
    return undefined;
  }
  const unmapped: string[] = [];
  const ambiguous: string[] = [];
  const resolve = (id: unknown): string | undefined => {
    if (typeof id !== "string" || id === "") {
      unmapped.push(String(id));
      return undefined;
    }
    const matches = rolesFor(roles, id);
    if (matches.length === 0) {
      unmapped.push(id);
    } else if (matches.length > 1) {
      ambiguous.push(`${id} (${matches.sort().join(", ")})`);
    }
    return matches.length === 1 ? matches[0] : undefined;
  };
  const monitor = resolve(ids.monitor);
  const targets = ids.targets.map(resolve);
  if (unmapped.length > 0) {
    problems.push(`route: these IDs map to no registry role: ${unmapped.join(", ")}`);
  }
  if (ambiguous.length > 0) {
    problems.push(`route: these IDs map to more than one registry role: ${ambiguous.join("; ")}`);
  }
  if (unmapped.length > 0 || ambiguous.length > 0 || monitor === undefined) {
    return undefined;
  }
  const route = {
    host,
    monitor,
    schema: 1,
    state: source.state,
    targets: [...new Set(targets as string[])],
  };
  try {
    return validateRoleRoute(layout.config, route);
  } catch (error) {
    problems.push(`route: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Plan the route conversion, or return undefined after recording a problem or a note. `roles` is
 * the registry being built, or the existing one; undefined when neither is available.
 */
export function planRoute(
  layout: Layout,
  roles: Readonly<Record<string, RoleRecord>> | undefined,
  notes: string[],
  problems: string[],
): RoutePlan | undefined {
  const hosts = Object.keys(layout.config.games).filter(
    (game) => isRegularFile(legacyRouteFile(gameLayout(layout, game).repo)) !== undefined,
  );
  if (hosts.length === 0) {
    notes.push("route: no game has .claude/monitor/route.json; nothing to migrate");
    return undefined;
  }
  if (hosts.length > 1) {
    problems.push(`route: more than one game has .claude/monitor/route.json (${hosts.join(", ")})`);
    return undefined;
  }
  const [game] = hosts as [string];
  const repo = gameLayout(layout, game).repo;
  const source = legacyRouteFile(repo);
  const target = layout.routeFile;
  const marker = join(layout.varDir, ROUTE_MARKER);
  if (isRegularFile(source) !== true) {
    problems.push(`route: ${source} is not a regular file`);
    return undefined;
  }
  const content = readSource(source);
  if (content === undefined) {
    problems.push(`route: ${source} is not a JSON object`);
    return undefined;
  }
  const root = content.host_project_root;
  if (typeof root !== "string" || resolve(root) !== repo) {
    problems.push(`route: ${source} host_project_root does not name ${repo}`);
    return undefined;
  }
  const stats = lstatSync(source);
  const sha256 = hashFile(source);
  const plan = { game, marker, mode: stats.mode & 0o777, sha256, size: stats.size, source, target };
  const recorded = readJsonIfExists(marker) as Partial<MigrationMarker> | undefined;
  if (recorded !== undefined) {
    if (recorded.schema !== 1 || recorded.source !== source) {
      problems.push(`route: ${marker} does not describe ${source}`);
      return undefined;
    }
    if (isRegularFile(target) !== true) {
      problems.push(`route: ${marker} exists but ${target} does not`);
      return undefined;
    }
    if (recorded.sourceDigest !== sha256) {
      problems.push(
        `route: ${source} changed since it was migrated; inspect before migrating again`,
      );
      return undefined;
    }
    return { ...plan, kind: "done" };
  }
  if (isRegularFile(target) !== undefined) {
    problems.push(`route: ${target} exists without ${marker}; inspect it before migrating`);
    return undefined;
  }
  if (roles === undefined) {
    problems.push("route: no registry to map conversation IDs to role names");
    return undefined;
  }
  const route = convertRoute(layout, roles, game, content, problems);
  return route === undefined ? undefined : { ...plan, kind: "copy", route };
}

export function describeRoute(plan: RoutePlan): string {
  return plan.kind === "done"
    ? `route: already migrated from ${plan.source} (digest matches)\n`
    : `route: convert ${plan.source} -> ${plan.target} (${plan.game} is the route host; monitor ${
        plan.route?.monitor ?? "?"
      }, ${plan.route?.targets.length ?? 0} targets)\n`;
}

/**
 * Write the converted route durably, verify it reads back as written and the source is unchanged,
 * then write the marker with the source digest.
 */
export function copyRoute(now: Date, plan: RoutePlan): void {
  if (plan.route === undefined) {
    throw new Error("route: nothing converted to write");
  }
  const data = `${JSON.stringify(plan.route, null, 2)}\n`;
  writeDurable(plan.target, data, { mode: plan.mode });
  if (readFileSync(plan.target, "utf8") !== data || hashFile(plan.source) !== plan.sha256) {
    throw new Error(`route: ${plan.target} does not hold the conversion of ${plan.source}`);
  }
  const targetDigest = hashFile(plan.target);
  const marker: MigrationMarker = {
    bytes: Buffer.byteLength(data),
    entries: 1,
    excluded: [],
    log: null,
    migratedAt: now.toISOString(),
    schema: 1,
    source: plan.source,
    sourceDigest: plan.sha256,
    target: plan.target,
    targetDigest,
    unit: "route",
  };
  writeJsonDurable(plan.marker, marker);
}
