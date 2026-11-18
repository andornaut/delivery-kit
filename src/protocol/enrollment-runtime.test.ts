import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { IntakeStore } from "../accounting/intake.ts";
import { LedgerStore } from "../accounting/store.ts";
import type { LedgerCommand, LedgerSource } from "../accounting/types.ts";
import { loadLayout } from "../layout.ts";
import { createRegistry, readRegistry, type Registry, updateRegistry } from "../registry/index.ts";
import * as registryStore from "../registry/store.ts";
import { CLAUDE_COORDINATOR, CLAUDE_TECH, makeFixture, registryInput } from "../testFixtures.ts";
import { ProtocolStore, protocolWorkerRole } from "./core.ts";
import { EnrollmentStore } from "./enrollment.ts";
import {
  enrollmentStatus,
  evaluateEnrollmentBoundary,
  resolveEnrollmentScope,
} from "./enrollment-runtime.ts";
import { ProtocolMessages } from "./messages.ts";
import type { Binding } from "./types.ts";
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
const SOURCE: LedgerSource = {
  native: null,
  origin: "owner-attested",
  reference: "fixture:approved-work",
  wordingHash: null,
};
function fixtureRequest(id: string) {
  return {
    assignment: null,
    dependencies: [],
    id,
    kind: "request" as const,
    parentId: null,
    question: null,
    reviewed: true,
    source: SOURCE,
    summary: "Fixture approved work",
    targets: [
      {
        consumers: [],
        criteria: [
          { description: "Checked source", id: "check", requiredEvidence: ["check" as const] },
        ],
        description: "Exact source",
        id: "target",
      },
    ],
  };
}
async function approvedWork(
  t: Awaited<ReturnType<typeof fixture>>,
  role: string,
  binding: Binding,
) {
  const ledger = new LedgerStore({ directory: join(t.input.stateRoot, "accounting") });
  let sequence = 0;
  const send = (command: LedgerCommand) =>
    ledger.apply({
      actor: "game-coordinator",
      at: AT,
      command,
      commandId: `${role}-fixture-${++sequence}`,
      expectedRevision: ledger.read().revision,
      schema: 1,
      source: SOURCE,
    });
  const artifact = await t.protocol.putArtifact(Buffer.from(`fixture essential source ${role}`));
  const plan = await t.protocol.putArtifact(Buffer.from(`fixture plan ${role}`));
  const work = new WorkStore({ protocol: t.protocol, readRequest: (id) => ledger.read(id) });
  const writer = (id: string) => ({
    at: AT,
    binding,
    epoch: t.protocol.read(role).epoch,
    expectedRevision: t.protocol.read(role).revision,
    id,
    role,
  });
  const publish = (id: string, requestId: string) =>
    work.publish(writer(`publish-${id}`), {
      definition: {
        artifacts: [artifact],
        clauseIds: [],
        criteria: [{ consumers: [], id: "check", phases: ["check"], targetId: "target" }],
        id,
        messageIds: [],
        plan,
        requestIds: [requestId],
        retention: null,
        source: {
          base: "b".repeat(40),
          commit: "a".repeat(40),
          dependencies: [],
          tree: "c".repeat(40),
        },
      },
      expectedWorkRevision: 0,
      ready: false,
      replaces: null,
    });
  const enroll = async (scope: ReturnType<typeof resolveEnrollmentScope>, id = "enrollment") => {
    const own = scope.participants.find((p) => p.role === role)!;
    return new EnrollmentStore({ protocol: t.protocol }).publish(
      writer(id),
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
          parentRole: own.parentRole ?? role,
          participantRole: role,
          reason: "unavailable source",
          scope: unknown,
        })),
        workspaceId: "fixture",
      },
      scope,
    );
  };
  return { artifact, enroll, publish, send, writer };
}
describe("canonical enrollment scope", () => {
  it("keeps an own active receipt adopted while later publications stay uncovered", async () => {
    const t = await fixture();
    const owner = await approvedWork(t, ROLE, BINDING);
    await owner.send({ request: fixtureRequest("request-one"), type: "register" });
    await owner.publish("work-one", "request-one");
    await owner.enroll(resolveEnrollmentScope(t.layout, t.protocol, t.input));
    const boundary = (phase: Parameters<typeof evaluateEnrollmentBoundary>[2]["boundary"]) =>
      evaluateEnrollmentBoundary(t.layout, t.protocol, {
        ...t.input,
        boundary: phase,
        role: ROLE,
        workId: "work-one",
      });
    expect(boundary("before-work").admission.allowed).toBe(true);
    await new ProtocolMessages({ store: t.protocol }).publish(owner.writer("message-publish"), {
      envelope: {
        body: "Exact later original\n",
        created: AT,
        fromRole: "game-coordinator",
        id: "message-later",
        intent: "queue",
        schema: 1,
        toRole: "archies-dog-walks/tech",
      },
      guards: { artifacts: [], hold: "unknown", question: "unknown", references: [] },
      links: { clauseIds: [], messageIds: [], requestIds: [], workIds: [] },
    });
    await owner.send({ request: fixtureRequest("request-later"), type: "register" });
    await owner.publish("work-later", "request-later");
    new IntakeStore({ directory: join(t.input.stateRoot, "accounting", "intake") }).offer({
      actor: "game-coordinator",
      command: {
        coverage: [],
        requests: [
          {
            assignment: null,
            dependencies: [],
            id: "request-offered",
            kind: "unknown",
            parentId: null,
            question: null,
            reviewed: false,
            source: SOURCE,
            summary: "Observed source awaiting owner review",
            targets: [],
          },
        ],
        type: "capture",
      },
      source: SOURCE,
    });
    for (const phase of ["before-work", "resume"] as const) {
      const checked = boundary(phase);
      expect(checked.admission).toEqual({ allowed: true, reason: null, requiredOwner: ROLE });
      expect(checked.report.participants.find((p) => p.role === ROLE)).toMatchObject({
        adopted: true,
        represented: true,
      });
      expect(checked.report.coverageComplete).toBe(false);
      expect(checked.report.uncovered.map((entry) => [entry.role, entry.reference.kind])).toEqual(
        expect.arrayContaining([
          [ROLE, "original"],
          [ROLE, "work"],
          [ROLE, "request"],
          [ROLE, "intake"],
        ]),
      );
      expect(checked.report.uncovered).toEqual(
        checked.report.omitted.filter((entry) => entry.role === ROLE),
      );
    }
    // An epoch change still invalidates the receipt instead of anchoring it.
    await t.protocol.claim({
      at: AT,
      binding: BINDING,
      evidence: "fixture:reclaim",
      expectedEpoch: 1,
      role: ROLE,
    });
    expect(boundary("resume").admission.reason).toBe("enrollment-required");
  });

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
  it("admits interleaved enrollments by two roles and refuses only the role whose own journal changed", async () => {
    const t = await fixture();
    const TECH = "games/archies-dog-walks/tech";
    const techBinding = { harness: "claude" as const, nativeId: CLAUDE_TECH };
    await t.protocol.claim({
      at: AT,
      binding: techBinding,
      evidence: "fixture:tech",
      expectedEpoch: 0,
      role: TECH,
    });
    const coordinator = await approvedWork(t, ROLE, BINDING);
    const tech = await approvedWork(t, TECH, techBinding);
    const coordinatorScope = resolveEnrollmentScope(t.layout, t.protocol, {
      ...t.input,
      role: ROLE,
    });
    const techScope = resolveEnrollmentScope(t.layout, t.protocol, { ...t.input, role: TECH });
    await tech.enroll(techScope);
    // The tech role's later message original does not invalidate the coordinator's inspection.
    await new ProtocolMessages({ store: t.protocol }).publish(tech.writer("tech-message"), {
      envelope: {
        body: "Unrelated tech original\n",
        created: AT,
        fromRole: "archies-dog-walks/tech",
        id: "tech-message",
        intent: "queue",
        schema: 1,
        toRole: "game-coordinator",
      },
      guards: { artifacts: [], hold: "unknown", question: "unknown", references: [] },
      links: { clauseIds: [], messageIds: [], requestIds: [], workIds: [] },
    });
    await coordinator.enroll(coordinatorScope);
    for (const role of [ROLE, TECH]) {
      const checked = evaluateEnrollmentBoundary(t.layout, t.protocol, {
        ...t.input,
        boundary: "resume",
        role,
      });
      expect(checked.admission, role).toMatchObject({ allowed: true });
    }
    // A concurrent write lands in the other role's journal between the scan and the recheck.
    const read = t.protocol.read.bind(t.protocol);
    const before = read(TECH);
    let techReads = 0;
    const spy = vi.spyOn(t.protocol, "read").mockImplementation((role) => {
      if (role !== TECH) {
        return read(role);
      }
      techReads += 1;
      return techReads === 1 ? before : { ...read(role), revision: before.revision + 1 };
    });
    expect(() => enrollmentStatus(t.layout, t.protocol, { ...t.input, role: ROLE })).not.toThrow();
    techReads = 0;
    expect(() => resolveEnrollmentScope(t.layout, t.protocol, { ...t.input, role: TECH })).toThrow(
      "enrollment-source-changed",
    );
    spy.mockRestore();
    // A change to the enrolling role's own registry entry still refuses its scope.
    const registry = readRegistry(t.layout);
    const reads = vi.spyOn(registryStore, "readRegistry");
    reads.mockReturnValueOnce(registry).mockImplementation(() => ({
      ...registry,
      roles: {
        ...registry.roles,
        "game-coordinator": {
          ...registry.roles["game-coordinator"]!,
          conversations: { claude: "00000000-0000-4000-8000-000000000099" },
        },
      },
    }));
    expect(() => resolveEnrollmentScope(t.layout, t.protocol, { ...t.input, role: ROLE })).toThrow(
      "enrollment-source-changed",
    );
    reads.mockReturnValueOnce(registry).mockImplementation(() => ({
      ...registry,
      roles: {
        ...registry.roles,
        "archies-dog-walks/tech": {
          ...registry.roles["archies-dog-walks/tech"]!,
          phase: "held",
        },
      },
    }));
    expect(() =>
      resolveEnrollmentScope(t.layout, t.protocol, { ...t.input, role: ROLE }),
    ).not.toThrow();
    reads.mockRestore();
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
