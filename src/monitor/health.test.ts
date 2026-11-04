import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { recordHealth } from "./health.ts";

const MONITOR = "00000000-0000-4000-8000-000000000001";

function snapshot(ids: string[]): Record<string, unknown> {
  return {
    errors: {},
    history: { [MONITOR]: { reason_code: "complete", status: "complete" } },
    process_health: {},
    process_health_source: { diagnostics: [], status: "disabled" },
    question_state: {},
    queues: {
      [MONITOR]: ids.map((id) => ({
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
    const first = recordHealth(context, MONITOR, 60, snapshot(["a"]), { status: "accepted" });
    expect(first).toMatchObject({
      backlog_slots: 1,
      monitor_status: "ok",
      process_health_status: "disabled",
    });
    const second = recordHealth(context, MONITOR, 120, snapshot(["a", "b"]), {
      status: "unchanged",
    });
    expect(second).toMatchObject({ backlog_slots: 2, monitor_status: "failed" });
    expect(second.monitor_reason).toContain("unacknowledged queue items");
    recordHealth(context, MONITOR, 180, snapshot(["a", "b"]), { status: "unchanged" });
    expect(events).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(unblock, "health", `${MONITOR}.json`), "utf8")) as {
      backlog_items: Record<string, Record<string, { age: number }>>;
    };
    expect(record.backlog_items[MONITOR]?.b?.age).toBe(2);
    const recovered = recordHealth(context, MONITOR, 240, snapshot([]), { status: "accepted" });
    expect(recovered).toMatchObject({ backlog_slots: 0, monitor_status: "ok" });
  });

  it("does not age a deferral explained by the recipient's own question", () => {
    const unblock = mkdtempSync(join(tmpdir(), "health-"));
    const context = { emit: () => undefined, unblock };
    for (const slot of [60, 120]) {
      const health = recordHealth(context, MONITOR, slot, snapshot([]), {
        status: "deferred",
        waiting_on_user: true,
      });
      expect(health).toMatchObject({ deferral_slots: 0, monitor_status: "ok" });
    }
  });
});
