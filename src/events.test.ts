import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, type Mock, vi } from "vitest";

import { uuid5Url } from "./adapters/codex/json.ts";
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
import { createRegistry, type Registry } from "./registry/index.ts";
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
      uuid5Url(`bus-event:${first}:${CLAUDE_GAME_DEV}`),
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
});
