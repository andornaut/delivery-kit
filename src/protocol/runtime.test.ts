import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { accountingStatus, captureAccounting } from "../accounting/boundary.ts";
import { LedgerStore } from "../accounting/store.ts";
import type { LedgerTransaction } from "../accounting/types.ts";
import { holdLock, LockBusy } from "../lock.ts";
import { messageChannelStateDir } from "../messages/paths.ts";
import { MessageService } from "../messages/service.ts";
import { MessageStore } from "../messages/store.ts";
import { claudeFixture, RECIPIENT } from "../review/fixtures.ts";
import { EnrollmentStore } from "./enrollment.ts";
import { resolveEnrollmentScope } from "./enrollment-runtime.ts";
import { declareProtocolWorkspace, resolveProtocolLayout } from "./layout.ts";
import {
  accountingIntake,
  ledgerStorageOptions,
  offerAccounting,
  runtimeProtocolStore,
} from "./runtime.ts";
import { activateProtocolFixture } from "./testFixtures.ts";

const AT = "2026-11-16T04:00:00.000Z";
const BINDING = { harness: "claude" as const, nativeId: RECIPIENT };

function transaction(): LedgerTransaction {
  const source = { native: null, origin: "unknown" as const, reference: null, wordingHash: null };
  return {
    actor: "game-coordinator",
    at: AT,
    command: {
      request: {
        assignment: null,
        dependencies: [],
        id: "fixture-untriaged",
        kind: "unknown",
        parentId: null,
        question: null,
        reviewed: false,
        source,
        summary: "Untriaged fixture source",
        targets: [],
      },
      type: "register",
    },
    commandId: "fixture-owner-intake",
    expectedRevision: 0,
    schema: 1,
    source,
    writer: { ...BINDING, epoch: 1 },
  };
}

