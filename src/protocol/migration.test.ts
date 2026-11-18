import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as durable from "../durable.ts";
import { loadLayout } from "../layout.ts";
import { LockBusy } from "../lock.ts";
import { messageEnvelope } from "../messages/envelope.ts";
import { messageChannelStateDir } from "../messages/paths.ts";
import { createRegistry, readRegistry, type Registry, updateRegistry } from "../registry/index.ts";
import { CLAUDE_COORDINATOR, makeFixture, registryInput } from "../testFixtures.ts";
import { ProtocolStore } from "./core.ts";
import { EnrollmentStore } from "./enrollment.ts";
import { enrollmentStatus, evaluateEnrollmentBoundary } from "./enrollment-runtime.ts";
import { declareProtocolWorkspace, resolveProtocolLayout } from "./layout.ts";
import { ProtocolMessages } from "./messages.ts";
import {
  activateProtocol,
  backupProtocol,
  importProtocolMigration,
  importProtocolOriginals,
  inventoryProtocol,
  planProtocolMigration,
  type ProtocolParticipant,
  recordObserverAdoption,
  restoreProtocol,
} from "./migration.ts";
import { WorkStore } from "./work.ts";
const AT = "2026-11-16T04:00:00.000Z";
const BINDING = { harness: "claude" as const, nativeId: CLAUDE_COORDINATOR };
function fixture(prepare: (messages: string) => void = () => {}) {
  const test = makeFixture();
  const layout = loadLayout(test.root);
  const raw = registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">;
  const input = { ...raw, operations: {} };
  const registry = createRegistry(layout, input);
  const dir = join(layout.varDir, "game-dev", "messages");
  mkdirSync(dir, { recursive: true });
  const envelope = messageEnvelope({
    body: "\uFEFFExact fixture\n",
    created: AT,
    fromRole: "game-coordinator",
    id: "legacy-message",
    intent: "queue",
    schema: 1,
    toRole: "archies-dog-walks/tech",
  });
  const bytes = Buffer.from(
    `${JSON.stringify({
      attempts: [],
      envelope,
      evidence: [],
      reason: "explicit-hold",
      retention: null,
      revision: 1,
      schema: 1,
      state: "held",
    })}\n`,
  );
  writeFileSync(join(dir, `${createHash("sha256").update(envelope.id).digest("hex")}.json`), bytes);
  writeFileSync(join(dir, `${createHash("sha256").update(envelope.id).digest("hex")}.lock`), "");
  prepare(dir);
  const stateRoot = join(test.base, "protocol-state");
  const plan = planProtocolMigration(layout, {
    expectedGeneration: 0,
    stateRoot,
    workspaceId: "fixture",
  });
  const participants: ProtocolParticipant[] = Object.entries(registry.roles).flatMap(
    ([role, value]) =>
      (["reader", "writer"] as const).map((kind) => ({
        artifactHash: "a".repeat(64),
        compatibilityRef: "fixture:reviewed-v1",
        harness: "claude",
        id: `${role}:${kind}`,
        kind,
        nativeId: value.conversations.claude!,
        protocolSchema: 1,
        quiescenceRef: "fixture:quiesced",
        role,
        version: "4.5.0",
      })),
  );
  return { ...test, bytes, envelope, layout, participants, plan, registry, stateRoot };
}
const RECIPIENT = "01a18dc1-f75d-7071-b26e-f547aa8a5ba6";
const REQUEST = "010b7a08-b0ba-47f6-95fd-24fa477f86ea";
const RECEIPT = Buffer.from(
  `${JSON.stringify({
    kind: "message",
    recipient: RECIPIENT,
    requestId: REQUEST,
    status: "accepted",
    text: "fixture",
  })}\n`,
);
/** The per-recipient transport layout the Claude channel and Codex queue transports write. */
function recipientState(messages: string): void {
  const unblock = join(messages, "recipients", RECIPIENT, "unblock");
  mkdirSync(join(unblock, "claude-spool"), { recursive: true });
  mkdirSync(join(unblock, "claude-delivered"), { recursive: true });
  writeFileSync(join(unblock, `${REQUEST}.json`), RECEIPT);
  writeFileSync(join(unblock, `${REQUEST}.json.lock`), "");
  writeFileSync(join(unblock, "unblock.lock"), "");
  writeFileSync(join(unblock, "claude-spool", "pending-request.json"), "{}\n");
  writeFileSync(join(unblock, "claude-spool", "claimed-request.claimed"), "{}\n");
  writeFileSync(join(unblock, "claude-delivered", `${REQUEST}.json`), "{}\n");
}
function publication(messageId: string) {
  return {
    evidenceRef: "fixture:legacy-audit",
    guards: { artifacts: [], hold: "held" as const, question: "unknown" as const, references: [] },
    links: { clauseIds: [], messageIds: [], requestIds: [], workIds: [] },
    messageId,
    writer: {
      at: AT,
      binding: BINDING,
      epoch: 1,
      expectedRevision: 1,
      id: "import-original",
      role: "coordinator",
    },
  };
}
async function claimCoordinator(stateRoot: string): Promise<ProtocolStore> {
  const store = new ProtocolStore({ directory: stateRoot, resolveBinding: () => true });
  await store.claim({
    at: AT,
    binding: BINDING,
    evidence: "fixture:owner",
    expectedEpoch: 0,
    role: "coordinator",
  });
  return store;
}
async function verifiedCopies(t: ReturnType<typeof fixture>) {
  const backup = await backupProtocol(t.layout, {
    destination: join(t.base, "backup"),
    stateRoot: t.stateRoot,
  });
  const restore = await restoreProtocol(t.layout, {
    backup,
    destination: join(t.base, "restore"),
  });
  return {
    backup,
    expectedGeneration: 0 as const,
    participants: t.participants,
    plan: t.plan,
    registryRevision: t.registry.revision,
    restore,
  };
}
describe("explicit initial protocol migration", () => {
  it("requires prepared representation and revalidation after managed cutover", async () => {
    const t = makeFixture();
    const layout = loadLayout(t.root);
    const raw = registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">;
    const registry = createRegistry(layout, { ...raw, operations: {} });
    await declareProtocolWorkspace(layout, {
      authorityRef: "fixture:approval",
      expectedGeneration: 0,
      workspaceId: "fixture",
    });
    const stateRoot = join(t.base, "state");
    const plan = planProtocolMigration(layout, {
      expectedGeneration: 0,
      stateRoot,
      workspaceId: "fixture",
    });
    expect(plan.required).toEqual({ authorityRef: "fixture:approval" });
    await importProtocolMigration(layout, plan);
    const protocol = new ProtocolStore({ directory: stateRoot, resolveBinding: () => true });
    await protocol.claim({
      at: AT,
      binding: BINDING,
      evidence: "fixture:owner",
      expectedEpoch: 0,
      role: "coordinator",
    });
    const participants: ProtocolParticipant[] = Object.entries(registry.roles).flatMap(
      ([role, value]) =>
        (["reader", "writer"] as const).map((kind) => ({
          artifactHash: "a".repeat(64),
          compatibilityRef: "fixture:reader-qualified",
          harness: "claude",
          id: role + kind,
          kind,
          nativeId: value.conversations.claude!,
          protocolSchema: 1,
          quiescenceRef: "fixture:quiesced",
          role,
          version: "4.6.0",
        })),
    );
    const backup = await backupProtocol(layout, {
      destination: join(t.base, "backup-before"),
      stateRoot,
    });
    const restore = await restoreProtocol(layout, {
      backup,
      destination: join(t.base, "restore-before"),
    });
    const activation = {
      backup,
      expectedGeneration: 0 as const,
      participants,
      plan,
      registryRevision: registry.revision,
      restore,
    };
    await expect(activateProtocol(layout, activation)).rejects.toMatchObject({
      code: "migration-enrollment-required",
    });
    const base = { generation: 1, phase: "prepared" as const, stateRoot, workspaceId: "fixture" };
    const { scope } = enrollmentStatus(layout, protocol, base);
    const own = scope.participants.find((p) => p.role === "coordinator")!;
    const evidence = await protocol.putArtifact(
      Buffer.from("fixture parent retains unavailable scopes"),
    );
    const receipt = {
      evidence: [evidence],
      generation: 1,
      inspectedAt: AT,
      ledger: { hash: null, revision: 0 },
      phase: "prepared" as const,
      references: [],
      registryRevision: registry.revision,
      unknowns: [
        ...own.requiredUnknownScopes.map((source, index) => ({
          evidence: [evidence],
          id: `unknown-${index}`,
          nextBoundary: "next owner audit",
          parentRole: "coordinator",
          participantRole: "coordinator",
          reason: "unavailable",
          scope: source,
        })),
        {
          evidence: [evidence],
          id: "retained-owner",
          nextBoundary: "next parent audit",
          parentRole: "coordinator",
          participantRole: "games/archies-dog-walks/tech",
          reason: "unavailable",
          scope: "participant",
        },
      ],
      workspaceId: "fixture",
    };
    await new EnrollmentStore({ protocol }).publish(
      {
        at: AT,
        binding: BINDING,
        epoch: 1,
        expectedRevision: 1,
        id: "prepared-enrollment",
        role: "coordinator",
      },
      receipt,
      scope,
    );
    const checked = enrollmentStatus(layout, protocol, base);
    expect(checked.report).toMatchObject({
      allAdopted: false,
      allRepresented: true,
      coverageComplete: false,
    });
    const finalBackup = await backupProtocol(layout, {
      destination: join(t.base, "backup-final"),
      stateRoot,
    });
    const finalRestore = await restoreProtocol(layout, {
      backup: finalBackup,
      destination: join(t.base, "restore-final"),
    });
    await activateProtocol(layout, {
      ...activation,
      backup: finalBackup,
      enrollment: {
        participants: checked.report.participants.map(({ revision, role }) => ({ revision, role })),
        registryRevision: registry.revision,
      },
      restore: finalRestore,
    });
    expect(resolveProtocolLayout(layout)?.required).toEqual(plan.required);
    const active = { ...base, phase: "active" as const };
    expect(enrollmentStatus(layout, protocol, active).report.allAdopted).toBe(false);
    const activeScope = enrollmentStatus(layout, protocol, active).scope;
    await new EnrollmentStore({ protocol }).publish(
      {
        at: AT,
        binding: BINDING,
        epoch: 1,
        expectedRevision: 2,
        id: "active-enrollment",
        role: "coordinator",
      },
      { ...receipt, phase: "active" },
      activeScope,
    );
    expect(
      evaluateEnrollmentBoundary(layout, protocol, {
        ...active,
        boundary: "startup",
        role: "coordinator",
      }).admission.allowed,
    ).toBe(true);
    expect(
      evaluateEnrollmentBoundary(layout, protocol, {
        ...active,
        boundary: "before-work",
        role: "coordinator",
      }).admission.reason,
    ).toBe("approved-work-required");
    expect(
      evaluateEnrollmentBoundary(layout, protocol, {
        ...active,
        boundary: "cleanup",
        role: "coordinator",
      }).admission.reason,
    ).toBe("essential-evidence-required");
    expect(
      evaluateEnrollmentBoundary(layout, protocol, {
        ...active,
        boundary: "worker-start",
        role: "coordinator",
      }).admission.reason,
    ).toBe("approved-work-required");
    const planArtifact = await protocol.putArtifact(Buffer.from("fixture retained work plan"));
    const essential = await protocol.putArtifact(
      Buffer.from("fixture essential source and handoff package"),
    );
    const work = new WorkStore({ protocol });
    for (const [index, artifacts] of [[], [essential]].entries()) {
      const id = `retained-${index}`;
      // The next enrollment inspects the publication committed by this iteration.
      // eslint-disable-next-line no-await-in-loop
      await work.publish(
        {
          at: AT,
          binding: BINDING,
          epoch: 1,
          expectedRevision: protocol.read("coordinator").revision,
          id: `publish-${id}`,
          role: "coordinator",
        },
        {
          definition: {
            artifacts,
            clauseIds: [],
            criteria: [{ consumers: [], id: "check", phases: ["check"], targetId: "target" }],
            id,
            messageIds: [],
            plan: planArtifact,
            requestIds: ["retained-request"],
            retention: {
              nextBoundary: "next parent review",
              owner: "game-coordinator",
              reason: "retained essential package",
            },
            source: null,
          },
          expectedWorkRevision: 0,
          ready: false,
          replaces: null,
        },
      );
      const current = enrollmentStatus(layout, protocol, active).scope;
      // eslint-disable-next-line no-await-in-loop
      await new EnrollmentStore({ protocol }).publish(
        {
          at: AT,
          binding: BINDING,
          epoch: 1,
          expectedRevision: protocol.read("coordinator").revision,
          id: `enroll-${id}`,
          role: "coordinator",
        },
        {
          ...receipt,
          phase: "active",
          references: current.participants.find((p) => p.role === "coordinator")!.knownReferences,
        },
        current,
      );
      expect(
        evaluateEnrollmentBoundary(layout, protocol, {
          ...active,
          boundary: "cleanup",
          role: "coordinator",
          workId: id,
        }).admission.allowed,
      ).toBe(index === 1);
    }
  });
  it("records truthful resident evidence with CAS repair and a discoverable canonical audit", async () => {
    const t = makeFixture();
    const layout = loadLayout(t.root);
    const registry = createRegistry(
      layout,
      registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">,
    );
    const protocol = new ProtocolStore({
      directory: join(t.base, "state"),
      resolveBinding: () => true,
    });
    await protocol.claim({
      at: AT,
      binding: BINDING,
      evidence: "fixture:owner",
      expectedEpoch: 0,
      role: "coordinator",
    });
    const resident = {
      binding: BINDING,
      cliSha256: "a".repeat(64),
      inspectionRef: "fixture:actual-resident-inspection",
      kind: "resident-adoption",
      observedAt: AT,
      operation: "archies-dog-walks",
      origin: "owner-attested",
      ownerRole: "game-coordinator",
      readerProtocolSchema: 1,
      residentId: "fixture-resident",
      schema: 1,
      version: "4.6.0",
    };
    const evidence = await protocol.putArtifact(Buffer.from(JSON.stringify(resident)));
    const input = {
      context: {
        at: AT,
        binding: BINDING,
        epoch: 1,
        expectedRevision: 1,
        id: "resident-adoption",
        role: "coordinator",
      },
      evidence,
      expectedRegistryRevision: registry.revision,
      operation: "archies-dog-walks",
    };
    const wrong = await protocol.putArtifact(
      Buffer.from(JSON.stringify({ ...resident, ownerRole: "archies-dog-walks/tech" })),
    );
    await expect(
      recordObserverAdoption(layout, protocol, { ...input, evidence: wrong }),
    ).rejects.toMatchObject({ code: "observer-adoption-invalid" });
    updateRegistry(layout, 1, (draft) => {
      draft.roles["archies-dog-walks/tech"]!.branch = "retained-branch";
    });
    const before = readRegistry(layout);
    await expect(recordObserverAdoption(layout, protocol, input)).rejects.toMatchObject({
      actionMayHaveCommitted: true,
      code: "observer-adoption-conflict",
      reconcileKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(readRegistry(layout)).toEqual(before);
    const result = await recordObserverAdoption(layout, protocol, {
      ...input,
      reconcileRegistryRevision: 2,
    });
    const next = readRegistry(layout);
    expect(next.roles).toEqual(before.roles);
    expect(next.transfers).toEqual(before.transfers);
    expect(next.operations["archies-dog-walks"]!.activation).toEqual(
      before.operations["archies-dog-walks"]!.activation,
    );
    expect(next.operations["archies-dog-walks"]!.lastAdoption?.evidenceRef).toBe(
      `protocol-artifact:${result.reconcileKey}`,
    );
    expect(
      JSON.parse(Buffer.from(protocol.readArtifact(result.reconcileKey)).toString("utf8")).evidence,
    ).toEqual(evidence);
    expect((await recordObserverAdoption(layout, protocol, input)).status).toBe("already-recorded");
    expect(readRegistry(layout)).toEqual(next);
    const changed = await protocol.putArtifact(
      Buffer.from(JSON.stringify({ ...resident, version: "4.6.1" })),
    );
    await expect(
      recordObserverAdoption(layout, protocol, {
        ...input,
        evidence: changed,
        reconcileRegistryRevision: next.revision,
      }),
    ).rejects.toMatchObject({ code: "transaction-conflict" });
    expect(readRegistry(layout)).toEqual(next);
    expect(
      protocol.history("coordinator").filter((event) => event.type === "transaction"),
    ).toHaveLength(1);
  });
  it("requires original imports and audited participants before verified cutover", async () => {
    const t = fixture();
    await importProtocolMigration(t.layout, t.plan);
    const firstBackup = await backupProtocol(t.layout, {
      destination: join(t.base, "backup-before"),
      stateRoot: t.stateRoot,
    });
    const firstRestore = await restoreProtocol(t.layout, {
      backup: firstBackup,
      destination: join(t.base, "restore-before"),
    });
    const candidate = {
      backup: firstBackup,
      expectedGeneration: 0 as const,
      participants: t.participants,
      plan: t.plan,
      registryRevision: t.registry.revision,
      restore: firstRestore,
    };
    await expect(activateProtocol(t.layout, candidate)).rejects.toMatchObject({
      code: "migration-originals-required",
      details: { ids: [t.envelope.id], owners: ["game-coordinator"] },
    });
    expect(resolveProtocolLayout(t.layout)).toBeNull();
    const store = new ProtocolStore({ directory: t.stateRoot, resolveBinding: () => true });
    await store.claim({
      at: AT,
      binding: BINDING,
      evidence: "fixture:owner",
      expectedEpoch: 0,
      role: "coordinator",
    });
    const result = await importProtocolOriginals(t.layout, {
      publications: [
        {
          evidenceRef: "fixture:legacy-audit",
          guards: { artifacts: [], hold: "held", question: "unknown", references: [] },
          links: { clauseIds: [], messageIds: [], requestIds: [], workIds: [] },
          messageId: t.envelope.id,
          writer: {
            at: AT,
            binding: BINDING,
            epoch: 1,
            expectedRevision: 1,
            id: "import-original",
            role: "coordinator",
          },
        },
      ],
      stateRoot: t.stateRoot,
    });
    expect(result.pending).toEqual([]);
    const original = new ProtocolMessages({ store }).read(result.published[0]!);
    expect(original.envelope).toEqual(t.envelope);
    expect(Buffer.from(store.readArtifact(original.imported!.legacyRecord.hash))).toEqual(t.bytes);
    expect(new ProtocolMessages({ store }).latestRecipientReceipt(result.published[0]!)).toBeNull();
    const backup = await backupProtocol(t.layout, {
      destination: join(t.base, "backup-final"),
      stateRoot: t.stateRoot,
    });
    const restore = await restoreProtocol(t.layout, {
      backup,
      destination: join(t.base, "restore-final"),
    });
    const final = { ...candidate, backup, restore };
    await expect(activateProtocol(t.layout, { ...final, participants: [] })).rejects.toMatchObject({
      code: "migration-participants-incomplete",
    });
    const sourceBefore = inventoryProtocol(t.layout);
    const historyBefore = store.history("coordinator");
    const write = durable.writeJsonDurable;
    const fault = vi
      .spyOn(durable, "writeJsonDurable")
      .mockImplementation((path, value, options) => {
        if (path === join(t.layout.varDir, "work-protocol.json")) {
          throw new Error("fixture pointer write failure");
        }
        return write(path, value, options);
      });
    try {
      await expect(activateProtocol(t.layout, final)).rejects.toMatchObject({
        code: "migration-unavailable",
      });
      expect(() => resolveProtocolLayout(t.layout)).toThrow("protocol-fenced");
    } finally {
      fault.mockRestore();
    }
    expect(inventoryProtocol(t.layout)).toEqual(sourceBefore);
    expect(store.history("coordinator")).toEqual(historyBefore);
    expect(JSON.parse(readFileSync(join(backup.backupRoot, "backup.json"), "utf8"))).toEqual(
      backup,
    );
    let blockedWriters = 0;
    const guard = vi
      .spyOn(durable, "writeJsonDurable")
      .mockImplementation((path, value, options) => {
        if (path === join(t.layout.varDir, "work-protocol.json")) {
          expect(() =>
            updateRegistry(
              t.layout,
              t.registry.revision,
              (draft) => {
                draft.roles["game-coordinator"]!.conversations.claude =
                  "00000000-0000-4000-8000-000000000007";
              },
              { timeoutSeconds: 0 },
            ),
          ).toThrow(LockBusy);
          blockedWriters++;
        }
        return write(path, value, options);
      });
    let active: Awaited<ReturnType<typeof activateProtocol>>;
    try {
      active = await activateProtocol(t.layout, final);
    } finally {
      guard.mockRestore();
    }
    expect(blockedWriters).toBe(1);
    expect(store.history("coordinator")).toEqual(historyBefore);
    expect(active?.stateRoot).toBe(t.stateRoot);
    expect(readFileSync(join(t.layout.varDir, "work-protocol-fence.json"))).toEqual(
      readFileSync(join(t.layout.varDir, "work-protocol.json")),
    );
    expect(await activateProtocol(t.layout, final)).toEqual(active);
    const registryAfter = updateRegistry(
      t.layout,
      t.registry.revision,
      (draft) => {
        draft.roles["game-coordinator"]!.branch = "after-cutover";
      },
      { timeoutSeconds: 0 },
    );
    expect(registryAfter.roles["game-coordinator"]!.branch).toBe("after-cutover");
    expect(() =>
      planProtocolMigration(t.layout, {
        expectedGeneration: 1,
        stateRoot: join(t.base, "relocation"),
        workspaceId: "fixture",
      }),
    ).toThrow("migration-already-active");
  });
  it("carries recipient transport state to the state root without publishing it as originals", async () => {
    const t = fixture(recipientState);
    await importProtocolMigration(t.layout, t.plan);
    await claimCoordinator(t.stateRoot);
    await expect(
      importProtocolOriginals(t.layout, {
        publications: [publication(REQUEST)],
        stateRoot: t.stateRoot,
      }),
    ).rejects.toMatchObject({ code: "invalid-migration" });
    const result = await importProtocolOriginals(t.layout, {
      publications: [publication(t.envelope.id)],
      stateRoot: t.stateRoot,
    });
    expect(result.pending).toEqual([]);
    expect(result.published.map((item) => item.messageId)).toEqual([t.envelope.id]);
    const active = await activateProtocol(t.layout, await verifiedCopies(t));
    expect(active?.stateRoot).toBe(t.stateRoot);
    const unblock = messageChannelStateDir(t.layout, RECIPIENT);
    expect(unblock).toBe(
      join(t.stateRoot, "transport", "messages", "recipients", RECIPIENT, "unblock"),
    );
    expect(readFileSync(join(unblock, `${REQUEST}.json`))).toEqual(RECEIPT);
    expect(readFileSync(join(unblock, "claude-spool", "pending-request.json"), "utf8")).toBe(
      "{}\n",
    );
  });
  it.each([
    "notes.txt",
    `recipients/${RECIPIENT}/receipt.json`,
    `recipients/${RECIPIENT.toUpperCase()}/unblock/${REQUEST}.json`,
    "recipients/not-a-session/unblock/request.json",
    `recipients/${RECIPIENT}/unblock/request.txt`,
    `recipients/${RECIPIENT}/unblock/nested/request.json`,
    `recipients/${RECIPIENT}/unblock/claude-spool/request.tmp`,
  ])("refuses unexpected legacy message file %s", async (path) => {
    const t = fixture((messages) => {
      mkdirSync(dirname(join(messages, path)), { recursive: true });
      writeFileSync(join(messages, path), "{}\n");
    });
    await importProtocolMigration(t.layout, t.plan);
    await claimCoordinator(t.stateRoot);
    await expect(
      importProtocolOriginals(t.layout, {
        publications: [publication(t.envelope.id)],
        stateRoot: t.stateRoot,
      }),
    ).rejects.toMatchObject({ code: "invalid-migration" });
    await expect(activateProtocol(t.layout, await verifiedCopies(t))).rejects.toMatchObject({
      code: "invalid-migration",
    });
    expect(resolveProtocolLayout(t.layout)).toBeNull();
  });
  it("refuses changed source bytes, source aliases, overlapping backups, and corrupt restoration", async () => {
    const t = fixture();
    const ledger = join(t.layout.varDir, "accounting");
    mkdirSync(ledger);
    writeFileSync(join(ledger, "new-reference"), "fixture");
    await expect(importProtocolMigration(t.layout, t.plan)).rejects.toMatchObject({
      code: "migration-source-changed",
    });
    symlinkSync(join(ledger, "new-reference"), join(ledger, "alias"));
    expect(() => inventoryProtocol(t.layout)).toThrow("unsafe-migration-entry");
    const other = fixture();
    await importProtocolMigration(other.layout, other.plan);
    await expect(
      backupProtocol(other.layout, {
        destination: join(other.stateRoot, "backup"),
        stateRoot: other.stateRoot,
      }),
    ).rejects.toMatchObject({ code: "migration-backup-required" });
    const backup = await backupProtocol(other.layout, {
      destination: join(other.base, "backup"),
      stateRoot: other.stateRoot,
    });
    writeFileSync(join(backup.backupRoot, "state", "workspace.json"), "{}");
    await expect(
      restoreProtocol(other.layout, { backup, destination: join(other.base, "restore") }),
    ).rejects.toMatchObject({ code: "migration-backup-required" });
  });
});
