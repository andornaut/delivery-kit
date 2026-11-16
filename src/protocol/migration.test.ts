import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as durable from "../durable.ts";
import { loadLayout } from "../layout.ts";
import { messageEnvelope } from "../messages/envelope.ts";
import { createRegistry, type Registry } from "../registry/index.ts";
import { CLAUDE_COORDINATOR, makeFixture, registryInput } from "../testFixtures.ts";
import { ProtocolStore } from "./core.ts";
import { resolveProtocolLayout } from "./layout.ts";
import { ProtocolMessages } from "./messages.ts";
import {
  activateProtocol,
  backupProtocol,
  importProtocolMigration,
  importProtocolOriginals,
  inventoryProtocol,
  planProtocolMigration,
  type ProtocolParticipant,
  restoreProtocol,
} from "./migration.ts";

const AT = "2026-11-16T04:00:00.000Z";
const BINDING = { harness: "claude" as const, nativeId: CLAUDE_COORDINATOR };
function fixture() {
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

describe("explicit initial protocol migration", () => {
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
    const active = await activateProtocol(t.layout, final);
    expect(store.history("coordinator")).toEqual(historyBefore);
    expect(active?.stateRoot).toBe(t.stateRoot);
    expect(readFileSync(join(t.layout.varDir, "work-protocol-fence.json"))).toEqual(
      readFileSync(join(t.layout.varDir, "work-protocol.json")),
    );
    expect(await activateProtocol(t.layout, final)).toEqual(active);
    expect(() =>
      planProtocolMigration(t.layout, {
        expectedGeneration: 1,
        stateRoot: join(t.base, "relocation"),
        workspaceId: "fixture",
      }),
    ).toThrow("migration-already-active");
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
