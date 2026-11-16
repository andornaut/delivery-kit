import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { fsyncDirectory, writeDurable, writeJsonDurable } from "../durable.ts";
import { holdLockAsync, LockBusy, type LockHandle } from "../lock.ts";
import type {
  ArtifactRef,
  Binding,
  ProtocolClaim,
  ProtocolCollection,
  ProtocolEvent,
  ProtocolMutation,
  ProtocolParent,
  ProtocolRoleListOptions,
  ProtocolState,
  ProtocolStoreOptions,
  ProtocolTransaction,
  ProtocolWriter,
} from "./types.ts";

const NAME = "[a-z0-9][a-z0-9-]{0,63}";
const BASE_ROLE = new RegExp(`^(?:coordinator|kits/${NAME}|games/${NAME}/${NAME})$`, "u");
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const COLLECTIONS = ["work", "submissions", "messages", "receipts", "intake"];
const HELD = new AsyncLocalStorage<ReadonlySet<string>>();

export class ProtocolError extends Error {
  readonly code: string;
  readonly actionMayHaveCommitted: boolean;

  constructor(code: string, actionMayHaveCommitted = false) {
    super(`protocol: ${code}`);
    this.name = "ProtocolError";
    this.code = code;
    this.actionMayHaveCommitted = actionMayHaveCommitted;
  }
}

function demand(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new ProtocolError(code);
  }
}

function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) < 999_999_999_999;
}

