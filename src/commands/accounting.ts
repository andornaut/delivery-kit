// JSON transactions preserve the core's actor, provenance, command identity and revision.
import { isUtf8 } from "node:buffer";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { captureAccounting } from "../accounting/boundary.ts";
import { snapshotIntake } from "../accounting/ingress.ts";
import { IntakeError, IntakeStore, type PendingIntake } from "../accounting/intake.ts";
import { projectOwnerBinding } from "../accounting/ownership.ts";
import { LedgerError, LedgerStore } from "../accounting/store.ts";
import type { LedgerEvent, LedgerTransaction } from "../accounting/types.ts";
import { codexAdapter } from "../adapters/codex/index.ts";
import { type HistoryRefs, historyRefs } from "../adapters/codex/inventory.ts";
import { connectControl } from "../adapters/codex/rpc.ts";
import { resolveCodexControlSocket } from "../adapters/shared/endpoints.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { type Layout, loadLayout } from "../layout.ts";
import { resolveConversation, resolveHarness, resolveRole } from "../registry/resolve.ts";
import type { Registry } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";

export const LEDGER_INPUT_OPTIONS = { "input-file": { type: "string" } } as const;
export const LEDGER_ID_OPTIONS = { id: { type: "string" } } as const;
export const LEDGER_REPORT_OPTIONS = {
  at: { type: "string" },
  owner: { type: "string" },
} as const;
export const LEDGER_COVERAGE_OPTIONS = { owner: { type: "string" } } as const;
export const LEDGER_BOUNDARY_OPTIONS = {
  phase: { type: "string" },
  role: { type: "string" },
} as const;

const CORE_ERRORS = new Set([
  "invalid-handoff",
  "assignment-conflict",
  "ledger-busy",
  "actor-not-owner",
  "cancellation-scope-mismatch",
  "evidence-exists",
  "invalid-dependency",
  "invalid-capture",
  "invalid-directory",
  "invalid-report",
  "reopen-dependent-first",
  "source-binding-mismatch",
  "source-link-exists",
  "scope-reopen-required",
  "stale-time",
  "unreviewed-source",
  "invalid-transaction",
  "command-conflict",
  "stale-revision",
  "invalid-request",
  "request-exists",
  "request-missing",
  "invalid-assignment",
  "owner-unavailable",
  "owner-changed",
  "invalid-transition",
  "incomplete-evidence",
  "unresolved-children",
  "unresolved-dependency",
  "question-guarded",
  "invalid-coverage",
  "corrupt-ledger",
]);

class CommandError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

class ReadProjectionError extends CommandError {
  readonly pendingIntake: PendingIntake;

  constructor(code: string, pendingIntake: PendingIntake) {
    super(code);
    this.pendingIntake = pendingIntake;
  }
}

function failure(
  io: Io,
  code: string,
  exitCode = EXIT_INVALID,
  pendingIntake?: PendingIntake,
): number {
  io.err(
    `${JSON.stringify({ error: { code }, ok: false, ...(pendingIntake === undefined ? {} : { pendingIntake }) })}\n`,
  );
  return exitCode;
}

function options(spec: NonNullable<ParseArgsConfig["options"]>, args: string[]) {
  const parsed = parseArgs({ args, options: spec, strict: true, tokens: true });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind === "option") {
      if (seen.has(token.name)) {
        throw new CommandError("invalid-ledger-options");
      }
      seen.add(token.name);
    }
  }
  const values = parsed.values as Record<string, string | undefined>;
  if (Object.values(values).some((value) => value?.trim() === "")) {
    throw new CommandError("invalid-ledger-options");
  }
  return values;
}

function required(values: Record<string, string | undefined>, name: string): string {
  const value = values[name];
  if (value === undefined) {
    throw new CommandError("invalid-ledger-options");
  }
  return value;
}

function store(io: Io, layout: Layout): LedgerStore {
  return new LedgerStore({
    directory: join(layout.varDir, "accounting"),
    async resolveOwner(assignment) {
      try {
        const registry = readRegistry(layout);
        const role = resolveRole(registry, assignment.ownerRole);
        const harness = resolveHarness(registry, role);
        const nativeId = resolveConversation(registry, role);
        if (nativeId === null || assignment.harness !== harness) {
          return null;
        }
        if (assignment.worker !== null) {
          const worker = assignment.worker;
          if (
            harness !== "codex" ||
            worker.parentRole !== role ||
            worker.parentNativeId !== nativeId ||
            assignment.nativeId !== worker.id
          ) {
            return null;
          }
          const endpoint = resolveCodexControlSocket({ env: io.env });
          return await codexAdapter(layout, {
            controlSocket: endpoint.path,
            env: io.env,
          }).withWorkerInbox(
            { harness: "codex", parent: nativeId, worker: worker.id },
            async () => {
              const fresh = readRegistry(layout);
              if (
                resolveHarness(fresh, role) !== harness ||
                resolveConversation(fresh, role) !== nativeId
              ) {
                return null;
              }
              return assignment;
            },
          );
        }
        if (assignment.nativeId !== nativeId) {
          return null;
        }
        return { harness, nativeId, ownerRole: role, worker: null };
      } catch {
        return null;
      }
    },
  });
}

