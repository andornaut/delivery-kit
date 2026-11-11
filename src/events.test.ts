import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it, type Mock, vi } from "vitest";

import { codexAdapter } from "./adapters/codex/index.ts";
import { startFakeControl } from "./adapters/codex/testControlSocket.ts";
import { eventRequestId } from "./adapters/shared/ids.ts";
import type { DeliveryReceipt } from "./adapters/types.ts";
import {
  clean,
  DELIVERY_BUDGET,
  deliveryMessage,
  emitEvent,
  type EventAdapter,
  eventId,
  eventsDir,
  flushEventsWith,
} from "./events.ts";
import { type GameLayout, gameLayout, loadLayout } from "./layout.ts";
import { holdLock } from "./lock.ts";
import { createRegistry, readRegistry, type Registry, updateRegistry } from "./registry/index.ts";
import { claudeFixture, RECIPIENT } from "./review/fixtures.ts";
import { CLAUDE_GAME_DEV, makeFixture, registryInput } from "./testFixtures.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OPTIONS = { project: "Archie" };

function setup(): GameLayout {
  const { root } = makeFixture();
  const layout = loadLayout(root);
  createRegistry(layout, registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">);
  return gameLayout(layout, "archies-dog-walks");
}

function readRecord(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function events(game: GameLayout): Record<string, unknown>[] {
  const directory = eventsDir(game);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readRecord(join(directory, name)));
}

type MockAdapter = EventAdapter & { deliver: Mock };

function mockAdapter(statuses: DeliveryReceipt["status"][]): MockAdapter {
  const deliver = vi.fn((_path: string, requestId: string) =>
    Promise.resolve({ requestId, status: statuses.shift() ?? "accepted" }),
  );
  return {
    ack: vi.fn(),
    deliver,
    harness: "claude",
    inventory: vi.fn(),
    status: vi.fn(),
  } as unknown as MockAdapter;
}

describe("emitEvent", () => {
  it("records an event once per identity and folds every blocked-* kind together", () => {
    const game = setup();
    emitEvent(game, OPTIONS, "blocked-gate", "abc", "gate failed");
    emitEvent(game, OPTIONS, "blocked-ci", "abc", "ci failed");
    emitEvent(game, OPTIONS, "blocked-gate", "abc", "gate failed again");
    const id = "19d395c3c05e17f202c8406010e2cebb9c35619d6f08da9b641caa39f926f4a8";
    expect(eventId("blocked-ci", "abc")).toBe(id);
    expect(events(game)).toEqual([
      expect.objectContaining({
        id,
        key: "abc",
        kind: "blocked-gate",
        message: "Archie bus: gate failed",
        sent: false,
      }),
    ]);
    const text = readFileSync(join(eventsDir(game), `${id}.json`), "utf8");
    expect(text).toMatch(/^\{"created": \d{19}, "id": "19d3/);
    expect(text.endsWith('"sent": false}\n')).toBe(true);
  });

  it("replaces control characters and keeps at most 1800 characters", () => {
    expect(clean("a\nb\u007fc")).toBe("a b c");
    expect(Array.from(clean("é".repeat(2000)))).toHaveLength(1800);
  });

  it("never records quiet kinds but tracks commit state to completion", () => {
    const game = setup();
    emitEvent(game, OPTIONS, "push", SHA, "pushed");
    emitEvent(game, OPTIONS, "ci_pending", SHA, "pending");
    emitEvent(game, OPTIONS, "ci_success", SHA, "CI green");
    emitEvent(game, OPTIONS, "ci_running", SHA, "late progress");
    const state = () =>
      JSON.parse(readFileSync(join(eventsDir(game), `${SHA}.state`), "utf8")) as unknown;
    expect(state()).toEqual({ ci: "success", deploy: "pending", pushed: true });
    expect(events(game).map((event) => event.kind)).toEqual(
      expect.arrayContaining(["push", "ci_success"]),
    );
    emitEvent(game, OPTIONS, "deploy_skipped", SHA, "docs only");
    const complete = events(game).find((event) => event.kind === "complete");
    expect(complete?.message).toBe(
      `Archie bus: COMPLETE ${SHA}: full gate passed; CI success; deployment skipped.`,
    );
    expect(
      events(game)
        .map((event) => event.kind)
        .sort(),
    ).toEqual(["ci_success", "complete", "deploy_skipped", "push"]);
  });
});

describe("deliveryMessage", () => {
  it("cuts at a character boundary within the byte budget and appends the event ID", () => {
    const id = "f".repeat(64);
    const message = deliveryMessage({ id, message: "é".repeat(1000) });
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(DELIVERY_BUDGET);
    expect(message.endsWith(` [bus event ${"f".repeat(12)}]`)).toBe(true);
    expect(message).not.toContain("�");
    expect(deliveryMessage({ id, message: "short" })).toBe(`short [bus event ${"f".repeat(12)}]`);
  });
});

describe("flushEventsWith", () => {
  it("honours a new recipient decision guard between native event sends", async () => {
    const fixture = claudeFixture();
    updateRegistry(fixture.layout, 1, (draft) => {
      draft.roles["game-dev"]!.harness = "codex";
      draft.roles["game-dev"]!.conversations.codex = RECIPIENT;
    });
    const control = await startFakeControl(fixture.base, (method, params) => {
      if (method === "thread/read") {
        return {
          result: {
            thread: {
              canAcceptDirectInput: true,
              status: { activeFlags: [], type: "active" },
            },
          },
        };
      }
      if (method === "thread/turns/list") {
        return { result: { data: [{ id: "active-turn", status: "inProgress" }] } };
      }
      if (method === "turn/steer") {
        fixture.clear("pending");
        return { result: { turnId: params.expectedTurnId } };
      }
      return { result: { data: [] } };
    });
    try {
      emitEvent(fixture.game, OPTIONS, "push", "one", "first");
      emitEvent(fixture.game, OPTIONS, "push", "two", "second");
      await flushEventsWith(
        {
          codex: (layout) => codexAdapter(layout, { controlSocket: control.path }),
        },
        fixture.game,
      );
      expect(
        Object.fromEntries(events(fixture.game).map((event) => [event.key, event.sent])),
      ).toEqual({ one: true, two: false });
      expect(control.calls.filter((call) => call.method === "initialize")).toHaveLength(1);
      expect(control.calls.filter((call) => call.method === "turn/steer")).toHaveLength(1);
    } finally {
      await control.close();
    }
  });

  it.each([
    ["sending", "sending"],
    ["ambiguous", "ambiguous"],
    ["rejected", "rejected"],
    ["unknown", "sending"],
  ])(
    "preserves a prior %s receipt when the role moves to another provider",
    async (status, attemptStatus) => {
      const game = setup();
      const layout = loadLayout(resolve(game.stateDir, "..", "..", ".."));
      emitEvent(game, OPTIONS, "push", "one", "first");
      const id = eventId("push", "one");
      const directory = join(eventsDir(game), "native");
      mkdirSync(directory);
      const path = join(directory, `${id}-${CLAUDE_GAME_DEV}.json`);
      const receipt = JSON.stringify({
        attempts: [{ method: "claude-channel", status: attemptStatus }],
        clientUserMessageId: eventRequestId(id, CLAUDE_GAME_DEV),
        event_id: id,
        recipient: CLAUDE_GAME_DEV,
        status,
      });
      writeFileSync(path, receipt);
      updateRegistry(layout, 1, (draft) => {
        draft.roles["game-dev"]!.harness = "codex";
        draft.roles["game-dev"]!.conversations.codex = "00000000-0000-4000-8000-000000000004";
      });
      const adapter = mockAdapter([]);
      const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await flushEventsWith({ codex: () => adapter }, game);
        expect(adapter.deliver).not.toHaveBeenCalled();
        expect(events(game)[0]?.sent).toBe(false);
        expect(readFileSync(path, "utf8")).toBe(receipt);
        expect(diagnostic).toHaveBeenCalledWith(
          expect.stringContaining("reconcile prior native receipt"),
        );
      } finally {
        diagnostic.mockRestore();
      }
    },
  );

  it.each([
    { method: "unknown-method", status: "sending" },
    { method: "claude-channel", status: "unknown-status" },
  ])("preserves a same-ID receipt with an unprovable attempt $method/$status", async (attempt) => {
    const game = setup();
    const layout = loadLayout(resolve(game.stateDir, "..", "..", ".."));
    emitEvent(game, OPTIONS, "push", "one", "first");
    const id = eventId("push", "one");
    const directory = join(eventsDir(game), "native");
    mkdirSync(directory);
    const path = join(directory, `${id}-${CLAUDE_GAME_DEV}.json`);
    const receipt = JSON.stringify({
      attempts: [attempt],
      clientUserMessageId: eventRequestId(id, CLAUDE_GAME_DEV),
      event_id: id,
      recipient: CLAUDE_GAME_DEV,
      status: "deferred",
    });
    writeFileSync(path, receipt);
    updateRegistry(layout, 1, (draft) => {
      draft.roles["game-dev"]!.harness = "codex";
      draft.roles["game-dev"]!.conversations.codex = CLAUDE_GAME_DEV;
    });
    const adapter = mockAdapter([]);
    const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await flushEventsWith({ codex: () => adapter }, game);
      expect(adapter.deliver).not.toHaveBeenCalled();
      expect(events(game)[0]?.sent).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(receipt);
      expect(diagnostic).toHaveBeenCalledWith(
        expect.stringContaining("reconcile prior native receipt"),
      );
    } finally {
      diagnostic.mockRestore();
    }
  });

  it("reconciles an accepted receipt from the previous provider without another send", async () => {
    const game = setup();
    const layout = loadLayout(resolve(game.stateDir, "..", "..", ".."));
    emitEvent(game, OPTIONS, "push", "one", "first");
    const id = eventId("push", "one");
    const directory = join(eventsDir(game), "native");
    mkdirSync(directory);
    writeFileSync(
      join(directory, `${id}-${CLAUDE_GAME_DEV}.json`),
      JSON.stringify({
        attempts: [{ method: "claude-channel", status: "accepted" }],
        clientUserMessageId: eventRequestId(id, CLAUDE_GAME_DEV),
        event_id: id,
        recipient: CLAUDE_GAME_DEV,
        status: "accepted",
      }),
    );
    updateRegistry(layout, 1, (draft) => {
      draft.roles["game-dev"]!.harness = "codex";
      draft.roles["game-dev"]!.conversations.codex = "00000000-0000-4000-8000-000000000004";
    });
    const adapter = mockAdapter([]);
    await flushEventsWith({ codex: () => adapter }, game);
    expect(adapter.deliver).not.toHaveBeenCalled();
    expect(events(game)[0]?.sent).toBe(true);
  });

  it("uses the recipient's selected harness even when the global default differs", async () => {
    const game = setup();
    const layout = loadLayout(resolve(game.stateDir, "..", "..", ".."));
    updateRegistry(layout, 1, (draft) => {
      draft.harness = "codex";
      draft.roles["game-dev"]!.harness = "claude";
    });
    const claude = mockAdapter([]);
    const codex = mockAdapter([]);
    emitEvent(game, OPTIONS, "push", "one", "first");
    await flushEventsWith({ claude: () => claude, codex: () => codex }, game);
    expect(claude.deliver).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      CLAUDE_GAME_DEV,
      expect.any(String),
      { event_id: eventId("push", "one") },
    );
    expect(codex.deliver).not.toHaveBeenCalled();
    expect(readRegistry(layout).harness).toBe("codex");
  });

  it("resolves role selection again between deliveries in one flush", async () => {
    const game = setup();
    const layout = loadLayout(resolve(game.stateDir, "..", "..", ".."));
    const codexRecipient = "00000000-0000-4000-8000-000000000004";
    updateRegistry(layout, 1, (draft) => {
      draft.harness = "codex";
      draft.roles["game-dev"]!.harness = "claude";
      draft.roles["game-dev"]!.conversations.codex = codexRecipient;
    });
    const claude = mockAdapter([]);
    const codex = mockAdapter([]);
    claude.deliver.mockImplementationOnce((_path: string, requestId: string) => {
      updateRegistry(layout, 2, (draft) => {
        draft.roles["game-dev"]!.harness = "codex";
      });
      return Promise.resolve({ requestId, status: "accepted" });
    });
    emitEvent(game, OPTIONS, "push", "one", "first");
    emitEvent(game, OPTIONS, "push", "two", "second");
    await flushEventsWith({ claude: () => claude, codex: () => codex }, game);
    expect(claude.deliver.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      [CLAUDE_GAME_DEV, expect.stringContaining("first")],
    ]);
    expect(codex.deliver.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      [codexRecipient, expect.stringContaining("second")],
    ]);
    expect(events(game).every((event) => event.sent)).toBe(true);
    expect(readRegistry(layout).harness).toBe("codex");
  });

  it("keeps an event unsent when the selected harness has no conversation", async () => {
    const game = setup();
    const layout = loadLayout(resolve(game.stateDir, "..", "..", ".."));
    updateRegistry(layout, 1, (draft) => {
      draft.roles["game-dev"]!.harness = "codex";
    });
    const adapter = mockAdapter([]);
    emitEvent(game, OPTIONS, "push", "one", "first");
    await flushEventsWith({ claude: () => adapter, codex: () => adapter }, game);
    expect(adapter.deliver).not.toHaveBeenCalled();
    expect(events(game)[0]?.sent).toBe(false);
  });

  it("delivers in creation order to the recipient and marks only accepted events", async () => {
    const game = setup();
    emitEvent(game, OPTIONS, "push", "one", "first");
    emitEvent(game, OPTIONS, "push", "two", "second");
    emitEvent(game, OPTIONS, "push", "three", "third");
    const adapter = mockAdapter(["accepted", "deferred"]);
    await flushEventsWith({ claude: () => adapter }, game);
    expect(adapter.deliver).toHaveBeenCalledTimes(2);
    const first = eventId("push", "one");
    expect(adapter.deliver).toHaveBeenNthCalledWith(
      1,
      join(eventsDir(game), "native", `${first}-${CLAUDE_GAME_DEV}.json`),
      eventRequestId(first, CLAUDE_GAME_DEV),
      CLAUDE_GAME_DEV,
      `Archie bus: first [bus event ${first.slice(0, 12)}]`,
      { event_id: first },
    );
    const sent = Object.fromEntries(events(game).map((event) => [event.key, event.sent]));
    expect(sent).toEqual({ one: true, three: false, two: false });

    const retry = mockAdapter([]);
    await flushEventsWith({ claude: () => retry }, game);
    expect(retry.deliver.mock.calls.map((call) => call[3])).toEqual([
      expect.stringContaining("second"),
      expect.stringContaining("third"),
    ]);
  });

  it("suppresses a queued quiet event without delivering it", async () => {
    const game = setup();
    const directory = eventsDir(game);
    mkdirSync(directory, { recursive: true });
    const id = eventId("ci_running", SHA);
    writeFileSync(
      join(directory, `${id}.json`),
      JSON.stringify({ created: 1, id, key: SHA, kind: "ci_running", message: "m", sent: false }),
    );
    const adapter = mockAdapter([]);
    await flushEventsWith({ claude: () => adapter }, game);
    expect(adapter.deliver).not.toHaveBeenCalled();
    expect(events(game)[0]).toMatchObject({ suppressed: true });
  });

  it("does nothing while another flush holds dispatch.lock", async () => {
    const game = setup();
    emitEvent(game, OPTIONS, "push", "one", "first");
    const adapter = mockAdapter([]);
    const lock = holdLock(join(eventsDir(game), "dispatch.lock"));
    try {
      await flushEventsWith({ claude: () => adapter }, game);
    } finally {
      lock.release();
    }
    expect(adapter.deliver).not.toHaveBeenCalled();
  });

  it("defers every event when the active harness has no adapter", async () => {
    const game = setup();
    emitEvent(game, OPTIONS, "push", "one", "first");
    await flushEventsWith({}, game);
    expect(events(game)[0]).toMatchObject({ sent: false });
  });

  it("keeps the exact nanosecond creation time when marking an event sent", async () => {
    const game = setup();
    const directory = eventsDir(game);
    mkdirSync(directory, { recursive: true });
    const id = eventId("push", "big");
    const created = "1793757000123456789";
    writeFileSync(
      join(directory, `${id}.json`),
      `{"created": ${created}, "id": "${id}", "key": "big", "kind": "push", "message": "m", "sent": false}\n`,
    );
    await flushEventsWith({ claude: () => mockAdapter([]) }, game);
    const text = readFileSync(join(directory, `${id}.json`), "utf8");
    expect(text).toContain(`"created": ${created},`);
    expect(text).toContain('"sent": true');
  });

  it("resolves the harness and recipient again for each flush, without a restart", async () => {
    const game = setup();
    const root = resolve(game.stateDir, "..", "..", "..");
    const layout = loadLayout(root);
    const codexRecipient = "00000000-0000-4000-8000-000000000004";
    updateRegistry(layout, 1, (draft) => {
      draft.roles["game-dev"]!.conversations.codex = codexRecipient;
    });
    writeFileSync(
      layout.routeFile,
      JSON.stringify({
        host: "archies-dog-walks",
        schema: 2,
        state: "active",
        targets: ["archies-dog-walks/tech"],
      }),
    );
    const claude = mockAdapter([]);
    const codex = mockAdapter([]);
    const adapters = { claude: () => claude, codex: () => codex };
    emitEvent(game, OPTIONS, "push", "one", "first");
    await flushEventsWith(adapters, game);
    updateRegistry(layout, 2, (draft) => {
      draft.harness = "codex";
    });
    emitEvent(game, OPTIONS, "push", "two", "second");
    await flushEventsWith(adapters, game);
    expect(claude.deliver.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      [CLAUDE_GAME_DEV, expect.stringContaining("first")],
    ]);
    expect(codex.deliver.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      [codexRecipient, expect.stringContaining("second")],
    ]);
  });
});
