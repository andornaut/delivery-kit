// Explicit filesystem protocol operations use canonical producers and operation-scoped leases.
import { isUtf8 } from "node:buffer";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { captureAccounting } from "../accounting/boundary.ts";
import { IntakeStore } from "../accounting/intake.ts";
import { LedgerStore } from "../accounting/store.ts";
import type { LedgerRequest } from "../accounting/types.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { type Layout, loadLayout } from "../layout.ts";
import { ProtocolError, ProtocolStore } from "../protocol/core.ts";
import {
  checkProtocolLayout,
  resolveProtocolLayout,
  validateProtocolRoot,
  withProtocolLayout,
} from "../protocol/layout.ts";
import { type MessageWriter, type OriginalRef, ProtocolMessages } from "../protocol/messages.ts";
import {
  activateProtocol,
  backupProtocol,
  importProtocolMigration,
  importProtocolOriginals,
  inspectProtocolMigration,
  inventoryProtocol,
  MigrationError,
  planProtocolMigration,
  restoreProtocol,
} from "../protocol/migration.ts";
import {
  ledgerStorageOptions,
  protocolFailure,
  protocolRole,
  registryRole,
  resolveProtocolBinding,
  runtimeProtocolStore,
} from "../protocol/runtime.ts";
import type { ProtocolClaim } from "../protocol/types.ts";
import { type WorkContext, WorkStore } from "../protocol/work.ts";
import { readRegistry } from "../registry/store.ts";
export const PROTOCOL_ROOT_OPTIONS = { "state-root": { type: "string" } } as const;
export const PROTOCOL_INPUT_OPTIONS = {
  ...PROTOCOL_ROOT_OPTIONS,
  "input-file": { type: "string" },
} as const;
export const PROTOCOL_ROLE_OPTIONS = {
  ...PROTOCOL_ROOT_OPTIONS,
  id: { type: "string" },
  role: { type: "string" },
} as const;
export const PROTOCOL_ARTIFACT_OPTIONS = {
  ...PROTOCOL_ROOT_OPTIONS,
  file: { type: "string" },
  hash: { type: "string" },
  "output-file": { type: "string" },
} as const;
export const PROTOCOL_INBOX_OPTIONS = {
  ...PROTOCOL_ROOT_OPTIONS,
  "include-body": { type: "boolean" },
  role: { type: "string" },
  sender: { multiple: true, type: "string" },
} as const;
export const PROTOCOL_INTAKE_OPTIONS = {
  id: { type: "string" },
  owner: { type: "string" },
} as const;
export const PROTOCOL_BOUNDARY_OPTIONS = {
  ...PROTOCOL_ROOT_OPTIONS,
  at: { type: "string" },
  phase: { type: "string" },
  role: { type: "string" },
} as const;
export const PROTOCOL_PHASES = [
  "intake",
  "startup",
  "resume",
  "before-work",
  "worker-publication",
  "parent-review",
  "integration",
  "before-cleanup",
  "review",
] as const;
type Phase = (typeof PROTOCOL_PHASES)[number];
type Values = Record<string, string | string[] | boolean | undefined>;
class UsageError extends Error {}
function options(spec: NonNullable<ParseArgsConfig["options"]>, args: string[]): Values {
  const parsed = parseArgs({ args, options: spec, strict: true, tokens: true });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind === "option") {
      if (seen.has(token.name) && spec[token.name]?.multiple !== true) {
        throw new UsageError();
      }
      seen.add(token.name);
    }
  }
  const values = parsed.values as Values;
  if (Object.values(values).some((value) => typeof value === "string" && value.trim() === "")) {
    throw new UsageError();
  }
  return values;
}
function required(values: Values, key: string): string {
  const value = values[key];
  if (typeof value !== "string") {
    throw new UsageError();
  }
  return value;
}
function input<T>(io: Io, values: Values): T {
  const data = readFileSync(resolve(io.cwd, required(values, "input-file")));
  if (!isUtf8(data)) {
    throw new UsageError();
  }
  try {
    return JSON.parse(data.toString("utf8")) as T;
  } catch {
    throw new UsageError();
  }
}
const FAILURES = new Set([
  "artifact-corrupt",
  "artifact-missing",
  "binding-changed",
  "binding-unavailable",
  "corrupt-history",
  "duplicate-object",
  "epoch-conflict",
  "invalid-artifact",
  "invalid-claim",
  "invalid-options",
  "invalid-parent",
  "invalid-role",
  "invalid-transaction",
  "invalid-writer",
  "object-conflict",
  "parent-fenced",
  "protocol-busy",
  "stale-revision",
  "stale-time",
  "transaction-conflict",
  "unsafe-path",
  "writer-action-ambiguous",
  "writer-fenced",
  "writer-reentrant",
  "artifact-size-mismatch",
  "definition-mismatch",
  "explicit-replacement-required",
  "invalid-publication",
  "invalid-receipt",
  "invalid-work",
  "no-work-publication",
  "no-worker-submission",
  "parent-publication-required",
  "protocol-unavailable",
  "publication-mismatch",
  "ready-evidence-missing",
  "receipt-exists",
  "receipt-scope-mismatch",
  "receipt-source-mismatch",
  "role-unclaimed",
  "stale-work",
  "submission-changed",
  "submission-publication-mismatch",
  "submission-scope-mismatch",
  "work-missing",
  "work-operation-conflict",
  "worker-scope-mismatch",
  "corrupt-message",
  "invalid-legacy-record",
  "invalid-message",
  "invalid-message-guards",
  "invalid-message-links",
  "invalid-message-read-view",
  "invalid-message-receipt",
  "invalid-message-transport",
  "invalid-message-withdrawal",
  "invalid-original-reference",
  "legacy-original-mismatch",
  "message-command-conflict",
  "message-conflict",
  "message-missing",
  "message-read-view-write-refused",
  "message-recipient-mismatch",
  "message-retention-required",
  "message-sender-mismatch",
  "original-reference-mismatch",
]);
function code(error: unknown): string {
  if (error instanceof MigrationError) {
    return error.code;
  }
  const configured = protocolFailure(error);
  if (configured !== null) {
    return configured;
  }
  const value = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  return typeof value === "string" && FAILURES.has(value) ? value : "protocol-operation-failed";
}
function handler(
  spec: NonNullable<ParseArgsConfig["options"]>,
  action: (io: Io, layout: Layout, values: Values) => unknown | Promise<unknown>,
): Handler {
  return async (io, root, args) => {
    let values: Values;
    try {
      values = options(spec, args);
    } catch {
      io.err('{"error":{"code":"invalid-protocol-options"},"ok":false}\n');
      return EXIT_USAGE;
    }
    try {
      const result = await action(io, loadLayout(root), values);
      io.out(`${JSON.stringify(result)}\n`);
      return EXIT_OK;
    } catch (error) {
      if (error instanceof UsageError) {
        io.err('{"error":{"code":"invalid-protocol-options"},"ok":false}\n');
        return EXIT_USAGE;
      }
      const details = error instanceof MigrationError ? error.details : undefined;
      const failure = {
        error: {
          ...(error instanceof ProtocolError && error.actionMayHaveCommitted
            ? { actionMayHaveCommitted: true }
            : {}),
          code: code(error),
          ...(details === undefined ? {} : { details }),
        },
        ok: false,
      };
      io.err(`${JSON.stringify(failure)}\n`);
      return EXIT_INVALID;
    }
  };
}
function selected(layout: Layout, values: Values) {
  const expected = resolveProtocolLayout(layout);
  const requested =
    typeof values["state-root"] === "string"
      ? validateProtocolRoot(layout, values["state-root"])
      : undefined;
  if (expected !== null) {
    if (requested !== undefined && requested !== expected.stateRoot) {
      throw new Error("stale-root");
    }
    return { expected, root: expected.stateRoot };
  }
  if (requested === undefined) {
    throw new Error("protocol-not-configured");
  }
  inspectProtocolMigration(layout, requested);
  return { expected, root: requested };
}
function store(io: Io, layout: Layout, root: string) {
  const active = runtimeProtocolStore(layout, io);
  if (active !== null) {
    return active;
  }
  return new ProtocolStore({
    directory: root,
    resolveBinding: (role, binding) => resolveProtocolBinding(layout, io, role, binding),
  });
}
function work(protocol: ProtocolStore, layout: Layout) {
  return new WorkStore({
    protocol,
    readRequest(id: string): LedgerRequest | null {
      try {
        return new LedgerStore(ledgerStorageOptions(layout)).read(id) ?? null;
      } catch {
        return null;
      }
    },
  });
}
/** Read only known filesystem publications; unavailable human history remains an explicit gap. */
function boundary(layout: Layout, protocol: ProtocolStore, role: string, phase: Phase, at: string) {
  if (!PROTOCOL_PHASES.includes(phase) || !Number.isFinite(Date.parse(at))) {
    throw new UsageError();
  }
  const namespace = protocolRole(layout, role);
  let accounting: unknown;
  let pending: unknown;
  try {
    const storage = ledgerStorageOptions(layout);
    const ledger = new LedgerStore(storage);
    const report = ledger.report({ at, owner: role });
    accounting = {
      coverage: report.coverage,
      coverageState: report.coverageState,
      open: report.open,
      protectedQuestions: report.protectedQuestions,
      revision: report.revision,
      status: "available",
      unassigned: report.unassigned,
      untriaged: report.untriaged,
    };
    pending = new IntakeStore({ directory: join(storage.directory, "intake") })
      .pending(ledger.history(), [role])
      .map((offer) => ({
        commandId: `intake-${offer.id}`,
        id: offer.id,
        requiredOwner: offer.actor,
      }));
  } catch {
    accounting = { status: "unavailable" };
    pending = null;
  }
  const senders = protocol.listRoles({ includeWorkers: true });
  const inbox = new ProtocolMessages({ store: protocol }).inbox({
    includeBody: false,
    recipientRole: namespace,
    senders,
  });
  const report = work(protocol, layout).report({ roles: [namespace] });
  return {
    accounting,
    at,
    inbox,
    pendingIntake: pending,
    phase,
    role,
    scope: { nativeHistory: "not-collected", publishedSenders: senders, roles: [namespace] },
    work: report,
  };
}
async function mutating<T>(
  io: Io,
  layout: Layout,
  values: Values,
  writer: WorkContext | MessageWriter,
  phase: Phase,
  action: (protocol: ProtocolStore) => Promise<T>,
) {
  const selection = selected(layout, values);
  const role = registryRole(writer.role.split("/workers/")[0]!);
  if (selection.expected !== null) {
    await captureAccounting(
      layout,
      {},
      phase === "startup" || phase === "resume" ? phase : "review",
      "message",
      [role],
    );
  }
  return withProtocolLayout(layout, selection.expected, async () => {
    const protocol = store(io, layout, selection.root);
    const before = boundary(layout, protocol, role, phase, writer.at);
    const result = await action(protocol);
    return {
      boundary: { after: boundary(layout, protocol, role, phase, writer.at), before },
      result,
    };
  });
}
export const protocolStatus = handler(PROTOCOL_ROOT_OPTIONS, (_io, layout, values) => {
  const active = resolveProtocolLayout(layout);
  if (active === null && values["state-root"] === undefined) {
    return { legacyCompatibility: true, protocol: null, status: "not-configured" };
  }
  const chosen = selected(layout, values);
  return {
    protocol: { ...active, stateRoot: chosen.root },
    status: active === null ? "prepared" : "active",
  };
});
export const protocolInventory = handler({}, (_io, layout) => inventoryProtocol(layout));
export const protocolDryRun = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) =>
  planProtocolMigration(layout, input(io, values)),
);
export const protocolImport = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) =>
  importProtocolMigration(layout, input(io, values)),
);
export const protocolImportOriginals = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) =>
  importProtocolOriginals(layout, input(io, values)),
);
export const protocolBackup = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) =>
  backupProtocol(layout, input(io, values)),
);
export const protocolRestore = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) =>
  restoreProtocol(layout, input(io, values)),
);
export const protocolActivate = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) =>
  activateProtocol(layout, input(io, values)),
);
export const protocolClaim = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) => {
  const value = input<ProtocolClaim>(io, values);
  const chosen = selected(layout, values);
  return withProtocolLayout(layout, chosen.expected, () =>
    store(io, layout, chosen.root).claim(value),
  );
});
export const protocolRoleRead = handler(PROTOCOL_ROLE_OPTIONS, (io, layout, values) => {
  const chosen = selected(layout, values);
  const state = store(io, layout, chosen.root).read(required(values, "role"));
  checkProtocolLayout(layout, chosen.expected);
  return {
    ...state,
    objects: state.objects.map((value) => ({
      collection: value.collection,
      id: value.id,
      revision: value.revision,
    })),
  };
});
export const protocolWorkPublish = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) => {
  const value = input<{
    context: WorkContext;
    input: Parameters<WorkStore["publish"]>[1];
  }>(io, values);
  return mutating(io, layout, values, value.context, "before-work", (protocol) =>
    work(protocol, layout).publish(value.context, value.input),
  );
});
export const protocolWorkSubmit = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) => {
  const value = input<{
    context: WorkContext;
    input: Parameters<WorkStore["submit"]>[1];
  }>(io, values);
  return mutating(io, layout, values, value.context, "worker-publication", (protocol) =>
    work(protocol, layout).submit(value.context, value.input),
  );
});
export const protocolWorkAccept = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) => {
  const value = input<{
    context: WorkContext;
    input: Parameters<WorkStore["accept"]>[1];
  }>(io, values);
  return mutating(io, layout, values, value.context, "parent-review", (protocol) =>
    work(protocol, layout).accept(value.context, value.input),
  );
});
export const protocolWorkReceipt = handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) => {
  const value = input<{
    context: WorkContext;
    input: Parameters<WorkStore["receipt"]>[1];
  }>(io, values);
  return mutating(io, layout, values, value.context, "integration", (protocol) =>
    work(protocol, layout).receipt(value.context, value.input),
  );
});
export const protocolWorkRead = handler(PROTOCOL_ROLE_OPTIONS, (io, layout, values) => {
  const chosen = selected(layout, values);
  const reader = work(store(io, layout, chosen.root), layout);
  const result =
    values.id === undefined
      ? reader.report({ roles: [required(values, "role")] })
      : reader.read(required(values, "role"), required(values, "id"));
  checkProtocolLayout(layout, chosen.expected);
  return result;
});
type MessageOperation = "publish" | "receipt" | "withdraw" | "observeTransport";
function message(operation: MessageOperation): Handler {
  return handler(PROTOCOL_INPUT_OPTIONS, (io, layout, values) => {
    const value = input<{
      writer: MessageWriter;
      input: unknown;
    }>(io, values);
    return mutating(
      io,
      layout,
      values,
      value.writer,
      operation === "publish" ? "intake" : "review",
      async (protocol) => {
        const messages = new ProtocolMessages({ store: protocol });
        switch (operation) {
          case "publish":
            return messages.publish(
              value.writer,
              value.input as Parameters<ProtocolMessages["publish"]>[1],
            );
          case "receipt":
            return messages.receipt(
              value.writer,
              value.input as Parameters<ProtocolMessages["receipt"]>[1],
            );
          case "withdraw":
            return messages.withdraw(
              value.writer,
              value.input as Parameters<ProtocolMessages["withdraw"]>[1],
            );
          case "observeTransport":
            return messages.observeTransport(
              value.writer,
              value.input as Parameters<ProtocolMessages["observeTransport"]>[1],
            );
          default:
            throw new UsageError();
        }
      },
    );
  });
}
export const protocolMessagePublish = message("publish");
export const protocolMessageReceipt = message("receipt");
export const protocolMessageWithdraw = message("withdraw");
export const protocolMessageObserve = message("observeTransport");
export const protocolInbox = handler(PROTOCOL_INBOX_OPTIONS, (io, layout, values) => {
  const chosen = selected(layout, values);
  const senders = values.sender;
  if (!Array.isArray(senders) || senders.length === 0) {
    throw new UsageError();
  }
  const result = new ProtocolMessages({ store: store(io, layout, chosen.root) }).inbox({
    includeBody: values["include-body"] === true,
    recipientRole: required(values, "role"),
    senders,
  });
  checkProtocolLayout(layout, chosen.expected);
  return result;
});
export const protocolOriginal = handler(
  { ...PROTOCOL_INPUT_OPTIONS, "include-body": { type: "boolean" } },
  (io, layout, values) => {
    const chosen = selected(layout, values);
    const value = new ProtocolMessages({ store: store(io, layout, chosen.root) }).read(
      input<OriginalRef>(io, values),
    );
    checkProtocolLayout(layout, chosen.expected);
    if (values["include-body"] === true) {
      return value;
    }
    const envelope: Record<string, unknown> = { ...value.envelope };
    delete envelope.body;
    return { ...value, envelope };
  },
);
export const protocolIntake = handler(PROTOCOL_INTAKE_OPTIONS, (_io, layout, values) => {
  const owner = required(values, "owner");
  if (!Object.hasOwn(readRegistry(layout).roles, owner)) {
    throw new UsageError();
  }
  const storage = ledgerStorageOptions(layout);
  const ledger = new LedgerStore(storage);
  const offers = new IntakeStore({ directory: join(storage.directory, "intake") }).pending(
    ledger.history(),
    [owner],
  );
  return {
    offers:
      values.id === undefined
        ? offers
        : offers.filter((offer) => offer.id === required(values, "id")),
    owner,
    status: "available",
  };
});
export const protocolBoundary = handler(PROTOCOL_BOUNDARY_OPTIONS, async (io, layout, values) => {
  const chosen = selected(layout, values);
  const role = required(values, "role");
  const phase = required(values, "phase") as Phase;
  if (!PROTOCOL_PHASES.includes(phase)) {
    throw new UsageError();
  }
  if (chosen.expected !== null) {
    await captureAccounting(
      layout,
      {},
      phase === "startup" || phase === "resume" ? phase : "review",
      "message",
      [role],
    );
  }
  return withProtocolLayout(layout, chosen.expected, () =>
    boundary(layout, store(io, layout, chosen.root), role, phase, required(values, "at")),
  );
});
export const protocolArtifactPut = handler(PROTOCOL_ARTIFACT_OPTIONS, (io, layout, values) => {
  const chosen = selected(layout, values);
  const path = resolve(io.cwd, required(values, "file"));
  if (
    /^(?:\.env|credentials|id_rsa|id_ed25519)/u.test(path.split("/").at(-1)!) ||
    /\.(?:key|pem|p12)$/u.test(path)
  ) {
    throw new UsageError();
  }
  return withProtocolLayout(layout, chosen.expected, () =>
    store(io, layout, chosen.root).putArtifact(readFileSync(path)),
  );
});
export const protocolArtifactRead = handler(PROTOCOL_ARTIFACT_OPTIONS, (io, layout, values) => {
  const chosen = selected(layout, values);
  const hash = required(values, "hash");
  const value = store(io, layout, chosen.root).readArtifact(hash);
  checkProtocolLayout(layout, chosen.expected);
  const output = resolve(io.cwd, required(values, "output-file"));
  if (existsSync(output)) {
    throw new UsageError();
  }
  writeFileSync(output, value, { flag: "wx", mode: 0o600 });
  return { hash, size: value.length };
});
