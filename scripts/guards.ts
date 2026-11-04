// Resource, source-identity and ownership guards shared by check.ts, contract.ts and pack.ts.
// They run on the host as the invoking user and use only node: builtins plus git.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** The uid and gid every container runs as; nothing on the host is owned by them. */
export const CONTAINER_ID = 19001;
export const LOAD_LIMIT = 24;
export const DEFAULT_VOLUME = "delivery-kit-npm-check";

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

/** The verification image is the Node version pinned in .nvmrc. */
export function checkImage(root: string): string {
  return `node:${readFileSync(join(root, ".nvmrc"), "utf8").trim().replace(/^v/, "")}`;
}

/** Fail unless the one-minute load in `loadavg` (the /proc/loadavg text) is below the limit. */
export function requireLoad(loadavg = readFileSync("/proc/loadavg", "utf8")): void {
  const load = Number(loadavg.split(/\s+/)[0]);
  if (!(load < LOAD_LIMIT)) {
    throw new GuardError(`one-minute load must be below ${LOAD_LIMIT} before starting a container`);
  }
}

function git(root: string, args: string[]): Buffer {
  const result = spawnSync("git", ["-C", root, ...args], { maxBuffer: 1 << 30 });
  if (result.status !== 0) {
    throw new GuardError(`git ${args[0] ?? ""} failed: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout;
}

function nulSplit(data: Buffer): string[] {
  return data
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry !== "");
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function walk(
  root: string,
  skip: (relativePath: string) => boolean,
  visit: (path: string) => void,
): void {
  const recurse = (path: string): void => {
    visit(path);
    const stats = lstatSync(path);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      for (const name of readdirSync(path).sort()) {
        const child = join(path, name);
        if (!skip(relative(root, child))) {
          recurse(child);
        }
      }
    }
  };
  recurse(root);
}

/**
 * The files a check sees: Git's tracked and untracked list, or a snapshot's files outside
 * .claude, node_modules and dist. Paths a worktree deletes are left out, so a copy of the list
 * matches the fingerprinted tree.
 */
export function sourceList(root: string): string[] {
  let names: string[];
  if (existsSync(join(root, ".git"))) {
    names = nulSplit(
      git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"]),
    );
  } else {
    names = [];
    const pruned = new Set([".claude", "node_modules", "dist"]);
    walk(
      root,
      (path) => pruned.has(path),
      (path) => {
        const stats = lstatSync(path);
        if (path !== root && (stats.isFile() || stats.isSymbolicLink())) {
          names.push(relative(root, path));
        }
      },
    );
  }
  return names.filter((name) => present(join(root, name)));
}

const CREDENTIAL_SHAPED = /\/(\.env|\.env\..*|\.ssh|\.private)\//;

/**
 * Digest of Git status plus the name, mode and content of every listed file. A source snapshot
 * without Git metadata is identified by its SOURCE_COMMIT and file contents instead.
 * Credential-shaped paths are refused before any content is read.
 */
export function sourceFingerprint(root: string): string {
  const hash = createHash("sha256");
  let names: string[];
  if (existsSync(join(root, ".git"))) {
    hash.update(git(root, ["rev-parse", "HEAD"]));
    hash.update(git(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]));
    names = nulSplit(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]));
  } else if (existsSync(join(root, "SOURCE_COMMIT"))) {
    hash.update("snapshot\0");
    names = [];
    walk(
      root,
      () => false,
      (path) => {
        const stats = lstatSync(path);
        if (path !== root && (stats.isFile() || stats.isSymbolicLink())) {
          names.push(relative(root, path));
        }
      },
    );
  } else {
    throw new GuardError("checks require a checkout or identified source snapshot");
  }
  const sorted = [...new Set(names)].sort();
  if (sorted.some((name) => CREDENTIAL_SHAPED.test(`/${name}/`))) {
    throw new GuardError("refusing a credential-shaped path in the source fingerprint");
  }
  for (const name of sorted) {
    const path = join(root, name);
    hash.update(`${name}\0`);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      hash.update("missing\0");
      continue;
    }
    if (stats.isSymbolicLink()) {
      hash.update(`link:${readlinkSync(path)}\0`);
    } else if (stats.isFile()) {
      hash.update(`${(stats.mode & 0o7777).toString(8)}\0`);
      hash.update(createHash("sha256").update(readFileSync(path)).digest("hex"));
    } else {
      hash.update("missing\0");
    }
  }
  return hash.digest("hex");
}

/**
 * Owner, group and mode of every host entry under the checkout except .git, so a container that
 * changed any of them is detected even where the content fingerprint does not look.
 */
export function hostOwners(root: string): string {
  const lines: string[] = [];
  walk(
    root,
    (path) => path === ".git",
    (path) => {
      const stats = lstatSync(path);
      lines.push(`${stats.uid}:${stats.gid} ${(stats.mode & 0o7777).toString(8)} ${path}`);
    },
  );
  return createHash("sha256").update(lines.sort().join("\0")).digest("hex");
}

/** The first entry under `root`, .git included, owned by one of the given uids or gids. */
export function foreignOwner(
  root: string,
  ids: { readonly uids: readonly number[]; readonly gids: readonly number[] },
): string | undefined {
  let found: string | undefined;
  walk(
    root,
    () => found !== undefined,
    (path) => {
      if (found === undefined) {
        const stats = lstatSync(path);
        if (ids.uids.includes(stats.uid) || ids.gids.includes(stats.gid)) {
          found = path;
        }
      }
    },
  );
  return found;
}

export interface Snapshot {
  readonly fingerprint: string;
  readonly owners: string;
}

export function snapshot(root: string): Snapshot {
  return { fingerprint: sourceFingerprint(root), owners: hostOwners(root) };
}

/**
 * The problem that discards a check result, or undefined when the source content, ownership and
 * modes are unchanged and nothing in the checkout is owned by a container identity.
 */
export function discardReason(
  root: string,
  before: Snapshot,
  ids: { readonly uids: readonly number[]; readonly gids: readonly number[] },
): string | undefined {
  let after: Snapshot;
  try {
    after = snapshot(root);
  } catch {
    return "cannot verify source fingerprints; discard the check result";
  }
  if (after.fingerprint !== before.fingerprint || after.owners !== before.owners) {
    return "source content or ownership changed during checks; discard the check result";
  }
  const owned = foreignOwner(root, ids);
  if (owned !== undefined) {
    return `${owned} is owned by a container identity`;
  }
  return undefined;
}

/** `--group-add` arguments for the distinct groups of `paths`, so uid 19001 can read them. */
export function groupAdds(paths: readonly string[]): string[] {
  const gids = [...new Set(paths.map((path) => lstatSync(path).gid))].sort((a, b) => a - b);
  return gids.flatMap((gid) => ["--group-add", String(gid)]);
}

/** Run a command with inherited output; returns its exit status (1 when it could not start). */
export function run(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): number {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error !== undefined) {
    process.stderr.write(`delivery-kit: ${command}: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

/** Whether pack's two arguments are an exact 40-hex SHA and a new absolute directory. */
export function validPackArgs(args: readonly string[]): boolean {
  const [sha, output] = args;
  return (
    args.length === 2 &&
    sha !== undefined &&
    /^[0-9a-f]{40}$/.test(sha) &&
    output !== undefined &&
    isAbsolute(output) &&
    !existsSync(output)
  );
}
