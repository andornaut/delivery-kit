// Initial cutover preserves opaque legacy bytes. Publications and operator evidence remain distinct.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { fsyncDirectory, writeDurable, writeJsonDurable } from "../durable.ts";
import type { Layout } from "../layout.ts";
import { holdLockAsync } from "../lock.ts";
import { messageEnvelope } from "../messages/envelope.ts";
import type { MessageEnvelope, MessageInput } from "../messages/types.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import { readRegistry } from "../registry/store.ts";
import { ProtocolError, protocolRole, ProtocolStore } from "./core.ts";
import {
  type ProtocolConfiguration,
  ProtocolLayoutError,
  protocolPaths,
  resolveProtocolLayout,
  validateProtocolRoot,
  withProtocolLayout,
} from "./layout.ts";
import {
  type MessageWriter,
  type OriginalRef,
  type ProtocolMessageGuards,
  type ProtocolMessageLinks,
  ProtocolMessages,
} from "./messages.ts";
import { resolveProtocolBinding } from "./runtime.ts";
export type MigrationErrorCode =
  | "invalid-migration"
  | "migration-unavailable"
  | "unsafe-migration-entry"
  | "migration-source-changed"
  | "migration-target-conflict"
  | "migration-already-active"
  | "migration-generation-conflict"
  | "migration-backup-required"
  | "migration-restore-required"
  | "migration-participants-incomplete"
  | "migration-originals-required";