describe("external protocol at existing runtime boundaries (isolated fixtures)", () => {
  it("pins a generation through asynchronous writes and fences every cached view after selection changes", async () => {
    const fixture = claudeFixture();
    activateProtocolFixture(fixture.layout);
    const protocol = runtimeProtocolStore(fixture.layout)!;
    await protocol.claim({
      at: AT,
      binding: BINDING,
      evidence: "fixture-owner",
      expectedEpoch: 0,
      role: "coordinator",
    });
    const artifact = await protocol.putArtifact(Buffer.from("canonical fixture bytes"));
    let enter = (): void => undefined;
    let finish = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const operation = protocol.withWriter(
      { binding: BINDING, epoch: 1, role: "coordinator" },
      async () => {
        enter();
        await barrier;
        return "committed fixture action";
      },
    );
    await entered;
    try {
      expect(() =>
        holdLock(join(fixture.layout.varDir, "work-protocol.lock"), { nonBlocking: true }),
      ).toThrow(LockBusy);
    } finally {
      finish();
    }
    expect(await operation).toBe("committed fixture action");
    holdLock(join(fixture.layout.varDir, "work-protocol.lock"), { nonBlocking: true }).release();
    activateProtocolFixture(fixture.layout);
    expect(() => protocol.read("coordinator")).toThrow("protocol-generation-conflict");
    expect(() => protocol.history("coordinator")).toThrow("protocol-generation-conflict");
    expect(() => protocol.listRoles()).toThrow("protocol-generation-conflict");
    expect(() => protocol.readArtifact(artifact.hash)).toThrow("protocol-generation-conflict");
    await expect(protocol.putArtifact(Buffer.from("stale write"))).rejects.toThrow(
      "protocol-generation-conflict",
    );
    await expect(
      protocol.claim({
        at: AT,
        binding: BINDING,
        evidence: "stale",
        expectedEpoch: 1,
        role: "coordinator",
      }),
    ).rejects.toThrow("protocol-generation-conflict");
  });

  it("fences cached legacy views and stale role epochs while retaining the sole request journal", async () => {
    const fixture = claudeFixture();
    const selected = ledgerStorageOptions(fixture.layout);
    const messages = new MessageStore({ layout: fixture.layout, resolveOwner: () => null });
    const root = activateProtocolFixture(fixture.layout);
    const legacy = new LedgerStore(selected);
    expect(() => legacy.read()).toThrow("protocol-generation-conflict");
    expect(messages.summary()).toMatchObject({ counts: null, status: "unavailable" });
    const store = new LedgerStore(ledgerStorageOptions(fixture.layout));
    const missingWriter = { ...transaction() };
    delete missingWriter.writer;
    await expect(store.apply(missingWriter)).rejects.toThrow("protocol-writer-required");
    expect(existsSync(join(root, "accounting"))).toBe(false);
    const protocol = runtimeProtocolStore(fixture.layout)!;
    await protocol.claim({
      at: AT,
      binding: BINDING,
      evidence: "fixture-owner",
      expectedEpoch: 0,
      role: "coordinator",
    });
    const input = transaction();
    await store.apply(input);
    expect(new LedgerStore({ directory: join(root, "accounting") }).history()[0]?.writer).toEqual(
      input.writer,
    );
    await protocol.claim({
      at: AT,
      binding: BINDING,
      evidence: "fixture-next-epoch",
      expectedEpoch: 1,
      role: "coordinator",
    });
    await expect(
      store.apply({ ...input, commandId: "stale-writer-command", expectedRevision: 1 }),
    ).rejects.toThrow("writer-fenced");
    expect(store.history()).toHaveLength(1);
    expect(existsSync(join(fixture.layout.varDir, "accounting"))).toBe(false);
  });

  it("retains unknown intake across reload without impersonating writers or clearing questions", async () => {
    const fixture = claudeFixture();
    fixture.clear("pending");
    const marker = join(fixture.unblock, "decisions", `${RECIPIENT}.json`);
    const before = readFileSync(marker, "utf8");
    const root = activateProtocolFixture(fixture.layout);
    const exclusive = holdLock(join(fixture.layout.varDir, "work-protocol.lock"));
    try {
      const deferred = await captureAccounting(
        fixture.layout,
        { harness: "claude", history: {} },
        "resume",
        "snapshot",
        ["game-coordinator"],
      );
      expect(deferred).toMatchObject({ reason: "protocol-busy", status: "unavailable" });
    } finally {
      exclusive.release();
    }
    const report = await captureAccounting(
      fixture.layout,
      { harness: "claude", history: {}, queues: {} },
      "resume",
      "snapshot",
      ["game-coordinator"],
    );
    expect(report).toMatchObject({ accounting_ready: false, status: "available" });
    expect(report.pendingIntake?.offers?.length).toBeGreaterThan(0);
    expect(report.pendingIntake?.reason).toBe("protocol-writer-required");
    expect(JSON.stringify(report.observedGaps)).toContain("claude-native-history-unsupported");
    const journal = new LedgerStore({ directory: join(root, "accounting") });
    expect(journal.history()).toEqual([]);
    const reloaded = accountingIntake(fixture.layout).pending(journal.history());
    expect(reloaded.length).toBeGreaterThan(0);
    expect(
      accountingStatus(fixture.layout, ["game-coordinator"]).pendingIntake?.offers?.length,
    ).toBe(reloaded.length);
    expect(readFileSync(marker, "utf8")).toBe(before);
    expect(resolveProtocolLayout(fixture.layout)?.stateRoot).toBe(root);
  });

  it("defers journal admission without waiting when backup begins after durable intake", async () => {
    const fixture = claudeFixture();
    activateProtocolFixture(fixture.layout);
    const journal = new LedgerStore({
      ...ledgerStorageOptions(fixture.layout, undefined, { nonBlocking: true }),
      nonBlocking: true,
    });
    const input = transaction();
    if (input.command.type !== "register") {
      throw new Error("register fixture required");
    }
    const offered = await offerAccounting(fixture.layout, {
      actor: input.actor,
      command: {
        type: "capture",
        coverage: [],
        requests: [{ ...input.command.request, summary: "Observed source awaiting owner review" }],
      },
      source: input.source,
    });
    const exclusive = holdLock(join(fixture.layout.varDir, "work-protocol.lock"));
    try {
      await expect(journal.apply(input)).rejects.toThrow("protocol-busy");
      expect(
        accountingIntake(fixture.layout)
          .pending([])
          .map((offer) => offer.id),
      ).toContain(offered.id);
      expect(journal.history()).toHaveLength(0);
    } finally {
      exclusive.release();
    }
  });

  it("retains pending intake and communication without admitting a legacy journal or clearing questions", async () => {
    const fixture = claudeFixture();
    fixture.clear("pending");
    const marker = join(fixture.unblock, "decisions", `${RECIPIENT}.json`);
    const before = readFileSync(marker, "utf8");
    const legacy = new LedgerStore(ledgerStorageOptions(fixture.layout));
    const staleMessages = new MessageStore({ layout: fixture.layout, resolveOwner: () => null });
    const channel = messageChannelStateDir(fixture.layout, RECIPIENT);
    await declareProtocolWorkspace(fixture.layout, {
      workspaceId: "managed-fixture",
      authorityRef: "fixture-explicit-managed-authority",
      expectedGeneration: 0,
    });
    expect(() => legacy.read()).toThrow("protocol-generation-conflict");
    expect(staleMessages.summary()).toMatchObject({ status: "unavailable" });
    expect(messageChannelStateDir(fixture.layout, RECIPIENT)).toBe(channel);
    const current = new LedgerStore(ledgerStorageOptions(fixture.layout));
    await expect(current.apply(transaction())).rejects.toThrow("protocol-enrollment-pending");
    const service = new MessageService({ layout: fixture.layout, env: {} });
    const sent = await service.send({
      id: "11619fb4-c059-454b-bf80-c1f5d63c6ac9",
      fromRole: "game-coordinator",
      recipient: "game-coordinator",
      body: "Exact pending fixture original\n",
    });
    expect(sent.state).toBe("queued");
    expect(service.status({ id: sent.envelope.id, includeBody: true })[0]?.body).toBe(
      sent.envelope.body,
    );
    const captured = await captureAccounting(
      fixture.layout,
      { harness: "claude", history: {} },
      "resume",
      "snapshot",
      ["game-coordinator"],
    );
    expect(captured).toMatchObject({
      status: "available",
      accounting_ready: false,
      workProtocol: { managedRequired: true, reason: "protocol-enrollment-pending" },
      pendingIntake: { reason: "protocol-enrollment-pending" },
    });
    expect(accountingIntake(fixture.layout).pending([]).length).toBeGreaterThan(0);
    expect(current.history()).toEqual([]);
    expect(readFileSync(marker, "utf8")).toBe(before);
  });

  it("keeps owner admission local and fails closed when enrollment is unavailable", async () => {
    const fixture = claudeFixture();
    const stateRoot = activateProtocolFixture(fixture.layout, {
      authorityRef: "fixture-managed-approval",
    });
    const protocol = runtimeProtocolStore(fixture.layout)!;
    await protocol.claim({
      at: AT,
      binding: BINDING,
      evidence: "fixture-owner",
      expectedEpoch: 0,
      role: "coordinator",
    });
    const source = {
      native: null,
      origin: "owner-attested" as const,
      reference: "fixture-owner-window",
      wordingHash: null,
    };
    await new LedgerStore(ledgerStorageOptions(fixture.layout)).apply({
      actor: "game-coordinator",
      at: AT,
      commandId: "owner-coverage",
      expectedRevision: 0,
      schema: 1,
      source,
      writer: { ...BINDING, epoch: 1 },
      command: {
        type: "coverage",
        coverage: {
          id: "owner-window",
          ownerRole: "game-coordinator",
          source,
          range: { from: "first", through: "last" },
          state: "covered",
          gaps: [],
          nextBoundary: null,
        },
      },
    });
    const evidence = await protocol.putArtifact(
      Buffer.from("fixture owner inspection; unsupported history remains unknown"),
    );
    const scope = resolveEnrollmentScope(fixture.layout, protocol, {
      workspaceId: "fixture",
      generation: 1,
      phase: "active",
      stateRoot,
    });
    const owner = scope.participants.find((participant) => participant.role === "coordinator")!;
    const enrollment = new EnrollmentStore({ protocol });
    await enrollment.publish(
      {
        id: "owner-enrollment",
        at: AT,
        role: owner.role,
        epoch: 1,
        binding: BINDING,
        expectedRevision: protocol.read(owner.role).revision,
      },
      {
        workspaceId: "fixture",
        generation: 1,
        phase: "active",
        registryRevision: scope.registryRevision,
        inspectedAt: AT,
        ledger: scope.ledgerAnchors.at(-1)!,
        references: owner.knownReferences,
        evidence: [evidence],
        unknowns: owner.requiredUnknownScopes.map((value) => ({
          id: `fixture-${value}`,
          participantRole: owner.role,
          parentRole: owner.role,
          scope: value,
          reason: "bounded fixture evidence only",
          nextBoundary: "next owner review",
          evidence: [evidence],
        })),
      },
      scope,
    );
    expect(accountingStatus(fixture.layout, ["game-coordinator"])).toMatchObject({
      accounting_ready: true,
      enrollment: { required: true, ready: true },
      workProtocol: { enrollment: { allAdopted: false, coverageComplete: false } },
    });
    expect(accountingStatus(fixture.layout, ["archies-dog-walks/tech"])).toMatchObject({
      enrollment: { required: true, ready: false },
    });
    const failingReport = vi
      .spyOn(EnrollmentStore.prototype, "report")
      .mockImplementationOnce(() => {
        throw new Error("fixture unreadable coverage");
      });
    try {
      expect(accountingStatus(fixture.layout, ["game-coordinator"])).toMatchObject({
        accounting_ready: false,
        enrollment: { required: true, ready: false },
        workProtocol: { status: "unavailable" },
      });
    } finally {
      failingReport.mockRestore();
    }
  });
});
