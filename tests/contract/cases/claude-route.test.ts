// Version 2 Claude route resolution and harness selection. Observed through the scheduled brief and
// `monitor snapshot`.
import { expect } from "vitest";

import { cli } from "../lib/adapter.ts";
import {
  ARCHIE,
  briefTarget,
  CHIBI,
  claudeGame,
  claudeRoute,
  MONITOR,
  tick,
} from "../lib/claude-fixture.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { at } from "../lib/time.ts";

const SLOT = at(20);

suite("claude route", () => {
  const workspace = workspaces();

  contract(
    "an active route deduplicates targets, excludes held ones and only the host dispatches",
    async () => {
      const ws = workspace();
      claudeGame(ws);
      const snapshot = await cli(ws, ["monitor", "snapshot", "--recipient", MONITOR]);
      expect(snapshot.code, snapshot.stdout + snapshot.stderr).toBe(0);
      const output = JSON.parse(snapshot.stdout);
      expect(Object.keys(output.target_queue_status)).toEqual([ARCHIE]);
      expect(Object.keys(output.session_status)).toEqual([MONITOR, ARCHIE]);
      const result = await tick(ws, SLOT);
      expect(result.monitor[0]!.result.status).toBe("sending");
      const [entry] = ws.list("unblock", "claude-spool");
      const text = ws.readJson<{ text: string }>(`unblock/claude-spool/${entry}`).text;
      expect(text.split(briefTarget(ws, "Archie tech", ARCHIE))).toHaveLength(2);
      expect(text).not.toContain(CHIBI);
      for (const change of [
        { host_project_root: `${ws.repo}/other` },
        {
          state: "held",
          monitor: { session_id: null, name: "monitor", ownership: "held" },
          targets: [],
        },
      ]) {
        ws.writeRoute(claudeRoute(ws, change));
        const quiet = await tick(ws, at(50));
        expect(quiet.monitor).toEqual([]);
        expect(quiet.stderr).not.toContain("monitor deferred");
        expect(ws.exists(`unblock/${MONITOR}-${at(50)}.json`)).toBe(false);
      }
    },
  );

  contract("route harness selection keeps the Codex and Claude resolvers disjoint", async () => {
    const ws = workspace();
    claudeGame(ws);
    const v1 = {
      version: 1,
      harness: "codex",
      host_project_root: ws.repo,
      state: "active",
      monitor_thread_id: MONITOR,
      targets: [{ thread_id: ARCHIE, ownership: "active" }],
    };
    ws.writeRoute(v1);
    const codex = await cli(ws, ["monitor", "snapshot", "--recipient", MONITOR]);
    // The registry's active harness selects the adapter: under a Claude registry a version 1
    // route is rejected or deferred and never takes the Codex path.
    let status: unknown;
    try {
      status = (JSON.parse(codex.stdout) as { status?: unknown }).status;
    } catch {
      status = undefined;
    }
    expect(codex.code !== 0 || status === "deferred", codex.stdout + codex.stderr).toBe(true);
    expect(codex.stdout + codex.stderr).not.toContain("CODEX_CONTROL_SOCKET");
    expect(codex.stdout).not.toContain('"harness": "codex"');
    ws.writeRoute(claudeRoute(ws));
    const claude = await cli(ws, ["monitor", "snapshot", "--recipient", MONITOR]);
    expect(claude.code).toBe(0);
    expect(JSON.parse(claude.stdout).harness).toBe("claude");
    for (const route of [
      { ...v1, version: 2 },
      claudeRoute(ws, { version: 1 }),
      [],
      { version: "2", harness: "claude" },
    ]) {
      ws.writeRoute(route);
      const result = await cli(ws, ["monitor", "snapshot", "--recipient", MONITOR]);
      expect(result.code, JSON.stringify(route)).not.toBe(0);
      expect(result.stdout).not.toContain('"harness": "claude"');
    }
  });
});
