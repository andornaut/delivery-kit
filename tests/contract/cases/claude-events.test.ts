// Bus events through the Claude channel spool and the Claude report sink. Events come from a real
// scheduled departure blocked by load; the notifier flushes the outbox.
import { rmSync } from "node:fs";
import { expect } from "vitest";

import { execute, impl, type Resident, startRunner } from "../lib/adapter.ts";
import {
  agents,
  Channel,
  clear,
  claudeGame,
  claudeRoute,
  eventRequestId,
  RECIPIENT,
} from "../lib/claude-fixture.ts";
import { CASE_TIMEOUT_MS, contract, EXIT_INVALID, suite, workspaces } from "../lib/cases.ts";
import { at, LOAD_WAIT_SECONDS } from "../lib/time.ts";
import type { Workspace } from "../lib/workspace.ts";
import type { Json } from "../lib/json.ts";

type Event = { id: string; kind: string; message: string; sent: boolean; created: number };

function spooled(ws: Workspace): Array<Json> {
  return ws
    .list("unblock", "claude-spool")
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, ...ws.readJson(`unblock/claude-spool/${name}`) }));
}

function events(ws: Workspace): Event[] {
  return ws.events() as unknown as Event[];
}

function eventReceipt(ws: Workspace, event: Event): Json {
  return ws.readJson(`events/native/${event.id}-${RECIPIENT}.json`);
}

function deliveryMessage(event: Event): string {
  const suffix = ` [bus event ${event.id.slice(0, 12)}]`;
  const body = Buffer.from(event.message, "utf8").subarray(0, 900 - Buffer.byteLength(suffix));
  return new TextDecoder("utf-8", { fatal: false }).decode(body).replace(/�+$/, "") + suffix;
}

/** A Claude game whose next departure is blocked by load, so it emits attempt and blocked events. */
function blockedDeparture(ws: Workspace): void {
  claudeGame(ws, { recipient: true });
  ws.config.schedule = { departures: ["00"], timezone: "America/Toronto" };
  // A zero limit against the real host load forces a load block.
  ws.hostLoad = "real";
  ws.config.resources = { cpus: 4, loadLimit: 0 };
  // Keep review slots out of the event window.
  ws.updateGameDevConfig({ wakeMinutes: [45] });
  impl.offer(ws, ["bus/queued"]);
  ws.setClock(at(-1, 50));
}

/**
 * Step the virtual clock past the load wait once the departure has reported its attempt, unless
 * the virtual clock already passed it, then wait for its blocked-load event.
 */
async function loadWaitOver(ws: Workspace, runner: Resident): Promise<void> {
  await runner.until(() => events(ws).length >= 1);
  if (events(ws).length === 1) {
    ws.advanceClock(LOAD_WAIT_SECONDS);
  }
  await runner.until(() => events(ws).length >= 2);
}

/** Wait for two further notifier flushes (one virtual minute each). */
async function flushes(runner: Resident): Promise<void> {
  const before = Date.now();
  await runner.until(() => Date.now() - before > 2_500);
}

