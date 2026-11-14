import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverPending } from "../adapters/claude/channel.ts";
import { spoolDir } from "../adapters/claude/spool.ts";
import { type FakeHandler, startFakeControl } from "../adapters/codex/testControlSocket.ts";
import { gameLayout } from "../layout.ts";
import { MessageStore } from "../messages/store.ts";
import { readRegistry, updateRegistry } from "../registry/index.ts";
import { projectConfig, writeFixtureJson } from "../testFixtures.ts";
import { type ClaudeFixture, claudeFixture, GAME, RECIPIENT, SLOT, TECH } from "./fixtures.ts";
import { DEFERRED_PREFIX, deliverScheduledWake } from "./wake.ts";

function useEnv(fixture: ClaudeFixture): void {
  for (const [key, value] of Object.entries(fixture.env)) {
    vi.stubEnv(key, value ?? "");
  }
}

function localMessages(fixture: ClaudeFixture): MessageStore {
  return new MessageStore({
    layout: fixture.layout,
    resolveOwner: () => ({ harness: "codex", nativeId: TECH, parentBinding: null }),
  });
}

function breakLocalInbox(fixture: ClaudeFixture): void {
  const directory = join(fixture.layout.reviewDir, "messages");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${"a".repeat(64)}.json`), "{");
}

function queuedBrief(fixture: ClaudeFixture, slot: number): string {
  const state = JSON.parse(
    readFileSync(join(fixture.unblock, `${RECIPIENT}-${slot}.json`), "utf8"),
  );
  return (
    JSON.parse(
      readFileSync(join(spoolDir(fixture.game.busDir), `${state.requestId}.json`), "utf8"),
    ) as { text: string }
  ).text;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deliverScheduledWake (claude)", () => {
  it("spools one brief for the configured recipient and deduplicates the slot", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    const store = localMessages(fixture);
    const body = "private local worker body, never in a coordinator brief";
    const original = await store.enqueue({
      body,
      created: "2026-11-14T20:00:00Z",
      fromRole: "game-coordinator",
      id: "worker-ready",
      intent: "queue",
      parentRole: "archies-dog-walks/tech",
      schema: 1,
      toRole: "archies-dog-walks/tech",
      workerId: "00000000-0000-4000-8000-000000000080",
    });
    const first = await deliverScheduledWake(fixture.layout, fixture.game, SLOT);
    expect(JSON.parse(first)).toMatchObject({
      status: "sending",
      recipient: RECIPIENT,
      recipient_session_status: "idle",
      message_backlog_slots: 1,
      message_health_status: "ok",
    });
    expect(
      JSON.parse(await deliverScheduledWake(fixture.layout, fixture.game, SLOT)),
    ).toMatchObject({
      status: "deduplicated",
      previousStatus: "sending",
      reason: null,
      message_backlog_slots: 1,
    });
    const snapshot = JSON.parse(readFileSync(JSON.parse(first).snapshot_path, "utf8"));
    expect(snapshot.message_summary.messages).toContainEqual(
      expect.objectContaining({
        id: "worker-ready",
        workerId: original.envelope.workerId,
        parentRole: original.envelope.parentRole,
      }),
    );
    expect(JSON.stringify(snapshot)).not.toContain(body);
    const text = queuedBrief(fixture, SLOT);
    expect(text).toContain("worker-ready");
    expect(text).toContain("message status --recipient ROLE --include-body");
    expect(text).not.toContain(body);
    const receipt = JSON.parse(
      readFileSync(join(fixture.unblock, `${RECIPIENT}-${SLOT}.json`), "utf8"),
    ) as {
      diagnostics: { kind: string; parent?: string }[];
    };
    expect(receipt.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "worker_health", parent: RECIPIENT }),
    );
    await deliverPending(() => undefined, fixture.game.busDir, RECIPIENT);
    expect(
      JSON.parse(await deliverScheduledWake(fixture.layout, fixture.game, SLOT + 1800)),
    ).toMatchObject({
      status: "sending",
      message_backlog_slots: 2,
      message_health_status: "stalled",
    });
    expect(queuedBrief(fixture, SLOT + 1800)).toContain("ownerRole");
    expect(store.read("worker-ready")).toEqual(original);
  });

  it("still spools each distinct Claude slot when local message visibility is unavailable", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    breakLocalInbox(fixture);
    const first = JSON.parse(await deliverScheduledWake(fixture.layout, fixture.game, SLOT));
    expect(first).toMatchObject({
      status: "sending",
      message_health_status: "unknown",
      message_counts: null,
    });
    const captured = JSON.parse(readFileSync(first.snapshot_path, "utf8"));
    expect(captured.message_summary).toEqual({
      schema: 1,
      status: "unavailable",
      reason: "unreadable-inbox",
      counts: null,
      messages: null,
    });
    expect(queuedBrief(fixture, SLOT)).toContain("unavailable/unknown");
    await deliverPending(() => undefined, fixture.game.busDir, RECIPIENT);
    expect(
      JSON.parse(await deliverScheduledWake(fixture.layout, fixture.game, SLOT + 1800)),
    ).toMatchObject({
      status: "sending",
      message_health_status: "unknown",
      message_counts: null,
    });
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
});

describe("deliverScheduledWake (codex)", () => {
  function codexFixture(): ClaudeFixture {
    const fixture = claudeFixture();
    const registry = readRegistry(fixture.layout);
    updateRegistry(fixture.layout, registry.revision, (draft) => {
      draft.harness = "codex";
      const coordinator = draft.roles["game-coordinator"];
      if (coordinator !== undefined) {
        coordinator.conversations.codex = RECIPIENT;
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
      draft.roles["game-coordinator"]!.harness = "codex";
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
    config.reports.workerParents = [
      "game-coordinator",
      "archies-dog-walks/tech",
      "chibis-way-home/tech",
    ];
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
    const store = localMessages(fixture);
    const record = await store.enqueue({
      body: "private durable body",
      created: "2026-11-14T20:00:00Z",
      fromRole: "game-coordinator",
      id: "accepted-not-handled",
      intent: "queue",
      schema: 1,
      toRole: "archies-dog-walks/tech",
    });
    const lease = await store.beginAttempt({
      envelope: record.envelope,
      revision: record.revision,
      source: null,
    });
    const accepted = lease.complete({ reason: null, source: lease.source, state: "accepted" });
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
      expect(text).toContain("accepted-not-handled");
      expect(text).toContain("message status --recipient ROLE --include-body");
      expect(text).not.toContain(record.envelope.body);
      const captured = JSON.parse(readFileSync(first.snapshot_path as string, "utf8"));
      expect(captured.message_summary.counts.accepted).toBe(1);
      expect(JSON.stringify(captured.message_summary)).not.toContain(record.envelope.body);
      const receipt = JSON.parse(
        readFileSync(join(fixture.unblock, `${RECIPIENT}-${SLOT}.json`), "utf8"),
      ) as Record<string, unknown>;
      expect(receipt).toMatchObject({ attempt: 1, method: "turn/steer", status: "accepted" });
      const second = JSON.parse(
        await deliverScheduledWake(fixture.layout, fixture.game, SLOT),
      ) as Record<string, unknown>;
      expect(second).toMatchObject({ previousStatus: "accepted", status: "deduplicated" });
      expect(steers).toHaveLength(1);
      const next = JSON.parse(
        await deliverScheduledWake(fixture.layout, fixture.game, SLOT + 1800),
      );
      expect(next).toMatchObject({
        status: "accepted",
        message_health_status: "stalled",
        message_backlog_slots: 2,
      });
      expect(next.message_stalled).toContainEqual(
        expect.objectContaining({
          id: "accepted-not-handled",
          ownerRole: "archies-dog-walks/tech",
        }),
      );
      expect(JSON.stringify(steers[1]?.input)).toContain("accepted-not-handled");
      expect(store.read("accepted-not-handled")).toEqual(accepted);
    } finally {
      await control.close();
    }
  });

  it("does not turn unavailable local messages into a native queue failure or skip a Codex slot", async () => {
    const fixture = codexFixture();
    breakLocalInbox(fixture);
    const steers: Record<string, unknown>[] = [];
    const control = await startFakeControl(fixture.base, handler(steers));
    vi.stubEnv("CODEX_CONTROL_SOCKET", control.path);
    try {
      const first = JSON.parse(await deliverScheduledWake(fixture.layout, fixture.game, SLOT));
      const second = JSON.parse(
        await deliverScheduledWake(fixture.layout, fixture.game, SLOT + 1800),
      );
      expect(first).toMatchObject({
        status: "accepted",
        message_health_status: "unknown",
        message_counts: null,
      });
      expect(second).toMatchObject({
        status: "accepted",
        message_health_status: "unknown",
        message_counts: null,
      });
      expect(steers).toHaveLength(2);
      expect(JSON.stringify(steers[1]?.input)).toContain("unavailable/unknown");
      expect(JSON.parse(readFileSync(second.snapshot_path, "utf8")).errors).toEqual({});
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
});
