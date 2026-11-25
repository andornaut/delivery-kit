// Matching a release version against an npm `engines` range, for the optional package check.
//
// It covers the range grammar `engines` fields use: `||` alternatives of space-separated
// comparators (`<`, `<=`, `>`, `>=`, `=`, `^`, `~`), partial and wildcard versions (`1`, `1.2`,
// `1.x`, `*`) and hyphen ranges (`1.2 - 2`). Anything else, a prerelease tag included, is
// unknown, so the caller can stay conservative.

type Version = readonly [number, number, number];
type Operator = "<" | "<=" | ">" | ">=";
interface Bound {
  readonly operator: Operator;
  readonly version: Version;
}
/** A version with any trailing parts missing or wildcards; undefined marks each. */
type Partial = readonly [number | undefined, number | undefined, number | undefined];

const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/u;
const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)$/u;
const COMPARATOR = /^(<=|>=|<|>|=|\^|~>|~|)(.*)$/u;
const HYPHEN = /^(\S+)\s+-\s+(\S+)$/u;

function partial(text: string): Partial | undefined {
  const match = PARTIAL.exec(text);
  if (match === null) {
    return undefined;
  }
  const parts: (number | undefined)[] = [];
  for (const part of match.slice(1, 4)) {
    // A wildcard or missing part makes every later part a wildcard too.
    parts.push(
      part === undefined || /^[xX*]$/u.test(part) || parts.includes(undefined)
        ? undefined
        : Number(part),
    );
  }
  return [parts[0], parts[1], parts[2]];
}

function compare(left: Version, right: Version): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function filled([major, minor, patch]: Partial): Version {
  return [major ?? 0, minor ?? 0, patch ?? 0];
}

/** The exclusive upper bound of the versions a partial version names (`1.2` is below `1.3.0`). */
function above([major, minor]: Partial): Version | undefined {
  if (major === undefined) {
    return undefined;
  }
  return minor === undefined ? [major + 1, 0, 0] : [major, minor + 1, 0];
}

/** The bounds of `<=`-style upper end `version`: inclusive when complete, else below the next. */
function atMost(version: Partial): Bound[] | undefined {
  if (version[2] !== undefined) {
    return [{ operator: "<=", version: filled(version) }];
  }
  const next = above(version);
  return next === undefined ? [] : [{ operator: "<", version: next }];
}

function caretUpper([major, minor, patch]: Partial): Version {
  if (major === undefined || major > 0 || minor === undefined) {
    return [(major ?? 0) + 1, 0, 0];
  }
  if (minor > 0 || patch === undefined) {
    return [0, minor + 1, 0];
  }
  return [0, 0, patch + 1];
}

/** The bounds one comparator stands for; [] is any version and undefined is unknown. */
function comparator(text: string): Bound[] | undefined {
  const [, operator = "", rest = ""] = COMPARATOR.exec(text) ?? [];
  const version = partial(rest);
  if (version === undefined) {
    return undefined;
  }
  const lower: Bound = { operator: ">=", version: filled(version) };
  const wildcard = version[0] === undefined;
  switch (operator) {
    case "":
    case "=":
      return wildcard ? [] : [lower, ...(atMost(version) ?? [])];
    case ">=":
      return [lower];
    case ">": {
      if (version[2] !== undefined) {
        return [{ operator: ">", version: filled(version) }];
      }
      const next = above(version);
      return next === undefined ? undefined : [{ operator: ">=", version: next }];
    }
    case "<":
      return wildcard ? undefined : [{ operator: "<", version: filled(version) }];
    case "<=":
      return atMost(version);
    case "^":
      return wildcard ? [] : [lower, { operator: "<", version: caretUpper(version) }];
    default: {
      // `~` and `~>`: patch changes only, or minor changes when no minor is given.
      if (wildcard) {
        return [];
      }
      const next = above(version[1] === undefined ? version : [version[0], version[1], 0]);
      return next === undefined ? [lower] : [lower, { operator: "<", version: next }];
    }
  }
}

/** The bounds of one `||` alternative, or undefined when any part is unknown. */
function alternative(text: string): Bound[] | undefined {
  const trimmed = text.trim();
  const hyphen = HYPHEN.exec(trimmed);
  if (hyphen !== null) {
    const from = partial(hyphen[1] ?? "");
    const to = partial(hyphen[2] ?? "");
    if (from === undefined || to === undefined) {
      return undefined;
    }
    const upper = atMost(to);
    return upper === undefined ? undefined : [{ operator: ">=", version: filled(from) }, ...upper];
  }
  const bounds: Bound[] = [];
  const parts = trimmed.replace(/(<=|>=|<|>|=|\^|~>|~)\s+/gu, "$1").split(/\s+/u);
  for (const part of parts.filter((value) => value !== "")) {
    const more = comparator(part);
    if (more === undefined) {
      return undefined;
    }
    bounds.push(...more);
  }
  return bounds;
}

function within(version: Version, bound: Bound): boolean {
  const order = compare(version, bound.version);
  switch (bound.operator) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    default:
      return order >= 0;
  }
}

/**
 * Whether the release `version` (`24.11.1`) satisfies the npm range `range`, or undefined when
 * either cannot be read.
 */
export function satisfiesRange(range: string, version: string): boolean | undefined {
  const release = RELEASE.exec(version.trim());
  if (release === null) {
    return undefined;
  }
  const parsed: Version = [Number(release[1]), Number(release[2]), Number(release[3])];
  let unknown = false;
  for (const text of range.split("||")) {
    const bounds = alternative(text);
    if (bounds === undefined) {
      unknown = true;
    } else if (bounds.every((bound) => within(parsed, bound))) {
      return true;
    }
  }
  return unknown ? undefined : false;
}
