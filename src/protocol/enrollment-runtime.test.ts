import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LedgerStore } from "../accounting/store.ts";
import type { LedgerCommand, LedgerSource } from "../accounting/types.ts";
import { loadLayout } from "../layout.ts";
import { createRegistry, type Registry, updateRegistry } from "../registry/index.ts";
import { CLAUDE_COORDINATOR, makeFixture, registryInput } from "../testFixtures.ts";
import { ProtocolStore, protocolWorkerRole } from "./core.ts";
import { EnrollmentStore } from "./enrollment.ts";
import {
  enrollmentStatus,
  evaluateEnrollmentBoundary,
  resolveEnrollmentScope,
} from "./enrollment-runtime.ts";
import { WorkStore } from "./work.ts";
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
  it("allows completed evidence cleanup without reopening execution or cancelled authority", async () => {
    const t = await fixture();
    const ledger = new LedgerStore({ directory: join(t.input.stateRoot, "accounting") });
    const source: LedgerSource = {
      native: null,
      origin: "owner-attested",
      reference: "fixture:approved-work",
      wordingHash: null,
    };
    let sequence = 0;
    const send = (command: LedgerCommand) =>
      ledger.apply({
        actor: "game-coordinator",
        at: AT,
        command,
        commandId: `fixture-${++sequence}`,
        expectedRevision: ledger.read().revision,
        schema: 1,
        source,
      });
    await send({
      request: {
        assignment: null,
        dependencies: [],
        id: "request-one",
        kind: "request",
        parentId: null,
        question: null,
        reviewed: true,
        source,
        summary: "Fixture approved cleanup work",
        targets: [
          {
            consumers: [],
            criteria: [
              { description: "Canonical checked source", id: "check", requiredEvidence: ["check"] },
            ],
            description: "Exact source",
            id: "target",
          },
        ],
      },
      type: "register",
    });
    const artifact = await t.protocol.putArtifact(
      Buffer.from("fixture retained essential source package"),
    );
    const plan = await t.protocol.putArtifact(Buffer.from("fixture scoped plan"));
    const pin = {
      base: "b".repeat(40),
      commit: "a".repeat(40),
      dependencies: [],
      tree: "c".repeat(40),
    };
    const work = new WorkStore({ protocol: t.protocol, readRequest: (id) => ledger.read(id) });
    const writer = (id: string) => ({
      at: AT,
      binding: BINDING,
      epoch: 1,
      expectedRevision: t.protocol.read(ROLE).revision,
      id,
      role: ROLE,
    });
    await work.publish(writer("work-publish"), {
      definition: {
        artifacts: [artifact],
        clauseIds: [],
        criteria: [{ consumers: [], id: "check", phases: ["check"], targetId: "target" }],
        id: "work-one",
        messageIds: [],
        plan,
        requestIds: ["request-one"],
        retention: null,
        source: pin,
      },
      expectedWorkRevision: 0,
      ready: false,
      replaces: null,
    });
    await work.receipt(writer("work-check"), {
      expectedWorkRevision: 1,
      receipt: {
        artifact,
        consumer: null,
        criterionId: "check",
        definitionHash: work.read(ROLE, "work-one")!.definitionHash,
        id: "work-check-proof",
        outcome: "passed",
        phase: "check",
        source: pin,
        workId: "work-one",
      },
      workId: "work-one",
    });
    await send({
      evidence: {
        consumer: null,
        criterionId: "check",
        id: "ledger-check",
        kind: "check",
        outcome: "passed",
        reference: `protocol-artifact:${artifact.hash}`,
        targetId: "target",
      },
      id: "request-one",
      type: "evidence",
    });
    const scope = resolveEnrollmentScope(t.layout, t.protocol, t.input);
    const own = scope.participants.find((p) => p.role === ROLE)!;
    await new EnrollmentStore({ protocol: t.protocol }).publish(
      writer("enrollment"),
      {
        evidence: [artifact],
        generation: 1,
        inspectedAt: AT,
        ledger: scope.ledgerAnchors.at(-1)!,
        phase: "active",
        references: own.knownReferences,
        registryRevision: scope.registryRevision,
        unknowns: own.requiredUnknownScopes.map((unknown, index) => ({
          evidence: [artifact],
          id: `unknown-${index}`,
          nextBoundary: "next owner audit",
          parentRole: ROLE,
          participantRole: ROLE,
          reason: "unavailable source",
          scope: unknown,
        })),
        workspaceId: "fixture",
      },
      scope,
    );
    const boundary = (phase: Parameters<typeof evaluateEnrollmentBoundary>[2]["boundary"]) =>
      evaluateEnrollmentBoundary(t.layout, t.protocol, {
        ...t.input,
        boundary: phase,
        role: ROLE,
        workId: "work-one",
      }).admission;
    expect(boundary("before-work").allowed).toBe(true);
    await send({
      evidenceIds: ["ledger-check"],
      id: "request-one",
      reason: "Actual checked source complete",
      type: "close",
    });
    expect(
      new LedgerStore({ directory: join(t.input.stateRoot, "accounting") }).read("request-one")
        ?.state,
    ).toBe("completed");
    expect(boundary("before-work").reason).toBe("approved-work-required");
    expect(boundary("worker-start").reason).toBe("approved-work-required");
    expect(boundary("finish").allowed).toBe(true);
    expect(boundary("before-cleanup").allowed).toBe(true);
    expect(boundary("cleanup").allowed).toBe(true);
    updateRegistry(t.layout, 1, (draft) => {
      draft.roles["game-coordinator"]!.phase = "held";
    });
    expect(boundary("cleanup").reason).toBe("role-guarded");
    updateRegistry(t.layout, 2, (draft) => {
      draft.roles["game-coordinator"]!.phase = "active";
    });
    await send({
      evidenceRef: "fixture:reopened",
      id: "request-one",
      reason: "New owner review",
      type: "reopen",
    });
    await send({
      authorityRef: "fixture:cancelled",
      descendants: [],
      id: "request-one",
      reason: "Explicit cancellation",
      type: "cancel",
    });
    expect(boundary("cleanup").allowed).toBe(false);
  });
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
