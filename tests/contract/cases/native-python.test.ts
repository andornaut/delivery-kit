// Native Codex interpreter selection and capability reporting (from tests/test_native_python.py).
// The fake control socket stands in for the native server; interpreter keys are 0.9 bus.conf only.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, expect } from "vitest";

import { cli } from "../lib/adapter.ts";
import { clearMonitor } from "../lib/claude-codex.ts";
import { codexWorld, tick } from "../lib/claude-fixture.ts";
import { bashConfig, bashOnly, contract, suite, workspaces } from "../lib/cases.ts";
import { CodexSocket } from "../lib/codex-socket.ts";
import { at } from "../lib/time.ts";
import type { Workspace } from "../lib/workspace.ts";
import type { Json } from "../lib/json.ts";

const TECH = "00000000-0000-0000-0000-000000000001";
const ART = "00000000-0000-0000-0000-000000000002";
const GAMEPLAY = "00000000-0000-0000-0000-000000000003";
const MONITOR = "00000000-0000-0000-0000-000000000004";
const PRIVATE = "PRIVATE_QUEUE_PAYLOAD";
const QUEUE = [
  { id: "queued-one", clientUserMessageId: "client-one", input: [{ type: "text", text: PRIVATE }] },
];

function script(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

/** Tech reports to itself; legacy release-driven triage resolves art and gameplay from the session map. */
async function nativeGame(ws: Workspace, sockets: CodexSocket[]): Promise<CodexSocket> {
  ws.writeRegistry({
    schema: 1,
    revision: 1,
    harness: "codex",
    roles: {
      tech: { conversations: { codex: TECH } },
      art: { conversations: { codex: ART } },
      gameplay: { conversations: { codex: GAMEPLAY } },
      monitor: { conversations: { codex: MONITOR } },
    },
  });
  ws.config.git = { main: "main", remote: "origin", github: "" };
  ws.config.schedule = { departures: ["00"], timezone: "America/Toronto" };
  ws.config.deploy = { mode: "none", skipPattern: "" };
  ws.config.reports = { project: "Fixture", recipient: "tech" };
  clearMonitor(ws, TECH);
  const socket = await codexWorld(new CodexSocket(ws), { [TECH]: QUEUE }).listen();
  sockets.push(socket);
  ws.env.CODEX_CONTROL_SOCKET = socket.path;
  return socket;
}

function legacyTriage(ws: Workspace, extra = ""): void {
  const map = `${ws.root}/sessions.json`;
  writeFileSync(map, JSON.stringify({ codex: { tech: TECH, art: ART, gameplay: GAMEPLAY } }));
  ws.legacyConf = `CODEX_SHARED_ROLES=''\nSHARED_TARGETS_FILE=''\nSESSION_MAP_FILE=${map}\n${extra}`;
}

suite("native interpreter", () => {
  const workspace = workspaces();
  const sockets: CodexSocket[] = [];
  afterAll(async () => {
    for (const socket of sockets.splice(0)) await socket.close();
  });

  bashConfig(
    "the default and configured interpreters bypass a PATH python3 for public and scheduled paths",
    async () => {
      const ws = workspace();
      const socket = await nativeGame(ws, sockets);
      legacyTriage(ws);
      const shadow = `${ws.root}/shadow`;
      mkdirSync(shadow);
      script(`${shadow}/python3`, "#!/bin/sh\necho PATH_PYTHON_USED >&2\nexit 91\n");
      const path = ws.baseEnv().PATH;
      ws.env.PATH = `${shadow}:${path}`;
      const result = await cli(ws, ["monitor-snapshot", "--recipient", TECH]);
      expect(result.code, result.stderr).toBe(0);
      const snapshot = JSON.parse(result.stdout);
      expect(existsSync(snapshot.path)).toBe(true);
      expect(result.stdout + result.stderr).not.toContain(PRIVATE);
      expect(result.stderr).not.toContain("PATH_PYTHON_USED");
      const log = `${ws.root}/wrapper-calls`;
      const wrapper = script(
        `${ws.root}/native-python`,
        `#!/bin/sh\nprintf "selected\\n" >> "${log}"\nexec /usr/bin/python3 "$@"\n`,
      );
      legacyTriage(ws, `CODEX_PYTHON=${wrapper}\n`);
      expect((await cli(ws, ["monitor-snapshot", "--recipient", TECH])).code).toBe(0);
      // The resident runner itself runs PATH python3 helpers, so the shadow covers only the CLI.
      ws.env.PATH = path;
      const scheduled = await tick(ws, at(0));
      expect(scheduled.monitor[0]!.result.status).toBe("accepted");
      expect(scheduled.stdout + scheduled.stderr).not.toContain(PRIVATE);
      expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual([
        "selected",
        "selected",
        "selected",
      ]);
      expect(socket.callsOf("turn/steer").map((call) => call.params.threadId)).toEqual([TECH]);
    },
  );

  contract(
    "the routed observer uses monitor clearance and deduplicates a slot persistently",
    async () => {
      const ws = workspace();
      const socket = await nativeGame(ws, sockets);
      ws.writeRoute({
        version: 1,
        harness: "codex",
        host_project_root: ws.repo,
        state: "active",
        monitor_thread_id: MONITOR,
        targets: [
          { thread_id: TECH, ownership: "active" },
          { thread_id: GAMEPLAY, ownership: "active" },
        ],
      });
      const twenty = at(20);
      const fifty = at(50);
      const first = await tick(ws, twenty);
      const receipt = ws.readJson<Json>(`unblock/${MONITOR}-${twenty}.json`);
      expect(receipt.status).toBe("deferred");
      const queues = JSON.parse(readFileSync(receipt.snapshot_path, "utf8")).queues;
      expect(new Set(Object.keys(queues))).toEqual(new Set([MONITOR, TECH, GAMEPLAY]));
      expect(queues[TECH][0].input[0].text).toBe(PRIVATE);
      expect(socket.methods().some((method) => method.startsWith("turn/"))).toBe(false);
      clearMonitor(ws, MONITOR);
      const next = await tick(ws, fifty);
      expect(next.monitor[0]!.result.status).toBe("accepted");
      const duplicate = await tick(ws, fifty);
      expect(duplicate.monitor[0]!.result.status).toBe("deduplicated");
      const mutations = socket.calls.filter((call) => call.method.startsWith("turn/"));
      expect(mutations.map((call) => [call.method, call.params.threadId])).toEqual([
        ["turn/steer", MONITOR],
      ]);
      expect(ws.readJson<Json>(`unblock/${MONITOR}-${fifty}.json`).status).toBe("accepted");
      expect(first.stdout + next.stdout + duplicate.stdout).not.toContain(PRIVATE);
    },
  );

  bashConfig(
    "an invalid declared interpreter never falls back or breaks nonnative configuration",
    async () => {
      const ws = workspace();
      const socket = await nativeGame(ws, sockets);
      const nonexecutable = `${ws.root}/not-executable`;
      writeFileSync(nonexecutable, "fixture");
      for (const value of ["", "python3", `${ws.root}/missing-python`, nonexecutable]) {
        legacyTriage(ws, `CODEX_PYTHON='${value}'\n`);
        expect((await cli(ws, ["check-config"])).code, value).toBe(0);
        const snapshot = await cli(ws, ["monitor-snapshot", "--recipient", TECH]);
        expect(snapshot.code, value).toBe(2);
        expect(snapshot.stderr).toContain("CODEX_PYTHON");
        const scheduled = await tick(ws, at(0), {
          done: ({ stderr }) => stderr.includes("CODEX_PYTHON"),
        });
        expect(scheduled.stderr, value).toContain("CODEX_PYTHON");
      }
      expect(socket.calls).toEqual([]);
    },
  );

  bashOnly(
    "a missing websocket dependency names the actual interpreter without private error bodies",
    async () => {
      const ws = workspace();
      await nativeGame(ws, sockets);
      legacyTriage(ws);
      ws.env.PYTHONPATH = "";
      const result = await cli(ws, ["monitor-snapshot", "--recipient", TECH]);
      expect(result.code).toBe(1);
      const reason = JSON.parse(result.stdout).reason as string;
      expect(reason).toContain("websocket-client");
      expect(reason).toContain("/usr/bin/python3");
      expect(reason).toContain("CODEX_PYTHON");
      const scheduled = await tick(ws, at(0));
      expect(scheduled.stdout).toContain(reason);
      expect(result.stdout + result.stderr + scheduled.stdout + scheduled.stderr).not.toContain(
        "PRIVATE_",
      );
    },
  );

  contract("a transport failure reports a generic reason without private bodies", async () => {
    const ws = workspace();
    const socket = await nativeGame(ws, sockets);
    socket.on("initialize", { close: true });
    const result = await cli(ws, ["monitor-snapshot", "--recipient", TECH]);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("PRIVATE_");
    expect(JSON.parse(result.stdout).reason).not.toContain("websocket-client");
  });
});
