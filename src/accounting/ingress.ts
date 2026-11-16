// Pure intake records observations, never human authority or native lifecycle changes.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { isRecord } from "../adapters/shared/pyjson.ts";
import type { MessageSummary } from "../messages/types.ts";
import type {
  LedgerCommand,
  LedgerCoverage,
  LedgerProjection,
  LedgerRequestInput,
  LedgerSource,
  NativeReference,
} from "./types.ts";

export interface IntakeContext {
  readonly ownerRole: string;
  readonly harness: "codex" | "claude";
  readonly nativeId: string | null;
  readonly phase: "startup" | "resume" | "handoff" | "review";
  readonly nextBoundary: string;
  readonly known?: Pick<LedgerProjection, "requests" | "coverage">;
}

export interface IngressGap {
  readonly source: LedgerSource;
  readonly range: LedgerCoverage["range"];
  readonly requiredOwner: string;
  readonly requiredParent?: { readonly ownerRole: string; readonly nativeId: string };
  readonly reason: string;
  readonly nextBoundary: string;
}

export interface IngressIntake {
  readonly commands: readonly LedgerCommand[];
  readonly candidateIds: readonly string[];
  readonly pendingCandidateIds: readonly string[];
  readonly coverage: readonly LedgerCoverage[];
  readonly gaps: readonly IngressGap[];
  /** Raw capability diagnostics do not revoke explicit reconciliation of an unchanged window. */
  readonly observedGaps: readonly IngressGap[];
  readonly accounting_ready: boolean;
}

/** An owner-reviewed audit supplies references only, never raw native text or credentials. */
export interface AuditSubmission {
  readonly reference: string;
  readonly reviewed: boolean;
  readonly sources: readonly LedgerSource[];
  readonly range: LedgerCoverage["range"];
  readonly gaps: readonly LedgerCoverage["gaps"][number][];
}

