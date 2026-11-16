// Canonical observations supply scope; publication discovery alone never proves enrollment coverage.
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { IntakeStore } from "../accounting/intake.ts";
import { LedgerStore } from "../accounting/store.ts";
import type { LedgerRequest } from "../accounting/types.ts";
import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import type { Layout } from "../layout.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import { readRegistry } from "../registry/store.ts";
import { protocolRole, ProtocolStore, protocolWorkerRole } from "./core.ts";
import {
  EnrollmentError,
  type EnrollmentParticipant,
  type EnrollmentPhase,
  type EnrollmentReference,
  type EnrollmentScope,
  EnrollmentStore,
} from "./enrollment.ts";
import type { ArtifactRef, Binding } from "./types.ts";
import { WorkStore } from "./work.ts";
/** Already collected supported census metadata. This adapter performs no native requests. */
export interface EnrollmentWorkerCensus {
  readonly parentRole: string;
  readonly parentBinding: Binding;
  readonly parentEpoch: number;
  readonly status: "complete" | "partial" | "unavailable";
  readonly evidence: ArtifactRef;
  readonly workers: readonly {
    readonly id: string;
    readonly parentNativeId: string;
    readonly lineageVerified: true;
  }[];
}
export interface EnrollmentScopeInput {
  readonly workspaceId: string;
  readonly generation: number;
  readonly phase: EnrollmentPhase;
  readonly stateRoot: string;
  readonly census?: readonly EnrollmentWorkerCensus[];
}
/** One replayed request view per operation, including explicit unknown when replay is unavailable. */
export function enrollmentRequests(directory: string): Map<string, LedgerRequest> {
  const view = new LedgerStore({ directory }).read();
  return new Map(view.requests.map((request) => [request.id, request]));
}
export function resolveEnrollmentScope(
  layout: Layout,
  protocol: ProtocolStore,
  input: EnrollmentScopeInput,
): EnrollmentScope {
  const registry = readRegistry(layout);
  const ledger = new LedgerStore({ directory: join(input.stateRoot, "accounting") });
  const view = ledger.read();
  const history = ledger.history();
  const last = history.at(-1);
  if ((last?.revision ?? 0) !== view.revision || (last?.hash ?? null) !== view.hash) {
    throw new EnrollmentError("enrollment-source-changed");
  }
  const participants = new Map<string, EnrollmentParticipant>();
  const references = new Map<string, EnrollmentReference[]>();
  const unknowns = new Map<string, Set<string>>();
  const add = (role: string, kind: EnrollmentReference["kind"], key: string) => {
    const values = references.get(role);
    if (!values) {
      throw new EnrollmentError("enrollment-roster-mismatch");
    }
    if (!values.some((ref) => ref.kind === kind && ref.key === key)) {
      values.push({ key, kind });
    }
  };
  const snapshots = new Map<string, ReturnType<ProtocolStore["read"]>>();
  const state = (role: string) => {
    if (!snapshots.has(role)) {
      snapshots.set(role, protocol.read(role));
    }
    return snapshots.get(role)!;
  };
  for (const role of Object.keys(registry.roles).sort()) {
    const namespace = protocolRole(role);
    const nativeId = resolveConversation(registry, role);
    const current = state(namespace);
    participants.set(namespace, {
      binding: nativeId === null ? null : { harness: resolveHarness(registry, role), nativeId },
      epoch: current.epoch || null,
      knownReferences: [],
      parentRole: namespace === "coordinator" ? null : "coordinator",
      requiredUnknownScopes: [],
      role: namespace,
    });
    references.set(namespace, []);
    unknowns.set(namespace, new Set(["external-wip", "native-history", "worker-census"]));
  }
  // A workspace without a registered coordinator cannot assign itself an invented parent.
  if (!participants.has("coordinator")) {
    for (const [role, p] of participants) {
      participants.set(role, { ...p, parentRole: null });
    }
  }
  for (const request of view.requests.filter(
    (value) =>
      !["completed", "cancelled", "superseded"].includes(value.state) ||
      (value.question !== null && ["pending", "unknown"].includes(value.question.status)),
  )) {
    const role = protocolRole(request.assignment?.ownerRole ?? request.createdBy);
    add(role, "request", request.id);
    if (request.question !== null) {
      add(role, "question", request.id);
    }
  }
  for (const coverage of view.coverage) {
    const role = protocolRole(coverage.ownerRole);
    add(role, "coverage", coverage.id);
  }
  try {
    for (const offer of new IntakeStore({
      directory: join(input.stateRoot, "accounting", "intake"),
    }).pending(history)) {
      add(protocolRole(offer.actor), "intake", offer.id);
    }
  } catch {
    for (const set of unknowns.values()) {
      set.add("intake-unavailable");
    }
  }
  for (const role of Object.keys(registry.roles)) {
    const p = participants.get(protocolRole(role))!;
    if (registry.roles[role]!.phase === "held" || registry.roles[role]!.phase === "source-held") {
      add(p.role, "hold", JSON.stringify([role, registry.roles[role]!.phase, p.binding]));
    }
  }
  const canonicalRoles = protocol.listRoles({ includeWorkers: true });
  for (const role of canonicalRoles.filter((role) => !role.includes("/workers/"))) {
    if (!participants.has(role) && state(role).objects.length > 0) {
      throw new EnrollmentError("enrollment-roster-mismatch");
    }
  }
  const canonicalWorkers = canonicalRoles.filter((role) => role.includes("/workers/"));
  for (const namespace of canonicalWorkers) {
    const child = state(namespace);
    const parent = child.parent;
    if (parent === null || !participants.has(parent.role)) {
      throw new EnrollmentError("enrollment-roster-mismatch");
    }
    const owner = participants.get(parent.role)!;
    if (owner.epoch !== parent.epoch) {
      // Historical children retain canonical evidence under their parent, without claiming current lineage.
      for (const object of child.objects.filter(
        (value) => value.collection === "submissions" || value.collection === "work",
      )) {
        add(
          parent.role,
          object.collection === "work" ? "work" : "submission",
          JSON.stringify([namespace, object.id]),
        );
      }
      continue;
    }
    participants.set(namespace, {
      binding: null,
      epoch: child.epoch || null,
      knownReferences: [],
      parentRole: parent.role,
      requiredUnknownScopes: [],
      role: namespace,
    });
    references.set(namespace, []);
    unknowns.set(namespace, new Set(["external-wip", "native-history", "worker-lineage"]));
  }
  const seen = new Set<string>();
  for (const census of input.census ?? []) {
    const parent = participants.get(census.parentRole);
    if (
      !parent ||
      seen.has(census.parentRole) ||
      parent.epoch !== census.parentEpoch ||
      !isDeepStrictEqual(parent.binding, census.parentBinding)
    ) {
      throw new EnrollmentError("enrollment-parent-mismatch");
    }
    seen.add(census.parentRole);
    if (protocol.readArtifact(census.evidence.hash).length !== census.evidence.size) {
      throw new EnrollmentError("enrollment-reference-mismatch");
    }
    for (const child of census.workers) {
      if (
        child.lineageVerified !== true ||
        !isCanonicalUuid(child.id) ||
        child.parentNativeId !== census.parentBinding.nativeId ||
        child.id === child.parentNativeId ||
        census.parentBinding.harness !== "codex"
      ) {
        throw new EnrollmentError("enrollment-parent-mismatch");
      }
      const namespace = protocolWorkerRole(census.parentRole, child.id, census.parentEpoch);
      const current = state(namespace);
      if (!participants.has(namespace)) {
        participants.set(namespace, {
          binding: { harness: "codex", nativeId: child.id },
          epoch: current.epoch || null,
          knownReferences: [],
          parentRole: census.parentRole,
          requiredUnknownScopes: [],
          role: namespace,
        });
        references.set(namespace, []);
        unknowns.set(namespace, new Set(["external-wip", "native-history"]));
      }
      const observed = participants.get(namespace)!;
      participants.set(namespace, {
        ...observed,
        binding: { harness: "codex", nativeId: child.id },
      });
      unknowns.get(namespace)?.delete("worker-lineage");
    }
    if (census.status === "complete") {
      unknowns.get(census.parentRole)?.delete("worker-census");
    }
  }
  for (const [role] of participants) {
    for (const object of state(role).objects) {
      if (
        object.collection === "work" ||
        object.collection === "submissions" ||
        object.collection === "messages"
      ) {
        add(
          role,
          object.collection === "work"
            ? "work"
            : object.collection === "submissions"
              ? "submission"
              : "original",
          JSON.stringify([role, object.id]),
        );
      }
    }
  }
  for (const [role, snapshot] of snapshots) {
    if (!isDeepStrictEqual(snapshot, protocol.read(role))) {
      throw new EnrollmentError("enrollment-source-changed");
    }
  }
  if (
    !isDeepStrictEqual(registry, readRegistry(layout)) ||
    !isDeepStrictEqual(
      view,
      new LedgerStore({ directory: join(input.stateRoot, "accounting") }).read(),
    )
  ) {
    throw new EnrollmentError("enrollment-source-changed");
  }
  return {
    generation: input.generation,
    ledgerAnchors: [
      { hash: null, revision: 0 },
      ...history.map((event) => ({ hash: event.hash, revision: event.revision })),
    ],
    participants: [...participants.values()].map((p) => ({
      ...p,
      knownReferences: references
        .get(p.role)!
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key)),
      requiredUnknownScopes: [...unknowns.get(p.role)!].sort(),
    })),
    phase: input.phase,
    registryRevision: registry.revision,
    workspaceId: input.workspaceId,
  };
}
export function enrollmentStatus(
  layout: Layout,
  protocol: ProtocolStore,
  input: EnrollmentScopeInput,
) {
  const scope = resolveEnrollmentScope(layout, protocol, input);
  return { report: new EnrollmentStore({ protocol }).report(scope), scope };
}
export const PROTOCOL_LIFECYCLE_PHASES = [
  "intake",
  "startup",
  "resume",
  "before-work",
  "worker-start",
  "worker-publication",
  "worker-finish",
  "parent-review",
  "integration",
  "handoff",
  "finish",
  "before-cleanup",
  "cleanup",
  "review",
] as const;
export type ProtocolLifecyclePhase = (typeof PROTOCOL_LIFECYCLE_PHASES)[number];
export function evaluateEnrollmentBoundary(
  layout: Layout,
  protocol: ProtocolStore,
  input: EnrollmentScopeInput & {
    readonly role: string;
    readonly boundary: ProtocolLifecyclePhase;
    readonly workId?: string;
    readonly workRole?: string;
  },
) {
  const current = enrollmentStatus(layout, protocol, input);
  const row = current.report.participants.find((value) => value.role === input.role);
  let reason:
    | "enrollment-required"
    | "approved-work-required"
    | "essential-evidence-required"
    | "role-guarded"
    | null = row?.adopted ? null : "enrollment-required";
  const registry = readRegistry(layout);
  const parent = input.role.split("/workers/")[0]!;
  const owner = Object.entries(registry.roles).find(([key]) => protocolRole(key) === parent)?.[1];
  if (
    !["intake", "review"].includes(input.boundary) &&
    (!owner ||
      owner.ownership !== "active" ||
      owner.phase === "held" ||
      owner.phase === "source-held")
  ) {
    reason = "role-guarded";
  }
  if (
    reason === null &&
    input.workRole !== undefined &&
    input.workRole !== input.role &&
    !(input.role.includes("/workers/") && input.workRole === parent)
  ) {
    reason = "approved-work-required";
  }
  if (reason === null && ["before-work", "worker-start"].includes(input.boundary)) {
    if (input.workId === undefined) {
      reason = "approved-work-required";
    } else {
      const requests = enrollmentRequests(join(input.stateRoot, "accounting"));
      const work = new WorkStore({ protocol, readRequest: (id) => requests.get(id) });
      const role = input.workRole ?? input.role;
      const value = work.read(role, input.workId);
      const evaluation = value === undefined ? null : work.evaluate(role, input.workId);
      if (value === undefined || evaluation?.authorization !== "reviewed" || evaluation.guarded) {
        reason = "approved-work-required";
      }
    }
  }
  if (
    reason === null &&
    ["worker-finish", "handoff", "finish", "before-cleanup", "cleanup"].includes(input.boundary)
  ) {
    const requests = enrollmentRequests(join(input.stateRoot, "accounting"));
    const work = new WorkStore({ protocol, readRequest: (id) => requests.get(id) });
    const role = input.workRole ?? input.role;
    const value = input.workId === undefined ? undefined : work.read(role, input.workId);
    if (
      value === undefined ||
      (value.definition.retention === null && !work.evaluate(role, input.workId!).closureReady)
    ) {
      reason = "essential-evidence-required";
    }
    if (
      ["before-cleanup", "cleanup"].includes(input.boundary) &&
      !value?.definition.artifacts.some(
        (artifact) => artifact.size > 0 && artifact.hash !== value.definition.plan.hash,
      )
    ) {
      reason = "essential-evidence-required";
    }
    if (value !== undefined) {
      protocol.readArtifact(value.definition.plan.hash);
      for (const artifact of value.definition.artifacts) {
        protocol.readArtifact(artifact.hash);
      }
    }
    if (
      input.role.includes("/workers/") &&
      !value?.accepted.some((entry) => entry.submission.role === input.role)
    ) {
      reason = "essential-evidence-required";
    }
  }
  return { ...current, admission: { allowed: reason === null, reason, requiredOwner: input.role } };
}
