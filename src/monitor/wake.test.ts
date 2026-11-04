import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type FakeHandler, startFakeControl } from "../adapters/codex/testControlSocket.ts";
import { readRegistry, updateRegistry } from "../registry/index.ts";
import { type ClaudeFixture, claudeFixture, GAME, MONITOR, SLOT, TECH } from "./fixtures.ts";
import { DEFERRED_PREFIX, deliverScheduledWake } from "./wake.ts";

function useEnv(fixture: ClaudeFixture): void {
  for (const [key, value] of Object.entries(fixture.env)) {
    vi.stubEnv(key, value ?? "");
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deliverScheduledWake (claude)", () => {
  it("spools one brief for the registry monitor and deduplicates the slot", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    const first = await deliverScheduledWake(fixture.layout, fixture.game, SLOT);
    expect(first).toBe('{"status": "sending", "monitor_session_status": "idle"}');
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe(
      '{"status": "deduplicated", "previousStatus": "sending", "reason": null}',
    );
    const receipt = JSON.parse(
      readFileSync(join(fixture.unblock, `${MONITOR}-${SLOT}.json`), "utf8"),
    ) as {
      diagnostics: { kind: string; parent?: string }[];
    };
    expect(receipt.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "worker_health", parent: MONITOR }),
    );
  });

  it("does not dispatch from a nonhost project", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    fixture.route({ host: "chibis-way-home" });
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe("");
  });

  it("defers when the route monitor has no conversation for the active harness", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    fixture.route({ monitor: "art-kit" });
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toContain(
      "monitor has no conversation for the active harness",
    );
    expect(existsSync(join(fixture.unblock, `${MONITOR}-${SLOT}.json`))).toBe(false);
  });

  it("defers on an invalid route that names a conversation ID", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    fixture.route({ monitor: MONITOR });
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe(
      `${DEFERRED_PREFIX}monitor route is unavailable or invalid; ` +
        "its owner must verify identities and ownership",
    );
    expect(existsSync(join(fixture.unblock, `${MONITOR}-${SLOT}.json`))).toBe(false);
  });

  it("defers when the route is unreadable", async () => {
    const fixture = claudeFixture();
    writeFileSync(fixture.layout.routeFile, "not json");
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe(
      `${DEFERRED_PREFIX}monitor route is unavailable or invalid; ` +
        "its owner must verify identities and ownership",
    );
  });
});

describe("deliverScheduledWake (codex)", () => {
  function codexFixture(): ClaudeFixture {
    const fixture = claudeFixture();
    const registry = readRegistry(fixture.layout);
    updateRegistry(fixture.layout, registry.revision, (draft) => {
      draft.harness = "codex";
      const gameDev = draft.roles["game-dev"];
      if (gameDev !== undefined) {
        gameDev.conversations.codex = MONITOR;
      }
      const tech = draft.roles["archies-dog-walks/tech"];
      if (tech !== undefined) {
        tech.conversations.codex = TECH;
      }
    });
    writeFileSync(
      fixture.layout.routeFile,
      JSON.stringify({
        host: GAME,
        monitor: "game-dev",
        schema: 1,
        state: "active",
        targets: ["archies-dog-walks/tech"],
      }),
    );
    return fixture;
  }

  function handler(steers: Record<string, unknown>[]): FakeHandler {
    return (method, params) => {
      switch (method) {
        case "thread/queue/list":
          return {
            result: {
              data:
                params.threadId === TECH
                  ? [{ clientUserMessageId: "q1", id: "q1", input: [{ text: "p", type: "text" }] }]
                  : [],
            },
          };
        case "thread/read":
          return {
            result: {
              thread: { canAcceptDirectInput: true, status: { activeFlags: [], type: "active" } },
            },
          };
        case "thread/turns/list":
          return { result: { data: [{ id: "turn-one", status: "inProgress" }] } };
        case "turn/steer":
          steers.push(params);
          return { result: { turnId: params.expectedTurnId } };
        default:
          return { result: { data: [] } };
      }
    };
  }

  it("reminds the registry monitor once over one connection and deduplicates the slot", async () => {
    const fixture = codexFixture();
    const steers: Record<string, unknown>[] = [];
    const control = await startFakeControl(fixture.base, handler(steers));
    vi.stubEnv("CODEX_CONTROL_SOCKET", control.path);
    try {
      const first = JSON.parse(
        await deliverScheduledWake(fixture.layout, fixture.game, SLOT),
      ) as Record<string, unknown>;
      expect(first).toMatchObject({ monitor_status: "ok", recipient: MONITOR, status: "accepted" });
      expect(steers).toHaveLength(1);
      expect(steers[0]?.clientUserMessageId).toBe("7abe3e43-9217-5727-9bc2-9b9c22636262");
      const text = JSON.stringify(steers[0]?.input);
      expect(text).toContain(`${TECH}: q1`);
      expect(text).toContain(`${MONITOR}: none`);
      const receipt = JSON.parse(
        readFileSync(join(fixture.unblock, `${MONITOR}-${SLOT}.json`), "utf8"),
      ) as Record<string, unknown>;
      expect(receipt).toMatchObject({ attempt: 1, method: "turn/steer", status: "accepted" });
      const second = JSON.parse(
        await deliverScheduledWake(fixture.layout, fixture.game, SLOT),
      ) as Record<string, unknown>;
      expect(second).toMatchObject({ previousStatus: "accepted", status: "deduplicated" });
      expect(steers).toHaveLength(1);
    } finally {
      await control.close();
    }
  });

  it("defers without clearance and without an available socket", async () => {
    const fixture = codexFixture();
    const steers: Record<string, unknown>[] = [];
    const control = await startFakeControl(fixture.base, handler(steers));
    vi.stubEnv("CODEX_CONTROL_SOCKET", control.path);
    try {
      fixture.clear("pending");
      expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toContain(
        '"status": "deferred"',
      );
      expect(steers).toEqual([]);
    } finally {
      await control.close();
    }
    vi.stubEnv("CODEX_CONTROL_SOCKET", join(fixture.base, "missing.sock"));
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT + 60)).toContain(
      "CODEX_CONTROL_SOCKET",
    );
    vi.stubEnv("CODEX_CONTROL_SOCKET", "relative.sock");
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT + 120)).toBe(
      `${DEFERRED_PREFIX}provide CODEX_CONTROL_SOCKET and the installed unblock helper`,
    );
  });

  it("defers an unreadable or 0.x route and records no slot", async () => {
    const fixture = codexFixture();
    vi.stubEnv("CODEX_CONTROL_SOCKET", join(fixture.base, "missing.sock"));
    for (const content of ["", "not json", JSON.stringify({ harness: "codex", version: 1 })]) {
      writeFileSync(fixture.layout.routeFile, content);
      // Each route variant is checked in turn against the same fixture.
      // eslint-disable-next-line no-await-in-loop
      expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe(
        `${DEFERRED_PREFIX}monitor route is unavailable or invalid; ` +
          "its owner must verify identities and ownership",
      );
    }
    expect(existsSync(join(fixture.unblock, `${MONITOR}-${SLOT}.json`))).toBe(false);
  });
});
