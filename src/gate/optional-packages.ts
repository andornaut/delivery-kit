// The optional packages a passing install must have left in the gate container.
//
// npm skips an optional package whose fetch, build, platform or engine check fails and still
// exits 0. After a passing install of a checkout with package-lock.json (lockfileVersion 2 or 3),
// the gate reads the container's platform and expects every lock entry npm would have installed
// there with the `optional` flag. Entries flagged `devOptional` are not expected: npm treats
// their failure as an install failure, which exits non-zero.
//
// npm installs what the root and workspace folders reach through their dependencies, resolved by
// walking up node_modules/ directories, and skips an optional entry whose os, cpu, libc or
// engines do not match, together with what only it reaches. An entry whose engines range cannot
// be read is treated as skipped, so the check never requires a package npm might have skipped.
// The expectation assumes npm's default selection, as `npm ci` makes it: an install that omits
// optional, dev or peer packages leaves out entries this check requires.
import { isRecord } from "../lib/values.ts";
import { satisfiesRange } from "./version-range.ts";

/** The platform and versions npm matched lock entries against inside the gate container. */
export interface InstallPlatform {
  /** process.platform, such as linux. */
  readonly os: string;
  /** process.arch, such as x64. */
  readonly cpu: string;
  /** The libc family npm detects (glibc or musl), or undefined when it detects none. */
  readonly libc: string | undefined;
  /** The Node.js version, such as 24.11.1. */
  readonly node: string;
  /** The npm version, or undefined when the image has no npm. */
  readonly npm: string | undefined;
}

type LockEntry = Readonly<Record<string, unknown>>;
type LockPackages = Readonly<Record<string, LockEntry>>;

/** The `packages` map of a lockfileVersion 2 or 3 lock, or undefined for any other value. */
function lockPackages(lock: unknown): LockPackages | undefined {
  if (!isRecord(lock) || (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3)) {
    return undefined;
  }
  const { packages } = lock;
  if (!isRecord(packages)) {
    return undefined;
  }
  const entries: Record<string, LockEntry> = {};
  for (const [key, entry] of Object.entries(packages)) {
    if (isRecord(entry)) {
      entries[key] = entry;
    }
  }
  return entries;
}

/** Whether a lockfileVersion 2 or 3 lock lists any optional package. */
export function hasOptionalPackages(lock: unknown): boolean {
  return Object.values(lockPackages(lock) ?? {}).some((entry) => entry.optional === true);
}

/**
 * npm's platform list match: no negated (`!value`) entry names the value, and some plain entry
 * does when there are any. A list of only `any` matches everything.
 */
function listMatches(value: string | undefined, list: unknown): boolean {
  const entries = typeof list === "string" ? [list] : list;
  if (!Array.isArray(entries)) {
    return true;
  }
  if (entries.length === 1 && entries[0] === "any") {
    return true;
  }
  let negated = 0;
  let matched = false;
  for (const entry of entries) {
    const text = String(entry);
    if (text.startsWith("!")) {
      negated += 1;
      if (text.slice(1) === value) {
        return false;
      }
    } else {
      matched ||= text === value;
    }
  }
  return matched || negated === entries.length;
}

/** Whether npm installs an optional entry on `platform`: its os, cpu, libc and engines match. */
function installable(platform: InstallPlatform, entry: LockEntry): boolean {
  if (entry.os !== undefined && !listMatches(platform.os, entry.os)) {
    return false;
  }
  if (entry.cpu !== undefined && !listMatches(platform.cpu, entry.cpu)) {
    return false;
  }
  if (entry.libc !== undefined) {
    // npm checks libc on Linux only and never matches an undetected family.
    if (platform.os !== "linux" || platform.libc === undefined) {
      return false;
    }
    if (!listMatches(platform.libc, entry.libc)) {
      return false;
    }
  }
  const engines = isRecord(entry.engines) ? entry.engines : {};
  for (const [engine, version] of [
    ["node", platform.node],
    ["npm", platform.npm],
  ] as const) {
    const range = engines[engine];
    if (typeof range === "string") {
      if (version === undefined || satisfiesRange(range, version) !== true) {
        return false;
      }
    }
  }
  return true;
}

