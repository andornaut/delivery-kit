import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { accountingStatus, captureAccounting } from "../accounting/boundary.ts";
import { LedgerStore } from "../accounting/store.ts";
import type { LedgerTransaction } from "../accounting/types.ts";
import { holdLock, LockBusy } from "../lock.ts";
import { MessageStore } from "../messages/store.ts";
import { claudeFixture, RECIPIENT } from "../review/fixtures.ts";
import { resolveProtocolLayout } from "./layout.ts";
import { accountingIntake, ledgerStorageOptions, runtimeProtocolStore } from "./runtime.ts";
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
});
