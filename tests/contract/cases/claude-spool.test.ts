// Claude monitor slots: receipts, spool bounds and guards. Slots are dispatched by the resident
// observer.
import { renameSync, rmSync } from "node:fs";
import { expect } from "vitest";

import {
  agents,
  ARCHIE,
  briefTarget,
  CHIBI,
  claudeGame,
  claudeRoute,
  clear,
  deliver,
  holdLock,
  MONITOR,
  slotRequestId,
  tick,
} from "../lib/claude-fixture.ts";
import {
  CASE_TIMEOUT_MS,
  contract,
  ROUTE_INVALID_MESSAGE,
  suite,
  workspaces,
} from "../lib/cases.ts";
import { at } from "../lib/time.ts";
import type { Workspace } from "../lib/workspace.ts";
import type { Json } from "../lib/json.ts";

const SLOT = at(20);
const NEXT = at(50);

function receipt(ws: Workspace, slot = SLOT): Json {
  return ws.readJson(`unblock/${MONITOR}-${slot}.json`);
}

function spooled(ws: Workspace): string[] {
  return ws.list("unblock", "claude-spool").filter((name) => name.endsWith(".json"));
}

function claimAll(ws: Workspace): void {
  for (const name of spooled(ws)) {
    renameSync(
      ws.path("unblock", "claude-spool", name),
      ws.path("unblock", "claude-spool", name.replace(/\.json$/, ".claimed")),
    );
  }
}

