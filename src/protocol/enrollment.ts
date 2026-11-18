import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { canonical, ProtocolStore, protocolWorkerRole } from "./core.ts";
import type {
  ArtifactRef,
  Binding,
  ProtocolEvent,
  ProtocolState,
  ProtocolTransaction,
} from "./types.ts";

export type EnrollmentContext = Omit<ProtocolTransaction, "mutations">;
export type EnrollmentPhase = "prepared" | "active";
export interface EnrollmentReference {
  readonly kind:
    "request" | "work" | "submission" | "original" | "intake" | "coverage" | "question" | "hold";
  readonly key: string;
}
export interface EnrollmentLedgerAnchor {
  readonly revision: number;
  readonly hash: string | null;
}
export interface EnrollmentParticipant {
  readonly role: string;
  /** Verified worker parent, or the designated owning parent for unavailable owner coverage. */
  readonly parentRole: string | null;
  readonly epoch: number | null;
  readonly binding: Binding | null;
  readonly knownReferences: readonly EnrollmentReference[];
  readonly requiredUnknownScopes: readonly string[];
}
export interface EnrollmentScope {
  readonly workspaceId: string;
  readonly generation: number;
  readonly phase: EnrollmentPhase;
  readonly registryRevision: number;
  /** Complete externally observed roster, never inferred from committed namespaces alone. */
  readonly participants: readonly EnrollmentParticipant[];
  /** Verified replay prefixes of the sole ledger, including revision zero when uninitialized. */
  readonly ledgerAnchors: readonly EnrollmentLedgerAnchor[];
}
export interface EnrollmentUnknown {
  readonly id: string;
  readonly participantRole: string;
  /** 'participant' denotes an unavailable participant represented by its designated parent. */
  readonly scope: string;
  readonly parentRole: string;
  readonly reason: string;
  readonly nextBoundary: string;
  readonly evidence: readonly ArtifactRef[];
}
export interface EnrollmentInput {
  readonly workspaceId: string;
  readonly generation: number;
  readonly phase: EnrollmentPhase;
  readonly registryRevision: number;
  readonly inspectedAt: string;
  readonly ledger: EnrollmentLedgerAnchor;
  readonly references: readonly EnrollmentReference[];
  readonly unknowns: readonly EnrollmentUnknown[];
  readonly evidence: readonly ArtifactRef[];
}
export interface EnrollmentRecord extends EnrollmentInput {
  readonly schema: 1;
  readonly role: string;
  readonly epoch: number;
  readonly binding: Binding;
}
export interface EnrollmentReport {
  readonly allRepresented: boolean;
  readonly allAdopted: boolean;
  readonly coverageComplete: boolean;
  readonly missing: readonly string[];
  readonly stale: readonly { readonly role: string; readonly reason: string }[];
  /** Every current known reference a participant's receipt does not list. */
  readonly omitted: readonly { readonly role: string; readonly reference: EnrollmentReference }[];
  /**
   * The subset of `omitted` that first became known after the receipt was published. It keeps
   * coverage incomplete without revoking the receipt's adoption or representation.
   */
  readonly uncovered: readonly { readonly role: string; readonly reference: EnrollmentReference }[];
  readonly unknowns: readonly EnrollmentUnknown[];
  readonly participants: readonly {
    readonly role: string;
    readonly represented: boolean;
    readonly adopted: boolean;
    readonly revision: number | null;
  }[];
}

export class EnrollmentError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`protocol enrollment: ${code}`);
    this.code = code;
    this.name = "EnrollmentError";
  }
}

const KINDS = [
  "request",
  "work",
  "submission",
  "original",
  "intake",
  "coverage",
  "question",
  "hold",
];
const HASH = /^[a-f0-9]{64}$/u;

function demand(value: unknown, code = "invalid-enrollment"): asserts value {
  if (!value) {
    throw new EnrollmentError(code);
  }
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function fields(value: unknown, keys: readonly string[]): void {
  demand(typeof value === "object" && value !== null && !Array.isArray(value));
  demand(isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()));
}

