// Runtime adapters retain the existing request journal and transport identities after cutover.
import { join } from "node:path";

import { type IntakeInput, type IntakeOffer, IntakeStore } from "../accounting/intake.ts";
import type {
  LedgerEvent,
  LedgerRequest,
  LedgerStoreOptions,
  LedgerTransaction,
} from "../accounting/types.ts";
import { codexAdapter } from "../adapters/codex/index.ts";
import { resolveCodexControlSocket } from "../adapters/shared/endpoints.ts";
import type { Io } from "../io.ts";
import type { Layout } from "../layout.ts";
import { LockBusy } from "../lock.ts";
import { resolveConversation, resolveHarness, resolveRole } from "../registry/resolve.ts";
import { readRegistry } from "../registry/store.ts";
import { ProtocolError, ProtocolStore } from "./core.ts";
import {
  checkProtocolLayout,
  type ProtocolLayout,
  ProtocolLayoutError,
  resolveProtocolLayout,
  withProtocolLayout,
} from "./layout.ts";
import type {
  ProtocolClaim,
  ProtocolRoleListOptions,
  ProtocolTransaction,
  ProtocolWriter,
} from "./types.ts";
import { type WorkReport, WorkStore } from "./work.ts";

export interface ProtocolBoundaryStatus {
  readonly status: "not-configured" | "available" | "partial" | "unknown" | "unavailable";
  readonly generation?: number;
  readonly work?: WorkReport;
  readonly unattestedRoles?: readonly string[];
  readonly reason?: string;
}

/** This discovery projection never changes delivery readiness or grants work authority. */
export function protocolBoundaryStatus(
  layout: Layout,
  readRequest: (id: string) => LedgerRequest | null | undefined,
  roles?: readonly string[],
): ProtocolBoundaryStatus {
  try {
    const expected = resolveProtocolLayout(layout);
    if (expected === null) {
      return { reason: "explicit-migration-required", status: "not-configured" };
    }
    const store = new ProtocolStore({ directory: expected.stateRoot });
    const selected = (roles ?? Object.keys(readRegistry(layout).roles)).map((role) =>
      protocolRole(layout, role),
    );
    const unattestedRoles = selected.filter((role) => store.read(role).epoch === 0).sort();
    const work = new WorkStore({ protocol: store, readRequest }).report({ roles: selected });
    checkProtocolLayout(layout, expected);
    return {
      generation: expected.generation,
      status: unattestedRoles.length > 0 && work.status === "available" ? "partial" : work.status,
      unattestedRoles,
      work,
    };
  } catch {
    return { reason: "protocol-state-unavailable", status: "unavailable" };
  }
}

export class ProtocolRuntimeError extends Error {
  readonly code = "protocol-writer-required";

  constructor() {
    super("protocol-writer-required");
  }
}

const PROTOCOL_FAILURES = new Set([
  "binding-changed",
  "binding-unavailable",
  "corrupt-history",
  "invalid-protocol-config",
  "parent-fenced",
  "protocol-busy",
  "protocol-fenced",
  "protocol-generation-conflict",
  "protocol-root-excluded",
  "protocol-unavailable",
  "protocol-writer-required",
  "unsafe-path",
  "writer-action-ambiguous",
  "writer-fenced",
]);

export function protocolFailure(error: unknown): string | null {
  return (error instanceof ProtocolError ||
    error instanceof ProtocolLayoutError ||
    error instanceof ProtocolRuntimeError) &&
    PROTOCOL_FAILURES.has(error.code)
    ? error.code
    : null;
}

export function accountingDirectory(layout: Layout): string {
  return resolveProtocolLayout(layout)?.accountingDir ?? join(layout.varDir, "accounting");
}

export function accountingIntake(layout: Layout): IntakeStore {
  return new IntakeStore({ directory: join(accountingDirectory(layout), "intake") });
}

/** Capture unclassified references even when no role writer is available for semantic intake. */
export async function offerAccounting(layout: Layout, input: IntakeInput): Promise<IntakeOffer> {
  const expected = resolveProtocolLayout(layout);
  try {
    return await withProtocolLayout(
      layout,
      expected,
      async () =>
        new IntakeStore({
          directory: join(expected?.accountingDir ?? join(layout.varDir, "accounting"), "intake"),
        }).offer(input),
      { nonBlocking: true },
    );
  } catch (error) {
    if (error instanceof LockBusy) {
      throw new ProtocolError("protocol-busy");
    }
    throw error;
  }
}

export function protocolRole(layout: Layout, role: string): string {
  resolveRole(readRegistry(layout), role);
  if (role === "game-coordinator") {
    return "coordinator";
  }
  if (Object.hasOwn(layout.config.kits, role)) {
    return `kits/${role}`;
  }
  const [game, member, extra] = role.split("/");
  if (
    game !== undefined &&
    member !== undefined &&
    extra === undefined &&
    Object.hasOwn(layout.config.games, game) &&
    layout.config.games[game]!.roles.includes(member)
  ) {
    return `games/${game}/${member}`;
  }
  throw new Error("protocol-role-unavailable");
}

