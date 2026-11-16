import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LedgerRequest } from "../accounting/types.ts";
import { ProtocolStore, protocolWorkerRole } from "./core.ts";
import type { ArtifactRef, Binding } from "./types.ts";
import {
  type WorkContext,
  type WorkDefinition,
  type WorkPhase,
  type WorkReceipt,
  WorkStore,
} from "./work.ts";

const roots: string[] = [];
const ROLE = "kits/game-kit";
const BINDING: Binding = { harness: "codex", nativeId: "00000000-0000-4000-8000-000000000001" };
const SOURCE = {
  commit: "a".repeat(40),
  base: "b".repeat(40),
  tree: "c".repeat(40),
  dependencies: [],
};
const AT = "2026-11-16T04:00:00Z";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true });
  }
});

function authority(): LedgerRequest {
  return {
    id: "request-one",
    kind: "request",
    reviewed: true,
    summary: "Fixture approved source work",
    source: {
      origin: "owner-attested",
      reference: "fixture-user-approval",
      native: null,
      wordingHash: null,
    },
    assignment: null,
    parentId: null,
    dependencies: [],
    question: null,
    targets: [
      {
        id: "target-one",
        description: "Fixture target",
        consumers: ["consumer-a", "consumer-b"],
        criteria: [
          {
            id: "criterion-one",
            description: "Fixture criterion",
            requiredEvidence: [
              "implementation",
              "check",
              "integration",
              "publication",
              "consumer-adoption",
              "delivery",
              "deployment",
              "acceptance",
            ],
          },
        ],
      },
    ],
    createdBy: "game-kit",
    sources: [],
    state: "open",
    createdAt: AT,
    updatedAt: AT,
    revision: 1,
    children: [],
    evidence: [],
    closureEvidenceIds: [],
    reason: null,
    requiredOwner: null,
    nextBoundary: null,
    replacementId: null,
  };
}

async function fixture(
  phases: WorkPhase[] = ["check", "integration", "delivery", "deployment", "acceptance"],
  consumers: string[] = [],
) {
  const root = mkdtempSync(join(tmpdir(), "protocol-work-"));
  roots.push(root);
  const allowed = new Map<string, Binding>([[ROLE, BINDING]]);
  const protocol = new ProtocolStore({
    directory: join(root, "state"),
    resolveBinding: (role, binding) =>
      allowed.get(role)?.harness === binding.harness &&
      allowed.get(role)?.nativeId === binding.nativeId,
  });
  await protocol.claim({
    role: ROLE,
    expectedEpoch: 0,
    binding: BINDING,
    evidence: "fixture-owner",
    at: AT,
  });
  const request = authority();
  const work = new WorkStore({
    protocol,
    readRequest: (id) => (id === request.id ? request : undefined),
  });
  const task = join(root, "task");
  mkdirSync(task);
  writeFileSync(join(task, "plan.txt"), "Fixture canonical plan\n");
  const plan = await protocol.putArtifact(readFileSync(join(task, "plan.txt")));
  const evidence = await protocol.putArtifact(Buffer.from("Fixture immutable evidence\n"));
  const definition: WorkDefinition = {
    id: "work-one",
    requestIds: [request.id],
    clauseIds: ["clause-one"],
    messageIds: ["message-one"],
    plan,
    artifacts: [evidence],
    criteria: [{ id: "criterion-one", targetId: "target-one", phases, consumers }],
    source: SOURCE,
    retention: null,
  };
  let serial = 0;
  const context = (role = ROLE): WorkContext => {
    const current = protocol.read(role);
    return {
      id: `transaction-${++serial}`,
      role,
      epoch: current.epoch,
      binding: current.binding!,
      expectedRevision: current.revision,
      at: AT,
    };
  };
  const objectRevision = () =>
    protocol.read(ROLE).objects.find((o) => o.collection === "work")?.revision ?? 0;
  const publish = async (ready = false) =>
    work.publish(context(), {
      definition,
      expectedWorkRevision: objectRevision(),
      ready,
      replaces: null,
    });
  const receipt = (phase: WorkPhase, consumer: string | null = null): WorkReceipt => ({
    id: `receipt-${phase}-${consumer ?? "all"}-${++serial}`,
    workId: definition.id,
    definitionHash: work.read(ROLE, definition.id)!.definitionHash,
    criterionId: "criterion-one",
    phase,
    consumer,
    outcome: "passed",
    artifact: evidence,
    source: SOURCE,
  });
  const record = async (phase: WorkPhase, consumer: string | null = null) =>
    work.receipt(context(), {
      workId: definition.id,
      expectedWorkRevision: objectRevision(),
      receipt: receipt(phase, consumer),
    });
  return {
    root,
    task,
    allowed,
    protocol,
    request,
    work,
    definition,
    evidence,
    context,
    objectRevision,
    publish,
    receipt,
    record,
  };
}

