// Existing ingress retains accounting references independently of native delivery and ACKs.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { isRecord } from "../adapters/shared/pyjson.ts";
import type { Layout } from "../layout.ts";
import { messageSummary } from "../messages/store.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import { readRegistry } from "../registry/store.ts";
import { messageIntake, snapshotIntake } from "./ingress.ts";
import { type OwnerBinding, projectOwnerBinding } from "./ownership.ts";
import { LedgerError, LedgerStore } from "./store.ts";
import type { LedgerCommand, LedgerSource } from "./types.ts";

export interface AccountingBoundary {
  readonly status: "available" | "unavailable";
  readonly accounting_ready: boolean;
  readonly revision?: number;
  readonly coverageState?: string;
  readonly open?: readonly string[];
  readonly stalled?: readonly string[];
  readonly unassigned?: readonly string[];
  readonly unknownSource?: readonly string[];
  readonly untriaged?: readonly string[];
  readonly protectedQuestions?: readonly string[];
  readonly missingOwners?: readonly string[];
  readonly assignments?: readonly {
    readonly requestId: string;
    readonly ownerBinding: OwnerBinding;
  }[];
  readonly gaps?: readonly unknown[];
  readonly reason?: string;
}

function failureReason(error: unknown): string {
  const code = error instanceof LedgerError ? error.code : null;
  return code !== null &&
    [
      "corrupt-ledger",
      "stale-revision",
      "owner-unavailable",
      "invalid-directory",
      "ledger-busy",
    ].includes(code)
    ? code
    : "accounting-unavailable";
}

/** Readiness remains read-only. Unknown accounting coverage never becomes an empty ledger. */
export function accountingStatus(layout: Layout, roles?: readonly string[]): AccountingBoundary {
  try {
    const report = new LedgerStore({ directory: join(layout.varDir, "accounting") }).report({
      at: new Date().toISOString(),
    });
    const registry = readRegistry(layout);
    const owners = roles ?? Object.keys(registry.roles);
    if (owners.some((owner) => !Object.hasOwn(registry.roles, owner))) {
      throw new Error("accounting-owner-unavailable");
    }
    const selected = new Set(owners);
    const ids = new Set(
      report.requests
        .filter((request) => selected.has(request.assignment?.ownerRole ?? request.createdBy))
        .map((request) => request.id),
    );
    const coverage = report.coverage.filter((entry) => selected.has(entry.ownerRole));
    const missingOwners = owners
      .filter((owner) => !coverage.some((entry) => entry.ownerRole === owner))
      .sort();
    const visible = (values: readonly string[]) => values.filter((id) => ids.has(id));
    const unknownSource = visible(report.unknownSource);
    const untriaged = visible(report.untriaged);
    const protectedQuestions = visible(report.protectedQuestions);
    const open = visible(report.open);
    const unassigned = visible(report.unassigned);
    const assignments = report.requests
      .filter((request) => ids.has(request.id))
      .map((request) => ({
        ownerBinding: projectOwnerBinding(registry, request),
        requestId: request.id,
      }));
    const pending = new Set([...open, ...protectedQuestions]);
    const invalidBinding = assignments.some(
      (entry) =>
        pending.has(entry.requestId) &&
        (entry.ownerBinding.status === "stale" || entry.ownerBinding.status === "unavailable"),
    );
    const coverageState =
      unknownSource.length > 0 ||
      untriaged.length > 0 ||
      coverage.some((entry) => entry.state !== "covered" || entry.gaps.length > 0) ||
      (missingOwners.length > 0 && report.initialized)
        ? "incomplete"
        : coverage.length === 0
          ? "unknown"
          : "declared-complete";
    return {
      accounting_ready:
        missingOwners.length === 0 &&
        report.initialized &&
        coverageState === "declared-complete" &&
        protectedQuestions.length === 0 &&
        unassigned.length === 0 &&
        !invalidBinding,
      assignments,
      coverageState,
      missingOwners,
      open,
      protectedQuestions,
      revision: report.revision,
      stalled: visible(report.stalled),
      status: "available",
      unassigned,
      unknownSource,
      untriaged,
    };
  } catch (error) {
    return { accounting_ready: false, reason: failureReason(error), status: "unavailable" };
  }
}

