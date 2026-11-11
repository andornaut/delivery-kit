import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { HarnessAdapter } from "../adapters/types.ts";
import { acknowledge, DISPOSITIONS } from "./ack.ts";
import { captureCodex, captureMixed } from "./snapshot.ts";
import {
  ackPath,
  locked,
  payloadSignature,
  persist,
  queueEntry,
  retentionPath,
  snapshotPath,
} from "./store.ts";

const RECIPIENT = "00000000-0000-4000-8000-000000000003";
// sha256(json.dumps(["cm-native", [{"type": "text", "text": "hello"}]], sort_keys=True))
const NATIVE_DIGEST = "64bacfa5c81ed4b1e0596276e66e5c99d5da1466bcd2491ca8f443ddba9a2cc1";

function codex(): HarnessAdapter & { ack: ReturnType<typeof vi.fn> } {
  return {
    ack: vi.fn(() => Promise.resolve({ requestId: "r", status: "accepted" as const })),
    deliver: vi.fn(),
    harness: "codex",
    inventory: () =>
      Promise.resolve({
        entries: [{ clientUserMessageId: "cm-native", payload: "hello", queueId: "q-1" }],
        status: "available" as const,
      }),
    status: vi.fn(),
  };
}

describe("Codex acknowledgements", () => {
  it("bind retentions and removals to the native 0.9.x payload digest", async () => {
    const busDir = mkdtempSync(join(tmpdir(), "ack-"));
    const unblock = join(busDir, "unblock");
    const adapter = codex();
    const snapshot = await locked(unblock, () =>
      captureCodex({ busDir, unblock }, adapter, [RECIPIENT], []),
    );
    const id = snapshot.snapshot_id as string;
    const retained = await acknowledge(adapter, unblock, {
      disposition: "retained",
      queueIds: ["q-1"],
      reason: "waiting on Tech",
      recipient: RECIPIENT,
      snapshotId: id,
    });
    expect(retained).toEqual([{ queue_id: "q-1", state: "retained" }]);
    const [retention] = readdirSync(join(unblock, "retentions"));
    const record = JSON.parse(
      readFileSync(join(unblock, "retentions", retention ?? ""), "utf8"),
    ) as Record<string, unknown>;
    expect(record.payload_signature).toBe(NATIVE_DIGEST);

    // A disposition is fixed per snapshot, so the removal uses a fresh one.
    const fresh = await locked(unblock, () =>
      captureCodex({ busDir, unblock }, adapter, [RECIPIENT], []),
    );
    const handled = await acknowledge(adapter, unblock, {
      disposition: "handled",
      queueIds: ["q-1"],
      recipient: RECIPIENT,
      snapshotId: fresh.snapshot_id as string,
    });
    expect(handled).toEqual([{ queue_id: "q-1", state: "deleted" }]);
    expect(adapter.ack).toHaveBeenCalledWith(RECIPIENT, "q-1", "hello", "handled", undefined);
  });
});

