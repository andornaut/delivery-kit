// Explicit protocol selection is read-only. Generation leases share the activation lock.
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { readJsonIfExists, writeJsonDurable } from "../durable.ts";
import type { Layout } from "../layout.ts";
import { holdLockAsync, type LockHandle } from "../lock.ts";
import { validateRegistry } from "../registry/schema.ts";
export interface ProtocolRequirement {
  readonly authorityRef: string;
}
export type ProtocolManagement =
  | {
      readonly status: "unmanaged";
      readonly required: null;
    }
  | {
      readonly status: "pending";
      readonly workspaceId: string;
      readonly generation: 1;
      readonly required: ProtocolRequirement;
    }
  | {
      readonly status: "active";
      readonly workspaceId: string;
      readonly generation: number;
      readonly required: ProtocolRequirement | null;
    };
export interface ProtocolPendingFence {
  readonly schema: 1;
  readonly kind: "required-pending";
  readonly workspaceId: string;
  readonly generation: 1;
  readonly required: ProtocolRequirement;
}
export interface ProtocolConfiguration {
  readonly required?: ProtocolRequirement;
  readonly schema: 1;
  readonly workspaceId: string;
  readonly stateRoot: string;
  readonly generation: number;
}
export interface ProtocolLayout {
  readonly required?: ProtocolRequirement;
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
  | "protocol-unavailable"
  | "protocol-enrollment-pending";
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
function requirement(value: unknown): value is ProtocolRequirement {
  return (
    typeof value === "object" &&
    value !== null &&
    isDeepStrictEqual(Object.keys(value), ["authorityRef"]) &&
    typeof (value as ProtocolRequirement).authorityRef === "string" &&
    /\S/u.test((value as ProtocolRequirement).authorityRef) &&
    (value as ProtocolRequirement).authorityRef.length <= 4096 &&
    !(value as ProtocolRequirement).authorityRef.includes("\0")
  );
}
function workspaceId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value);
}
function pending(value: unknown): value is ProtocolPendingFence {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    isDeepStrictEqual(Object.keys(v).sort(), [
      "generation",
      "kind",
      "required",
      "schema",
      "workspaceId",
    ]) &&
    v.schema === 1 &&
    v.kind === "required-pending" &&
    v.generation === 1 &&
    workspaceId(v.workspaceId) &&
    requirement(v.required)
  );
}
function configuration(value: unknown): value is ProtocolConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    isDeepStrictEqual(
      Object.keys(v)
        .filter((key) => key !== "required")
        .sort(),
      ["generation", "schema", "stateRoot", "workspaceId"],
    ) &&
    (v.required === undefined || requirement(v.required)) &&
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
/** Inspect management without creating a state root or treating pending enrollment as legacy. */
function selection(layout: Layout): {
  management: ProtocolManagement;
  layout: ProtocolLayout | null;
} {
  try {
    const paths = protocolPaths(layout);
    const value = optionalFile(paths.config);
    const fence = optionalFile(paths.fence);
    if (value === undefined) {
      if (pending(fence)) {
        return {
          layout: null,
          management: {
            generation: 1,
            required: fence.required,
            status: "pending",
            workspaceId: fence.workspaceId,
          },
        };
      }
      if (fence !== undefined) {
        fail("protocol-fenced");
      }
      return { layout: null, management: { required: null, status: "unmanaged" } };
    }
    if (!configuration(value)) {
      fail("invalid-protocol-config");
    }
    const stateRoot = validateProtocolRoot(layout, value.stateRoot);
    const extra = value.required === undefined ? {} : { required: value.required };
    if (
      !isDeepStrictEqual(optionalFile(join(stateRoot, "workspace.json")), {
        generation: value.generation,
        schema: 1,
        workspaceId: value.workspaceId,
        ...extra,
      }) ||
      !isDeepStrictEqual(fence, value)
    ) {
      fail("protocol-generation-conflict");
    }
    return {
      layout: {
        accountingDir: join(stateRoot, "accounting"),
        generation: value.generation,
        messagesDir: join(stateRoot, "transport", "messages"),
        stateRoot,
        workspaceId: value.workspaceId,
        ...extra,
      },
      management: {
        generation: value.generation,
        required: value.required ?? null,
        status: "active",
        workspaceId: value.workspaceId,
      },
    };
  } catch (error) {
    throw error instanceof ProtocolLayoutError
      ? error
      : new ProtocolLayoutError("protocol-unavailable");
  }
}
export function resolveProtocolManagement(layout: Layout): ProtocolManagement {
  return selection(layout).management;
}
export function resolveProtocolLayout(layout: Layout): ProtocolLayout | null {
  const current = selection(layout);
  if (current.management.status === "pending") {
    fail("protocol-enrollment-pending");
  }
  return current.layout;
}
/** Required declaration is operator evidence, never activation or permission to change providers. */
export async function declareProtocolWorkspace(
  layout: Layout,
  input: {
    readonly workspaceId: string;
    readonly authorityRef: string;
    readonly expectedGeneration: 0;
  },
): Promise<ProtocolManagement> {
  if (
    !input ||
    input.expectedGeneration !== 0 ||
    !workspaceId(input.workspaceId) ||
    !requirement({ authorityRef: input.authorityRef })
  ) {
    fail("invalid-protocol-config");
  }
  const before = resolveProtocolManagement(layout);
  const lease = await acquireProtocolLayout(layout, null, {
    allowPending: true,
    exclusive: true,
    expectedManagement: before,
  });
  try {
    const fence: ProtocolPendingFence = {
      generation: 1,
      kind: "required-pending",
      required: { authorityRef: input.authorityRef },
      schema: 1,
      workspaceId: input.workspaceId,
    };
    const paths = protocolPaths(layout);
    const old = optionalFile(paths.fence);
    if (old !== undefined && !isDeepStrictEqual(old, fence)) {
      fail("protocol-generation-conflict");
    }
    writeJsonDurable(paths.fence, fence);
    return resolveProtocolManagement(layout);
  } finally {
    lease.release();
  }
}
export function checkProtocolLayout(layout: Layout, expected: ProtocolLayout | null): void {
  if (!isDeepStrictEqual(resolveProtocolLayout(layout), expected)) {
    fail("protocol-generation-conflict");
  }
}
export interface ProtocolLeaseOptions {
  readonly exclusive?: boolean;
  readonly allowPending?: boolean;
  readonly expectedManagement?: ProtocolManagement;
  readonly nonBlocking?: boolean;
}
export async function acquireProtocolLayout(
  layout: Layout,
  expected: ProtocolLayout | null,
  options: ProtocolLeaseOptions = {},
): Promise<LockHandle> {
  const before = options.expectedManagement ?? resolveProtocolManagement(layout);
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
    const after = resolveProtocolManagement(layout);
    if (!isDeepStrictEqual(before, after)) {
      fail("protocol-generation-conflict");
    }
    if (!(options.allowPending === true && expected === null && after.status === "pending")) {
      checkProtocolLayout(layout, expected);
    }
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