suite("claude monitor slots", () => {
  const workspace = workspaces();

  contract("idle and busy monitors spool one brief per slot with the slot request ID", async () => {
    const ws = workspace();
    claudeGame(ws);
    for (const [slot, mode] of [
      [SLOT, "idle"],
      [NEXT, "busy"],
    ] as const) {
      claimAll(ws);
      agents(ws, mode);
      const result = await tick(ws, slot);
      expect(result.monitor.map((row) => row.slot)).toEqual([slot]);
      expect(result.monitor[0]!.result.status).toBe("sending");
      expect(result.monitor[0]!.result.monitor_session_status).toBe(mode);
      const requestId = slotRequestId(MONITOR, slot);
      expect(receipt(ws, slot).requestId).toBe(requestId);
      const entry = ws.readJson<Record<string, string>>(`unblock/claude-spool/${requestId}.json`);
      expect(entry.receipt).toBe(`unblock/${MONITOR}-${slot}.json`);
      expect(entry.text).toContain(briefTarget(ws, "Archie tech", ARCHIE));
      expect(entry.text).not.toContain(CHIBI);
      expect(entry.text).toContain('"queue_inventory", "status": "unavailable"');
      expect(entry.text).toContain('"question_history", "status": "unavailable"');
    }
    expect(spooled(ws)).toHaveLength(1);
    agents(ws, "idle");
    const rerun = await tick(ws, NEXT);
    expect(rerun.monitor[0]!.result).toEqual({
      status: "deduplicated",
      previousStatus: "sending",
      reason: null,
    });
    expect(spooled(ws)).toHaveLength(1);
  });

  contract(
    "an unclaimed brief bounds the spool across later slots",
    async () => {
      const ws = workspace();
      claudeGame(ws);
      expect((await tick(ws, SLOT)).monitor[0]!.result.status).toBe("sending");
      for (const slot of [NEXT, at(20, 0, 1), at(50, 0, 1)]) {
        const result = await tick(ws, slot);
        expect(result.monitor[0]!.result.status).toBe("deferred");
        expect(String(result.monitor[0]!.result.reason)).toContain("earlier monitor brief");
        expect(receipt(ws, slot).status).toBe("deferred");
      }
      expect(spooled(ws)).toHaveLength(1);
      expect(receipt(ws).status).toBe("sending");
      await deliver(ws);
      expect(receipt(ws).status).toBe("accepted");
      expect((await tick(ws, at(20, 0, 2))).monitor[0]!.result.status).toBe("sending");
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "missing, blocked, unknown and unavailable monitors defer without spooling",
    async () => {
      const ws = workspace();
      claudeGame(ws);
      const cases = [
        [SLOT, "missing", "missing"],
        [NEXT, "blocked", "blocked"],
        [at(20, 0, 1), "fail", "listing unavailable"],
        [
          at(50, 0, 1),
          [{ sessionId: MONITOR, status: "waiting" }],
          "monitor session state unknown",
        ],
      ] as const;
      for (const [slot, mode, reason] of cases) {
        agents(ws, mode as never);
        const result = await tick(ws, slot);
        expect(result.monitor[0]!.result.status).toBe("deferred");
        expect(String(result.monitor[0]!.result.reason)).toContain(reason);
        expect(receipt(ws, slot).status).toBe("deferred");
        agents(ws, "idle");
        expect((await tick(ws, slot)).monitor[0]!.result.status).toBe("deduplicated");
      }
      expect(spooled(ws)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "recipient clearance and worker-parent route scope guard delivery",
    async () => {
      const ws = workspace();
      claudeGame(ws);
      clear(ws, MONITOR, "pending");
      expect(String((await tick(ws, SLOT)).monitor[0]!.result.reason)).toContain("clearance");
      clear(ws);
      ws.config.reports = { project: "Fixture", workerParents: ["chibi-tech"] };
      expect(String((await tick(ws, NEXT)).monitor[0]!.result.reason)).toContain("parents");
      ws.config.reports = { project: "Fixture", workerParents: ["archie-tech"] };
      const slot = at(20, 0, 1);
      expect((await tick(ws, slot)).monitor[0]!.result.status).toBe("sending");
      expect(receipt(ws, slot).diagnostics).toContainEqual({
        kind: "worker_health",
        parent: ARCHIE,
        status: "unavailable",
        reason_code: "claude_no_native_api",
      });
      expect(spooled(ws)).toHaveLength(1);
    },
    CASE_TIMEOUT_MS,
  );

  contract("an interrupted send becomes ambiguous and is never resent", async () => {
    const ws = workspace();
    claudeGame(ws);
    await tick(ws, SLOT);
    rmSync(ws.path("unblock", "claude-spool", spooled(ws)[0]!));
    const result = await tick(ws, SLOT);
    expect(result.monitor[0]!.result.previousStatus).toBe("ambiguous");
    expect(receipt(ws).status).toBe("ambiguous");
    expect(spooled(ws)).toEqual([]);
  });

  contract("a busy unblock lock and a held route write no receipt", async () => {
    const ws = workspace();
    claudeGame(ws);
    ws.write("unblock/unblock.lock", "");
    const release = await holdLock(ws.path("unblock", "unblock.lock"));
    try {
      expect((await tick(ws, SLOT)).monitor[0]!.result).toEqual({ status: "busy" });
    } finally {
      await release();
    }
    expect(ws.exists(`unblock/${MONITOR}-${SLOT}.json`)).toBe(false);
    ws.writeRoute(claudeRoute(ws, { state: "held" }));
    const held = await tick(ws, SLOT);
    expect(held.monitor).toEqual([]);
    expect(held.stderr).not.toContain("monitor deferred");
    expect(ws.exists(`unblock/${MONITOR}-${SLOT}.json`)).toBe(false);
  });

  contract("the observer spools, deduplicates a slot and defers an invalid route", async () => {
    const ws = workspace();
    claudeGame(ws);
    const first = await tick(ws, SLOT);
    expect(first.code, first.stderr).not.toBeNull();
    expect(first.stdout).toContain('"status": "sending"');
    expect(first.stdout).toContain('"monitor_session_status": "idle"');
    const duplicate = await tick(ws, SLOT);
    expect(duplicate.stdout).toContain("deduplicated");
    expect(spooled(ws)).toHaveLength(1);
    ws.writeRoute(claudeRoute(ws, { targets: [] }));
    const invalid = await tick(ws, NEXT);
    expect(invalid.stderr).toContain(ROUTE_INVALID_MESSAGE);
    expect(spooled(ws)).toHaveLength(1);
  });
});
