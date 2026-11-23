// The pin guard. The bundles inline coordination-kit's utilities; the build embeds its version, and
// the package check refuses a build whose bundled version is outside COORDINATION_KIT_RANGE.
// COORDINATOR_CLI_RANGE is the runtime range of the coordinator-installed CLI the seam spawns. At
// startup the runner records the loaded version, the bundled coordination-kit version, the game
// lockfile's integrity for the package and the sha256 of the loaded dist/cli.js in runner.json. At
// each departure it compares them with the installed copy; on a mismatch it logs, emits one
// deduplicated pin-mismatch event and finishes on the loaded code.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeJsonDurable } from "@andornaut/coordination-kit/build/shared";

import type { BusContext } from "./context.ts";
import { readTrimmed } from "./state.ts";

export const PACKAGE = "@andornaut/delivery-kit";
export const COORDINATION_KIT = "@andornaut/coordination-kit";
/**
 * The coordination-kit releases the build may inline. The one place the range is declared. It
 * spans 2.0.1 and 3.x because the bundles use only build/registry, build/review and build/shared,
 * which 3.0 keeps unchanged.
 */
export const COORDINATION_KIT_RANGE = ">=2.0.1 <4.0.0";
/**
 * The coordinator-installed coordination-kit CLI releases whose review and event results this
 * runner accepts. A result from a CLI outside it defers reviews and event delivery.
 */
export const COORDINATOR_CLI_RANGE = ">=3.0.0 <6.0.0";
declare const __DK_COORDINATION_KIT_VERSION__: string;
/** The coordination-kit version the build inlined; source runs report "0.0.0-source". */
export const COORDINATION_KIT_BUNDLED =
  typeof __DK_COORDINATION_KIT_VERSION__ === "string"
    ? __DK_COORDINATION_KIT_VERSION__
    : "0.0.0-source";

/** The read-only status report of the bundled coordination-kit and the supported range. */
export function coordinationKitReport(): { readonly bundled: string; readonly supported: string } {
  return { bundled: COORDINATION_KIT_BUNDLED, supported: COORDINATION_KIT_RANGE };
}

export interface PinIdentity {
  readonly version: string | null;
  readonly integrity: string | null;
  readonly sourceCommit: string | null;
  readonly cliSha256: string | null;
}

function sha256(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function jsonField(path: string, pick: (value: Record<string, unknown>) => unknown): string | null {
  try {
    const value = pick(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
    return typeof value === "string" && value.trim() !== "" ? value : null;
  } catch {
    return null;
  }
}

/** Source metadata is a claim, not independent archive verification. */
function sourceCommit(toolRoot: string): string | null {
  const value = readTrimmed(join(toolRoot, "SOURCE_COMMIT"));
  return value !== undefined && /^[a-f0-9]{40}$/.test(value) ? value : null;
}

function lockIntegrity(repo: string): string | null {
  return jsonField(join(repo, "package-lock.json"), (lock) => {
    const packages = lock.packages as Record<string, Record<string, unknown>> | undefined;
    return packages?.[`node_modules/${PACKAGE}`]?.integrity;
  });
}

/** The package the game's node_modules and package-lock.json currently provide. */
export function installedIdentity(repo: string): PinIdentity {
  const installed = join(repo, "node_modules", PACKAGE);
  return {
    cliSha256: sha256(join(installed, "dist", "cli.js")),
    integrity: lockIntegrity(repo),
    sourceCommit: sourceCommit(installed),
    version: jsonField(join(installed, "package.json"), (manifest) =>
      manifest.name === undefined || manifest.name === PACKAGE ? manifest.version : null,
    ),
  };
}

/** The running code: its embedded version, startup bundle digest and metadata. */
export function loadedIdentity(version: string, cliPath: string, repo: string): PinIdentity {
  return {
    cliSha256: sha256(cliPath),
    integrity: lockIntegrity(repo),
    sourceCommit: sourceCommit(dirname(dirname(cliPath))),
    version,
  };
}

export function recordPin(context: BusContext, loaded: PinIdentity, cliPath: string): void {
  writeJsonDurable(
    context.paths.runnerJson,
    {
      cliPath,
      cliSha256: loaded.cliSha256,
      coordinationKitVersion: COORDINATION_KIT_BUNDLED,
      integrity: loaded.integrity,
      pid: process.pid,
      schema: 1,
      startedAt: new Date(context.clock.now() * 1000).toISOString(),
      version: loaded.version,
    },
    { mode: 0o644 },
  );
}

function describe(identity: PinIdentity): string {
  return `${identity.version ?? "missing"} (cli ${identity.cliSha256?.slice(0, 12) ?? "missing"}, integrity ${
    identity.integrity ?? "missing"
  })`;
}

function samePin(a: PinIdentity, b: PinIdentity): boolean {
  return a.version === b.version && a.cliSha256 === b.cliSha256 && a.integrity === b.integrity;
}

/** A guard bound to the loaded identity; check() returns false on a mismatch. */
export function pinGuard(context: BusContext, loaded: PinIdentity): { check(): boolean } {
  let reported: string | undefined;
  return {
    check(): boolean {
      const installed = installedIdentity(context.game.repo);
      if (samePin(loaded, installed)) {
        return true;
      }
      const key = `${describe(loaded)} -> ${describe(installed)}`;
      context.log(
        `bus: pin mismatch: loaded ${describe(loaded)}, installed ${describe(installed)}; finishing on the loaded code`,
      );
      if (reported !== key) {
        reported = key;
        context.events.emit(
          "pin-mismatch",
          createHash("sha256").update(key).digest("hex"),
          [
            `Runner pin mismatch: loaded ${describe(loaded)}, installed ${describe(installed)};`,
            "the runner finishes on the loaded code until a controlled idle replacement.",
          ].join(" "),
        );
      }
      return false;
    },
  };
}

type Release = readonly [number, number, number];

/** A plain MAJOR.MINOR.PATCH release; prereleases and build metadata are not releases. */
function release(version: string): Release | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(left: Release, right: Release): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/** Whether a plain release satisfies every space-separated `<`, `<=`, `>`, `>=` or `=` comparator. */
export function satisfies(range: string, version: string): boolean {
  const target = release(version);
  if (target === null) {
    return false;
  }
  return range
    .trim()
    .split(/\s+/)
    .every((comparator) => {
      const match = /^(<=|>=|<|>|=)?(.+)$/.exec(comparator);
      const bound = release(match?.[2] ?? "");
      if (match === null || bound === null) {
        throw new Error(`unsupported range comparator: ${comparator}`);
      }
      const order = compare(target, bound);
      switch (match[1] ?? "=") {
        case "<":
          return order < 0;
        case "<=":
          return order <= 0;
        case ">":
          return order > 0;
        case ">=":
          return order >= 0;
        default:
          return order === 0;
      }
    });
}