async function operate(
  io: Io,
  root: string,
  action: (layout: Layout, ledger: LedgerStore) => unknown,
) {
  try {
    const layout = loadLayout(root);
    const result = await action(layout, store(io, layout));
    io.out(`${JSON.stringify(result)}\n`);
    return EXIT_OK;
  } catch (error) {
    const code =
      error instanceof CommandError
        ? error.code
        : error instanceof LedgerError && CORE_ERRORS.has(error.code)
          ? error.code
          : "ledger-operation-failed";
    return failure(
      io,
      code,
      EXIT_INVALID,
      error instanceof ReadProjectionError ? error.pendingIntake : undefined,
    );
  }
}

function transaction(io: Io, file: string): LedgerTransaction {
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolve(io.cwd, file));
  } catch {
    throw new CommandError("ledger-input-unavailable");
  }
  if (!isUtf8(bytes)) {
    throw new CommandError("invalid-ledger-encoding");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CommandError("invalid-ledger-json");
  }
  // Core validation owns the transaction schema. This check bounds actor lookup only.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommandError("invalid-transaction");
  }
  return value as LedgerTransaction;
}

function mutate(registerOnly: boolean): Handler {
  return (io, root, args) => {
    let file: string;
    try {
      file = required(options(LEDGER_INPUT_OPTIONS, args), "input-file");
    } catch {
      return failure(io, "invalid-ledger-options", EXIT_USAGE);
    }
    return operate(io, root, (layout, ledger) => {
      const input = transaction(io, file);
      if (registerOnly && input.command?.type !== "register") {
        throw new CommandError("invalid-transaction");
      }
      try {
        resolveRole(readRegistry(layout), input.actor);
      } catch {
        throw new CommandError("ledger-actor-unavailable");
      }
      return ledger.apply(input);
    });
  };
}

export const ledgerIntake = mutate(true);
export const ledgerApply = mutate(false);
export const ledgerReconcile = mutate(false);

function selected(history: boolean): Handler {
  return (io, root, args) => {
    let id: string;
    try {
      id = required(options(LEDGER_ID_OPTIONS, args), "id");
    } catch {
      return failure(io, "invalid-ledger-options", EXIT_USAGE);
    }
    return operate(io, root, (layout, ledger) => {
      if (history) {
        return ledger.history(id);
      }
      const pendingIntake = pendingSummary(layout, ledger);
      let record;
      try {
        record = ledger.read(id);
      } catch (error) {
        throw new ReadProjectionError(
          error instanceof LedgerError && CORE_ERRORS.has(error.code)
            ? error.code
            : "ledger-operation-failed",
          pendingIntake,
        );
      }
      if (record === undefined) {
        throw new CommandError("request-missing");
      }
      const registry = currentRegistry(layout);
      return { ...record, ownerBinding: projectOwnerBinding(registry, record), pendingIntake };
    });
  };
}

export const ledgerShow = selected(false);
export const ledgerHistory = selected(true);

export const ledgerReport: Handler = (io, root, args) => {
  let at: string;
  let owner: string | undefined;
  try {
    const values = options(LEDGER_REPORT_OPTIONS, args);
    at = required(values, "at");
    owner = values.owner;
    const date = new Date(at);
    if (
      !Number.isFinite(date.getTime()) ||
      ![date.toISOString(), date.toISOString().replace(".000Z", "Z")].includes(at)
    ) {
      throw new CommandError("invalid-ledger-options");
    }
  } catch {
    return failure(io, "invalid-ledger-options", EXIT_USAGE);
  }
  return operate(io, root, (layout, ledger) => {
    const registry = currentRegistry(layout);
    const pendingIntake = pendingSummary(layout, ledger, owner === undefined ? undefined : [owner]);
    let report;
    try {
      report = ledger.report({ at, ...(owner === undefined ? {} : { owner }) });
    } catch (error) {
      throw new ReadProjectionError(
        error instanceof LedgerError && CORE_ERRORS.has(error.code)
          ? error.code
          : "ledger-operation-failed",
        pendingIntake,
      );
    }
    return {
      ...report,
      pendingIntake,
      requests: report.requests.map((record) => ({
        ...record,
        ownerBinding: projectOwnerBinding(registry, record),
      })),
    };
  });
};