export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly details: {
    readonly ids: readonly string[];
    readonly owners: readonly string[];
  };
  constructor(
    code: MigrationErrorCode,
    ids: readonly string[] = [],
    owners: readonly string[] = [],
  ) {
    super(code);
    this.code = code;
    this.details = { ids, owners };
  }
}
export interface MigrationEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly size: number;
  readonly hash: string | null;
}
export interface MigrationInventory {
  readonly schema: 1;
  readonly entries: readonly MigrationEntry[];
  readonly fingerprint: string;
}
export interface ProtocolMigrationPlan {
  readonly schema: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly stateRoot: string;
  readonly expectedGeneration: 0;
  readonly inventory: MigrationInventory;
}
export interface ProtocolBackup {
  readonly schema: 1;
  readonly stateRoot: string;
  readonly backupRoot: string;
  readonly inventory: MigrationInventory;
  readonly stateDevice: number;
  readonly backupDevice: number;
}
export interface ProtocolRestoreProof {
  readonly schema: 1;
  readonly backupRoot: string;
  readonly restoreRoot: string;
  readonly fingerprint: string;
}
export interface ProtocolParticipant {
  readonly role: string;
  readonly kind: "reader" | "writer" | "observer";
  readonly id: string;
  readonly harness: "codex" | "claude";
  readonly nativeId: string;
  readonly artifactHash: string;
  readonly version: string;
  readonly protocolSchema: 1;
  readonly compatibilityRef: string;
  readonly quiescenceRef: string;
}
export interface ProtocolActivation {
  readonly plan: ProtocolMigrationPlan;
  readonly expectedGeneration: 0;
  readonly backup: ProtocolBackup;
  readonly restore: ProtocolRestoreProof;
  readonly registryRevision: number;
  readonly participants: readonly ProtocolParticipant[];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return `{${Object.keys(v)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(v[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function hash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function demand(value: unknown, code: MigrationErrorCode = "invalid-migration"): asserts value {
  if (!value) {
    throw new MigrationError(code);
  }
}
function token(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0")
  );
}
function makeDirectory(path: string): void {
  try {
    demand(lstatSync(path).isDirectory(), "unsafe-migration-entry");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  makeDirectory(dirname(path));
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  fsyncDirectory(dirname(path));
}
function bytes(path: string): Buffer {
  for (let cursor = dirname(path); ; cursor = dirname(cursor)) {
    demand(lstatSync(cursor).isDirectory(), "unsafe-migration-entry");
    if (dirname(cursor) === cursor) {
      break;
    }
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    demand(fstatSync(fd).isFile(), "unsafe-migration-entry");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function metadata(path: string): unknown {
  try {
    return JSON.parse(bytes(path).toString("utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error instanceof MigrationError ? error : new MigrationError("migration-unavailable");
  }
}
function unsafe(name: string): boolean {
  return (
    name === ".git" ||
    name === ".private" ||
    name === ".ssh" ||
    /^\.env(?:\.|$)/u.test(name) ||
    /^(?:credentials|auth\.json|id_rsa|id_ed25519)(?:\.|$)/u.test(name) ||
    /\.(?:pem|key|p12)$/u.test(name)
  );
}
function inventory(
  roots: readonly {
    path: string;
    prefix: string;
  }[],
): MigrationInventory {
  const entries: MigrationEntry[] = [];
  function visit(path: string, name: string): void {
    demand(!unsafe(name.split("/").at(-1)!), "unsafe-migration-entry");
    const stat = lstatSync(path);
    demand(
      !stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()),
      "unsafe-migration-entry",
    );
    entries.push({
      hash: stat.isFile() ? hash(bytes(path)) : null,
      kind: stat.isFile() ? "file" : "directory",
      mode: stat.mode & 0o777,
      path: name,
      size: stat.isFile() ? stat.size : 0,
    });
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) {
        visit(join(path, child), name ? `${name}/${child}` : child);
      }
    }
  }
  for (const root of roots) {
    try {
      lstatSync(root.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    visit(root.path, root.prefix);
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { entries, fingerprint: hash(canonical(entries)), schema: 1 };
}
function sourcePath(layout: Layout, path: string): string {
  return path === "accounting" || path.startsWith("accounting/")
    ? join(layout.varDir, path)
    : join(layout.varDir, "game-dev", path.slice("transport/".length));
}
function inventoryProtocolOperation(layout: Layout): MigrationInventory {
  try {
    return inventory([
      { path: join(layout.varDir, "accounting"), prefix: "accounting" },
      { path: join(layout.varDir, "game-dev", "messages"), prefix: "transport/messages" },
    ]);
  } catch (error) {
    throw error instanceof MigrationError ? error : new MigrationError("migration-unavailable");
  }
}
function planProtocolMigrationOperation(
  layout: Layout,
  input: {
    readonly workspaceId: string;
    readonly stateRoot: string;
    readonly expectedGeneration: number;
  },
): ProtocolMigrationPlan {
  demand(resolveProtocolLayout(layout) === null, "migration-already-active");
  demand(
    input.expectedGeneration === 0 && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(input.workspaceId),
  );
  const stateRoot = validateProtocolRoot(layout, input.stateRoot);
  const observed = inventoryProtocol(layout);
  const value = {
    expectedGeneration: 0 as const,
    inventory: observed,
    schema: 1 as const,
    stateRoot,
    workspaceId: input.workspaceId,
  };
  return { ...value, id: hash(canonical(value)) };
}
function validatePlan(layout: Layout, plan: ProtocolMigrationPlan, checkSource = true): void {
  demand(
    plan?.schema === 1 &&
      plan.expectedGeneration === 0 &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(plan.workspaceId) &&
      /^[a-f0-9]{64}$/u.test(plan.id),
  );
  demand(
    isDeepStrictEqual(Object.keys(plan).sort(), [
      "expectedGeneration",
      "id",
      "inventory",
      "schema",
      "stateRoot",
      "workspaceId",
    ]),
  );
  const { id, ...value } = plan;
  demand(
    hash(canonical(value)) === id &&
      validateProtocolRoot(layout, plan.stateRoot) === plan.stateRoot,
  );
  if (checkSource) {
    demand(
      isDeepStrictEqual(inventoryProtocol(layout), plan.inventory),
      "migration-source-changed",
    );
  }
}
function copyInventory(
  source: (path: string) => string,
  destination: string,
  observed: MigrationInventory,
): void {
  for (const entry of observed.entries) {
    demand(
      token(entry.path) && !entry.path.split("/").includes("..") && !entry.path.startsWith("/"),
    );
    const path = join(destination, entry.path);
    if (entry.kind === "directory") {
      makeDirectory(path);
      chmodSync(path, entry.mode);
      fsyncDirectory(path);
    } else {
      const value = bytes(source(entry.path));
      demand(hash(value) === entry.hash && value.length === entry.size, "migration-source-changed");
      makeDirectory(dirname(path));
      try {
        demand(hash(bytes(path)) === entry.hash, "migration-target-conflict");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        writeDurable(path, value, { mode: entry.mode });
      }
    }
  }
}
function imported(layout: Layout, root: string): ProtocolMigrationPlan {
  const plan = metadata(join(root, "migration", "import.json")) as ProtocolMigrationPlan;
  demand(plan?.stateRoot === root);
  validatePlan(layout, plan, false);
  demand(
    isDeepStrictEqual(metadata(join(root, "workspace.json")), {
      generation: 1,
      schema: 1,
      workspaceId: plan.workspaceId,
    }),
  );
  return plan;
}
async function importProtocolMigrationOperation(layout: Layout, plan: ProtocolMigrationPlan) {
  return withProtocolLayout(
    layout,
    null,
    async () => {
      validatePlan(layout, plan);
      const existing = metadata(join(plan.stateRoot, "migration", "import.json"));
      if (existing !== undefined) {
        demand(isDeepStrictEqual(existing, plan), "migration-target-conflict");
      } else {
        const prepared = metadata(join(plan.stateRoot, "migration-plan.json"));
        if (prepared !== undefined) {
          demand(isDeepStrictEqual(prepared, plan), "migration-target-conflict");
        } else {
          try {
            demand(readdirSync(plan.stateRoot).length === 0, "migration-target-conflict");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
          makeDirectory(plan.stateRoot);
          writeJsonDurable(join(plan.stateRoot, "migration-plan.json"), plan);
        }
        copyInventory((path) => sourcePath(layout, path), plan.stateRoot, plan.inventory);
        validatePlan(layout, plan);
        writeJsonDurable(join(plan.stateRoot, "workspace.json"), {
          generation: 1,
          schema: 1,
          workspaceId: plan.workspaceId,
        });
        makeDirectory(join(plan.stateRoot, "migration"));
        writeJsonDurable(join(plan.stateRoot, "migration", "import.json"), plan);
      }
      const target = inventory([
        { path: join(plan.stateRoot, "accounting"), prefix: "accounting" },
        { path: join(plan.stateRoot, "transport/messages"), prefix: "transport/messages" },
      ]);
      demand(target.fingerprint === plan.inventory.fingerprint, "migration-target-conflict");
      return {
        inventory: target,
        originals: "pending-publication" as const,
        planId: plan.id,
        status: "staged" as const,
      };
    },
    { exclusive: true },
  );
}
function independent(layout: Layout, source: string, destination: string): string {
  const target = validateProtocolRoot(layout, destination);
  demand(
    target !== source &&
      !target.startsWith(`${source}${sep}`) &&
      !source.startsWith(`${target}${sep}`),
    "migration-backup-required",
  );
  return target;
}
async function backupProtocolOperation(
  layout: Layout,
  input: {
    readonly stateRoot: string;
    readonly destination: string;
  },
): Promise<ProtocolBackup> {
  const expected = resolveProtocolLayout(layout);
  return withProtocolLayout(
    layout,
    expected,
    async () => {
      const stateRoot = validateProtocolRoot(layout, input.stateRoot);
      imported(layout, stateRoot);
      const backupRoot = independent(layout, stateRoot, input.destination);
      demand(metadata(join(backupRoot, "backup.json")) === undefined, "migration-target-conflict");
      const observed = inventory([{ path: stateRoot, prefix: "state" }]);
      makeDirectory(backupRoot);
      demand(readdirSync(backupRoot).length === 0, "migration-target-conflict");
      copyInventory((path) => join(stateRoot, path.slice("state/".length)), backupRoot, {
        ...observed,
        entries: observed.entries.filter((entry) => entry.path !== "state"),
      });
      makeDirectory(join(backupRoot, "state"));
      const result: ProtocolBackup = {
        backupDevice: statSync(backupRoot).dev,
        backupRoot,
        inventory: observed,
        schema: 1,
        stateDevice: statSync(stateRoot).dev,
        stateRoot,
      };
      writeJsonDurable(join(backupRoot, "backup.json"), result);
      demand(
        inventory([{ path: join(backupRoot, "state"), prefix: "state" }]).fingerprint ===
          observed.fingerprint,
        "migration-backup-required",
      );
      return result;
    },
    { exclusive: true },
  );
}
function verifiedBackup(layout: Layout, value: ProtocolBackup): void {
  demand(
    value?.schema === 1 &&
      isDeepStrictEqual(metadata(join(value.backupRoot, "backup.json")), value),
    "migration-backup-required",
  );
  demand(
    validateProtocolRoot(layout, value.stateRoot) === value.stateRoot &&
      value.inventory.schema === 1 &&
      hash(canonical(value.inventory.entries)) === value.inventory.fingerprint,
    "migration-backup-required",
  );
  independent(layout, value.stateRoot, value.backupRoot);
  demand(
    inventory([{ path: join(value.backupRoot, "state"), prefix: "state" }]).fingerprint ===
      value.inventory.fingerprint,
    "migration-backup-required",
  );
}
async function restoreProtocolOperation(
  layout: Layout,
  input: {
    readonly backup: ProtocolBackup;
    readonly destination: string;
  },
): Promise<ProtocolRestoreProof> {
  return withProtocolLayout(
    layout,
    resolveProtocolLayout(layout),
    async () => {
      verifiedBackup(layout, input.backup);
      const restoreRoot = independent(layout, input.backup.stateRoot, input.destination);
      independent(layout, input.backup.backupRoot, restoreRoot);
      try {
        demand(readdirSync(restoreRoot).length === 0, "migration-target-conflict");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      makeDirectory(restoreRoot);
      copyInventory((path) => join(input.backup.backupRoot, path), restoreRoot, {
        ...input.backup.inventory,
        entries: input.backup.inventory.entries.filter((entry) => entry.path !== "state"),
      });
      makeDirectory(join(restoreRoot, "state"));
      demand(
        inventory([{ path: join(restoreRoot, "state"), prefix: "state" }]).fingerprint ===
          input.backup.inventory.fingerprint,
        "migration-restore-required",
      );
      return {
        backupRoot: input.backup.backupRoot,
        fingerprint: input.backup.inventory.fingerprint,
        restoreRoot,
        schema: 1,
      };
    },
    { exclusive: true },
  );
}
function legacyOriginals(plan: ProtocolMigrationPlan) {
  const files = plan.inventory.entries.filter(
    (entry) => entry.kind === "file" && entry.path.startsWith("transport/messages/"),
  );
  demand(
    files.every((entry) => /^transport\/messages\/[a-f0-9]{64}\.(?:json|lock)$/u.test(entry.path)),
    "invalid-migration",
  );
  return plan.inventory.entries
    .filter((entry) => /^transport\/messages\/[a-f0-9]{64}\.json$/u.test(entry.path))
    .map((entry) => {
      const raw = bytes(join(plan.stateRoot, entry.path));
      demand(hash(raw) === entry.hash, "migration-target-conflict");
      const record = JSON.parse(raw.toString("utf8")) as {
        envelope: MessageEnvelope;
        state: string;
        holds?: readonly unknown[];
      };
      const envelope = messageEnvelope(record.envelope);
      demand(isDeepStrictEqual(envelope, record.envelope), "invalid-migration");
      return {
        entry,
        envelope,
        held: record.state === "held" || (record.holds?.length ?? 0) > 0,
        raw,
      };
    });
}
async function importProtocolOriginalsOperation(
  layout: Layout,
  input: {
    readonly stateRoot: string;
    readonly publications: readonly {
      readonly messageId: string;
      readonly writer: MessageWriter;
      readonly links: ProtocolMessageLinks;
      readonly guards: ProtocolMessageGuards;
      readonly evidenceRef: string;
    }[];
  },
) {
  return withProtocolLayout(
    layout,
    null,
    async () => {
      const root = validateProtocolRoot(layout, input.stateRoot);
      const plan = imported(layout, root);
      demand(Array.isArray(input.publications));
      const records = legacyOriginals(plan);
      const store = new ProtocolStore({
        directory: root,
        resolveBinding: (role, binding) => resolveProtocolBinding(layout, undefined, role, binding),
      });
      const messages = new ProtocolMessages({ store });
      const published: OriginalRef[] = [];
      for (const item of input.publications) {
        const record = records.find((value) => value.envelope.id === item.messageId);
        demand(record && token(item.evidenceRef));
        demand(
          item.guards.question !== "clear" &&
            (record.held ? item.guards.hold === "held" : item.guards.hold !== "clear"),
        );
        // Each publication consumes its exact role revision before the next publication.
        // eslint-disable-next-line no-await-in-loop
        const artifact = await store.putArtifact(record.raw);

        published.push(
          // eslint-disable-next-line no-await-in-loop
          await messages.publish(item.writer, {
            envelope: record.envelope as MessageInput,
            guards: item.guards,
            imported: { evidenceRef: item.evidenceRef, legacyRecord: artifact },
            links: item.links,
          }),
        );
      }
      return { pending: missingOriginals(plan, store), published };
    },
    { exclusive: true },
  );
}
function missingOriginals(
  plan: ProtocolMigrationPlan,
  store: ProtocolStore,
): readonly {
  id: string;
  owner: string;
}[] {
  const messages = new ProtocolMessages({ store });
  const pending: {
    id: string;
    owner: string;
  }[] = [];
  for (const record of legacyOriginals(plan)) {
    const reference = messages.find(protocolRole(record.envelope.fromRole), record.envelope.id);
    let valid = false;
    if (reference !== null) {
      const original = messages.read(reference);
      valid =
        isDeepStrictEqual(original.envelope, record.envelope) &&
        original.imported?.legacyRecord.hash === record.entry.hash &&
        original.imported.legacyRecord.size === record.entry.size &&
        token(original.imported.evidenceRef) &&
        original.guards.question !== "clear" &&
        (record.held ? original.guards.hold === "held" : original.guards.hold !== "clear") &&
        Buffer.from(store.readArtifact(original.imported.legacyRecord.hash)).equals(record.raw);
    }
    if (!valid) {
      pending.push({ id: record.envelope.id, owner: record.envelope.fromRole });
    }
  }
  return pending;
}
function participants(layout: Layout, input: ProtocolActivation): void {
  const registry = readRegistry(layout);
  demand(input.registryRevision === registry.revision, "migration-participants-incomplete");
  demand(
    Array.isArray(input.participants) &&
      new Set(input.participants.map((item) => `${item.kind}:${item.id}`)).size ===
        input.participants.length &&
      input.participants.every(
        (item) =>
          Object.hasOwn(registry.roles, item.role) &&
          ["reader", "writer", "observer"].includes(item.kind) &&
          (item.kind !== "observer" || Object.hasOwn(registry.operations, item.id)),
      ),
    "migration-participants-incomplete",
  );
  for (const role of Object.keys(registry.roles)) {
    for (const kind of ["reader", "writer"] as const) {
      const item = input.participants.find((value) => value.role === role && value.kind === kind);
      demand(
        item &&
          item.protocolSchema === 1 &&
          token(item.id) &&
          token(item.version) &&
          /^[a-f0-9]{64}$/u.test(item.artifactHash) &&
          token(item.compatibilityRef) &&
          token(item.quiescenceRef) &&
          item.harness === resolveHarness(registry, role) &&
          item.nativeId === resolveConversation(registry, role),
        "migration-participants-incomplete",
      );
    }
  }
  for (const [id, operation] of Object.entries(registry.operations)) {
    const item = input.participants.find(
      (value) => value.kind === "observer" && value.id === id && value.role === operation.busOwner,
    );
    demand(
      item &&
        operation.lastAdoption &&
        item.version === operation.lastAdoption.version &&
        item.artifactHash === operation.lastAdoption.cliSha256 &&
        item.harness === resolveHarness(registry, operation.busOwner) &&
        item.nativeId === resolveConversation(registry, operation.busOwner) &&
        item.protocolSchema === 1 &&
        token(item.compatibilityRef) &&
        token(item.quiescenceRef),
      "migration-participants-incomplete",
    );
  }
}
async function activateProtocolOperation(layout: Layout, input: ProtocolActivation) {
  makeDirectory(layout.varDir);
  const paths = protocolPaths(layout);
  try {
    demand(lstatSync(paths.lock).isFile(), "unsafe-migration-entry");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const lease = await holdLockAsync(paths.lock);
  try {
    validatePlan(layout, input.plan);
    demand(input.expectedGeneration === 0, "migration-generation-conflict");
    const config: ProtocolConfiguration = {
      generation: 1,
      schema: 1,
      stateRoot: input.plan.stateRoot,
      workspaceId: input.plan.workspaceId,
    };
    const current = metadata(paths.config);
    demand(
      current === undefined || isDeepStrictEqual(current, config),
      "migration-generation-conflict",
    );
    const fence = metadata(paths.fence);
    demand(
      fence === undefined || isDeepStrictEqual(fence, config),
      "migration-generation-conflict",
    );
    verifiedBackup(layout, input.backup);
    demand(
      input.backup.stateRoot === config.stateRoot &&
        input.restore.schema === 1 &&
        input.restore.backupRoot === input.backup.backupRoot &&
        input.restore.fingerprint === input.backup.inventory.fingerprint,
      "migration-restore-required",
    );
    independent(layout, config.stateRoot, input.restore.restoreRoot);
    independent(layout, input.backup.backupRoot, input.restore.restoreRoot);
    demand(
      inventory([{ path: join(input.restore.restoreRoot, "state"), prefix: "state" }])
        .fingerprint === input.backup.inventory.fingerprint,
      "migration-restore-required",
    );
    demand(
      inventory([{ path: config.stateRoot, prefix: "state" }]).fingerprint ===
        input.backup.inventory.fingerprint,
      "migration-backup-required",
    );
    participants(layout, input);
    const pending = missingOriginals(
      input.plan,
      new ProtocolStore({ directory: config.stateRoot }),
    );
    if (pending.length > 0) {
      throw new MigrationError(
        "migration-originals-required",
        pending.map((item) => item.id),
        pending.map((item) => item.owner),
      );
    }
    const receipt = join(layout.varDir, "work-protocol-activation.json");
    const prior = metadata(receipt);
    demand(prior === undefined || isDeepStrictEqual(prior, input), "migration-generation-conflict");
    writeJsonDurable(receipt, input);
    // Publish the old-writer fence first. Interrupted cutover fails closed and exact retry resumes.
    writeJsonDurable(paths.fence, config);
    writeJsonDurable(paths.config, config);
    return resolveProtocolLayout(layout);
  } finally {
    lease.release();
  }
}

function migrationFailure(error: unknown): never {
  if (
    error instanceof MigrationError ||
    error instanceof ProtocolError ||
    error instanceof ProtocolLayoutError
  ) {
    throw error;
  }
  throw new MigrationError("migration-unavailable");
}

export function inventoryProtocol(
  ...args: Parameters<typeof inventoryProtocolOperation>
): ReturnType<typeof inventoryProtocolOperation> {
  try {
    return inventoryProtocolOperation(...args);
  } catch (error) {
    return migrationFailure(error);
  }
}

export function planProtocolMigration(
  ...args: Parameters<typeof planProtocolMigrationOperation>
): ReturnType<typeof planProtocolMigrationOperation> {
  try {
    return planProtocolMigrationOperation(...args);
  } catch (error) {
    return migrationFailure(error);
  }
}

export async function importProtocolMigration(
  ...args: Parameters<typeof importProtocolMigrationOperation>
): ReturnType<typeof importProtocolMigrationOperation> {
  try {
    return await importProtocolMigrationOperation(...args);
  } catch (error) {
    return migrationFailure(error);
  }
}

export async function backupProtocol(
  ...args: Parameters<typeof backupProtocolOperation>
): ReturnType<typeof backupProtocolOperation> {
  try {
    return await backupProtocolOperation(...args);
  } catch (error) {
    return migrationFailure(error);
  }
}

export async function restoreProtocol(
  ...args: Parameters<typeof restoreProtocolOperation>
): ReturnType<typeof restoreProtocolOperation> {
  try {
    return await restoreProtocolOperation(...args);
  } catch (error) {
    return migrationFailure(error);
  }
}

export async function importProtocolOriginals(
  ...args: Parameters<typeof importProtocolOriginalsOperation>
): ReturnType<typeof importProtocolOriginalsOperation> {
  try {
    return await importProtocolOriginalsOperation(...args);
  } catch (error) {
    return migrationFailure(error);
  }
}

export async function activateProtocol(
  ...args: Parameters<typeof activateProtocolOperation>
): ReturnType<typeof activateProtocolOperation> {
  try {
    return await activateProtocolOperation(...args);
  } catch (error) {
    return migrationFailure(error);
  }
}

/** Verify a staged migration without claiming that its legacy source is still current. */
export function inspectProtocolMigration(layout: Layout, root: string): ProtocolMigrationPlan {
  try {
    return imported(layout, validateProtocolRoot(layout, root));
  } catch (error) {
    return migrationFailure(error);
  }
}
