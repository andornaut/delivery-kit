// CLEANUP (added 2026-11-03): remove with src/migrate/ at convergence (see tree.ts).
//
// The 0.x monitor route lives in the route host game's .claude/monitor/route.json; 1.x reads the
// fixed var/route.json. The host is the one game that has the file, and the route's own
// host_project_root must name that game. The copy follows the tree rules: hashed, durable,
// marked, idempotent, then the source is made read-only.
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { readJsonIfExists, writeDurable, writeJsonDurable } from "../durable.ts";
import { gameLayout, type Layout } from "../layout.ts";
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

function hostRoot(source: string): unknown {
  try {
    return (JSON.parse(readFileSync(source, "utf8")) as { host_project_root?: unknown })
      .host_project_root;
  } catch {
    return null;
  }
}

/** Plan the route copy, or return undefined after recording a problem or a note. */
export function planRoute(
  layout: Layout,
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
  const root = hostRoot(source);
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
  return { ...plan, kind: "copy" };
}

export function describeRoute(plan: RoutePlan): string {
  return plan.kind === "done"
    ? `route: already migrated from ${plan.source} (digest matches)\n`
    : `route: copy ${plan.source} -> ${plan.target} (${plan.game} is the route host)\n`;
}

/** Copy the route with a durable write, verify both hashes, then write the marker. */
export function copyRoute(now: Date, plan: RoutePlan): void {
  const data = readFileSync(plan.source);
  writeDurable(plan.target, data, { mode: plan.mode });
  const targetDigest = hashFile(plan.target);
  if (targetDigest !== plan.sha256 || hashFile(plan.source) !== plan.sha256) {
    throw new Error(`route: ${plan.target} does not match ${plan.source}`);
  }
  const marker: MigrationMarker = {
    bytes: plan.size,
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
