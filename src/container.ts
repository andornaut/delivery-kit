// Container argument rules shared by the gate and verification containers.
//
// Containers run as the invoking user with HOME=/tmp, so nothing they write is root-owned.
// Docker creates a missing bind source as a root-owned directory, so every writable source
// (the project npm cache in particular) is created first, and bind mounts use --mount, which
// fails on a missing source instead of creating it.
import { mkdirSync } from "node:fs";

export interface UserIds {
  readonly uid: number;
  readonly gid: number;
}

export const CACHE_TARGET = "/npmcache";

export function currentUser(): UserIds {
  return { gid: process.getgid?.() ?? 0, uid: process.getuid?.() ?? 0 };
}

export function userArgs(user: UserIds): string[] {
  return ["-u", `${user.uid}:${user.gid}`, "-e", "HOME=/tmp"];
}

export function bindMount(
  options: { readonly readonly?: boolean },
  source: string,
  target: string,
): string[] {
  if (/[,"]/.test(source) || /[,"]/.test(target)) {
    throw new Error(`bind mount paths must not contain a comma or quote: ${source}`);
  }
  return [
    "--mount",
    `type=bind,src=${source},dst=${target}${options.readonly === true ? ",readonly" : ""}`,
  ];
}

/** Create the cache directory (for example `<bus>/npm-cache`), then mount it as npm's cache. */
export function cacheMount(cacheDir: string): string[] {
  mkdirSync(cacheDir, { mode: 0o700, recursive: true });
  return [...bindMount({}, cacheDir, CACHE_TARGET), "-e", `npm_config_cache=${CACHE_TARGET}`];
}