function natural(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function anchor(value: EnrollmentLedgerAnchor): void {
  fields(value, ["revision", "hash"]);
  demand(natural(value.revision));
  demand(
    value.revision === 0
      ? value.hash === null
      : typeof value.hash === "string" && HASH.test(value.hash),
  );
}

function binding(value: Binding): void {
  fields(value, ["harness", "nativeId"]);
  demand(["codex", "claude"].includes(value.harness) && text(value.nativeId));
}

function referenceKey(value: EnrollmentReference): string {
  return JSON.stringify([value.kind, value.key]);
}

function references(values: readonly EnrollmentReference[]): void {
  demand(Array.isArray(values));
  for (const value of values) {
    fields(value, ["kind", "key"]);
    demand(KINDS.includes(value.kind) && text(value.key));
  }
  demand(new Set(values.map(referenceKey)).size === values.length);
}

function artifacts(protocol: ProtocolStore, values: readonly ArtifactRef[]): void {
  demand(Array.isArray(values) && values.length > 0, "enrollment-evidence-required");
  for (const value of values) {
    fields(value, ["hash", "size"]);
    demand(typeof value.hash === "string" && HASH.test(value.hash) && natural(value.size));
    demand(
      protocol.readArtifact(value.hash).byteLength === value.size,
      "enrollment-evidence-mismatch",
    );
  }
}

/** Journal object, written with each receipt, recording the references known at publication. */
const ANCHOR_ID = "enrollment-anchor";
const ANCHOR_KEYS = ["schema", "kind", "receipt", "knownReferences"];

interface EnrollmentAnchor {
  readonly schema: 1;
  readonly kind: "enrollment-anchor";
  /** SHA-256 of the canonical receipt it was published with. */
  readonly receipt: string;
  readonly knownReferences: readonly EnrollmentReference[];
}

function receiptDigest(record: EnrollmentRecord): string {
  return createHash("sha256").update(canonical(record)).digest("hex");
}

const INPUT_KEYS = [
  "workspaceId",
  "generation",
  "phase",
  "registryRevision",
  "inspectedAt",
  "ledger",
  "references",
  "unknowns",
  "evidence",
];

/** References are observations, not authorization or proof of native question handling. */
export class EnrollmentStore {
  readonly #protocol: ProtocolStore;

  constructor(options: { readonly protocol: ProtocolStore }) {
    this.#protocol = options.protocol;
  }

  #scope(scope: EnrollmentScope): Map<string, EnrollmentParticipant> {
    fields(scope, [
      "workspaceId",
      "generation",
      "phase",
      "registryRevision",
      "participants",
      "ledgerAnchors",
    ]);
    demand(text(scope.workspaceId) && natural(scope.generation) && scope.generation > 0);
    demand(["prepared", "active"].includes(scope.phase) && natural(scope.registryRevision));
    demand(
      Array.isArray(scope.participants) && scope.participants.length > 0,
      "enrollment-roster-required",
    );
    const participants = new Map<string, EnrollmentParticipant>();
    for (const participant of scope.participants) {
      fields(participant, [
        "role",
        "parentRole",
        "epoch",
        "binding",
        "knownReferences",
        "requiredUnknownScopes",
      ]);
      this.#protocol.read(participant.role);
      demand(!participants.has(participant.role), "enrollment-roster-conflict");
      demand(participant.parentRole === null || text(participant.parentRole));
      demand(participant.epoch === null || (natural(participant.epoch) && participant.epoch > 0));
      if (participant.binding !== null) {
        binding(participant.binding);
      }
      references(participant.knownReferences);
      demand(
        Array.isArray(participant.requiredUnknownScopes) &&
          participant.requiredUnknownScopes.every(text),
      );
      demand(
        new Set(participant.requiredUnknownScopes).size ===
          participant.requiredUnknownScopes.length,
      );
      participants.set(participant.role, participant);
    }
    for (const participant of participants.values()) {
      demand(participant.parentRole !== participant.role, "enrollment-parent-mismatch");
      demand(
        participant.parentRole === null || participants.has(participant.parentRole),
        "enrollment-parent-mismatch",
      );
      if (participant.role.includes("/workers/")) {
        const [parent, suffix] = participant.role.split("/workers/");
        const [workerId, epoch] = suffix!.split("/");
        demand(parent === participant.parentRole && workerId !== undefined && epoch !== undefined);
        demand(
          protocolWorkerRole(parent!, workerId, Number(epoch)) === participant.role,
          "enrollment-parent-mismatch",
        );
        const owner = participants.get(parent!)!;
        demand(owner.epoch === Number(epoch), "enrollment-parent-mismatch");
        demand(
          participant.binding === null ||
            (participant.binding.harness === "codex" && participant.binding.nativeId === workerId),
          "enrollment-parent-mismatch",
        );
      }
    }
    demand(
      Array.isArray(scope.ledgerAnchors) && scope.ledgerAnchors.length > 0,
      "enrollment-ledger-required",
    );
    scope.ledgerAnchors.forEach(anchor);
    demand(
      new Set(scope.ledgerAnchors.map((value) => value.revision)).size ===
        scope.ledgerAnchors.length,
    );
    return participants;
  }

  #input(input: EnrollmentInput): void {
    demand(text(input.workspaceId) && natural(input.generation) && input.generation > 0);
    demand(["prepared", "active"].includes(input.phase) && natural(input.registryRevision));
    demand(typeof input.inspectedAt === "string" && Number.isFinite(Date.parse(input.inspectedAt)));
    anchor(input.ledger);
    references(input.references);
    artifacts(this.#protocol, input.evidence);
    demand(Array.isArray(input.unknowns));
    for (const unknown of input.unknowns) {
      fields(unknown, [
        "id",
        "participantRole",
        "scope",
        "parentRole",
        "reason",
        "nextBoundary",
        "evidence",
      ]);
      demand(
        [
          unknown.id,
          unknown.participantRole,
          unknown.scope,
          unknown.parentRole,
          unknown.reason,
          unknown.nextBoundary,
        ].every(text),
      );
      artifacts(this.#protocol, unknown.evidence);
    }
    demand(new Set(input.unknowns.map((value) => value.id)).size === input.unknowns.length);
    demand(input.references.length + input.unknowns.length > 0, "empty-enrollment");
  }

  #matches(
    record: EnrollmentRecord,
    scope: EnrollmentScope,
    participant: EnrollmentParticipant,
    current: ProtocolState = this.#protocol.read(participant.role),
  ): string | null {
    if (
      record.workspaceId !== scope.workspaceId ||
      record.generation !== scope.generation ||
      record.phase !== scope.phase
    ) {
      return "enrollment-generation-mismatch";
    }
    if (record.registryRevision > scope.registryRevision) {
      return "enrollment-registry-mismatch";
    }
    if (!scope.ledgerAnchors.some((value) => isDeepStrictEqual(value, record.ledger))) {
      return "enrollment-ledger-mismatch";
    }
    if (
      participant.epoch === null ||
      participant.binding === null ||
      record.epoch !== participant.epoch ||
      !isDeepStrictEqual(record.binding, participant.binding) ||
      current.epoch !== participant.epoch ||
      !isDeepStrictEqual(current.binding, participant.binding)
    ) {
      return "enrollment-binding-mismatch";
    }
    if (current.parent !== null) {
      const parent = this.#protocol.read(current.parent.role);
      if (parent.epoch !== current.parent.epoch) {
        return "enrollment-parent-mismatch";
      }
    }
    return null;
  }

  #unknowns(
    role: string,
    input: EnrollmentInput,
    participants: Map<string, EnrollmentParticipant>,
  ): void {
    for (const unknown of input.unknowns) {
      const participant = participants.get(unknown.participantRole);
      demand(participant !== undefined, "enrollment-unknown-scope");
      if (unknown.participantRole !== role) {
        demand(
          unknown.scope === "participant" &&
            participant.parentRole === role &&
            unknown.parentRole === role,
          "enrollment-parent-mismatch",
        );
      } else {
        demand(
          unknown.parentRole === (participant.parentRole ?? role),
          "enrollment-parent-mismatch",
        );
        demand(
          participant.requiredUnknownScopes.includes(unknown.scope),
          "enrollment-unknown-scope",
        );
      }
    }
  }

  #record(state: ProtocolState): EnrollmentRecord | undefined {
    const object = state.objects.find(
      (entry) => entry.collection === "intake" && entry.id === "enrollment",
    );
    if (object === undefined) {
      return undefined;
    }
    fields(object.value, [...INPUT_KEYS, "schema", "role", "epoch", "binding"]);
    const record = object.value as unknown as EnrollmentRecord;
    demand(
      record.schema === 1 &&
        record.role === state.role &&
        natural(record.epoch) &&
        record.epoch > 0,
    );
    binding(record.binding);
    this.#input(record);
    return structuredClone(record);
  }

  /**
   * The reference keys known when `record` was published, or null for a receipt without a
   * matching anchor. A null anchor treats every omitted reference as revoking.
   */
  #anchor(state: ProtocolState, record: EnrollmentRecord): Set<string> | null {
    const object = state.objects.find(
      (entry) => entry.collection === "intake" && entry.id === ANCHOR_ID,
    );
    if (object === undefined) {
      return null;
    }
    try {
      fields(object.value, ANCHOR_KEYS);
      const anchor = object.value as unknown as EnrollmentAnchor;
      demand(anchor.schema === 1 && anchor.kind === "enrollment-anchor");
      references(anchor.knownReferences);
      return anchor.receipt === receiptDigest(record)
        ? new Set(anchor.knownReferences.map(referenceKey))
        : null;
    } catch {
      return null;
    }
  }

  read(role: string): EnrollmentRecord | undefined {
    return this.#record(this.#protocol.read(role));
  }

  async publish(
    context: EnrollmentContext,
    input: EnrollmentInput,
    scope: EnrollmentScope,
  ): Promise<ProtocolEvent> {
    fields(input, INPUT_KEYS);
    this.#input(input);
    const record: EnrollmentRecord = {
      ...structuredClone(input),
      binding: structuredClone(context.binding),
      epoch: context.epoch,
      role: context.role,
      schema: 1,
    };
    const previous = this.#protocol
      .history(context.role)
      .find((event) => event.type === "transaction" && event.transaction.id === context.id);
    const current = this.#protocol.read(context.role);
    const object = current.objects.find(
      (entry) => entry.collection === "intake" && entry.id === "enrollment",
    );
    const anchorObject = current.objects.find(
      (entry) => entry.collection === "intake" && entry.id === ANCHOR_ID,
    );
    let anchor: ProtocolTransaction["mutations"][number] | undefined;
    if (previous === undefined) {
      const participants = this.#scope(scope);
      const participant = participants.get(context.role);
      demand(participant !== undefined, "enrollment-roster-mismatch");
      demand(input.registryRevision === scope.registryRevision, "enrollment-registry-mismatch");
      const mismatch = this.#matches(record, scope, participant);
      demand(mismatch === null, mismatch ?? "invalid-enrollment");
      const known = new Set(participant.knownReferences.map(referenceKey));
      demand(
        input.references.every((reference) => known.has(referenceKey(reference))),
        "enrollment-reference-mismatch",
      );
      this.#unknowns(context.role, input, participants);
      demand(Date.parse(input.inspectedAt) <= Date.parse(context.at), "enrollment-inspection-time");
      const value: EnrollmentAnchor = {
        kind: "enrollment-anchor",
        knownReferences: [...participant.knownReferences].sort((a, b) =>
          referenceKey(a).localeCompare(referenceKey(b)),
        ),
        receipt: receiptDigest(record),
        schema: 1,
      };
      anchor = {
        collection: "intake",
        expectedRevision: anchorObject?.revision ?? 0,
        id: ANCHOR_ID,
        value: structuredClone(
          value,
        ) as unknown as ProtocolTransaction["mutations"][number]["value"],
      };
    } else if (previous.type === "transaction") {
      // An exact retry replays the anchor recorded with the original attempt.
      anchor = previous.transaction.mutations.find((mutation) => mutation.id === ANCHOR_ID);
    }
    return this.#protocol.transact({
      ...context,
      mutations: [
        {
          collection: "intake",
          expectedRevision:
            previous?.type === "transaction"
              ? previous.transaction.mutations[0]!.expectedRevision
              : (object?.revision ?? 0),
          id: "enrollment",
          value: record as unknown as ProtocolTransaction["mutations"][number]["value"],
        },
        ...(anchor === undefined ? [] : [anchor]),
      ],
    });
  }

  report(scope: EnrollmentScope): EnrollmentReport {
    const participants = this.#scope(scope);
    const records = new Map<string, EnrollmentRecord>();
    const revisions = new Map<string, number>();
    const missing: string[] = [];
    const stale: { role: string; reason: string }[] = [];
    const omitted: { role: string; reference: EnrollmentReference }[] = [];
    const uncovered: { role: string; reference: EnrollmentReference }[] = [];
    const anchors = new Map<string, Set<string> | null>();
    const snapshots = new Map<string, ProtocolState>();
    for (const participant of participants.values()) {
      try {
        const snapshot = this.#protocol.read(participant.role);
        snapshots.set(participant.role, snapshot);
        const record = this.#record(snapshot);
        if (record === undefined) {
          continue;
        }
        const mismatch = this.#matches(record, scope, participant, snapshot);
        if (mismatch !== null) {
          stale.push({ reason: mismatch, role: participant.role });
          continue;
        }
        this.#unknowns(participant.role, record, participants);
        records.set(participant.role, record);
        anchors.set(participant.role, this.#anchor(snapshot, record));
        revisions.set(
          participant.role,
          snapshot.objects.find(
            (entry) => entry.collection === "intake" && entry.id === "enrollment",
          )!.revision,
        );
      } catch {
        stale.push({ reason: "enrollment-unavailable", role: participant.role });
      }
    }
    const unknowns = [...records.values()].flatMap((record) => [...record.unknowns]);
    const rows = [...participants.values()]
      .sort((a, b) => a.role.localeCompare(b.role))
      .map((participant) => {
        const record = records.get(participant.role);
        const seen = new Set(record?.references.map(referenceKey));
        const absent = participant.knownReferences.filter(
          (value) => !seen.has(referenceKey(value)),
        );
        omitted.push(...absent.map((reference) => ({ reference, role: participant.role })));
        const anchor = anchors.get(participant.role) ?? null;
        const later = absent.filter((value) => anchor?.has(referenceKey(value)) === false);
        uncovered.push(...later.map((reference) => ({ reference, role: participant.role })));
        const unknownComplete = participant.requiredUnknownScopes.every((required) =>
          record?.unknowns.some(
            (value) => value.participantRole === participant.role && value.scope === required,
          ),
        );
        // References known at publication must be listed; later references stay uncovered only.
        const own = record !== undefined && absent.length === later.length && unknownComplete;
        const fallback = unknowns.some(
          (value) =>
            value.participantRole === participant.role &&
            value.scope === "participant" &&
            value.parentRole === participant.parentRole,
        );
        const represented = own || fallback;
        if (!represented) {
          missing.push(participant.role);
        }
        return {
          adopted: own && scope.phase === "active",
          represented,
          revision: revisions.get(participant.role) ?? null,
          role: participant.role,
        };
      });
    for (const [role, snapshot] of snapshots) {
      demand(isDeepStrictEqual(snapshot, this.#protocol.read(role)), "enrollment-source-changed");
    }
    const allRepresented = rows.every((row) => row.represented);
    return {
      allAdopted: rows.every((row) => row.adopted),
      allRepresented,
      coverageComplete: allRepresented && omitted.length === 0 && unknowns.length === 0,
      missing,
      omitted: omitted.sort(
        (a, b) =>
          a.role.localeCompare(b.role) ||
          referenceKey(a.reference).localeCompare(referenceKey(b.reference)),
      ),
      participants: rows,
      stale: stale.sort((a, b) => a.role.localeCompare(b.role)),
      uncovered: uncovered.sort(
        (a, b) =>
          a.role.localeCompare(b.role) ||
          referenceKey(a.reference).localeCompare(referenceKey(b.reference)),
      ),
      unknowns: unknowns.sort(
        (a, b) => a.participantRole.localeCompare(b.participantRole) || a.id.localeCompare(b.id),
      ),
    };
  }
}