/** Dependency names an entry's installed copy needs, leaving out optional peers. */
function dependencyNames(entry: LockEntry): string[] {
  const optionalPeers = isRecord(entry.peerDependenciesMeta) ? entry.peerDependenciesMeta : {};
  const names = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const map = entry[field];
    for (const name of isRecord(map) ? Object.keys(map) : []) {
      const meta = optionalPeers[name];
      if (field !== "peerDependencies" || !(isRecord(meta) && meta.optional === true)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/** The lock key `name` resolves to from `from`, walking up node_modules/ directories. */
function resolveKey(packages: LockPackages, from: string, name: string): string | undefined {
  const segments = from === "" ? [] : from.split("/");
  for (let length = segments.length; length >= 0; length -= 1) {
    const directory = segments.slice(0, length);
    if (directory.at(-1) !== "node_modules") {
      const key = [...directory, "node_modules", name].join("/");
      if (packages[key] !== undefined) {
        return key;
      }
    }
  }
  return undefined;
}

const IN_NODE_MODULES = /(?:^|\/)node_modules\//u;

/**
 * The `packages` keys (node_modules/... paths, nested ones included) of the optional entries npm
 * installs on `platform` from `lock`. Empty for anything but a lockfileVersion 2 or 3 lock.
 */
export function expectedOptionalPackages(platform: InstallPlatform, lock: unknown): string[] {
  const packages = lockPackages(lock);
  if (packages === undefined) {
    return [];
  }
  // The root, workspace and other linked folders are the checkout itself.
  const pending = Object.keys(packages).filter((key) => !IN_NODE_MODULES.test(key));
  const reached = new Set<string>();
  const expected: string[] = [];
  while (pending.length > 0) {
    const key = pending.pop() ?? "";
    const entry = packages[key];
    if (reached.has(key) || entry === undefined) {
      continue;
    }
    reached.add(key);
    // A link's target is a folder of the checkout, which is a starting point already.
    if (entry.link === true) {
      continue;
    }
    if (entry.optional === true) {
      if (!installable(platform, entry)) {
        continue;
      }
      // A bundled package arrives inside its parent's tarball, not from its own fetch.
      if (entry.inBundle !== true) {
        expected.push(key);
      }
    }
    for (const name of dependencyNames(entry)) {
      const resolved = resolveKey(packages, key, name);
      if (resolved !== undefined) {
        pending.push(resolved);
      }
    }
  }
  return expected.sort();
}

/** At most this many missing packages are named in a block reason. */
const NAMED_LIMIT = 5;

/**
 * The reason to block a gate whose install left out an `expected` optional package, or undefined
 * when every one is `present`. `log` names the install log.
 */
export function skippedOptionalReason(
  log: string,
  platform: InstallPlatform,
  expected: readonly string[],
  present: readonly string[],
): string | undefined {
  const installed = new Set(present);
  const missing = expected.filter((key) => !installed.has(key));
  if (missing.length === 0) {
    return undefined;
  }
  const named = missing.slice(0, NAMED_LIMIT).join(", ");
  const more =
    missing.length > NAMED_LIMIT ? ` and ${String(missing.length - NAMED_LIMIT)} more` : "";
  const target = [platform.os, platform.cpu, platform.libc].filter((part) => part !== undefined);
  return (
    `install skipped optional packages that package-lock.json lists for ${target.join(" ")}: ` +
    `${named}${more}; see ${log}`
  );
}

/** PLATFORM_SCRIPT's exit status when the image has no node, which it prints. */
export const NO_NODE = 3;

// Print npm's view of the container as JSON. The libc family follows npm's detection: the text
// of /usr/bin/ldd, else the process report's glibc runtime or musl shared objects.
const PLATFORM_JS = [
  'const fs = require("fs");',
  "let libc = null;",
  'if (process.platform === "linux") {',
  "  let ldd;",
  '  try { ldd = fs.readFileSync("/usr/bin/ldd", "utf8"); } catch {}',
  "  if (ldd !== undefined) {",
  '    libc = ldd.includes("musl") ? "musl" : ldd.includes("GNU C Library") ? "glibc" : null;',
  "  } else {",
  "    const report = process.report.getReport();",
  "    const objects = Array.isArray(report.sharedObjects) ? report.sharedObjects : [];",
  '    libc = report.header && report.header.glibcVersionRuntime ? "glibc"',
  '      : objects.some((f) => f.includes("libc.musl-") || f.includes("ld-musl-")) ? "musl" : null;',
  "  }",
  "}",
  "console.log(JSON.stringify({ cpu: process.arch, libc, node: process.versions.node,",
  "  npm: process.env.NPM_VERSION || null, os: process.platform }));",
].join("\n");

/** Reads the container's platform; exits NO_NODE, printing `node`, when the image has none. */
export const PLATFORM_SCRIPT = [
  `command -v node >/dev/null 2>&1 || { echo node; exit ${String(NO_NODE)}; }`,
  "NPM_VERSION=$(npm_config_update_notifier=false npm --version 2>/dev/null || true)",
  `NPM_VERSION="$NPM_VERSION" node -e '${PLATFORM_JS}'`,
].join("\n");

/** The InstallPlatform PLATFORM_SCRIPT printed, or undefined when its output is not one. */
export function parseInstallPlatform(stdout: string): InstallPlatform | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.os !== "string" ||
    typeof value.cpu !== "string" ||
    typeof value.node !== "string"
  ) {
    return undefined;
  }
  return {
    cpu: value.cpu,
    libc: typeof value.libc === "string" ? value.libc : undefined,
    node: value.node,
    npm: typeof value.npm === "string" && value.npm !== "" ? value.npm : undefined,
    os: value.os,
  };
}

/**
 * Prints each of its arguments, lock keys relative to the working copy `work`, whose package is
 * installed (it has a package.json).
 */
export function presenceScript(work: string): string {
  return [
    `cd ${work} || exit 1`,
    'for path; do if test -e "$path/package.json"; then printf "%s\\n" "$path"; fi; done',
  ].join("\n");
}
