import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { HarnessAdapter, HarnessCollectors } from "../adapters/types.ts";
import type { Harness } from "../registry/schema.ts";
import { captureCodex, captureMixed } from "./snapshot.ts";
import { payloadSignature, persist, queueEntry, retentionPath, snapshotPath } from "./store.ts";

const MONITOR = "00000000-0000-4000-8000-000000000001";
const CLAUDE = "00000000-0000-4000-8000-000000000002";
const CODEX_PARENT = "00000000-0000-4000-8000-000000000003";
const CLAUDE_PARENT = "00000000-0000-4000-8000-000000000004";

function context() {
  const busDir = mkdtempSync(join(tmpdir(), "mixed-snapshot-"));
  return { busDir, unblock: join(busDir, "unblock") };
}

function adapter(harness: Harness) {
  return {
    ack: vi.fn<HarnessAdapter["ack"]>(),
    collectors: {
      collect: vi.fn<HarnessCollectors["collect"]>(() =>
        Promise.resolve({
          collection_budget: {},
          history: {},
          question_state: {},
          worker_health: {},
        }),
      ),
    },
    deliver: vi.fn<HarnessAdapter["deliver"]>(),
    harness,
    inventory: vi.fn<HarnessAdapter["inventory"]>(() =>
      Promise.resolve({ entries: [{ payload: "work", queueId: "same-id" }], status: "available" }),
    ),
    status: vi.fn<HarnessAdapter["status"]>(),
  };
}

