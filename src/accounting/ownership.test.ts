import { describe, expect, it } from "vitest";

import { validateGameCoordinatorConfig } from "../layout.ts";
import { validateRegistry } from "../registry/schema.ts";
import { CLAUDE_TECH, coordinatorConfig, registryInput } from "../testFixtures.ts";
import { projectOwnerBinding } from "./ownership.ts";
import type { LedgerAssignment } from "./types.ts";

describe("read-only accounting owner projection", () => {
  it("distinguishes missing registry, missing native routing and unverified workers without changing history", () => {
    const registry = validateRegistry(validateGameCoordinatorConfig(coordinatorConfig()), {
      ...registryInput(),
      revision: 1,
      updatedAt: "2026-11-16T01:00:00.000Z",
    });
    const role = "archies-dog-walks/tech";
    const assignment: LedgerAssignment = {
      harness: "claude",
      nativeId: CLAUDE_TECH,
      ownerRole: role,
      worker: null,
    };
    const request = { assignment, createdBy: role };
    const original = structuredClone(request);
    expect(projectOwnerBinding(null, request)).toMatchObject({
      currentRole: null,
      reason: "registry-unavailable",
      registryRevision: null,
      status: "unavailable",
    });
    expect(projectOwnerBinding(registry, { assignment: null, createdBy: role })).toMatchObject({
      reason: "unassigned",
      status: "unassigned",
    });
    expect(projectOwnerBinding({ ...registry, roles: {} }, request)).toMatchObject({
      reason: "role-missing",
      status: "stale",
    });
    const unavailable = {
      ...registry,
      roles: {
        ...registry.roles,
        [role]: { ...registry.roles[role]!, conversations: {} },
      },
    };
    expect(projectOwnerBinding(unavailable, request)).toMatchObject({
      currentRole: { nativeId: null, role },
      reason: "conversation-unavailable",
      status: "unavailable",
    });
    expect(
      projectOwnerBinding(registry, {
        ...request,
        assignment: {
          ...assignment,
          nativeId: null,
        },
      }),
    ).toMatchObject({ reason: "recorded-binding-unavailable", status: "unavailable" });
    const workerId = "00000000-0000-4000-8000-000000000099";
    expect(
      projectOwnerBinding(registry, {
        ...request,
        assignment: {
          ...assignment,
          nativeId: workerId,
          worker: {
            id: workerId,
            parentNativeId: CLAUDE_TECH,
            parentRole: role,
            verificationRef: "historical-proof",
          },
        },
      }),
    ).toMatchObject({
      currentRole: { nativeId: CLAUDE_TECH, role },
      reason: "worker-lineage-unverified",
      status: "unavailable",
      workerLineage: "not-checked",
    });
    expect(request).toEqual(original);
  });
});
