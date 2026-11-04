// CLEANUP (added 2026-11-03): 0.x state migration. Remove with the rest of src/migrate/ once both
// skills use only config.json and var/registry.json, every game has completed one clean 1.x cycle
// (scheduled departure, CI, deploy, accepted event and ack, no ambiguous receipts) and no process
// references an old path.
//
// Tree scan, hashed copy and read-only marking. Symlinks are copied as links, never followed.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  rmSync,
  type Stats,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";

import { fsyncDirectory } from "../durable.ts";

export type EntryKind = "dir" | "file" | "symlink";

export interface Entry {
  /** Path relative to the scanned root, with `/` separators. */
  readonly path: string;
  readonly kind: EntryKind;
  /** Permission bits, including setgid and sticky. */
  readonly mode: number;
  readonly size: number;
  /** sha256 of a file's content, a symlink's target, or "" for a directory. */
  readonly digest: string;
}

/** True to leave `path` (and, for a directory, everything under it) out of the scan. */
export type Exclude = (path: string, kind: EntryKind) => boolean;

export class UnsupportedEntry extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`${path}: only directories, regular files and symlinks can be migrated`);
    this.name = "UnsupportedEntry";
    this.path = path;
  }
}

const CHUNK = 1 << 20;

export function hashFile(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK, null);
      if (read === 0) {
        break;
      }
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function kindOf(absolute: string, stats: Stats): EntryKind {
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (stats.isDirectory()) {
    return "dir";
  }
  if (stats.isFile()) {
    return "file";
  }
  throw new UnsupportedEntry(absolute);
}

/** Every entry under `root` (not `root` itself), sorted by path, minus the excluded ones. */
export function scanTree(exclude: Exclude, root: string): Entry[] {
  const entries: Entry[] = [];
  const walk = (relative: string): void => {
    const directory = relative === "" ? root : join(root, relative);
    for (const name of readdirSync(directory).sort()) {
      const path = relative === "" ? name : `${relative}/${name}`;
      const absolute = join(root, path);
      const stats = lstatSync(absolute);
      const kind = kindOf(absolute, stats);
      if (exclude(path, kind)) {
        continue;
      }
      let digest = "";
      if (kind === "file") {
        digest = hashFile(absolute);
      } else if (kind === "symlink") {
        digest = readlinkSync(absolute);
      }
      entries.push({ digest, kind, mode: stats.mode & 0o7777, path, size: stats.size });
      if (kind === "dir") {
        walk(path);
      }
    }
  };
  walk("");
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : Number(left.path > right.path),
  );
}

/** Content digest of a manifest. Modes are left out, so marking a tree read-only keeps it. */
export function treeDigest(entries: readonly Entry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${entry.kind}\0${entry.path}\0${entry.digest}\n`);
  }
  return hash.digest("hex");
}

export function totalBytes(entries: readonly Entry[]): number {
  return entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.size : 0), 0);
}

function fsyncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Copy `entries` from `sourceRoot` into the new directory `targetRoot`, renaming each path with
 * `rename`. Files are fsynced, directories get their modes and an fsync after their children,
 * and `targetRoot` itself takes `rootMode`.
 */
export function copyEntries(
  sourceRoot: string,
  rename: (path: string) => string,
  rootMode: number,
  entries: readonly Entry[],
  targetRoot: string,
): void {
  mkdirSync(targetRoot, { mode: 0o700 });
  const directories: string[] = [];
  for (const entry of entries) {
    const source = join(sourceRoot, entry.path);
    const target = join(targetRoot, rename(entry.path));
    if (entry.kind === "dir") {
      mkdirSync(target, { mode: 0o700 });
      directories.push(entry.path);
    } else if (entry.kind === "symlink") {
      symlinkSync(readlinkSync(source), target);
    } else {
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      chmodSync(target, entry.mode);
      const stats = lstatSync(source);
      utimesSync(target, stats.atime, stats.mtime);
      fsyncFile(target);
    }
  }
  // Deepest first, so a directory is complete before its mode can remove write access.
  const modes = new Map(entries.map((entry) => [entry.path, entry.mode]));
  for (const path of directories.reverse()) {
    const target = join(targetRoot, rename(path));
    fsyncDirectory(target);
    chmodSync(target, modes.get(path) ?? 0o700);
  }
  fsyncDirectory(targetRoot);
  chmodSync(targetRoot, rootMode);
}

/** Remove a directory this process owns, restoring owner write access first so modes cannot block it. */
export function removeOwnedTree(path: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (stats.isDirectory()) {
    chmodSync(path, (stats.mode & 0o7777) | 0o700);
    for (const name of readdirSync(path)) {
      removeOwnedTree(join(path, name));
    }
  }
  rmSync(path, { force: true, recursive: true });
}

/** Clear every write bit under and including `root`, leaving symlinks alone. Returns the count. */
export function removeWriteBits(root: string): number {
  let changed = 0;
  const visit = (path: string): void => {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      return;
    }
    if (stats.isDirectory()) {
      for (const name of readdirSync(path)) {
        visit(join(path, name));
      }
    }
    const mode = stats.mode & 0o7777;
    if ((mode & 0o222) !== 0) {
      chmodSync(path, mode & ~0o222);
      changed += 1;
    }
  };
  visit(root);
  return changed;
}