function identity(kind: string, parts: readonly unknown[]): string {
  return `${kind}-${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

function token(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function source(reference: string, native: NativeReference | null = null): LedgerSource {
  return { native, origin: "unknown", reference, wordingHash: null };
}

function candidate(observed: LedgerSource, question = false): LedgerRequestInput {
  return {
    assignment: null,
    dependencies: [],
    id: identity("intake", [observed.reference, observed.native]),
    kind: "unknown",
    parentId: null,
    question: question
      ? {
          native: observed.native,
          options: null,
          resolutionRef: null,
          status: "unknown",
          text: null,
        }
      : null,
    reviewed: false,
    source: observed,
    summary: question
      ? "Observed question reference awaiting owner review"
      : "Observed source awaiting owner review",
    targets: [],
  };
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      immutable(child);
    }
    Object.freeze(value);
  }
  return value;
}

function reviewed(context: IntakeContext, id: string): boolean {
  const record = context.known?.requests.find((request) => request.id === id);
  if (record === undefined || !record.reviewed || record.kind === "unknown") {
    return false;
  }
  const attested = [record.source, ...record.sources.map((link) => link.source)].some(
    (item) => item.origin === "owner-attested" && token(item.reference),
  );
  return attested;
}

function finish(
  context: IntakeContext,
  observed: LedgerSource,
  range: LedgerCoverage["range"],
  requests: readonly LedgerRequestInput[],
  reasons: readonly (string | LedgerCoverage["gaps"][number])[],
  unavailable = false,
): IngressIntake {
  if (!token(context.ownerRole) || !token(context.nextBoundary)) {
    throw new Error("invalid-ingress-context");
  }
  const unique = [...new Map(requests.map((request) => [request.id, request])).values()].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
  const pendingCandidateIds = unique
    .filter((request) => !reviewed(context, request.id))
    .map((request) => request.id);
  const protectedQuestion = context.known?.requests.some(
    (request) =>
      (request.assignment?.ownerRole ?? request.createdBy) === context.ownerRole &&
      request.question !== null &&
      ["pending", "unknown"].includes(request.question.status),
  );
  const observations = [
    ...reasons,
    ...(pendingCandidateIds.length ? ["owner-review-required"] : []),
    ...(protectedQuestion ? ["protected-question-unresolved"] : []),
  ].map((reason) => (typeof reason === "string" ? { ...range, reason } : { ...reason }));
  const gaps = [...new Map(observations.map((gap) => [JSON.stringify(gap), gap])).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, gap]) => gap);
  const coverage: LedgerCoverage = {
    gaps,
    id: identity("coverage", [
      context.ownerRole,
      observed.reference,
      range,
      unique.map((request) => request.id),
    ]),
    nextBoundary: context.nextBoundary,
    ownerRole: context.ownerRole,
    range: { ...range },
    source: observed,
    state: unavailable ? "unavailable" : gaps.length ? "partial" : "covered",
  };
  const commands: LedgerCommand[] = unique
    .filter((request) => !context.known?.requests.some((known) => known.id === request.id))
    .map((request) => ({ request, type: "register" }));
  const previous = context.known?.coverage.find((entry) => entry.id === coverage.id);
  const reconciled =
    previous !== undefined &&
    previous.ownerRole === context.ownerRole &&
    previous.state === "covered" &&
    previous.gaps.length === 0 &&
    previous.source.origin === "owner-attested" &&
    token(previous.source.reference) &&
    isDeepStrictEqual(previous.range, range);
  const effective = reconciled ? structuredClone(previous) : coverage;
  const actionable = reconciled
    ? gaps.filter(
        (gap) =>
          gap.reason === "owner-review-required" || gap.reason === "protected-question-unresolved",
      )
    : gaps;
  if (!reconciled && !isDeepStrictEqual(previous, coverage)) {
    commands.push({ coverage, type: "coverage" });
  }
  const projectGap = (gap: LedgerCoverage["gaps"][number]): IngressGap => ({
    nextBoundary: context.nextBoundary,
    range: { from: gap.from, through: gap.through },
    reason: gap.reason,
    requiredOwner: context.ownerRole,
    source: observed,
  });
  return immutable({
    accounting_ready:
      effective.state === "covered" && pendingCandidateIds.length === 0 && !protectedQuestion,
    candidateIds: Object.freeze(unique.map((request) => request.id)),
    commands: Object.freeze(commands),
    coverage: Object.freeze([effective]),
    gaps: Object.freeze(actionable.map(projectGap)),
    observedGaps: Object.freeze(reconciled ? gaps.map(projectGap) : []),
    pendingCandidateIds: Object.freeze(pendingCandidateIds),
  });
}

function queueCandidates(
  context: IntakeContext,
  snapshot: Readonly<Record<string, unknown>>,
  reasons: string[],
): LedgerRequestInput[] {
  const queues = isRecord(snapshot.queues) ? snapshot.queues : {};
  const entries = context.nativeId === null ? undefined : queues[context.nativeId];
  if (!Array.isArray(entries)) {
    reasons.push("recipient-queue-unavailable");
    return [];
  }
  const requests: LedgerRequestInput[] = [];
  for (const entry of entries as unknown[]) {
    if (!isRecord(entry) || !token(entry.id)) {
      reasons.push("malformed-queue-reference");
      continue;
    }
    const clientId = token(entry.clientUserMessageId) ? entry.clientUserMessageId : null;
    requests.push(
      candidate(
        source(
          `native-queue:${JSON.stringify([context.harness, context.nativeId, entry.id, clientId])}`,
          {
            harness: context.harness,
            index: null,
            itemId: null,
            threadId: context.nativeId,
            turnId: null,
          },
        ),
      ),
    );
  }
  return requests;
}

function nativeIntake(
  context: IntakeContext,
  snapshot: Readonly<Record<string, unknown>>,
  observed = source(`native-history:${JSON.stringify([context.harness, context.nativeId])}`),
): IngressIntake {
  const reasons: string[] = [];
  const requests: LedgerRequestInput[] = [];
  const range = { from: null as string | null, through: null as string | null };
  const harnesses = isRecord(snapshot.harnesses) ? snapshot.harnesses : {};
  const binding =
    context.nativeId === null ? null : (harnesses[context.nativeId] ?? snapshot.harness);
  if (binding !== context.harness || !token(context.nativeId)) {
    return finish(context, observed, range, [], ["native-binding-unavailable"], true);
  }
  requests.push(...queueCandidates(context, snapshot, reasons));
  if (context.harness === "claude") {
    return finish(
      context,
      observed,
      range,
      requests,
      [...reasons, "claude-native-history-unsupported"],
      true,
    );
  }
  const history = isRecord(snapshot.history) ? snapshot.history[context.nativeId] : undefined;
  if (!isRecord(history)) {
    return finish(
      context,
      observed,
      range,
      requests,
      [...reasons, "native-history-unavailable"],
      true,
    );
  }
  range.from = history.cursor === null ? "head" : token(history.cursor) ? history.cursor : null;
  range.through =
    history.nextCursor === null && history.complete === true
      ? "end-of-returned-history"
      : token(history.nextCursor)
        ? history.nextCursor
        : null;
  for (const field of ["user_reply_refs", "question_refs"] as const) {
    const refs = history[field];
    if (!Array.isArray(refs)) {
      reasons.push("malformed-native-references");
      continue;
    }
    for (const ref of refs as unknown[]) {
      if (!isRecord(ref) || !token(ref.turn_id) || !token(ref.item_id)) {
        reasons.push("malformed-native-reference");
        continue;
      }
      const native: NativeReference = {
        harness: "codex",
        index: null,
        itemId: ref.item_id,
        threadId: context.nativeId,
        turnId: ref.turn_id,
      };
      requests.push(
        candidate(
          source(`native-item:${JSON.stringify(native)}`, native),
          field === "question_refs",
        ),
      );
    }
  }
  // A complete returned page is not attestation of full historical human-request coverage.
  reasons.push("historical-human-origin-unattested");
  if (history.status !== "complete" || history.complete !== true || history.nextCursor !== null) {
    reasons.push("bounded-native-history-incomplete");
  }
  if (range.from === null || range.through === null) {
    reasons.push("native-range-unknown");
  }
  if (history.status === "unavailable" && observed.reference?.startsWith("worker-history:")) {
    reasons.push("child-native-history-unavailable");
  }
  return finish(context, observed, range, requests, reasons, history.status === "unavailable");
}

function combine(intakes: readonly IngressIntake[]): IngressIntake {
  return immutable({
    accounting_ready: intakes.every((intake) => intake.accounting_ready),
    candidateIds: [...new Set(intakes.flatMap((intake) => intake.candidateIds))].sort(),
    commands: [
      ...new Map(
        intakes
          .flatMap((intake) => intake.commands)
          .map((command) => [JSON.stringify(command), command]),
      ).values(),
    ],
    coverage: intakes.flatMap((intake) => intake.coverage),
    gaps: intakes.flatMap((intake) => intake.gaps),
    observedGaps: intakes.flatMap((intake) => intake.observedGaps),
    pendingCandidateIds: [
      ...new Set(intakes.flatMap((intake) => intake.pendingCandidateIds)),
    ].sort(),
  });
}

/** Account for observed verified children without turning worker discovery into input reads. */
function workerIntakes(
  context: IntakeContext,
  snapshot: Readonly<Record<string, unknown>>,
): readonly IngressIntake[] {
  if (context.harness !== "codex" || !token(context.nativeId)) {
    return [];
  }
  const parent = context.nativeId;
  const requiredParent = { nativeId: parent, ownerRole: context.ownerRole };
  const health = isRecord(snapshot.worker_health) ? snapshot.worker_health[parent] : undefined;
  const observed: LedgerSource = {
    ...source(`worker-inventory:${JSON.stringify(["codex", parent])}`),
    origin: "relay",
  };
  const range = { from: "observed-worker-inventory", through: "observed-worker-inventory" };
  const reasons: string[] = [];
  const children: IngressIntake[] = [];
  if (!isRecord(health) || !Array.isArray(health.children)) {
    reasons.push("worker-inventory-unavailable");
  } else {
    if (health.status !== "complete" || health.complete !== true) {
      reasons.push("worker-inventory-incomplete");
    }
    const omitted = isRecord(health.counts) ? health.counts.omitted : undefined;
    if (typeof omitted !== "number" || !Number.isSafeInteger(omitted) || omitted < 0) {
      reasons.push("worker-inventory-count-unknown");
    } else if (omitted > 0) {
      reasons.push("worker-inventory-omitted");
    }
    const seen = new Set<string>();
    for (const child of health.children as unknown[]) {
      if (
        !isRecord(child) ||
        child.lineage_verified !== true ||
        child.parent_id !== parent ||
        !isCanonicalUuid(parent) ||
        !isCanonicalUuid(child.child_id) ||
        child.child_id === parent
      ) {
        reasons.push("worker-lineage-unavailable");
        continue;
      }
      const id = child.child_id;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const childSource = source(`worker-history:${JSON.stringify([parent, id])}`, {
        harness: "codex",
        index: null,
        itemId: null,
        threadId: id,
        turnId: null,
      });
      const childContext = { ...context, nativeId: id };
      const history = isRecord(snapshot.history) ? snapshot.history[id] : undefined;
      if (isRecord(history)) {
        children.push(
          nativeIntake(
            childContext,
            {
              harness: "codex",
              harnesses: snapshot.harnesses,
              history: snapshot.history,
              queues: snapshot.queues,
            },
            childSource,
          ),
        );
      } else {
        children.push(
          finish(
            childContext,
            childSource,
            { from: null, through: null },
            [],
            ["child-native-history-unavailable"],
            true,
          ),
        );
      }
    }
  }
  const inventory = finish(
    context,
    observed,
    range,
    [],
    reasons,
    !isRecord(health) || health.status === "unavailable" || !Array.isArray(health.children),
  );
  return [inventory, ...children].map((intake) =>
    immutable({
      ...intake,
      gaps: intake.gaps.map((gap) => ({ ...gap, requiredParent })),
      observedGaps: intake.observedGaps.map((gap) => ({ ...gap, requiredParent })),
    }),
  );
}

/** Existing snapshots already collected native references; this function performs no reads. */
export function snapshotIntake(
  context: IntakeContext,
  snapshot: Readonly<Record<string, unknown>>,
): IngressIntake {
  return combine([nativeIntake(context, snapshot), ...workerIntakes(context, snapshot)]);
}

/** Delivery states and payloads never determine whether a transport contains a human request. */
export function messageIntake(context: IntakeContext, summary: MessageSummary): IngressIntake {
  const observed: LedgerSource = {
    ...source(`durable-messages:${context.ownerRole}`),
    origin: "relay",
  };
  const range = { from: "local-inbox", through: "local-inbox" };
  if (summary.status !== "available") {
    return finish(context, observed, range, [], ["local-message-store-unavailable"], true);
  }
  const requests = summary.messages
    .filter((message) => message.toRole === context.ownerRole)
    .map((message) => {
      const reference = `message:${JSON.stringify([
        message.id,
        message.fromRole,
        message.toRole,
        message.workerId ?? null,
        message.parentRole ?? null,
      ])}`;
      return candidate({ ...source(reference), origin: "relay" });
    });
  return finish(context, observed, range, requests, ["transport-is-not-human-origin-proof"]);
}

/** Review attests an audit window, never approves or semantically classifies its sources. */
export function auditIntake(context: IntakeContext, submission: AuditSubmission): IngressIntake {
  if (!token(submission.reference)) {
    throw new Error("invalid-ingress-audit");
  }
  const observed: LedgerSource = {
    ...source(submission.reference),
    origin: submission.reviewed ? "owner-attested" : "unknown",
  };
  const requests = submission.sources.map((entry) =>
    candidate({
      native:
        entry.native === null
          ? null
          : {
              harness: entry.native.harness,
              index: entry.native.index,
              itemId: entry.native.itemId,
              threadId: entry.native.threadId,
              turnId: entry.native.turnId,
            },
      origin: entry.origin,
      reference: entry.reference,
      wordingHash: null,
    }),
  );
  const reasons = [
    ...submission.gaps,
    ...(!submission.reviewed ? ["audit-owner-review-required"] : []),
    ...(submission.range.from === null || submission.range.through === null
      ? ["audit-range-unknown"]
      : []),
  ];
  return finish(context, observed, submission.range, requests, reasons);
}
