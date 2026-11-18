// Runner-side bus events: which events a departure records and when the resident observer asks the
// coordinator CLI to flush the outbox. Outbox delivery, deduplication, receipts and guards are
// coordination-kit's contract, reached through `events flush`.
import { expect } from "vitest";

import { impl, type Resident, startRunner } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { at, sleep } from "../lib/time.ts";
import { type Workspace } from "../lib/workspace.ts";

const RECIPIENT = "00000000-0000-4000-8000-000000000001";
const EVERY_MINUTE = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0"));
const FIRST = "a".repeat(64);
const SECOND = "b".repeat(64);

function bus(ws: Workspace, options: { github?: string } = {}): void {
  ws.config.schedule = { departures: EVERY_MINUTE, timezone: "America/Toronto" };
  ws.config.git = { main: "main", remote: "origin", github: options.github ?? "" };
  ws.writeRegistry({
    schema: 1,
    revision: 1,
    harness: "codex",
    roles: { "game-coordinator": { conversations: { codex: RECIPIENT } } },
  });
  ws.config.reports = { project: "Fixture", recipient: "game-coordinator" };
}

function kinds(ws: Workspace): string[] {
  return ws.events().map((event) => String(event.kind));
}

function start(ws: Workspace, speed = 30): Resident {
  ws.setClock(at(59, 58), speed);
  return startRunner(ws);
}

/** An unsent outbox entry written directly, so only an observer pass flushes it. */
function seed(ws: Workspace, id: string, created: number): void {
  ws.write(
    `events/${id}.json`,
    JSON.stringify({
      created,
      id,
      kind: "attempt",
      key: `fixture-${id.slice(0, 4)}`,
      message: "Fixture bus: scheduled attempt",
      sent: false,
    }) + "\n",
  );
}

function sent(ws: Workspace, id: string): boolean {
  return ws.exists(`events/${id}.json`) && ws.readJson(`events/${id}.json`).sent === true;
}

/** The `events flush` calls the fake coordination-kit CLI received. */
function flushes(ws: Workspace): number {
  return ws.coordinatorCalls().filter((call) => call.args[0] === "events").length;
}

suite("events", () => {
  const workspace = workspaces();

  contract("a failed gate records one blocked event of the gate stage's kind", async () => {
    const ws = workspace();
    bus(ws);
    ws.updateControl((c) => (c.docker = { gateFail: true }));
    impl.offer(ws, ["bus/feature"]);
    const runner = start(ws);
    await runner.until(() => kinds(ws).some((kind) => kind.startsWith("blocked-")));
    await sleep(500);
    await runner.stop();
    const blocked = ws.events().filter((event) => String(event.kind).startsWith("blocked-"));
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.kind).toBe("blocked-full-gate");
  });

  contract("the observer asks the coordinator CLI to flush the outbox once a minute", async () => {
    const ws = workspace();
    bus(ws);
    // The departure at minute 05 is never reached and no review slot is due.
    ws.config.schedule = { departures: ["05"], timezone: "America/Toronto" };
    ws.updateCoordinatorConfig({ wakeMinutes: [] });
    ws.scriptCoordinator({ flush: { markSent: true } });
    seed(ws, FIRST, 1);
    // The runner starts at minute 00 at wall speed.
    ws.updateControl((c) => (c.maxRealSleep = 0.2));
    ws.setClock(at(0, 0, -1), 1);
    const runner = startRunner(ws);
    try {
      await runner.armed();
      await runner.until(() => sent(ws, FIRST));
      const before = flushes(ws);
      expect(before).toBe(1);
      seed(ws, SECOND, 2);
      // Within the same virtual minute no further pass runs.
      await sleep(1_500);
      expect(flushes(ws)).toBe(before);
      expect(sent(ws, SECOND)).toBe(false);
      ws.advanceClock(60);
      await runner.until(() => sent(ws, SECOND));
      expect(flushes(ws)).toBe(before + 1);
    } finally {
      await runner.stop();
    }
    expect(ws.coordinatorCalls().find((call) => call.args[0] === "events")!.args).toEqual([
      "events",
      "flush",
      "--game",
      ws.game,
    ]);
  });

  contract("an unreadable outbox event defers the flush and is logged once", async () => {
    const ws = workspace();
    bus(ws);
    ws.config.schedule = { departures: ["05"], timezone: "America/Toronto" };
    ws.updateCoordinatorConfig({ wakeMinutes: [] });
    ws.scriptCoordinator({ flush: { markSent: true } });
    seed(ws, FIRST, 1);
    ws.write("events/broken.json", "{");
    const line = "bus: event flush deferred: outbox-unreadable: an outbox event is unreadable";
    const runner = start(ws);
    try {
      await runner.until(() => flushes(ws) >= 3);
    } finally {
      await runner.stop();
    }
    expect(runner.output().stdout.split(line).length - 1).toBe(1);
    expect(sent(ws, FIRST)).toBe(false);
  });
});