export function registryRole(namespace: string): string {
  if (namespace === "coordinator") {
    return "game-coordinator";
  }
  if (/^kits\/[a-z0-9][a-z0-9-]*$/u.test(namespace)) {
    return namespace.slice(5);
  }
  if (/^games\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u.test(namespace)) {
    return namespace.slice(6);
  }
  throw new Error("protocol-role-unavailable");
}

/** Same-account writer fencing, not authentication of a human or permission to resume. */
export async function resolveProtocolBinding(
  layout: Layout,
  io: Pick<Io, "env"> | undefined,
  namespace: string,
  binding: { readonly harness: "codex" | "claude"; readonly nativeId: string },
): Promise<boolean> {
  try {
    const worker = /^(.*)\/workers\/([a-f0-9-]+)\/([1-9][0-9]*)$/u.exec(namespace);
    const role = registryRole(worker?.[1] ?? namespace);
    const current = () => {
      const registry = readRegistry(layout);
      const key = resolveRole(registry, role);
      const owner = registry.roles[key]!;
      return {
        harness: resolveHarness(registry, key),
        nativeId:
          owner.ownership !== "active" || owner.phase === "held" || owner.phase === "source-held"
            ? null
            : resolveConversation(registry, key),
      };
    };
    const parent = current();
    if (parent.nativeId === null || binding.harness !== parent.harness) {
      return false;
    }
    if (worker === null) {
      return binding.nativeId === parent.nativeId;
    }
    if (io === undefined || binding.harness !== "codex" || binding.nativeId !== worker[2]) {
      return false;
    }
    const endpoint = resolveCodexControlSocket({ env: io.env });
    return await codexAdapter(layout, {
      controlSocket: endpoint.path,
      env: io.env,
    }).withWorkerInbox(
      { harness: "codex", parent: parent.nativeId, worker: binding.nativeId },
      async () => {
        const fresh = current();
        return fresh.harness === parent.harness && fresh.nativeId === parent.nativeId;
      },
    );
  } catch {
    return false;
  }
}

class RuntimeProtocolStore extends ProtocolStore {
  readonly #layout: Layout;
  readonly #expected: ProtocolLayout;

  constructor(layout: Layout, expected: ProtocolLayout, io?: Pick<Io, "env">) {
    super({
      directory: expected.stateRoot,
      resolveBinding: (role, binding) => {
        checkProtocolLayout(layout, expected);
        return resolveProtocolBinding(layout, io, role, binding);
      },
    });
    this.#layout = layout;
    this.#expected = expected;
  }

  #view<T>(read: () => T): T {
    checkProtocolLayout(this.#layout, this.#expected);
    const result = read();
    checkProtocolLayout(this.#layout, this.#expected);
    return result;
  }

  override read(role: string) {
    return this.#view(() => super.read(role));
  }

  override history(role: string) {
    return this.#view(() => super.history(role));
  }

  override listRoles(options: ProtocolRoleListOptions = {}) {
    return this.#view(() => super.listRoles(options));
  }

  override readArtifact(hash: string) {
    return this.#view(() => super.readArtifact(hash));
  }

  override claim(input: ProtocolClaim) {
    return withProtocolLayout(this.#layout, this.#expected, () => super.claim(input));
  }

  override transact(input: ProtocolTransaction) {
    return withProtocolLayout(this.#layout, this.#expected, () => super.transact(input));
  }

  override withWriter<T>(writer: ProtocolWriter, write: () => T | Promise<T>): Promise<T> {
    return withProtocolLayout(this.#layout, this.#expected, () => super.withWriter(writer, write));
  }

  override putArtifact(bytes: Uint8Array) {
    return withProtocolLayout(this.#layout, this.#expected, () => super.putArtifact(bytes));
  }
}

export function runtimeProtocolStore(layout: Layout, io?: Pick<Io, "env">): ProtocolStore | null {
  const expected = resolveProtocolLayout(layout);
  return expected === null ? null : new RuntimeProtocolStore(layout, expected, io);
}

export function ledgerStorageOptions(
  layout: Layout,
  io?: Pick<Io, "env">,
): Pick<LedgerStoreOptions, "directory" | "withWriter" | "checkRead"> {
  const expected = resolveProtocolLayout(layout);
  return {
    checkRead: () => checkProtocolLayout(layout, expected),
    directory: expected?.accountingDir ?? join(layout.varDir, "accounting"),
    withWriter: (transaction: LedgerTransaction, write: () => Promise<LedgerEvent>) =>
      withProtocolLayout(layout, expected, async () => {
        if (expected === null) {
          return write();
        }
        const writer = transaction.writer;
        if (writer === undefined) {
          throw new ProtocolRuntimeError();
        }
        const store = new ProtocolStore({
          directory: expected.stateRoot,
          resolveBinding: (role, binding) => resolveProtocolBinding(layout, io, role, binding),
        });
        return store.withWriter(
          {
            binding: { harness: writer.harness, nativeId: writer.nativeId },
            epoch: writer.epoch,
            role: protocolRole(layout, transaction.actor),
          },
          write,
        );
      }),
  };
}