/** Stable automatic intake retries never overwrite semantic owner reconciliation. */
async function captureCommand(
  store: LedgerStore,
  actor: string,
  source: LedgerSource,
  command: LedgerCommand,
): Promise<void> {
  const commandId = `boundary-${createHash("sha256")
    .update(JSON.stringify([actor, source, command]))
    .digest("hex")}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const prior = store.history().find((event) => event.commandId === commandId);
    if (prior !== undefined) {
      if (
        prior.actor !== actor ||
        !isDeepStrictEqual(prior.source, source) ||
        !isDeepStrictEqual(prior.command, command)
      ) {
        throw new Error("accounting-command-conflict");
      }
      return;
    }
    if (command.type === "register") {
      const existing = store.read(command.request.id);
      if (existing !== undefined) {
        if (!isDeepStrictEqual(existing.source, command.request.source)) {
          throw new Error("accounting-source-conflict");
        }
        return;
      }
    }
    try {
      // Retry only after replaying the previous committed revision.
      // eslint-disable-next-line no-await-in-loop
      await store.apply({
        actor,
        at: new Date().toISOString(),
        command,
        commandId,
        expectedRevision: store.read().revision,
        schema: 1,
        source,
      });
      return;
    } catch (error) {
      if (error instanceof LedgerError && error.code === "command-conflict") {
        const winner = store.history().find((event) => event.commandId === commandId);
        if (
          winner !== undefined &&
          winner.actor === actor &&
          isDeepStrictEqual(winner.source, source) &&
          isDeepStrictEqual(winner.command, command)
        ) {
          return;
        }
      }
      if (
        error instanceof LedgerError &&
        error.code === "request-exists" &&
        command.type === "register" &&
        isDeepStrictEqual(store.read(command.request.id)?.source, command.request.source)
      ) {
        return;
      }
      if (!(error instanceof LedgerError) || error.code !== "stale-revision") {
        throw error;
      }
    }
  }
  throw new Error("accounting-concurrent-update");
}

/** Capture only supported metadata, never infer human origin from a native item or message. */
export async function captureAccounting(
  layout: Layout,
  snapshot: Readonly<Record<string, unknown>>,
  phase: "startup" | "resume" | "handoff" | "review" = "review",
  sourceKind: "snapshot" | "message" = "snapshot",
  roles?: readonly string[],
): Promise<AccountingBoundary> {
  try {
    const registry = readRegistry(layout);
    const store = new LedgerStore({
      directory: join(layout.varDir, "accounting"),
      nonBlocking: true,
    });
    const inventory = messageSummary(layout);
    const messages =
      inventory.status === "available" && typeof snapshot.message_id === "string"
        ? {
            ...inventory,
            messages: inventory.messages.filter((message) => message.id === snapshot.message_id),
          }
        : inventory;
    const worker = isRecord(snapshot.worker_binding) ? snapshot.worker_binding : null;
    const gaps: unknown[] = [];
    const selectedRoles = roles ?? Object.keys(registry.roles);
    if (selectedRoles.some((role) => !Object.hasOwn(registry.roles, role))) {
      throw new Error("accounting-owner-unavailable");
    }
    for (const ownerRole of [...new Set(selectedRoles)].sort()) {
      const harness = resolveHarness(registry, ownerRole);
      const nativeId = resolveConversation(registry, ownerRole);
      const projection = store.read();
      const context = {
        harness,
        known: {
          coverage: projection.coverage.filter((entry) => entry.ownerRole === ownerRole),
          requests: projection.requests.filter(
            (request) => (request.assignment?.ownerRole ?? request.createdBy) === ownerRole,
          ),
        },
        nativeId,
        nextBoundary: "next supported owner startup, resume or scheduled review",
        ownerRole,
        phase,
      };
      const workerMatches =
        worker?.harness === "codex" &&
        harness === "codex" &&
        worker.parent === nativeId &&
        isCanonicalUuid(worker.worker) &&
        worker.worker !== nativeId;
      const workerContext = workerMatches
        ? { ...context, nativeId: worker.worker as string }
        : null;
      const intakes = [
        ...(sourceKind === "snapshot" ? [snapshotIntake(workerContext ?? context, snapshot)] : []),
        messageIntake(context, messages),
      ];
      const requests = [];
      const coverage = [];
      for (const intake of intakes) {
        gaps.push(...intake.gaps);
        for (const command of intake.commands) {
          if (command.type === "register") {
            requests.push(command.request);
          } else if (command.type === "coverage") {
            coverage.push(command.coverage);
          }
        }
      }
      if (requests.length > 0 || coverage.length > 0) {
        const source: LedgerSource = {
          native: null,
          origin: "unknown",
          reference: `accounting-boundary:${JSON.stringify([ownerRole, harness, nativeId, phase])}`,
          wordingHash: null,
        };
        // Each owner batch commits before the next owner reads the shared revision.
        // eslint-disable-next-line no-await-in-loop
        await captureCommand(store, ownerRole, source, { coverage, requests, type: "capture" });
      }
    }
    const report = accountingStatus(layout, selectedRoles);
    return {
      ...report,
      accounting_ready: report.accounting_ready && gaps.length === 0,
      gaps,
    };
  } catch (error) {
    // Accounting visibility cannot suppress monitor wakes or change live delivery controls.
    return { accounting_ready: false, reason: failureReason(error), status: "unavailable" };
  }
}

/** Metadata-only reminder. Complete local detail remains in the durable snapshot. */
export function accountingReview(value: unknown): string {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    return "\nRequest accounting is unavailable; reconcile the supported ledger boundary and coverage gaps.";
  }
  const record = value as Record<string, unknown>;
  const summary = Object.fromEntries(
    ["status", "accounting_ready", "revision", "coverageState", "missingOwners"].map((key) => [
      key,
      record[key] ?? null,
    ]),
  );
  return (
    `\nDurable request accounting: ${JSON.stringify(summary)}. ` +
    "Use ledger report and ledger coverage to reconcile open, stalled, unassigned and untriaged " +
    "work. Native history gaps remain explicit; transport handling is not request completion."
  );
}