function pendingSummary(
  layout: Layout,
  ledger: LedgerStore,
  roles?: readonly string[],
): PendingIntake {
  let events: readonly LedgerEvent[] | null;
  try {
    events = ledger.history();
  } catch {
    events = null;
  }
  if (events === null) {
    return { offers: null, reason: "ledger-unavailable", status: "unavailable" };
  }
  try {
    const store = new IntakeStore({ directory: join(layout.varDir, "accounting", "intake") });
    const offers = store.pending(events, roles).map((offer) => ({
      commandId: `intake-${offer.id}`,
      id: offer.id,
      requiredOwner: offer.actor,
    }));
    return { offers, reason: null, status: "available" };
  } catch (error) {
    return {
      offers: null,
      reason: error instanceof IntakeError ? error.code : "intake-unavailable",
      status: "unavailable",
    };
  }
}

function currentRegistry(layout: Layout): Registry | null {
  try {
    return readRegistry(layout);
  } catch {
    return null;
  }
}

export const ledgerCoverage: Handler = (io, root, args) => {
  let owner: string | undefined;
  try {
    owner = options(LEDGER_COVERAGE_OPTIONS, args).owner;
  } catch {
    return failure(io, "invalid-ledger-options", EXIT_USAGE);
  }
  return operate(io, root, (layout, ledger) => {
    if (owner !== undefined) {
      resolveRole(readRegistry(layout), owner);
    }
    return ledger.coverage(owner);
  });
};

export const ledgerBoundary: Handler = async (io, root, args) => {
  let role: string;
  let phase: "startup" | "resume" | "handoff" | "review";
  try {
    const values = options(LEDGER_BOUNDARY_OPTIONS, args);
    role = required(values, "role");
    const value = required(values, "phase");
    if (value !== "startup" && value !== "resume" && value !== "handoff" && value !== "review") {
      throw new CommandError("invalid-ledger-options");
    }
    phase = value;
  } catch {
    return failure(io, "invalid-ledger-options", EXIT_USAGE);
  }
  try {
    const layout = loadLayout(root);
    resolveRole(readRegistry(layout), role);
    const snapshot = await boundarySnapshot(io, layout, role, phase);
    const result = await captureAccounting(layout, snapshot, phase, "snapshot", [role]);
    io.out(`${JSON.stringify(result)}\n`);
    return result.accounting_ready ? EXIT_OK : EXIT_INVALID;
  } catch {
    return failure(io, "ledger-operation-failed");
  }
};

async function boundarySnapshot(
  io: Io,
  layout: Layout,
  role: string,
  phase: "startup" | "resume" | "handoff" | "review",
): Promise<Record<string, unknown>> {
  const registry = readRegistry(layout);
  const harness = resolveHarness(registry, role);
  const nativeId = resolveConversation(registry, role);
  if (harness !== "codex" || nativeId === null) {
    return { harness };
  }
  let history: HistoryRefs = {
    category: "transport",
    complete: false,
    cursor: null,
    nextCursor: null,
    question_refs: [],
    reason_code: "transport_failure",
    status: "unavailable",
    user_reply_refs: [],
  };
  try {
    const endpoint = resolveCodexControlSocket({ env: io.env });
    if (statSync(endpoint.path).isSocket()) {
      const client = await connectControl(performance.now() + 15_000, endpoint.path);
      try {
        history = await historyRefs(client, nativeId);
      } finally {
        client.close();
      }
    }
  } catch {
    // Failed collection is an explicit coverage gap; supported local intake still persists.
  }
  const snapshot = { harness, history: { [nativeId]: history } };
  const observed = snapshotIntake(
    {
      harness,
      nativeId,
      nextBoundary: "next supported owner startup, resume or scheduled review",
      ownerRole: role,
      phase,
    },
    snapshot,
  );
  const command = {
    coverage: observed.commands.flatMap((value) =>
      value.type === "coverage" ? [value.coverage] : [],
    ),
    requests: observed.commands.flatMap((value) =>
      value.type === "register" ? [value.request] : [],
    ),
    type: "capture" as const,
  };
  if (command.requests.length + command.coverage.length > 0) {
    new IntakeStore({ directory: join(layout.varDir, "accounting", "intake") }).offer({
      actor: role,
      command,
      source: command.coverage[0]?.source ?? command.requests[0]!.source,
    });
  }
  const fresh = readRegistry(layout);
  if (resolveHarness(fresh, role) !== harness || resolveConversation(fresh, role) !== nativeId) {
    return {};
  }
  return snapshot;
}
