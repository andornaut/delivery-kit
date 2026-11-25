// The package identity and the coordination-kit releases it supports: the one place each range is
// declared. The bundles inline coordination-kit's utilities; the build embeds both versions, and
// the package check refuses a build whose bundled coordination-kit is outside
// COORDINATION_KIT_RANGE. COORDINATOR_CLI_RANGE is the runtime range of the coordinator-installed
// CLI the seam spawns.

export const PACKAGE = "@andornaut/delivery-kit";
export const COORDINATION_KIT = "@andornaut/coordination-kit";
/**
 * The coordination-kit releases the build may inline. It spans 2.0.1 and 3.x because the bundles
 * use only build/registry, build/review and build/shared, which 3.0 keeps unchanged.
 */
export const COORDINATION_KIT_RANGE = ">=2.0.1 <4.0.0";
/**
 * The coordinator-installed coordination-kit CLI releases whose review and event results this
 * runner accepts. A result from a CLI outside it defers reviews and event delivery.
 */
export const COORDINATOR_CLI_RANGE = ">=3.0.0 <7.0.0";

declare const __DK_VERSION__: string;
declare const __DK_COORDINATION_KIT_VERSION__: string;
/** The delivery-kit version the build embedded; source runs report "0.0.0-source". */
export const VERSION = typeof __DK_VERSION__ === "string" ? __DK_VERSION__ : "0.0.0-source";
/** The coordination-kit version the build inlined; source runs report "0.0.0-source". */
export const COORDINATION_KIT_BUNDLED =
  typeof __DK_COORDINATION_KIT_VERSION__ === "string"
    ? __DK_COORDINATION_KIT_VERSION__
    : "0.0.0-source";

/** The read-only status report of the bundled coordination-kit and the supported range. */
export function coordinationKitReport(): { readonly bundled: string; readonly supported: string } {
  return { bundled: COORDINATION_KIT_BUNDLED, supported: COORDINATION_KIT_RANGE };
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
