// Legacy release-driven Codex triage peer resolution and route project-root guards
// (from tests/test_codex_adapter.py and tests/test_entry.py).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect } from "vitest";

import { bashConfig, suite, workspaces } from "../lib/cases.ts";
import { at, sleep } from "../lib/time.ts";
import { ART, GAMEPLAY, TECH } from "../lib/unblock-native.ts";
import { codexRegistry, codexRoute, decide, Monitored, wake } from "../lib/unblock-runner.ts";
import type { Workspace } from "../lib/workspace.ts";

const LIBRARY = "00000000-0000-0000-0000-000000000004";
const OTHER = "00000000-0000-0000-0000-000000000005";
const HELD = "00000000-0000-0000-0000-000000000006";

suite("codex triage", () => {
  const workspace = workspaces();
  const open: Monitored[] = [];
  afterEach(async () => {
    for (const monitored of open.splice(0)) await monitored.close();
  });

  /** Legacy mode: no monitor route; departures at minute 05 run the release-driven triage. */
  async function legacy(ws: Workspace = workspace()): Promise<Monitored> {
    codexRegistry(ws);
    ws.config.schedule = { departures: ["05"], timezone: "America/Toronto" };
    ws.config.reports = { recipient: "monitor" };
    decide(ws, TECH, { thread_id: TECH, state: "clear" });
    const m = new Monitored(ws);
    await m.listen();
    open.push(m);
    return m;
  }

  function files(
    ws: Workspace,
    mapping: unknown,
    targets: unknown,
  ): { map: string; targets: string } {
    const paths = { map: join(ws.root, "sessions.json"), targets: join(ws.root, "shared.json") };
    writeFileSync(paths.map, JSON.stringify(mapping));
    writeFileSync(paths.targets, JSON.stringify(targets));
    return paths;
  }

  /** Reach the departure in hour `hour` and return the triaged recipients, or the tick output. */
  async function depart(
    m: Monitored,
    hour: number,
  ): Promise<{ recipients?: string[]; output: string }> {
    const slot = at(5, 0, hour);
    const output = await m.jump(
      slot,
      (text) =>
        text.includes(`scheduled monitor ${slot}`) || text.includes(`hourly unblock ${slot}`),
    );
    const line = output.split("\n").find((row) => row.includes(`scheduled monitor ${slot}: `));
    if (!line) return { output };
    const result = JSON.parse(line.slice(line.indexOf(": {") + 2)) as { snapshot_id: string };
    const snapshot = m.ws.readJson<{ queues: Record<string, unknown> }>(
      `unblock/snapshots/${result.snapshot_id}.json`,
    );
    return { recipients: Object.keys(snapshot.queues), output };
  }

  bashConfig("shared roles respect host, harness, coordinator and ownership guards", async () => {
    const ws = workspace();
    const m = await legacy(ws);
    const mapping = { codex: { tech: TECH, art: ART, gameplay: GAMEPLAY } };
    const config = {
      version: 1,
      harness: "codex",
      host_coordinator_thread_id: TECH,
      host_project_root: ws.repo,
      targets: [
        { role: "custom-library", ownership: "active", thread_id: LIBRARY },
        { role: "custom-library", ownership: "active", thread_id: LIBRARY },
        { role: "custom-library", ownership: "held", thread_id: OTHER },
        { role: "custom-library", ownership: "active", thread_id: "invalid" },
        { role: "custom-library", ownership: "active", thread_id: TECH },
        { role: "unselected", ownership: "active", thread_id: OTHER },
      ],
    };
    const paths = files(ws, mapping, config);
    const conf = (roles: string, targets = paths.targets) =>
      `CODEX_SHARED_ROLES='${roles}'\nSESSION_MAP_FILE='${paths.map}'\nSHARED_TARGETS_FILE='${targets}'\n`;
    ws.legacyConf = conf("custom-library");
    await m.start();
    let hour = -1;
    expect((await depart(m, hour++)).recipients).toEqual([TECH, ART, GAMEPLAY, LIBRARY]);
    for (const change of [
      { harness: "other" },
      { host_project_root: join(ws.repo, "other") },
      { host_coordinator_thread_id: ART },
      { version: true },
    ]) {
      writeFileSync(paths.targets, JSON.stringify({ ...config, ...change }));
      expect((await depart(m, hour++)).recipients, JSON.stringify(change)).toEqual([
        TECH,
        ART,
        GAMEPLAY,
      ]);
    }
    writeFileSync(paths.targets, JSON.stringify(config));
    for (const roles of [
      { tech: ART, art: ART, gameplay: GAMEPLAY },
      { tech: TECH, art: ART, gameplay: ART },
    ]) {
      writeFileSync(paths.map, JSON.stringify({ codex: roles }));
      const tick = await depart(m, hour++);
      expect(tick.recipients).toBeUndefined();
      expect(tick.output).toContain("project session map invalid");
    }
    writeFileSync(paths.map, JSON.stringify(mapping));
    for (const legacyConf of [conf(""), conf("custom-library", "")]) {
      await m.stop();
      ws.legacyConf = legacyConf;
      await m.start();
      expect((await depart(m, -1)).recipients).toEqual([TECH, ART, GAMEPLAY]);
    }
  });

  bashConfig(
    "host-matching library targets are deduplicated and held targets excluded",
    async () => {
      const ws = workspace();
      const m = await legacy(ws);
      const config = {
        version: 1,
        harness: "codex",
        host_coordinator_thread_id: TECH,
        host_project_root: ws.repo,
        targets: [
          { role: "art-kit", ownership: "active", thread_id: LIBRARY },
          { role: "game-kit", ownership: "active", thread_id: LIBRARY },
          { role: "delivery-kit", ownership: "active", thread_id: OTHER },
          { role: "delivery-kit", ownership: "held", thread_id: HELD },
        ],
      };
      const paths = files(ws, { codex: { tech: TECH, art: ART, gameplay: GAMEPLAY } }, config);
      ws.legacyConf = `CODEX_SHARED_ROLES="art-kit delivery-kit game-kit"\nSESSION_MAP_FILE='${paths.map}'\nSHARED_TARGETS_FILE='${paths.targets}'\n`;
      await m.start();
      expect((await depart(m, -1)).recipients).toEqual([TECH, ART, GAMEPLAY, LIBRARY, OTHER]);
      writeFileSync(
        paths.targets,
        JSON.stringify({ ...config, host_project_root: "/different/project" }),
      );
      expect((await depart(m, 0)).recipients).toEqual([TECH, ART, GAMEPLAY]);
    },
  );

  bashConfig(
    "missing socket or shared-role configuration defers triage without the native helper",
    async () => {
      const ws = workspace();
      const m = await legacy(ws);
      for (const [legacyConf, missing, socket] of [
        ["CODEX_SHARED_ROLES=''\n", "CODEX_CONTROL_SOCKET", false],
        ["", "CODEX_SHARED_ROLES", true],
      ] as const) {
        if (socket) ws.env.CODEX_CONTROL_SOCKET = m.socket.path;
        else delete ws.env.CODEX_CONTROL_SOCKET;
        ws.legacyConf = legacyConf;
        await m.start();
        const tick = await depart(m, -1);
        expect(tick.recipients).toBeUndefined();
        expect(tick.output).toContain(missing);
        await m.stop();
      }
      expect(m.socket.connections).toEqual([]);
      expect(ws.exists("unblock/snapshots")).toBe(false);
    },
  );

  bashConfig("a monitor route rejects a relative project root even while held", async () => {
    const ws = workspace();
    const m = await Monitored.routed(ws, { state: "held", monitor_thread_id: null, targets: [] });
    open.push(m);
    ws.legacyConf = "REPO=.\n";
    await m.start();
    const output = await m.jump(wake(0), (text) => text.includes("monitor deferred"));
    expect(output).toContain("MONITOR_ROUTE_FILE is unavailable or invalid");
    await m.stop();
    ws.legacyConf = "";
    ws.writeRoute(codexRoute(ws, { state: "held", monitor_thread_id: null, targets: [] }));
    await m.start();
    await m.jump(wake(0), () => true);
    await sleep(1500);
    expect(m.text()).not.toContain("monitor deferred");
    expect(m.socket.connections).toEqual([]);
  });
});