describe("mixed monitor capture", () => {
  it("keeps requested native coverage separate from an unrelated unsupported peer", async () => {
    const record = await captureMixed(
      context(),
      { codex: adapter("codex") },
      { [CLAUDE]: "claude", [MONITOR]: "codex" },
      [MONITOR],
      [],
      { routeMembers: [MONITOR, CLAUDE] },
    );
    expect(record.native_complete).toBe(true);
    expect(record.errors).toEqual({});
    expect(record.history).toMatchObject({ [CLAUDE]: { status: "unavailable" } });
  });

  it("reports cross-provider retention conflicts without treating either inventory as retained", async () => {
    const target = context();
    const entry = queueEntry("same-id", "work");
    for (const [recipient, harness] of [
      [MONITOR, "claude"],
      [CLAUDE, "codex"],
    ]) {
      persist(retentionPath(target.unblock, recipient as string, entry.id), {
        active: true,
        harness,
        payload_signature: payloadSignature(entry),
        queue_id: entry.id,
        recipient,
      });
    }
    const record = await captureMixed(
      target,
      { claude: adapter("claude"), codex: adapter("codex") },
      { [CLAUDE]: "claude", [MONITOR]: "codex" },
      [MONITOR, CLAUDE],
      [],
    );
    expect(record.queues).toMatchObject({
      [MONITOR]: [{ retained: false, retention_status: "conflicting_harness" }],
    });
    expect(record.channel_queues).toMatchObject({
      [CLAUDE]: [{ retained: false, retention_status: "conflicting_harness" }],
    });
  });

  it("partitions every native collector list and labels local channel inventory separately", async () => {
    const codex = adapter("codex");
    const claude = adapter("claude");
    const collect = vi.fn(() =>
      Promise.resolve({
        collection_budget: { calls_used: 1 },
        history: { [MONITOR]: { status: "complete" } },
        question_state: { [MONITOR]: { status: "complete" } },
        worker_health: { [CODEX_PARENT]: { status: "complete" } },
      }),
    );
    const target = context();
    const harnesses = {
      [CLAUDE]: "claude",
      [CLAUDE_PARENT]: "claude",
      [CODEX_PARENT]: "codex",
      [MONITOR]: "codex",
    } as const;
    const record = await captureMixed(
      target,
      { claude, codex: { ...codex, collectors: { collect } } },
      harnesses,
      [MONITOR, CLAUDE],
      [CODEX_PARENT, CLAUDE_PARENT],
      { routeMembers: Object.keys(harnesses), slot: 2 },
    );
    expect(codex.inventory.mock.calls).toEqual([[MONITOR]]);
    expect(claude.inventory.mock.calls).toEqual([[CLAUDE]]);
    expect(claude.collectors.collect).not.toHaveBeenCalled();
    expect(collect).toHaveBeenCalledWith({
      historyCursor: null,
      parents: [CODEX_PARENT],
      recipients: [MONITOR],
      routeMembers: [CODEX_PARENT, MONITOR],
      slot: 2,
      unblockDir: target.unblock,
    });
    expect(record).toMatchObject({
      channel_queues: { [CLAUDE]: [{ id: "same-id" }] },
      errors: {},
      harness: "codex",
      harnesses,
      history: { [CLAUDE]: { reason_code: "claude_no_native_api", status: "unavailable" } },
      native_queues: { [CLAUDE]: { status: "unavailable" } },
      native_complete: false,
      question_state: { [CLAUDE]: { status: "unavailable" } },
      queue_sources: { [CLAUDE]: "local_channel_delivered", [MONITOR]: "native_queue" },
      queues: { [MONITOR]: [{ id: "same-id" }] },
      slot: 2,
      worker_health: { [CLAUDE_PARENT]: { status: "unavailable" } },
    });
    expect(record.queues).not.toHaveProperty(CLAUDE);
    expect(
      JSON.parse(readFileSync(snapshotPath(target.unblock, String(record.snapshot_id)), "utf8")),
    ).toEqual(record);
  });

  it("omits unsupported native queues even when the local channel has no delivered entries", async () => {
    const claude = adapter("claude");
    claude.inventory.mockResolvedValue({ entries: [], status: "available" });
    const record = await captureMixed(context(), { claude }, { [CLAUDE]: "claude" }, [CLAUDE], []);
    expect(record.queues).toEqual({});
    expect(record.channel_queues).toEqual({ [CLAUDE]: [] });
    expect(record.errors).toEqual({});
    expect(record.native_complete).toBe(false);
    expect(claude.collectors.collect).not.toHaveBeenCalled();
  });

  it("does not invent local inventory when the Claude adapter is unavailable", async () => {
    const record = await captureMixed(context(), {}, { [CLAUDE]: "claude" }, [CLAUDE], []);
    expect(record.queues).toEqual({});
    expect(record.channel_queues).toEqual({});
    expect(record.queue_sources).toEqual({ [CLAUDE]: "local_channel_unavailable" });
    expect(record.errors).toEqual({});
  });

  it("rejects missing endpoint bindings and mismatched adapters before inventory calls", async () => {
    const codex = adapter("codex");
    await expect(captureMixed(context(), { codex }, {}, [MONITOR], [])).rejects.toThrow(
      "harness missing or invalid",
    );
    await expect(
      captureMixed(context(), { claude: codex }, { [CLAUDE]: "claude" }, [CLAUDE], []),
    ).rejects.toThrow("adapter harness mismatch");
    expect(codex.inventory).not.toHaveBeenCalled();
  });

  it("keeps a real Codex inventory failure blocking alongside unsupported Claude APIs", async () => {
    const codex = adapter("codex");
    codex.inventory.mockResolvedValue({ entries: [], reason: "incomplete", status: "unavailable" });
    const record = await captureMixed(
      context(),
      { codex },
      { [CLAUDE]: "claude", [MONITOR]: "codex" },
      [MONITOR, CLAUDE],
      [],
    );
    expect(record.errors).toHaveProperty(MONITOR);
    expect(record.errors).not.toHaveProperty(CLAUDE);
    expect(record.queues).not.toHaveProperty(MONITOR);
  });

  it("preserves homogeneous legacy capture fields without requiring a harness map", async () => {
    const codex = adapter("codex");
    const record = await captureCodex(context(), codex, [MONITOR], []);
    expect(record.harness).toBe("codex");
    expect(record).not.toHaveProperty("harnesses");
    expect(record.queues).toHaveProperty(MONITOR);
  });
});
