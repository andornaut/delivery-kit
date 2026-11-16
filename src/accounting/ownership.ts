// Current registry routing is a read-only projection, separate from recorded assignments.
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import type { Harness, Registry } from "../registry/schema.ts";
import type { LedgerRequest } from "./types.ts";

export type OwnerBindingStatus = "unassigned" | "current" | "stale" | "unavailable";
export type OwnerBindingReason =
  | "unassigned"
  | "registry-unavailable"
  | "role-missing"
  | "conversation-unavailable"
  | "recorded-binding-unavailable"
  | "harness-changed"
  | "native-id-changed"
  | "worker-parent-changed"
  | "worker-binding-mismatch"
  | "worker-lineage-unverified";

export interface OwnerBinding {
  readonly status: OwnerBindingStatus;
  readonly registryRevision: number | null;
  /** Permanent role binding. For workers, this is the current parent, not the worker identity. */
  readonly currentRole: {
    readonly role: string;
    readonly harness: Harness;
    readonly nativeId: string | null;
  } | null;
  readonly reason: OwnerBindingReason | null;
  readonly workerLineage: "not-applicable" | "not-checked";
}

/** Registry equality proves routing only, never native availability or worker lineage. */
export function projectOwnerBinding(
  registry: Registry | null,
  request: Pick<LedgerRequest, "assignment" | "createdBy">,
): OwnerBinding {
  const { assignment } = request;
  const role = assignment?.ownerRole ?? request.createdBy;
  const worker = assignment?.worker ?? null;
  const base = {
    currentRole: null,
    registryRevision: registry?.revision ?? null,
    workerLineage: worker === null ? ("not-applicable" as const) : ("not-checked" as const),
  };
  if (registry === null) {
    return {
      ...base,
      reason: assignment === null ? "unassigned" : "registry-unavailable",
      status: assignment === null ? "unassigned" : "unavailable",
    };
  }
  if (!Object.hasOwn(registry.roles, role)) {
    return {
      ...base,
      reason: assignment === null ? "unassigned" : "role-missing",
      status: assignment === null ? "unassigned" : "stale",
    };
  }
  const harness = resolveHarness(registry, role);
  const nativeId = resolveConversation(registry, role);
  const binding = { ...base, currentRole: { harness, nativeId, role } };
  if (assignment === null) {
    return { ...binding, reason: "unassigned", status: "unassigned" };
  }
  if (nativeId === null) {
    return { ...binding, reason: "conversation-unavailable", status: "unavailable" };
  }
  if (assignment.harness === null || assignment.nativeId === null) {
    return { ...binding, reason: "recorded-binding-unavailable", status: "unavailable" };
  }
  if (assignment.harness !== harness) {
    return { ...binding, reason: "harness-changed", status: "stale" };
  }
  if (worker !== null) {
    if (worker.parentRole !== role || worker.parentNativeId !== nativeId) {
      return { ...binding, reason: "worker-parent-changed", status: "stale" };
    }
    if (assignment.nativeId !== worker.id) {
      return { ...binding, reason: "worker-binding-mismatch", status: "stale" };
    }
    return { ...binding, reason: "worker-lineage-unverified", status: "unavailable" };
  }
  if (assignment.nativeId !== nativeId) {
    return { ...binding, reason: "native-id-changed", status: "stale" };
  }
  return { ...binding, reason: null, status: "current" };
}
