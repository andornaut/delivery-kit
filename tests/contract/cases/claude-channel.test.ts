// The stdio MCP channel consumer (from tests/test_claude_adapter.py ChannelTests and
// MultiProjectChannelTests). The consumer is driven as a Claude Code client drives it.
import { renameSync } from "node:fs";
import { expect } from "vitest";

import { execute, impl } from "../lib/adapter.ts";
import {
  ARCHIE,
  Channel,
  claudeGame,
  claudeRoute,
  deliver,
  MONITOR,
  tick,
} from "../lib/claude-fixture.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { at } from "../lib/time.ts";
import type { Workspace } from "../lib/workspace.ts";
import type { Json } from "../lib/json.ts";

const SLOT = at(20);
const NEXT = at(50);
const ACCEPTED_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

function receipt(ws: Workspace, slot = SLOT): Json {
  return ws.readJson(`unblock/${MONITOR}-${slot}.json`);
}

function spooled(ws: Workspace): string[] {
  return ws.list("unblock", "claude-spool").filter((name) => name.endsWith(".json"));
}

suite("claude channel consumer", () => {
  const workspace = workspaces();

  contract("the consumer emits exactly once per request ID across restarts", async () => {
    const ws = workspace();
    claudeGame(ws);
    await tick(ws, SLOT);
    expect(await deliver(ws)).toHaveLength(1);
    await tick(ws, NEXT);
    const channel = Channel.open(ws, [ws.path("unblock")]);
    channel.initialize();
    channel.initialized();
    await channel.waitFor(() => channel.channel().length > 0);
    await channel.collect(500);
    const initialize = channel.messages[0]!;
    expect(initialize.id).toBe(1);
    expect(initialize.result.capabilities).toEqual({ experimental: { "claude/channel": {} } });
    expect(initialize.result.protocolVersion).toBe("2025-06-18");
    const notifications = channel.channel();
    expect(notifications.map((m) => m.params.meta.slot)).toEqual([String(NEXT)]);
    expect(notifications[0]!.params.meta.kind).toBe("monitor");
    for (const slot of [SLOT, NEXT]) {
      expect(receipt(ws, slot).status).toBe("accepted");
      expect(receipt(ws, slot).acceptedAt).toMatch(ACCEPTED_AT);
    }
    expect((await tick(ws, SLOT)).monitor[0]!.result.previousStatus).toBe("accepted");
    expect((await channel.close()).code).toBe(0);
    const restarted = Channel.open(ws, [ws.path("unblock")]);
    restarted.initialize();
    restarted.initialized();
    await restarted.collect(500);
    expect(restarted.channel()).toEqual([]);
    expect((await restarted.close()).code).toBe(0);
  });

  contract("nothing is emitted before initialization or for another recipient", async () => {
    const ws = workspace();
    claudeGame(ws);
    await tick(ws, SLOT);
    const early = Channel.open(ws, [ws.path("unblock")]);
    early.initialize();
    await early.collect(400);
    expect(early.channel()).toEqual([]);
    await early.close();
    const other = Channel.open(ws, [ws.path("unblock")], ARCHIE);
    other.initialize();
    other.initialized();
    await other.collect(400);
    expect(other.channel()).toEqual([]);
    await other.close();
    expect(receipt(ws).status).toBe("sending");
    expect(spooled(ws)).toHaveLength(1);
  });

  contract(
    "a failed channel write and an interrupted claim are ambiguous and never resent",
    async () => {
      const ws = workspace();
      claudeGame(ws);
      await tick(ws, SLOT);
      const broken = Channel.open(ws, [ws.path("unblock")]);
      broken.initialize();
      await broken.waitFor(() => broken.messages.length > 0);
      // The client stops reading: the consumer's next write fails.
      broken.resident.child.stdout.destroy();
      broken.initialized();
      const failed = await broken.resident.done;
      // The consumer exits nonzero once its output is unusable.
      expect(failed.code).not.toBe(0);
      expect(receipt(ws).status).toBe("ambiguous");
      expect(await deliver(ws)).toEqual([]);
      await tick(ws, NEXT);
      const [pending] = spooled(ws);
      renameSync(
        ws.path("unblock", "claude-spool", pending!),
        ws.path("unblock", "claude-spool", pending!.replace(/\.json$/, ".claimed")),
      );
      expect(await deliver(ws)).toEqual([]);
      expect(receipt(ws, NEXT).status).toBe("ambiguous");
    },
  );

  contract(
    "one consumer drains each project state once and rejects a repeated state directory",
    async () => {
      const host = workspace();
      const other = workspace();
      claudeGame(host);
      claudeGame(other);
      // Each project dispatches only while it is the route host.
      other.writeRoute(claudeRoute(other));
      await tick(other, SLOT);
      await tick(host, SLOT);
      const dirs = [host.path("unblock"), other.path("unblock")];
      const channel = Channel.open(host, dirs);
      channel.initialize();
      channel.initialized();
      await channel.waitFor(() => channel.channel().length >= 2);
      await channel.collect(500);
      expect(channel.channel()).toHaveLength(2);
      await channel.close();
      for (const ws of [host, other]) {
        expect(receipt(ws).status).toBe("accepted");
        expect(ws.list("unblock", "claude-delivered")).toHaveLength(1);
      }
      const repeated = impl.channel(host, [
        "--monitor",
        MONITOR,
        "--state-dir",
        dirs[0]!,
        "--state-dir",
        dirs[0]!,
      ]);
      expect((await execute(repeated)).code).toBe(2);
    },
  );
});