function stamp(value: unknown): value is string {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function binding(value: unknown): value is Binding {
  return (
    object(value, ["harness", "nativeId"]) &&
    (value.harness === "codex" || value.harness === "claude") &&
    isCanonicalUuid(value.nativeId)
  );
}

function json(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (
    typeof value !== "object" ||
    seen.has(value) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    return false;
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return false;
  }
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    if (
      Object.keys(value).length !== value.length ||
      !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(
        Boolean,
      )
    ) {
      return false;
    }
  }
  if (
    Object.entries(entries).some(
      ([key, descriptor]) =>
        key !== "length" && (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")),
    )
  ) {
    return false;
  }
  seen.add(value);
  const valid = Object.keys(value).every((key) =>
    json((value as Record<string, unknown>)[key], seen),
  );
  seen.delete(value);
  return valid;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parentOf(role: string): ProtocolParent | null {
  const split = role.split("/workers/");
  if (split.length === 1) {
    demand(BASE_ROLE.test(role), "invalid-role");
    return null;
  }
  demand(split.length === 2 && BASE_ROLE.test(split[0]!), "invalid-role");
  const [workerId, epoch, ...extra] = split[1]!.split("/");
  demand(
    extra.length === 0 &&
      isCanonicalUuid(workerId) &&
      typeof epoch === "string" &&
      /^[1-9][0-9]*$/u.test(epoch) &&
      integer(Number(epoch), 1),
    "invalid-role",
  );
  return { epoch: Number(epoch), role: split[0]!, workerId };
}

/** Stable registry names become canonical protocol namespaces, never native conversation names. */
export function protocolRole(role: string): string {
  demand(typeof role === "string", "invalid-role");
  if (BASE_ROLE.test(role)) {
    return role;
  }
  if (role === "game-coordinator") {
    return "coordinator";
  }
  if (new RegExp(`^${NAME}$`, "u").test(role)) {
    return `kits/${role}`;
  }
  if (new RegExp(`^${NAME}/${NAME}$`, "u").test(role)) {
    return `games/${role}`;
  }
  throw new ProtocolError("invalid-role");
}

export function protocolWorkerRole(
  parentRole: string,
  workerId: string,
  parentEpoch: number,
): string {
  const role = protocolRole(parentRole);
  demand(isCanonicalUuid(workerId) && integer(parentEpoch, 1), "invalid-parent");
  return `${role}/workers/${workerId}/${parentEpoch}`;
}

function writer(value: unknown): asserts value is ProtocolWriter {
  demand(
    object(value, ["role", "epoch", "binding"]) &&
      text(value.role) &&
      integer(value.epoch, 1) &&
      binding(value.binding),
    "invalid-writer",
  );
  parentOf(value.role);
}

function claim(value: unknown): asserts value is ProtocolClaim {
  demand(
    object(value, ["role", "expectedEpoch", "binding", "evidence", "at"], ["parent"]) &&
      text(value.role) &&
      integer(value.expectedEpoch) &&
      binding(value.binding) &&
      text(value.evidence) &&
      stamp(value.at),
    "invalid-claim",
  );
  const expected = parentOf(value.role);
  if (expected === null) {
    demand(!Object.hasOwn(value, "parent"), "invalid-parent");
  } else {
    demand(
      object(value.parent, ["role", "epoch", "workerId"]) &&
        canonical(value.parent) === canonical(expected) &&
        value.binding.nativeId === expected.workerId,
      "invalid-parent",
    );
  }
}

function mutation(value: unknown): value is ProtocolMutation {
  return (
    object(value, ["collection", "id", "expectedRevision", "value"]) &&
    typeof value.collection === "string" &&
    COLLECTIONS.includes(value.collection) &&
    typeof value.id === "string" &&
    ID.test(value.id) &&
    integer(value.expectedRevision) &&
    json(value.value)
  );
}

function transaction(value: unknown): asserts value is ProtocolTransaction {
  demand(
    object(value, ["id", "role", "epoch", "binding", "expectedRevision", "at", "mutations"]) &&
      typeof value.id === "string" &&
      ID.test(value.id) &&
      text(value.role) &&
      integer(value.epoch, 1) &&
      binding(value.binding) &&
      integer(value.expectedRevision) &&
      stamp(value.at) &&
      Array.isArray(value.mutations) &&
      value.mutations.length > 0 &&
      value.mutations.every(mutation),
    "invalid-transaction",
  );
  parentOf(value.role);
  const keys = value.mutations.map((m) => canonical([m.collection, m.id]));
  demand(new Set(keys).size === keys.length, "duplicate-object");
}

/** Inspect metadata before following any directory component. Reads never initialize state. */
function directory(path: string, create = false): boolean {
  const parent = dirname(path);
  if (parent !== path && !directory(parent, create)) {
    return false;
  }
  let stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined && create) {
    try {
      mkdirSync(path, { mode: 0o700 });
      fsyncDirectory(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    stat = lstatSync(path);
  }
  if (stat === undefined) {
    return false;
  }
  demand(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe-path");
  return true;
}

function regular(path: string): Buffer | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) {
    return undefined;
  }
  demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "unsafe-path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    demand(
      opened.isFile() && opened.nlink === 1 && opened.dev === stat.dev && opened.ino === stat.ino,
      "unsafe-path",
    );
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

interface Replay {
  readonly events: ProtocolEvent[];
  state: ProtocolState;
}

function key(collection: ProtocolCollection, id: string): string {
  return canonical([collection, id]);
}

function project(replay: Replay, event: ProtocolEvent): void {
  const current = replay.state;
  if (event.type === "claim") {
    claim(event.claim);
    demand(
      event.claim.role === current.role &&
        event.claim.expectedEpoch === current.epoch &&
        event.epoch === current.epoch + 1,
      "corrupt-history",
    );
    replay.state = {
      ...current,
      binding: structuredClone(event.claim.binding),
      epoch: event.epoch,
      hash: event.hash,
      parent: structuredClone(event.claim.parent ?? null),
      revision: event.revision,
    };
    return;
  }
  transaction(event.transaction);
  const input = event.transaction;
  demand(
    input.role === current.role &&
      input.epoch === current.epoch &&
      canonical(input.binding) === canonical(current.binding) &&
      input.expectedRevision === current.revision,
    "corrupt-history",
  );
  const objects = new Map(current.objects.map((o) => [key(o.collection, o.id), o]));
  for (const mutation of input.mutations) {
    const previous = objects.get(key(mutation.collection, mutation.id));
    demand(mutation.expectedRevision === (previous?.revision ?? 0), "object-conflict");
    objects.set(key(mutation.collection, mutation.id), {
      collection: mutation.collection,
      id: mutation.id,
      revision: mutation.expectedRevision + 1,
      value: structuredClone(mutation.value),
    });
  }
  replay.state = {
    ...current,
    hash: event.hash,
    objects: [...objects.values()].sort((a, b) =>
      key(a.collection, a.id).localeCompare(key(b.collection, b.id)),
    ),
    revision: event.revision,
  };
}

export class ProtocolStore {
  readonly #options: ProtocolStoreOptions;

  constructor(options: ProtocolStoreOptions) {
    demand(
      typeof options.directory === "string" &&
        isAbsolute(options.directory) &&
        resolve(options.directory) === options.directory &&
        (options.nonBlocking === undefined || typeof options.nonBlocking === "boolean") &&
        (options.resolveBinding === undefined || typeof options.resolveBinding === "function"),
      "invalid-options",
    );
    this.#options = { ...options };
  }

  #roleDirectory(role: string): string {
    parentOf(role);
    return join(this.#options.directory, "roles", role);
  }

  #replay(role: string): Replay {
    const replay: Replay = {
      events: [],
      state: { binding: null, epoch: 0, hash: null, objects: [], parent: null, revision: 0, role },
    };
    const path = join(this.#roleDirectory(role), "events");
    if (!directory(path)) {
      return replay;
    }
    try {
      for (const name of readdirSync(path).sort()) {
        if (/^\.\d{12}\.json\.\d+\.[a-f0-9]{12}\.tmp$/u.test(name)) {
          continue;
        }
        const revision = replay.events.length + 1;
        demand(name === `${String(revision).padStart(12, "0")}.json`, "corrupt-history");
        const bytes = regular(join(path, name));
        demand(bytes !== undefined, "corrupt-history");
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        demand(
          object(
            value,
            ["schema", "type", "revision", "previousHash", "hash"],
            ["claim", "epoch", "transaction"],
          ) &&
            value.schema === 1 &&
            value.revision === revision &&
            value.previousHash === replay.state.hash &&
            typeof value.hash === "string" &&
            HASH.test(value.hash),
          "corrupt-history",
        );
        demand(bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)), "corrupt-history");
        const { hash: storedHash, ...base } = value;
        demand(storedHash === hash(canonical(base)), "corrupt-history");
        if (value.type === "claim") {
          demand(
            object(value, ["schema", "type", "revision", "previousHash", "hash", "claim", "epoch"]),
            "corrupt-history",
          );
        } else {
          demand(
            value.type === "transaction" &&
              object(value, ["schema", "type", "revision", "previousHash", "hash", "transaction"]),
            "corrupt-history",
          );
          demand(
            !replay.events.some(
              (e) =>
                e.type === "transaction" &&
                (value.transaction as ProtocolTransaction).id === e.transaction.id,
            ),
            "corrupt-history",
          );
        }
        const event = value as unknown as ProtocolEvent;
        const at = event.type === "claim" ? event.claim.at : event.transaction.at;
        const previous = replay.events.at(-1);
        const priorAt = previous?.type === "claim" ? previous.claim.at : previous?.transaction.at;
        demand(priorAt === undefined || Date.parse(at) >= Date.parse(priorAt), "corrupt-history");
        project(replay, event);
        replay.events.push(event);
      }
      const parent = parentOf(role);
      if (parent !== null && replay.state.epoch > 0) {
        demand(this.#replay(parent.role).state.epoch >= parent.epoch, "corrupt-history");
      }
      return replay;
    } catch {
      throw new ProtocolError("corrupt-history");
    }
  }

  read(role: string): ProtocolState {
    return structuredClone(this.#replay(role).state);
  }

  history(role: string): readonly ProtocolEvent[] {
    return structuredClone(this.#replay(role).events);
  }

  async #locks<T>(role: string, action: () => Promise<T>): Promise<T> {
    const parent = parentOf(role);
    const roles = parent === null ? [role] : [parent.role, role];
    const root = join(this.#options.directory, "locks");
    directory(root, true);
    const paths = roles.map((role) => join(root, `role-${hash(role)}.lock`));
    demand(!paths.some((path) => HELD.getStore()?.has(path)), "writer-reentrant");
    const locks: LockHandle[] = [];
    try {
      for (const path of paths) {
        const stat = lstatSync(path, { throwIfNoEntry: false });
        demand(
          stat === undefined || (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1),
          "unsafe-path",
        );
        // Deterministic parent-before-worker acquisition prevents crossing epoch publication.
        // eslint-disable-next-line no-await-in-loop
        locks.push(await holdLockAsync(path, { nonBlocking: this.#options.nonBlocking ?? false }));
      }
      return await HELD.run(new Set([...(HELD.getStore() ?? []), ...paths]), action);
    } catch (error) {
      if (error instanceof LockBusy) {
        throw new ProtocolError("protocol-busy");
      }
      throw error;
    } finally {
      for (const lock of locks.reverse()) {
        lock.release();
      }
    }
  }

  async #binding(role: string, binding: Binding): Promise<void> {
    demand(this.#options.resolveBinding !== undefined, "binding-unavailable");
    let valid: boolean;
    try {
      valid = await this.#options.resolveBinding(role, structuredClone(binding));
    } catch {
      throw new ProtocolError("binding-unavailable");
    }
    demand(valid === true, "binding-changed");
  }

  async #parent(role: string): Promise<void> {
    const parent = parentOf(role);
    if (parent === null) {
      return;
    }
    const state = this.#replay(parent.role).state;
    demand(state.epoch === parent.epoch && state.binding !== null, "parent-fenced");
    await this.#binding(parent.role, state.binding);
  }

  async #fence(writer: ProtocolWriter): Promise<Replay> {
    const replay = this.#replay(writer.role);
    demand(
      replay.state.epoch === writer.epoch &&
        canonical(replay.state.binding) === canonical(writer.binding),
      "writer-fenced",
    );
    const parent = parentOf(writer.role);
    demand(parent === null || writer.binding.nativeId === parent.workerId, "writer-fenced");
    await this.#parent(writer.role);
    await this.#binding(writer.role, writer.binding);
    return replay;
  }

  #publish(
    replay: Replay,
    base:
      | Omit<Extract<ProtocolEvent, { type: "claim" }>, "hash">
      | Omit<Extract<ProtocolEvent, { type: "transaction" }>, "hash">,
  ): ProtocolEvent {
    const event = { ...base, hash: hash(canonical(base)) } as ProtocolEvent;
    const at = event.type === "claim" ? event.claim.at : event.transaction.at;
    const previous = replay.events.at(-1);
    const priorAt = previous?.type === "claim" ? previous.claim.at : previous?.transaction.at;
    demand(priorAt === undefined || Date.parse(at) >= Date.parse(priorAt), "stale-time");
    project(replay, event);
    const path = join(this.#roleDirectory(replay.state.role), "events");
    directory(path, true);
    const target = join(path, `${String(event.revision).padStart(12, "0")}.json`);
    demand(lstatSync(target, { throwIfNoEntry: false }) === undefined, "corrupt-history");
    writeJsonDurable(target, event);
    return structuredClone(event);
  }

  async claim(input: ProtocolClaim): Promise<{ epoch: number; revision: number }> {
    claim(input);
    const value = structuredClone(input);
    return this.#locks(value.role, async () => {
      const replay = this.#replay(value.role);
      await this.#parent(value.role);
      await this.#binding(value.role, value.binding);
      const existing = replay.events.find(
        (e) => e.type === "claim" && canonical(e.claim) === canonical(value),
      );
      if (existing?.type === "claim") {
        demand(
          replay.state.epoch === existing.epoch &&
            canonical(replay.state.binding) === canonical(value.binding),
          "writer-fenced",
        );
        await this.#parent(value.role);
        await this.#binding(value.role, value.binding);
        return { epoch: existing.epoch, revision: existing.revision };
      }
      demand(value.expectedEpoch === replay.state.epoch, "epoch-conflict");
      await this.#parent(value.role);
      await this.#binding(value.role, value.binding);
      const event = this.#publish(replay, {
        claim: value,
        epoch: value.expectedEpoch + 1,
        previousHash: replay.state.hash,
        revision: replay.state.revision + 1,
        schema: 1,
        type: "claim",
      });
      return { epoch: value.expectedEpoch + 1, revision: event.revision };
    });
  }

  async transact(input: ProtocolTransaction): Promise<ProtocolEvent> {
    transaction(input);
    const value = structuredClone(input);
    return this.#locks(value.role, async () => {
      const replay = await this.#fence(value);
      const existing = replay.events.find(
        (e) => e.type === "transaction" && e.transaction.id === value.id,
      );
      if (existing?.type === "transaction") {
        demand(canonical(existing.transaction) === canonical(value), "transaction-conflict");
        await this.#fence(value);
        return structuredClone(existing);
      }
      demand(value.expectedRevision === replay.state.revision, "stale-revision");
      await this.#fence(value);
      return this.#publish(replay, {
        previousHash: replay.state.hash,
        revision: replay.state.revision + 1,
        schema: 1,
        transaction: value,
        type: "transaction",
      });
    });
  }

  /** Serializes an existing journal's action; it is not a cross-file commit or rollback mechanism. */
  async withWriter<T>(input: ProtocolWriter, action: () => T | Promise<T>): Promise<T> {
    writer(input);
    const value = structuredClone(input);
    return this.#locks(value.role, async () => {
      await this.#fence(value);
      const result = await action();
      try {
        await this.#fence(value);
      } catch {
        throw new ProtocolError("writer-action-ambiguous", true);
      }
      return result;
    });
  }

  listRoles(options: ProtocolRoleListOptions = {}): readonly string[] {
    const roles: string[] = [];
    const root = join(this.#options.directory, "roles");
    if (!directory(root)) {
      return roles;
    }
    const names = (path: string): string[] => (directory(path) ? readdirSync(path).sort() : []);
    const add = (role: string): void => {
      const state = this.read(role);
      if (state.epoch > 0) {
        roles.push(role);
      }
      if (options.includeWorkers !== true) {
        return;
      }
      for (const id of names(join(root, role, "workers"))) {
        demand(isCanonicalUuid(id), "unsafe-path");
        for (const epoch of names(join(root, role, "workers", id))) {
          const worker = `${role}/workers/${id}/${epoch}`;
          parentOf(worker);
          if (this.read(worker).epoch > 0) {
            roles.push(worker);
          }
        }
      }
    };
    for (const category of names(root)) {
      demand(["coordinator", "kits", "games"].includes(category), "unsafe-path");
      if (category === "coordinator") {
        add(category);
      } else if (category === "kits") {
        for (const kit of names(join(root, category))) {
          add(`kits/${kit}`);
        }
      } else {
        for (const game of names(join(root, category))) {
          demand(new RegExp(`^${NAME}$`, "u").test(game), "unsafe-path");
          for (const role of names(join(root, category, game))) {
            add(`games/${game}/${role}`);
          }
        }
      }
    }
    return roles.sort();
  }

  async putArtifact(input: Uint8Array): Promise<ArtifactRef> {
    demand(input instanceof Uint8Array, "invalid-artifact");
    const bytes = Buffer.from(input);
    const digest = hash(bytes);
    const locks = join(this.#options.directory, "locks");
    directory(locks, true);
    const path = join(locks, `artifact-${digest}.lock`);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    demand(
      stat === undefined || (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1),
      "unsafe-path",
    );
    let lock: LockHandle;
    try {
      lock = await holdLockAsync(path, { nonBlocking: this.#options.nonBlocking ?? false });
    } catch (error) {
      if (error instanceof LockBusy) {
        throw new ProtocolError("protocol-busy");
      }
      throw error;
    }
    try {
      const directoryPath = join(
        this.#options.directory,
        "artifacts",
        "sha256",
        digest.slice(0, 2),
      );
      directory(directoryPath, true);
      const target = join(directoryPath, digest);
      const existing = regular(target);
      if (existing !== undefined) {
        demand(existing.equals(bytes) && hash(existing) === digest, "artifact-corrupt");
      } else {
        writeDurable(target, bytes);
      }
      return { hash: digest, size: bytes.length };
    } finally {
      lock.release();
    }
  }

  readArtifact(digest: string): Uint8Array {
    demand(typeof digest === "string" && HASH.test(digest), "invalid-artifact");
    const path = join(this.#options.directory, "artifacts", "sha256", digest.slice(0, 2));
    demand(directory(path), "artifact-missing");
    const bytes = regular(join(path, digest));
    demand(bytes !== undefined, "artifact-missing");
    demand(hash(bytes) === digest, "artifact-corrupt");
    return Uint8Array.from(bytes);
  }
}
