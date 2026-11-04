import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { HarnessAdapter } from "../adapters/types.ts";
import { acknowledge } from "./ack.ts";
import { captureCodex } from "./snapshot.ts";
import { locked } from "./store.ts";

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
