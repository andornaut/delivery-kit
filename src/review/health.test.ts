import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { recordHealth } from "./health.ts";

const RECIPIENT = "00000000-0000-4000-8000-000000000001";

function snapshot(ids: string[]): Record<string, unknown> {
  return {
    errors: {},
    history: { [RECIPIENT]: { reason_code: "complete", status: "complete" } },
    question_state: {},
    queues: {
      [RECIPIENT]: ids.map((id) => ({
        clientUserMessageId: id,
        id,
        input: [{ text: id, type: "text" }],
      })),
    },
    snapshot_id: "00000000-0000-4000-8000-0000000000aa",
    worker_health: {},
  };
}

describe("recordHealth", () => {
  it("ages items across distinct slots and reports one episode", () => {
    const unblock = mkdtempSync(join(tmpdir(), "health-"));
    const events: string[] = [];
    const context = { emit: (_kind: string, key: string) => events.push(key), unblock };
    const first = recordHealth(context, RECIPIENT, 60, snapshot(["a"]), { status: "accepted" });
    expect(first).toMatchObject({ backlog_slots: 1, review_status: "ok" });
    expect(first).not.toHaveProperty("process_health_status");
    const second = recordHealth(context, RECIPIENT, 120, snapshot(["a", "b"]), {
      status: "unchanged",
    });
    expect(second).toMatchObject({ backlog_slots: 2, review_status: "failed" });
    expect(second.review_reason).toContain("unacknowledged queue items");
    recordHealth(context, RECIPIENT, 180, snapshot(["a", "b"]), { status: "unchanged" });
    expect(events).toHaveLength(1);
    const record = JSON.parse(
      readFileSync(join(unblock, "health", `${RECIPIENT}.json`), "utf8"),
    ) as {
      backlog_items: Record<string, Record<string, { age: number }>>;
    };
    expect(record.backlog_items[RECIPIENT]?.b?.age).toBe(2);
    const recovered = recordHealth(context, RECIPIENT, 240, snapshot([]), { status: "accepted" });
    expect(recovered).toMatchObject({ backlog_slots: 0, review_status: "ok" });
  });

  it("does not age a deferral explained by the recipient's own question", () => {
    const unblock = mkdtempSync(join(tmpdir(), "health-"));
    const context = { emit: () => undefined, unblock };
    for (const slot of [60, 120]) {
      const health = recordHealth(context, RECIPIENT, slot, snapshot([]), {
        status: "deferred",
        waiting_on_user: true,
      });
      expect(health).toMatchObject({ deferral_slots: 0, review_status: "ok" });
    }
  });

  it("keeps the process keys of an older health record and ignores them in a snapshot", () => {
    const unblock = mkdtempSync(join(tmpdir(), "health-"));
    const context = { emit: () => undefined, unblock };
    const path = join(unblock, "health", `${RECIPIENT}.json`);
    const older = { accepted_process_requests: [["p"]], process_observations: [], seen_slots: [] };
    mkdirSync(join(unblock, "health"));
    writeFileSync(path, JSON.stringify(older));
    const legacy = {
      ...snapshot([]),
      process_health: { [RECIPIENT]: { jobs: [{ state: "stalled" }], status: "degraded" } },
      process_health_source: { status: "unavailable" },
    };
    const health = recordHealth(context, RECIPIENT, 60, legacy, { status: "accepted" });
    expect(health).toMatchObject({ review_status: "ok" });
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(record.accepted_process_requests).toEqual([["p"]]);
    expect(record.process_observations).toEqual([]);
  });
});
