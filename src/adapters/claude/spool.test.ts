import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { holdLock } from "../../lock.ts";
import {
  activeRoute,
  type ClaudeFixture,
  claudeFixture,
  idle,
  MONITOR,
  SLOT,
  TECH,
} from "../../monitor/fixtures.ts";
import { eventRequestId, slotRequestId } from "../shared/ids.ts";
import type { ActiveScope } from "../shared/route.ts";
import { deliverPending } from "./channel.ts";
import { spoolDir, spoolEvent, spoolMonitorBrief } from "./spool.ts";

type Active = ActiveScope;

function active(fixture: ClaudeFixture): Active {
  const route = activeRoute(fixture);
  return route;
}

function receipt(fixture: ClaudeFixture, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixture.unblock, name), "utf8")) as Record<string, unknown>;
}

function spooled(fixture: ClaudeFixture): string[] {
  const spool = spoolDir(fixture.game.busDir);
  return existsSync(spool) ? readdirSync(spool).filter((name) => name.endsWith(".json")) : [];
}

function brief(
  fixture: ClaudeFixture,
  slot = SLOT,
  parents: string[] = [],
): Record<string, unknown> {
  return spoolMonitorBrief(
    fixture.env,
    fixture.game.busDir,
    active(fixture),
    slot,
    parents,
  ) as unknown as Record<string, unknown>;
}

function claimAll(fixture: ClaudeFixture): void {
  const spool = spoolDir(fixture.game.busDir);
  for (const name of spooled(fixture)) {
    renameSync(join(spool, name), join(spool, name.replace(/\.json$/, ".claimed")));
  }
}

