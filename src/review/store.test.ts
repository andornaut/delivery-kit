import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  payloadSignature,
  persist,
  queueEntry,
  retained,
  retentionPath,
  retentionStatus,
  snapshotPath,
} from "./store.ts";

const RECIPIENT = "00000000-0000-4000-8000-000000000003";

function fixture(extra: Record<string, unknown> = {}) {
  const unblock = mkdtempSync(join(tmpdir(), "retention-binding-"));
  const entry = queueEntry("same-id", "same payload");
  const path = retentionPath(unblock, RECIPIENT, entry.id);
  persist(path, {
    active: true,
    payload_signature: payloadSignature(entry),
    queue_id: entry.id,
    recipient: RECIPIENT,
    ...extra,
  });
  return { entry, path, unblock };
}

describe("harness-bound retention", () => {
  it("does not accept an identical payload retained by the other provider or mutate its record", () => {
    const { entry, path, unblock } = fixture({ harness: "claude" });
    const before = readFileSync(path);
    expect(retentionStatus(unblock, "codex", RECIPIENT, entry)).toBe("conflicting_harness");
    expect(retentionStatus(unblock, "claude", RECIPIENT, entry)).toBe("retained");
    expect(readFileSync(path)).toEqual(before);
  });

  it.each(["mixed"])("recovers a legacy binding from its %s durable snapshot", (kind) => {
    const { entry, unblock } = fixture({ snapshot_id: "original" });
    persist(snapshotPath(unblock, "original"), {
      harness: "codex",
      ...(kind === "mixed" ? { harnesses: { [RECIPIENT]: "claude" } } : {}),
      snapshot_id: "original",
    });
    const harness = kind === "mixed" ? "claude" : "codex";
    expect(retentionStatus(unblock, harness, RECIPIENT, entry)).toBe("retained");
    expect(
      retentionStatus(unblock, harness === "claude" ? "codex" : "claude", RECIPIENT, entry),
    ).toBe("conflicting_harness");
  });

  it("keeps unprovable legacy binding unknown while preserving the three-argument API", () => {
    const { entry, path, unblock } = fixture({ snapshot_id: "missing" });
    const before = readFileSync(path);
    expect(retentionStatus(unblock, "codex", RECIPIENT, entry)).toBe("unknown");
    expect(retained(unblock, RECIPIENT, entry)).toBe(true);
    expect(readFileSync(path)).toEqual(before);
  });

  it("does not use the global harness to fill a missing mixed snapshot binding", () => {
    const { entry, unblock } = fixture({ snapshot_id: "original" });
    persist(snapshotPath(unblock, "original"), {
      harness: "codex",
      harnesses: {},
      snapshot_id: "original",
    });
    expect(retentionStatus(unblock, "codex", RECIPIENT, entry)).toBe("unknown");
  });
});
