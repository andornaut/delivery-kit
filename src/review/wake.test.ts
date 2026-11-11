import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type FakeHandler, startFakeControl } from "../adapters/codex/testControlSocket.ts";
import { ROUTE_SCHEMA_1 } from "../adapters/shared/route.ts";
import { gameLayout } from "../layout.ts";
import { readRegistry, updateRegistry } from "../registry/index.ts";
import { projectConfig, writeFixtureJson } from "../testFixtures.ts";
import { type ClaudeFixture, claudeFixture, GAME, RECIPIENT, SLOT, TECH } from "./fixtures.ts";
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
  it("uses the Claude recipient transport while the global default remains Codex", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    updateRegistry(fixture.layout, 1, (draft) => {
      draft.harness = "codex";
      draft.roles["game-dev"]!.harness = "claude";
      draft.roles["archies-dog-walks/tech"]!.harness = "claude";
    });
    const result = JSON.parse(
      await deliverScheduledWake(fixture.layout, fixture.game, SLOT),
    ) as Record<string, unknown>;
    expect(result.status).toBe("sending");
    expect(readRegistry(fixture.layout).harness).toBe("codex");
    const receipt = JSON.parse(
      readFileSync(join(fixture.unblock, `${RECIPIENT}-${SLOT}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(receipt.method).toBe("claude-channel");
  });

  it("spools one brief for the configured recipient and deduplicates the slot", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    const first = await deliverScheduledWake(fixture.layout, fixture.game, SLOT);
    expect(first).toBe(
      `{"status": "sending", "recipient": "${RECIPIENT}", "recipient_session_status": "idle"}`,
    );
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe(
      '{"status": "deduplicated", "previousStatus": "sending", "reason": null}',
    );
    const receipt = JSON.parse(
      readFileSync(join(fixture.unblock, `${RECIPIENT}-${SLOT}.json`), "utf8"),
    ) as {
      diagnostics: { kind: string; parent?: string }[];
    };
    expect(receipt.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "worker_health", parent: RECIPIENT }),
    );
  });

  it("does not dispatch from a nonhost project", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    fixture.route({ host: "chibis-way-home" });
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe("");
  });

  it("defers when the host's recipient has no conversation for the active harness", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    const config = projectConfig("Archie");
    (config.reports as Record<string, unknown>).recipient = "art-kit";
    writeFixtureJson(fixture.game.configFile, config);
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toContain(
      "recipient has no conversation for the active harness",
    );
    expect(existsSync(join(fixture.unblock, `${RECIPIENT}-${SLOT}.json`))).toBe(false);
  });

  it("defers on an invalid route that names a conversation ID", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    fixture.route({ targets: [RECIPIENT] });
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe(
      `${DEFERRED_PREFIX}review route is unavailable or invalid; ` +
        "its owner must verify identities and ownership",
    );
    expect(existsSync(join(fixture.unblock, `${RECIPIENT}-${SLOT}.json`))).toBe(false);
  });

  it("defers a schema 1 route with its exact migration edit", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    fixture.route({ monitor: "game-dev", schema: 1 });
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe(
      `${DEFERRED_PREFIX}${ROUTE_SCHEMA_1}`,
    );
    expect(existsSync(join(fixture.unblock, `${RECIPIENT}-${SLOT}.json`))).toBe(false);
  });

  it("defers an active route that targets its recipient", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    fixture.route({ targets: ["game-dev", "archies-dog-walks/tech"] });
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe(
      `${DEFERRED_PREFIX}review route is unavailable or invalid; ` +
        "its owner must verify identities and ownership",
    );
  });

  it("defers when the route is unreadable", async () => {
    const fixture = claudeFixture();
    writeFileSync(fixture.layout.routeFile, "not json");
    expect(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)).toBe(
      `${DEFERRED_PREFIX}review route is unavailable or invalid; ` +
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
        gameDev.conversations.codex = RECIPIENT;
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
        schema: 2,
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

  it("keeps Chibi's Codex review slots and native collection separate from Claude peers", async () => {
    const fixture = codexFixture();
    const claudeTech = "00000000-0000-4000-8000-000000000011";
    const chibiTech = "00000000-0000-4000-8000-000000000012";
    const registry = readRegistry(fixture.layout);
    updateRegistry(fixture.layout, registry.revision, (draft) => {
      draft.roles["game-dev"]!.harness = "codex";
      draft.roles["archies-dog-walks/tech"]!.harness = "claude";
      draft.roles["archies-dog-walks/tech"]!.conversations.claude = claudeTech;
      draft.roles["chibis-way-home/tech"] = {
        conversations: { codex: chibiTech },
        harness: "codex",
        ownership: "active",
        worktree: "../chibis-way-home/.worktrees/tech",
      };
    });
    fixture.route({ host: "chibis-way-home" });
    const game = gameLayout(fixture.layout, "chibis-way-home");
    const unblock = join(game.busDir, "unblock");
    mkdirSync(join(unblock, "decisions"), { recursive: true });
    const clearance = join(unblock, "decisions", `${RECIPIENT}.json`);
    writeFileSync(clearance, JSON.stringify({ state: "clear", thread_id: RECIPIENT }));
    const config = JSON.parse(readFileSync(game.configFile, "utf8")) as {
      reports: { workerParents: string[] };
    };
    config.reports.workerParents = ["game-dev", "archies-dog-walks/tech", "chibis-way-home/tech"];
    writeFileSync(game.configFile, JSON.stringify(config));
    const steers: Record<string, unknown>[] = [];
    const control = await startFakeControl(fixture.base, handler(steers));
    vi.stubEnv("CODEX_CONTROL_SOCKET", control.path);
    try {
      const first = JSON.parse(await deliverScheduledWake(fixture.layout, game, SLOT)) as Record<
        string,
        unknown
      >;
      expect(first.status).toBe("accepted");
      expect(control.calls.filter((call) => call.method === "initialize")).toHaveLength(1);
      const snapshot = JSON.parse(readFileSync(first.snapshot_path as string, "utf8")) as {
        harnesses: Record<string, string>;
        history: Record<string, unknown>;
        native_queues: Record<string, unknown>;
        queues: Record<string, unknown>;
        worker_health: Record<string, unknown>;
      };
      expect(snapshot.harnesses).toMatchObject({
        [RECIPIENT]: "codex",
        [claudeTech]: "claude",
        [chibiTech]: "codex",
      });
      expect(snapshot.native_queues[claudeTech]).toMatchObject({ status: "unavailable" });
      expect(snapshot.history[claudeTech]).toMatchObject({ status: "unavailable" });
      expect(snapshot.worker_health[claudeTech]).toMatchObject({ status: "unavailable" });
      expect(snapshot.queues).not.toHaveProperty(claudeTech);
      expect(
        control.calls.flatMap((call) => [call.params.threadId, call.params.parentThreadId]),
      ).not.toContain(claudeTech);
      const repeated = JSON.parse(await deliverScheduledWake(fixture.layout, game, SLOT)) as Record<
        string,
        unknown
      >;
      expect(repeated.status).toBe("deduplicated");
      const next = JSON.parse(
        await deliverScheduledWake(fixture.layout, game, SLOT + 1800),
      ) as Record<string, unknown>;
      expect(next.status).toBe("accepted");
      expect(steers).toHaveLength(2);
      expect(control.calls.filter((call) => call.method === "initialize")).toHaveLength(3);
      writeFileSync(clearance, JSON.stringify({ state: "pending", thread_id: RECIPIENT }));
      const guarded = JSON.parse(
        await deliverScheduledWake(fixture.layout, game, SLOT + 3600),
      ) as Record<string, unknown>;
      expect(guarded.status).toBe("deferred");
      expect(steers).toHaveLength(2);
      expect(
        control.calls.flatMap((call) => [call.params.threadId, call.params.parentThreadId]),
      ).not.toContain(claudeTech);
    } finally {
      await control.close();
    }
  });

  it("reminds the configured recipient once over one connection and deduplicates the slot", async () => {
    const fixture = codexFixture();
    const steers: Record<string, unknown>[] = [];
    const control = await startFakeControl(fixture.base, handler(steers));
    vi.stubEnv("CODEX_CONTROL_SOCKET", control.path);
    try {
      const first = JSON.parse(
        await deliverScheduledWake(fixture.layout, fixture.game, SLOT),
      ) as Record<string, unknown>;
      expect(first).toMatchObject({
        review_status: "ok",
        recipient: RECIPIENT,
        status: "accepted",
      });
      expect(steers).toHaveLength(1);
      expect(steers[0]?.clientUserMessageId).toBe("7abe3e43-9217-5727-9bc2-9b9c22636262");
      const text = JSON.stringify(steers[0]?.input);
      expect(text).toContain(`${TECH}: q1`);
      expect(text).toContain(`${RECIPIENT}: none`);
      const receipt = JSON.parse(
        readFileSync(join(fixture.unblock, `${RECIPIENT}-${SLOT}.json`), "utf8"),
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
        `${DEFERRED_PREFIX}review route is unavailable or invalid; ` +
          "its owner must verify identities and ownership",
      );
    }
    expect(existsSync(join(fixture.unblock, `${RECIPIENT}-${SLOT}.json`))).toBe(false);
  });
});