suite("claude bus events", () => {
  const workspace = workspaces();

  contract(
    "an event is spooled once, deduplicated across flushes and accepted by the consumer",
    async () => {
      const ws = workspace();
      blockedDeparture(ws);
      const runner = startRunner(ws);
      try {
        await runner.until(() => spooled(ws).length === 1);
        await loadWaitOver(ws, runner);
        const [first] = events(ws);
        expect(first!.kind).toBe("attempt");
        const requestId = eventRequestId(first!.id, RECIPIENT);
        const receipt = eventReceipt(ws, first!);
        expect([receipt.status, receipt.clientUserMessageId, receipt.attempts]).toEqual([
          "sending",
          requestId,
          [{ method: "claude-channel", status: "sending" }],
        ]);
        expect(JSON.stringify(receipt)).not.toContain(first!.message);
        expect(spooled(ws).map((entry) => entry.name)).toEqual([`${requestId}.json`]);
        expect(spooled(ws)[0]!.recipient).toBe(RECIPIENT);
        await flushes(runner);
        expect(spooled(ws).map((entry) => entry.name)).toEqual([`${requestId}.json`]);
        const channel = Channel.open(ws, [ws.path("unblock")]);
        channel.initialize();
        channel.initialized();
        await channel.waitFor(() => channel.channel().length >= 2, 20_000);
        await channel.collect(1_500);
        await channel.close();
        const notifications = channel.channel();
        const [, second] = events(ws);
        expect(notifications.map((m) => m.params.meta.event_id)).toEqual([first!.id, second!.id]);
        expect(notifications[0]!.params.content).toBe(deliveryMessage(first!));
        expect(notifications[0]!.params.meta).toEqual({
          request_id: requestId,
          kind: "event",
          event_id: first!.id,
        });
        const accepted = eventReceipt(ws, first!);
        expect([accepted.status, accepted.attempts.at(-1).status]).toEqual([
          "accepted",
          "accepted",
        ]);
        await runner.until(() => events(ws).every((event) => event.sent));
        expect(spooled(ws)).toEqual([]);
      } finally {
        await runner.stop();
      }
    },
  );

  contract(
    "the outbox stays unsent until the consumer accepts, then marks the event sent",
    async () => {
      const ws = workspace();
      blockedDeparture(ws);
      const runner = startRunner(ws);
      try {
        await runner.until(() => spooled(ws).length === 1);
        await loadWaitOver(ws, runner);
        await flushes(runner);
        expect(spooled(ws)).toHaveLength(1);
        expect(events(ws).map((event) => event.sent)).toEqual([false, false]);
        const channel = Channel.open(ws, [ws.path("unblock")]);
        channel.initialize();
        channel.initialized();
        await channel.waitFor(() => channel.channel().length >= 1);
        await runner.until(() => events(ws)[0]!.sent);
        await channel.collect(1_500);
        await channel.close();
        expect(
          channel.channel().filter((m) => m.params.meta.event_id === events(ws)[0]!.id),
        ).toHaveLength(1);
        expect(String(channel.channel()[0]!.params.content)).toContain("scheduled attempt");
      } finally {
        await runner.stop();
      }
    },
  );

  contract(
    "an interrupted event send becomes ambiguous, is never resent and holds later events",
    async () => {
      const ws = workspace();
      blockedDeparture(ws);
      const runner = startRunner(ws);
      try {
        await runner.until(() => spooled(ws).length === 1);
        await loadWaitOver(ws, runner);
        rmSync(ws.path("unblock", "claude-spool", spooled(ws)[0]!.name));
        const [first] = events(ws);
        await runner.until(() => eventReceipt(ws, first!).status === "ambiguous");
        await flushes(runner);
        const receipt = eventReceipt(ws, first!);
        expect([receipt.status, receipt.attempts.at(-1).status]).toEqual([
          "ambiguous",
          "ambiguous",
        ]);
        expect(spooled(ws)).toEqual([]);
        expect(events(ws).map((event) => event.sent)).toEqual([false, false]);
        expect(ws.list("events", "native")).toEqual([`${first!.id}-${RECIPIENT}.json`]);
      } finally {
        await runner.stop();
      }
    },
  );

  contract(
    "a missing recipient or absent clearance defers the event without spooling",
    async () => {
      const ws = workspace();
      blockedDeparture(ws);
      agents(ws, "missing");
      const runner = startRunner(ws);
      try {
        await runner.until(() => ws.list("events", "native").length === 1);
        const [first] = events(ws);
        expect(eventReceipt(ws, first!).status).toBe("deferred");
        clear(ws, RECIPIENT, "pending");
        agents(ws, "idle");
        await flushes(runner);
        expect(spooled(ws)).toEqual([]);
        expect(eventReceipt(ws, first!).status).toBe("deferred");
        clear(ws);
        await runner.until(() => spooled(ws).length === 1);
        expect(eventReceipt(ws, first!).status).toBe("sending");
      } finally {
        await runner.stop();
      }
    },
  );

  contract(
    "events go to the channel only for the active route recipient and never fall back to Codex",
    async () => {
      const cases: Array<[string, (ws: Workspace) => void]> = [
        [
          "recipient is a route target",
          (ws) => (ws.config.reports = { project: "Fixture", recipient: "archie-tech" }),
        ],
        ["route held", (ws) => ws.writeRoute(claudeRoute(ws, { state: "held" }))],
      ];
      for (const [name, change] of cases) {
        const ws = workspace();
        blockedDeparture(ws);
        change(ws);
        const runner = startRunner(ws);
        try {
          await loadWaitOver(ws, runner);
          await flushes(runner);
        } finally {
          await runner.stop();
        }
        expect(spooled(ws), name).toEqual([]);
        expect(
          events(ws).map((event) => event.sent),
          name,
        ).toEqual([false, false]);
      }
    },
    CASE_TIMEOUT_MS,
  );

  contract("the report recipient must resolve to a canonical session UUID", async () => {
    const ws = workspace();
    claudeGame(ws, { recipient: true });
    for (const [value, expected] of [
      [RECIPIENT, 0],
      ["AAAAAAAA-0000-4000-8000-000000000001", EXIT_INVALID],
      ["not-a-uuid", EXIT_INVALID],
    ] as const) {
      ws.writeRegistry({
        schema: 1,
        revision: 1,
        harness: "claude",
        roles: { "dev-manager": { conversations: { claude: value } } },
      });
      const result = await execute(impl.checkConfig(ws));
      expect(result.code, `${value} ${result.stderr}`).toBe(expected);
    }
  });
});