describe("spoolMonitorBrief", () => {
  it("writes the sending receipt and one spool entry keyed by the slot request ID", () => {
    const fixture = claudeFixture();
    fixture.agents([{ kind: "interactive", sessionId: MONITOR, status: "busy" }, idle(TECH)]);
    const state = brief(fixture);
    expect(state).toMatchObject({
      method: "claude-channel",
      monitor_session_status: "busy",
      status: "sending",
    });
    const requestId = slotRequestId(MONITOR, SLOT);
    expect(receipt(fixture, `${MONITOR}-${SLOT}.json`).requestId).toBe(requestId);
    const entry = JSON.parse(
      readFileSync(join(spoolDir(fixture.game.busDir), `${requestId}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(entry).toMatchObject({
      kind: "monitor",
      receipt: `unblock/${MONITOR}-${SLOT}.json`,
      slot: SLOT,
    });
    expect(entry.text).toContain(`archies-dog-walks/tech: ${TECH}`);
    expect(entry.text).not.toContain("chibis-way-home/tech");
    expect(entry.text).toContain(
      '{"kind": "queue_inventory", "status": "unavailable", "reason_code": "claude_no_native_api"}',
    );
    expect(entry.text).toContain(`"session_id": "${TECH}", "status": "unavailable"`);
    expect(brief(fixture)).toEqual({
      previousStatus: "sending",
      reason: null,
      status: "deduplicated",
    });
    expect(spooled(fixture)).toHaveLength(1);
  });

  it("defers a missing, blocked, unknown or unlisted monitor without spooling", () => {
    const fixture = claudeFixture();
    const cases: [number, Parameters<ClaudeFixture["agents"]>[0], string][] = [
      [SLOT, [], "missing"],
      [SLOT + 1, [{ kind: "background", sessionId: MONITOR, state: "blocked" }], "blocked"],
      [SLOT + 2, [{ sessionId: MONITOR, status: "waiting" }], "unknown"],
      [SLOT + 3, "fail", "listing unavailable"],
    ];
    for (const [slot, rows, reason] of cases) {
      fixture.agents(rows);
      const state = brief(fixture, slot);
      expect(state.status).toBe("deferred");
      expect(state.reason).toContain(reason);
      expect(receipt(fixture, `${MONITOR}-${slot}.json`).status).toBe("deferred");
      fixture.agents([idle()]);
      expect(brief(fixture, slot).status).toBe("deduplicated");
    }
    expect(spooled(fixture)).toEqual([]);
  });

  it("requires clearance and route-scoped parents, and reports parents unavailable", () => {
    const fixture = claudeFixture();
    fixture.clear("pending");
    expect(brief(fixture).reason).toContain("clearance");
    fixture.clear();
    expect(brief(fixture, SLOT + 1, ["00000000-0000-4000-8000-00000000000f"]).reason).toContain(
      "parents",
    );
    const state = brief(fixture, SLOT + 2, [TECH]);
    expect(state.status).toBe("sending");
    expect(state.diagnostics).toContainEqual({
      kind: "worker_health",
      parent: TECH,
      reason_code: "claude_no_native_api",
      status: "unavailable",
    });
  });

  it("turns an interrupted send into ambiguous without resending", () => {
    const fixture = claudeFixture();
    brief(fixture);
    unlinkSync(join(spoolDir(fixture.game.busDir), spooled(fixture)[0] as string));
    expect(brief(fixture)).toMatchObject({ previousStatus: "ambiguous", status: "deduplicated" });
    expect(receipt(fixture, `${MONITOR}-${SLOT}.json`).status).toBe("ambiguous");
    expect(spooled(fixture)).toEqual([]);
  });

  it("bounds the spool to one unclaimed brief across slots", async () => {
    const fixture = claudeFixture();
    expect(brief(fixture).status).toBe("sending");
    for (let slot = SLOT + 1800; slot < SLOT + 1800 * 4; slot += 1800) {
      expect(brief(fixture, slot).reason).toContain("earlier monitor brief");
    }
    expect(spooled(fixture)).toHaveLength(1);
    await deliverPending(() => undefined, fixture.game.busDir, MONITOR);
    expect(brief(fixture, SLOT + 1800 * 5).status).toBe("sending");
    claimAll(fixture);
  });

  it("reports busy while another holder has unblock.lock", () => {
    const fixture = claudeFixture();
    const lock = holdLock(join(fixture.unblock, "unblock.lock"));
    try {
      expect(brief(fixture)).toEqual({ status: "busy" });
    } finally {
      lock.release();
    }
    expect(existsSync(join(fixture.unblock, `${MONITOR}-${SLOT}.json`))).toBe(false);
  });
});

describe("spoolEvent", () => {
  const EVENT = "e".repeat(64);

  function receiptPath(fixture: ClaudeFixture): string {
    return join(fixture.game.busDir, "events", "native", `${EVENT}-${MONITOR}.json`);
  }

  function send(fixture: ClaudeFixture): boolean {
    return spoolEvent(
      fixture.env,
      fixture.game.busDir,
      receiptPath(fixture),
      MONITOR,
      EVENT,
      "PRIVATE_EVENT",
    );
  }

  function eventReceipt(fixture: ClaudeFixture): Record<string, unknown> {
    return JSON.parse(readFileSync(receiptPath(fixture), "utf8")) as Record<string, unknown>;
  }

  it("spools once, deduplicates while pending and reports accepted after delivery", async () => {
    const fixture = claudeFixture();
    expect(send(fixture)).toBe(false);
    expect(eventReceipt(fixture)).toMatchObject({
      attempts: [{ method: "claude-channel", status: "sending" }],
      clientUserMessageId: eventRequestId(EVENT, MONITOR),
      status: "sending",
    });
    expect(readFileSync(receiptPath(fixture), "utf8")).not.toContain("PRIVATE_EVENT");
    expect(send(fixture)).toBe(false);
    expect(spooled(fixture)).toHaveLength(1);
    const lines: string[] = [];
    expect(
      await deliverPending((line) => void lines.push(line), fixture.game.busDir, MONITOR),
    ).toBe(true);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      params: { content: "PRIVATE_EVENT", meta: { event_id: EVENT, kind: "event" } },
    });
    expect(eventReceipt(fixture)).toMatchObject({
      attempts: [{ status: "accepted" }],
      status: "accepted",
    });
    expect(send(fixture)).toBe(true);
    expect(spooled(fixture)).toEqual([]);
  });

  it("turns an interrupted send into ambiguous and never resends", () => {
    const fixture = claudeFixture();
    send(fixture);
    unlinkSync(join(spoolDir(fixture.game.busDir), spooled(fixture)[0] as string));
    expect(send(fixture)).toBe(false);
    expect(eventReceipt(fixture)).toMatchObject({
      attempts: [{ status: "ambiguous" }],
      status: "ambiguous",
    });
    expect(send(fixture)).toBe(false);
    expect(spooled(fixture)).toEqual([]);
  });

  it("defers without clearance or an available monitor", () => {
    const fixture = claudeFixture();
    fixture.agents([]);
    expect(send(fixture)).toBe(false);
    expect(eventReceipt(fixture).status).toBe("deferred");
    fixture.agents([idle()]);
    fixture.clear("pending");
    expect(send(fixture)).toBe(false);
    expect(spooled(fixture)).toEqual([]);
    fixture.clear();
    expect(send(fixture)).toBe(false);
    expect(spooled(fixture)).toHaveLength(1);
  });
});
