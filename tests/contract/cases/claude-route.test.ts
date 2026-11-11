// Claude route resolution and adapter selection, observed through the scheduled brief and
// `inbox snapshot`.
import { expect } from "vitest";

import { cli } from "../lib/adapter.ts";
import {
  ARCHIE,
  briefTarget,
  CHIBI,
  claudeGame,
  claudeRoute,
  RECIPIENT,
  tick,
} from "../lib/claude-fixture.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { at } from "../lib/time.ts";
import { otherGame } from "../lib/routes.ts";

const SLOT = at(20);

suite("claude route", () => {
  const workspace = workspaces();

  contract("an active route reaches only its targets, and only the host dispatches", async () => {
    const ws = workspace();
    claudeGame(ws);
    const snapshot = await cli(ws, ["inbox", "snapshot", "--recipient", RECIPIENT]);
    expect(snapshot.code, snapshot.stdout + snapshot.stderr).toBe(0);
    const output = JSON.parse(snapshot.stdout);
    expect(Object.keys(output.target_queue_status)).toEqual([ARCHIE]);
    expect(Object.keys(output.session_status)).toEqual([RECIPIENT, ARCHIE]);
    const result = await tick(ws, SLOT);
    expect(result.review[0]!.result.status).toBe("sending");
    const [entry] = ws.list("unblock", "claude-spool");
    const text = ws.readJson<{ text: string }>(`unblock/claude-spool/${entry}`).text;
    expect(text.split(briefTarget(ws, "Archie tech", ARCHIE))).toHaveLength(2);
    expect(text).not.toContain(CHIBI);
    for (const change of [{ host: otherGame(ws) }, { state: "held", targets: [] }]) {
      ws.writeRoute(claudeRoute(ws, change));
      const quiet = await tick(ws, at(50));
      expect(quiet.review).toEqual([]);
      expect(quiet.stderr).not.toContain("review deferred");
      expect(ws.exists(`unblock/${RECIPIENT}-${at(50)}.json`)).toBe(false);
    }
  });

  contract("the registry's harness, not the route, selects the adapter", async () => {
    const ws = workspace();
    claudeGame(ws);
    // A route names roles only: under a Claude registry the Claude adapter serves it and the
    // Codex path is never taken.
    const claude = await cli(ws, ["inbox", "snapshot", "--recipient", RECIPIENT]);
    expect(claude.code).toBe(0);
    expect(JSON.parse(claude.stdout).harness).toBe("claude");
    expect(claude.stdout + claude.stderr).not.toContain("CODEX_CONTROL_SOCKET");
    for (const route of [
      claudeRoute(ws, { harness: "codex" }),
      claudeRoute(ws, { schema: 1 }),
      [],
      { schema: "2", targets: [] },
    ]) {
      ws.writeRoute(route);
      const result = await cli(ws, ["inbox", "snapshot", "--recipient", RECIPIENT]);
      expect(result.code, JSON.stringify(route)).not.toBe(0);
      expect(result.stdout).not.toContain('"harness": "claude"');
    }
  });
});
