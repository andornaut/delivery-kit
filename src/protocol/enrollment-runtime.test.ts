import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadLayout } from "../layout.ts";
import { createRegistry, type Registry, updateRegistry } from "../registry/index.ts";
import { CLAUDE_COORDINATOR, makeFixture, registryInput } from "../testFixtures.ts";
import { ProtocolStore, protocolWorkerRole } from "./core.ts";
import { EnrollmentStore } from "./enrollment.ts";
import { enrollmentStatus, resolveEnrollmentScope } from "./enrollment-runtime.ts";
const AT = "2026-11-16T06:00:00.000Z";
const ROLE = "coordinator";
const BINDING = { harness: "claude" as const, nativeId: CLAUDE_COORDINATOR };
async function fixture() {
  const t = makeFixture();
  const layout = loadLayout(t.root);
  const registry = createRegistry(
    layout,
    registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">,
  );
  const stateRoot = join(t.base, "state");
  const protocol = new ProtocolStore({ directory: stateRoot, resolveBinding: () => true });
  await protocol.claim({
    at: AT,
    binding: BINDING,
    evidence: "fixture:owner",
    expectedEpoch: 0,
    role: ROLE,
  });
  return {
    ...t,
    input: { generation: 1, phase: "active" as const, stateRoot, workspaceId: "fixture" },
    layout,
    protocol,
    registry,
  };
}
describe("canonical enrollment scope", () => {
  it("requires actual registry owners and UNKNOWN scopes instead of empty publication discovery", async () => {
    const t = await fixture();
    const scope = resolveEnrollmentScope(t.layout, t.protocol, t.input);
    expect(scope.participants.map((p) => p.role)).toEqual([
      "games/archies-dog-walks/tech",
      "coordinator",
    ]);
    const own = scope.participants.find((p) => p.role === ROLE)!;
    expect(own.requiredUnknownScopes).toEqual(["external-wip", "native-history", "worker-census"]);
    expect(new EnrollmentStore({ protocol: t.protocol }).report(scope).allRepresented).toBe(false);
    const evidence = await t.protocol.putArtifact(
      Buffer.from("fixture audited unavailable native scope"),
    );
    await new EnrollmentStore({ protocol: t.protocol }).publish(
      { at: AT, binding: BINDING, epoch: 1, expectedRevision: 1, id: "enrollment-one", role: ROLE },
      {
        evidence: [evidence],
        generation: 1,
        inspectedAt: AT,
        ledger: { hash: null, revision: 0 },
        phase: "active",
        references: [],
        registryRevision: scope.registryRevision,
        unknowns: [
          ...own.requiredUnknownScopes.map((source, index) => ({
            evidence: [evidence],
            id: `unknown-${index}`,
            nextBoundary: "next owner review",
            parentRole: ROLE,
            participantRole: ROLE,
            reason: "fixture unavailable",
            scope: source,
          })),
          {
            evidence: [evidence],
            id: "unknown-owner",
            nextBoundary: "next parent review",
            parentRole: ROLE,
            participantRole: "games/archies-dog-walks/tech",
            reason: "fixture owner unavailable",
            scope: "participant",
          },
        ],
        workspaceId: "fixture",
      },
      scope,
    );
    const checked = enrollmentStatus(t.layout, t.protocol, t.input);
    expect(checked.report).toMatchObject({
      allAdopted: false,
      allRepresented: true,
      coverageComplete: false,
    });
    expect(checked.report.participants.find((p) => p.role === ROLE)?.adopted).toBe(true);
  });
  it("does not turn a canonical child namespace into fresh lineage or omit an unmapped owner", async () => {
    const t = await fixture();
    const parent = "games/archies-dog-walks/tech";
    const parentBinding = {
      harness: "codex" as const,
      nativeId: "00000000-0000-4000-8000-000000000002",
    };
    updateRegistry(t.layout, t.registry.revision, (draft) => {
      draft.roles["archies-dog-walks/tech"]!.harness = "codex";
    });
    await t.protocol.claim({
      at: AT,
      binding: parentBinding,
      evidence: "fixture:parent",
      expectedEpoch: 0,
      role: parent,
    });
    const id = "00000000-0000-4000-8000-000000000004";
    const child = protocolWorkerRole(parent, id, 1);
    await t.protocol.claim({
      at: AT,
      binding: { harness: "codex", nativeId: id },
      evidence: "fixture:verified-child",
      expectedEpoch: 0,
      parent: { epoch: 1, role: parent, workerId: id },
      role: child,
    });
    const before = resolveEnrollmentScope(t.layout, t.protocol, t.input);
    expect(before.participants.find((p) => p.role === child)).toMatchObject({
      binding: null,
      requiredUnknownScopes: ["external-wip", "native-history", "worker-lineage"],
    });
    const evidence = await t.protocol.putArtifact(
      Buffer.from("fixture supported lineage observation"),
    );
    const verified = resolveEnrollmentScope(t.layout, t.protocol, {
      ...t.input,
      census: [
        {
          evidence,
          parentBinding,
          parentEpoch: 1,
          parentRole: parent,
          status: "partial",
          workers: [{ id, lineageVerified: true, parentNativeId: parentBinding.nativeId }],
        },
      ],
    });
    expect(verified.participants.find((p) => p.role === child)?.binding).toEqual({
      harness: "codex",
      nativeId: id,
    });
    expect(verified.participants.find((p) => p.role === parent)?.requiredUnknownScopes).toContain(
      "worker-census",
    );
    updateRegistry(t.layout, 2, (draft) => {
      delete draft.roles["archies-dog-walks/tech"];
    });
    expect(() => resolveEnrollmentScope(t.layout, t.protocol, t.input)).toThrow(
      "enrollment-roster-mismatch",
    );
  });
});
