// Explicit protocol selection is read-only. Generation leases share the activation lock.
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { readJsonIfExists } from "../durable.ts";
import type { Layout } from "../layout.ts";
import { holdLockAsync, type LockHandle } from "../lock.ts";
import { validateRegistry } from "../registry/schema.ts";

export interface ProtocolConfiguration {
  readonly schema: 1;
  readonly workspaceId: string;
  readonly stateRoot: string;
  readonly generation: number;
}

export interface ProtocolLayout {
  readonly workspaceId: string;
  readonly stateRoot: string;
  readonly generation: number;
  readonly accountingDir: string;
  readonly messagesDir: string;
}

export type ProtocolLayoutErrorCode =
  | "invalid-protocol-config"
  | "protocol-root-excluded"
  | "protocol-generation-conflict"
  | "protocol-fenced"
  | "protocol-unavailable";

export class ProtocolLayoutError extends Error {
  readonly code: ProtocolLayoutErrorCode;
  constructor(code: ProtocolLayoutErrorCode) {
    super(code);
    this.code = code;
  }
}

export function protocolPaths(layout: Pick<Layout, "varDir">) {
  return {
    config: join(layout.varDir, "work-protocol.json"),
    fence: join(layout.varDir, "work-protocol-fence.json"),
    lock: join(layout.varDir, "work-protocol.lock"),
  };
}

function fail(code: ProtocolLayoutErrorCode): never {
  throw new ProtocolLayoutError(code);
}

function optionalFile(path: string): unknown {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail("invalid-protocol-config");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return readJsonIfExists(path);
}

function configuration(value: unknown): value is ProtocolConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    isDeepStrictEqual(Object.keys(v).sort(), [
      "generation",
      "schema",
      "stateRoot",
      "workspaceId",
    ]) &&
    v.schema === 1 &&
    typeof v.workspaceId === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(v.workspaceId) &&
    typeof v.stateRoot === "string" &&
    isAbsolute(v.stateRoot) &&
    !v.stateRoot.includes("\0") &&
    Number.isSafeInteger(v.generation) &&
    Number(v.generation) > 0
  );
}

/** Resolve existing aliases without creating a missing destination. */
export function canonicalProtocolPath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {
    fail("invalid-protocol-config");
  }
  let cursor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      lstatSync(cursor);
      return resolve(realpathSync(cursor), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      // A dangling alias is not a missing directory that may be safely initialised.
      try {
        if (lstatSync(cursor).isSymbolicLink()) {
          fail("protocol-root-excluded");
        }
      } catch (check) {
        if ((check as NodeJS.ErrnoException).code !== "ENOENT") {
          throw check;
        }
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        fail("protocol-unavailable");
      }
      missing.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** Reject every configured repository, registered worktree and detected Git ancestor. */
export function validateProtocolRoot(layout: Layout, path: string): string {
  const target = canonicalProtocolPath(path);
  const roots = [
    layout.root,
    ...Object.values(layout.config.games).map((game) => resolve(layout.root, game.path)),
    ...Object.values(layout.config.kits).map((kit) => resolve(layout.root, kit.path)),
  ];
  const rawRegistry = readJsonIfExists(layout.registryFile);
  if (rawRegistry !== undefined) {
    const registry = validateRegistry(layout.config, rawRegistry);
    roots.push(...Object.values(registry.roles).map((role) => resolve(layout.root, role.worktree)));
  }
  if (
    roots.some((root) => {
      const source = canonicalProtocolPath(root);
      return contains(source, target) || contains(target, source);
    })
  ) {
    fail("protocol-root-excluded");
  }
  for (let cursor = target; ; cursor = dirname(cursor)) {
    try {
      lstatSync(join(cursor, ".git"));
      fail("protocol-root-excluded");
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        (error as NodeJS.ErrnoException).code !== "ENOTDIR"
      ) {
        throw error;
      }
    }
    if (dirname(cursor) === cursor) {
      break;
    }
  }
  return target;
}

/** Missing configuration means legacy compatibility only while no cutover fence exists. */
export function resolveProtocolLayout(layout: Layout): ProtocolLayout | null {
  try {
    const paths = protocolPaths(layout);
    const value = optionalFile(paths.config);
    const fence = optionalFile(paths.fence);
    if (value === undefined) {
      if (fence !== undefined) {
        fail("protocol-fenced");
      }
      return null;
    }
    if (!configuration(value)) {
      fail("invalid-protocol-config");
    }
    const stateRoot = validateProtocolRoot(layout, value.stateRoot);
    const header = optionalFile(join(stateRoot, "workspace.json"));
    if (
      !isDeepStrictEqual(header, {
        generation: value.generation,
        schema: 1,
        workspaceId: value.workspaceId,
      }) ||
      !isDeepStrictEqual(fence, value)
    ) {
      fail("protocol-generation-conflict");
    }
    return {
      accountingDir: join(stateRoot, "accounting"),
      generation: value.generation,
      messagesDir: join(stateRoot, "transport", "messages"),
      stateRoot,
      workspaceId: value.workspaceId,
    };
  } catch (error) {
    throw error instanceof ProtocolLayoutError
      ? error
      : new ProtocolLayoutError("protocol-unavailable");
  }
}

export function checkProtocolLayout(layout: Layout, expected: ProtocolLayout | null): void {
  if (!isDeepStrictEqual(resolveProtocolLayout(layout), expected)) {
    fail("protocol-generation-conflict");
  }
}

export interface ProtocolLeaseOptions {
  readonly exclusive?: boolean;
  readonly nonBlocking?: boolean;
}

export async function acquireProtocolLayout(
  layout: Layout,
  expected: ProtocolLayout | null,
  options: ProtocolLeaseOptions = {},
): Promise<LockHandle> {
  const paths = protocolPaths(layout);
  mkdirSync(layout.varDir, { recursive: true });
  try {
    if (!lstatSync(paths.lock).isFile()) {
      fail("invalid-protocol-config");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const lock = await holdLockAsync(paths.lock, {
    nonBlocking: options.nonBlocking === true,
    shared: options.exclusive !== true,
  });
  try {
    checkProtocolLayout(layout, expected);
    return lock;
  } catch (error) {
    lock.release();
    throw error;
  }
}

export async function withProtocolLayout<T>(
  layout: Layout,
  expected: ProtocolLayout | null,
  use: (current: ProtocolLayout | null) => T | Promise<T>,
  options: ProtocolLeaseOptions = {},
): Promise<T> {
  const lock = await acquireProtocolLayout(layout, expected, options);
  try {
    return await use(expected);
  } finally {
    lock.release();
  }
}