describe("protocol work publications", () => {
  it("requires canonical READY evidence, survives task cleanup and replays exact publication IDs", async () => {
    const f = await fixture();
    await f.publish();
    await expect(f.publish(true)).rejects.toMatchObject({ code: "ready-evidence-missing" });
    await f.record("check");
    const context = f.context();
    const input = {
      definition: f.definition,
      expectedWorkRevision: f.objectRevision(),
      ready: true,
      replaces: null,
    };
    await f.work.publish(context, input);
    const revision = f.protocol.read(ROLE).revision;
    expect(await f.work.publish(context, input)).toMatchObject({ type: "transaction" });
    expect(f.protocol.read(ROLE).revision).toBe(revision);
    await expect(f.work.publish(context, { ...input, ready: false })).rejects.toMatchObject({
      code: "work-operation-conflict",
    });
    rmSync(f.task, { recursive: true });
    expect(Buffer.from(f.protocol.readArtifact(f.definition.plan.hash)).toString()).toBe(
      "Fixture canonical plan\n",
    );
    expect(f.work.read(ROLE, f.definition.id)?.ready).toBe(true);
    await expect(
      f.work.publish(f.context(), {
        ...input,
        definition: {
          ...f.definition,
          id: "missing-artifact",
          artifacts: [{ hash: "d".repeat(64), size: 1 }],
        },
        expectedWorkRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "artifact-missing" });
    expect(f.work.read(ROLE, "missing-artifact")).toBeUndefined();
    await f.protocol.claim({
      role: ROLE,
      expectedEpoch: 1,
      binding: BINDING,
      evidence: "fixture-explicit-owner-rotation",
      at: AT,
    });
    await expect(f.work.publish(context, input)).rejects.toMatchObject({ code: "writer-fenced" });
    expect(f.work.read(ROLE, f.definition.id)?.ready).toBe(true);
  });

  it("publishes worker results in their own fenced namespace and requires explicit parent acceptance", async () => {
    const f = await fixture();
    await f.publish();
    const workerId = "00000000-0000-4000-8000-000000000002";
    const parentEpoch = f.protocol.read(ROLE).epoch;
    const role = protocolWorkerRole(ROLE, workerId, parentEpoch);
    const binding: Binding = { harness: "codex", nativeId: workerId };
    f.allowed.set(role, binding);
    await f.protocol.claim({
      role,
      expectedEpoch: 0,
      binding,
      evidence: "fixture-verified-lineage",
      at: AT,
      parent: { role: ROLE, epoch: parentEpoch, workerId },
    });
    const input = {
      id: "worker-result",
      parentRole: ROLE,
      parentEpoch,
      workerId,
      workId: f.definition.id,
      definitionHash: f.work.read(ROLE, f.definition.id)!.definitionHash,
      criterionIds: ["criterion-one"],
      source: SOURCE,
      artifacts: [f.evidence],
      receipts: [f.receipt("check")],
    };
    const parentRevision = f.protocol.read(ROLE).revision;
    await expect(
      f.work.submit(f.context(role), {
        ...input,
        id: "false-integration",
        receipts: [f.receipt("integration")],
      }),
    ).rejects.toMatchObject({ code: "submission-scope-mismatch" });
    const submissionContext = f.context(role);
    await f.work.submit(submissionContext, input);
    expect(f.protocol.read(ROLE).revision).toBe(parentRevision);
    expect(f.work.read(ROLE, f.definition.id)?.accepted).toEqual([]);
    expect(f.work.report().readyUnaccepted).toContain(`${role}:worker-result`);
    const object = f.protocol.read(role).objects.find((o) => o.collection === "submissions")!;
    const artifact = (object.value as unknown as { publication: ArtifactRef }).publication;
    await f.work.accept(f.context(), {
      workId: f.definition.id,
      expectedWorkRevision: f.objectRevision(),
      submission: { role, id: object.id, revision: object.revision, artifact },
      evidence: f.evidence,
    });
    expect(f.work.report().acceptedUnintegrated).toEqual([`${ROLE}:work-one`]);
    expect(f.work.report().readyUnaccepted).not.toContain(`${role}:worker-result`);
    expect(f.work.evaluate(ROLE, f.definition.id).closureReady).toBe(false);
    const oldContext = f.context(role);
    await f.protocol.claim({
      role: ROLE,
      expectedEpoch: parentEpoch,
      binding: BINDING,
      evidence: "fixture-explicit-owner-rotation",
      at: AT,
    });
    await expect(f.work.submit(oldContext, { ...input, id: "late-result" })).rejects.toMatchObject({
      code: "parent-fenced",
    });
    await expect(f.work.submit(submissionContext, input)).rejects.toMatchObject({
      code: "parent-fenced",
    });
    expect(
      f.protocol.read(role).objects.filter((o) => o.collection === "submissions"),
    ).toHaveLength(1);
  });

  it("requires every declared target-consumer phase and does not equate checks, deployment or acceptance", async () => {
    const phases: WorkPhase[] = [
      "check",
      "integration",
      "publication",
      "consumer-adoption",
      "delivery",
      "deployment",
      "acceptance",
    ];
    const f = await fixture(phases, ["consumer-a", "consumer-b"]);
    await f.publish();
    for (const phase of phases.slice(0, -1)) {
      for (const consumer of ["consumer-a", "consumer-b"]) {
        // Each receipt binds the revision committed by the previous receipt.
        // eslint-disable-next-line no-await-in-loop
        await f.record(phase, consumer);
      }
      if (phase === "check") {
        // eslint-disable-next-line no-await-in-loop
        await f.publish(true);
        expect(f.work.report().acceptedUnintegrated).toEqual([]);
      }
      if (phase === "integration") {
        expect(f.work.report().integratedUndelivered).toEqual([`${ROLE}:work-one`]);
      }
    }
    await f.record("acceptance", "consumer-a");
    expect(f.work.report().deployedUnaccepted).toEqual([`${ROLE}:work-one`]);
    expect(f.work.evaluate(ROLE, f.definition.id).closureReady).toBe(false);
    await f.record("acceptance", "consumer-b");
    expect(f.work.evaluate(ROLE, f.definition.id)).toMatchObject({
      criteriaSatisfied: true,
      closureReady: true,
    });
    expect(f.work.report().readyUnaccepted).toEqual([`${ROLE}:work-one`]);
    expect(f.request.state).toBe("open");
  });

  it("distinguishes parent acceptance, absent phases and missing role coverage", async () => {
    const f = await fixture(["check", "delivery", "acceptance"]);
    await f.publish();
    await f.record("check");
    await f.publish(true);
    await f.record("acceptance");
    const report = f.work.report({ roles: [ROLE, "kits/art-kit"] });
    expect(report.status).toBe("partial");
    expect(report.readyUnaccepted).toEqual([`${ROLE}:work-one`]);
    expect(report.integratedUndelivered).toEqual([]);
    expect(report.deployedUnaccepted).toEqual([]);
    expect(report.unavailable).toEqual([{ role: "kits/art-kit", reason: "role-unclaimed" }]);
    expect(f.work.index("kits/art-kit")).toMatchObject({ epoch: 0, status: "unknown", items: [] });
    f.allowed.set("kits/art-kit", BINDING);
    await f.protocol.claim({
      role: "kits/art-kit",
      expectedEpoch: 0,
      binding: BINDING,
      evidence: "fixture-owner",
      at: AT,
    });
    expect(f.work.report({ roles: ["kits/art-kit"] })).toMatchObject({
      status: "unknown",
      unavailable: [{ reason: "no-work-publication" }],
    });
    expect(
      new WorkStore({ protocol: f.protocol }).evaluate(ROLE, f.definition.id).authorization,
    ).toBe("unknown");
  });

  it("preserves ledger questions and rejects unbound checks without inventing approval", async () => {
    const f = await fixture(["check"]);
    await f.publish();
    const request = {
      ...f.request,
      question: {
        native: null,
        text: null,
        options: null,
        status: "pending" as const,
        resolutionRef: null,
      },
    };
    const guarded = new WorkStore({ protocol: f.protocol, readRequest: () => request });
    await expect(
      f.work.receipt(f.context(), {
        workId: f.definition.id,
        expectedWorkRevision: f.objectRevision(),
        receipt: { ...f.receipt("check"), source: null },
      }),
    ).rejects.toMatchObject({ code: "receipt-source-mismatch" });
    await f.record("check");
    await f.publish(true);
    expect(guarded.evaluate(ROLE, f.definition.id)).toMatchObject({
      guarded: true,
      closureReady: false,
    });
    expect(request.question.status).toBe("pending");
    expect(
      new WorkStore({ protocol: f.protocol, readRequest: () => null }).report().unknownRetained,
    ).toEqual([`${ROLE}:work-one`]);
    const failed = { ...f.receipt("check"), outcome: "failed" as const };
    await f.work.receipt(f.context(), {
      workId: f.definition.id,
      expectedWorkRevision: f.objectRevision(),
      receipt: failed,
    });
    expect(f.work.read(ROLE, f.definition.id)?.ready).toBe(false);
    expect(f.work.evaluate(ROLE, f.definition.id).criteriaSatisfied).toBe(false);
  });

  it("retains immutable old evidence when a source publication is explicitly replaced", async () => {
    const f = await fixture(["check"]);
    await f.publish();
    await f.record("check");
    const before = f.work.read(ROLE, f.definition.id)!;
    const changed = {
      ...f.definition,
      source: { ...SOURCE, commit: "d".repeat(40) },
      retention: {
        owner: "game-kit",
        reason: "new source needs checking",
        nextBoundary: "owner review",
      },
    };
    await expect(
      f.work.publish(f.context(), {
        definition: changed,
        expectedWorkRevision: f.objectRevision(),
        ready: false,
        replaces: null,
      }),
    ).rejects.toMatchObject({ code: "explicit-replacement-required" });
    await f.work.publish(f.context(), {
      definition: changed,
      expectedWorkRevision: f.objectRevision(),
      ready: false,
      replaces: before.publication.hash,
    });
    expect(f.work.read(ROLE, f.definition.id)).toMatchObject({
      ready: false,
      receipts: [],
      definition: { retention: changed.retention },
    });
    expect(f.protocol.readArtifact(before.publication.hash).byteLength).toBe(
      before.publication.size,
    );
    expect(f.work.report().unknownRetained).toEqual([`${ROLE}:work-one`]);
    expect(f.work.index(ROLE).items[0]).not.toHaveProperty("definition");
  });
});