describe("mixed snapshot acknowledgement binding", () => {
  describe.each(["other provider", "legacy other provider", "unknown", "inactive other provider"])(
    "preserves %s retention bytes",
    (binding) => {
      it.each(DISPOSITIONS)(
        "blocks %s before inventory or retention mutation",
        async (disposition) => {
          const busDir = mkdtempSync(join(tmpdir(), "mixed-retention-ack-"));
          const unblock = join(busDir, "unblock");
          const adapter = codex();
          const captured = await captureMixed(
            { busDir, unblock },
            { codex: adapter },
            { [RECIPIENT]: "codex" },
            [RECIPIENT],
            [],
          );
          const entry = { ...queueEntry("q-1", "hello"), clientUserMessageId: "cm-native" };
          const path = retentionPath(unblock, RECIPIENT, entry.id);
          persist(path, {
            active: binding !== "inactive other provider",
            ...(binding === "other provider" || binding === "inactive other provider"
              ? { harness: "claude" }
              : {}),
            payload_signature: payloadSignature(entry),
            queue_id: entry.id,
            recipient: RECIPIENT,
            snapshot_id: "original",
          });
          if (binding === "legacy other provider") {
            persist(snapshotPath(unblock, "original"), {
              harness: "claude",
              snapshot_id: "original",
            });
          }
          const before = readFileSync(path);
          const inventory = vi.spyOn(adapter, "inventory");
          const results = await acknowledge(adapter, unblock, {
            disposition,
            queueIds: [entry.id],
            reason: "review later",
            recipient: RECIPIENT,
            snapshotId: captured.snapshot_id as string,
          });
          expect(results).toEqual([
            {
              queue_id: entry.id,
              state:
                binding === "unknown" ? "retention_binding_unknown" : "retention_harness_conflict",
            },
          ]);
          expect(readFileSync(path)).toEqual(before);
          expect(inventory).not.toHaveBeenCalled();
          expect(adapter.ack).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("rejects the other harness before reading or deleting an identical queue ID", async () => {
    const busDir = mkdtempSync(join(tmpdir(), "mixed-ack-"));
    const unblock = join(busDir, "unblock");
    const original = codex();
    const captured = await captureMixed(
      { busDir, unblock },
      { codex: original },
      { [RECIPIENT]: "codex" },
      [RECIPIENT],
      [],
    );
    const inventory = vi.fn(original.inventory);
    const retargeted: HarnessAdapter = { ...codex(), harness: "claude", inventory };
    await expect(
      acknowledge(retargeted, unblock, {
        disposition: "handled",
        queueIds: ["q-1"],
        recipient: RECIPIENT,
        snapshotId: captured.snapshot_id as string,
      }),
    ).rejects.toThrow("snapshot recipient mismatch");
    expect(inventory).not.toHaveBeenCalled();
    expect(retargeted.ack).not.toHaveBeenCalled();
  });

  it("acknowledges local channel entries using their Claude binding in a Codex recipient snapshot", async () => {
    const busDir = mkdtempSync(join(tmpdir(), "mixed-ack-"));
    const unblock = join(busDir, "unblock");
    const codexRecipient = "00000000-0000-4000-8000-000000000001";
    const claude: HarnessAdapter = { ...codex(), harness: "claude" };
    const native = codex();
    const captured = await captureMixed(
      { busDir, unblock },
      { claude, codex: native },
      { [codexRecipient]: "codex", [RECIPIENT]: "claude" },
      [codexRecipient, RECIPIENT],
      [],
    );
    expect(captured.harness).toBe("codex");
    const results = await acknowledge(claude, unblock, {
      disposition: "handled",
      queueIds: ["q-1"],
      recipient: RECIPIENT,
      snapshotId: captured.snapshot_id as string,
    });
    expect(results).toEqual([{ queue_id: "q-1", state: "deleted" }]);
    expect(claude.ack).toHaveBeenCalledWith(RECIPIENT, "q-1", "hello", "handled", undefined);
    expect(native.ack).not.toHaveBeenCalled();
  });

  it("refuses an old recipient ID after selection retargets to a different conversation", async () => {
    const busDir = mkdtempSync(join(tmpdir(), "mixed-ack-"));
    const unblock = join(busDir, "unblock");
    const adapter = codex();
    const captured = await captureCodex({ busDir, unblock }, adapter, [RECIPIENT], []);
    await expect(
      acknowledge(adapter, unblock, {
        disposition: "handled",
        queueIds: ["q-1"],
        recipient: "00000000-0000-4000-8000-000000000009",
        snapshotId: captured.snapshot_id as string,
      }),
    ).rejects.toThrow("snapshot recipient mismatch");
    expect(adapter.ack).not.toHaveBeenCalled();
  });

  it("does not fall back to the snapshot-wide harness when a mixed binding is missing", async () => {
    const busDir = mkdtempSync(join(tmpdir(), "mixed-ack-"));
    const unblock = join(busDir, "unblock");
    const adapter = codex();
    const captured = await captureCodex({ busDir, unblock }, adapter, [RECIPIENT], []);
    persist(snapshotPath(unblock, captured.snapshot_id as string), { ...captured, harnesses: {} });
    await expect(
      acknowledge(adapter, unblock, {
        disposition: "handled",
        queueIds: ["q-1"],
        recipient: RECIPIENT,
        snapshotId: captured.snapshot_id as string,
      }),
    ).rejects.toThrow("snapshot recipient mismatch");
    expect(adapter.ack).not.toHaveBeenCalled();
  });

  it("refuses a durable operation written for another harness before touching inventory", async () => {
    const busDir = mkdtempSync(join(tmpdir(), "mixed-ack-"));
    const unblock = join(busDir, "unblock");
    const adapter = codex();
    const captured = await captureCodex({ busDir, unblock }, adapter, [RECIPIENT], []);
    const snapshotId = captured.snapshot_id as string;
    persist(ackPath(unblock, RECIPIENT, snapshotId, "q-1"), {
      disposition: "handled",
      harness: "claude",
      queue_id: "q-1",
      recipient: RECIPIENT,
      snapshot_id: snapshotId,
    });
    await expect(
      acknowledge(adapter, unblock, {
        disposition: "handled",
        queueIds: ["q-1"],
        recipient: RECIPIENT,
        snapshotId,
      }),
    ).rejects.toThrow("transport binding differs");
    expect(adapter.ack).not.toHaveBeenCalled();
  });
});
