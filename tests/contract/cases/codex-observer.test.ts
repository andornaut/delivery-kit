// The routed Codex observer slot and its transport failures. The fake control socket stands in
// for the native server.
import { readFileSync } from "node:fs";
import { afterAll, expect } from "vitest";

import { cli } from "../lib/adapter.ts";
import { clearRecipient } from "../lib/claude-codex.ts";
import { codexWorld, tick } from "../lib/claude-fixture.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { CodexSocket } from "../lib/codex-socket.ts";
import { at } from "../lib/time.ts";
import type { Workspace } from "../lib/workspace.ts";
import type { Json } from "../lib/json.ts";
import { roleRoute } from "../lib/routes.ts";

const TECH = "00000000-0000-0000-0000-000000000001";
const ART = "00000000-0000-0000-0000-000000000002";
const GAMEPLAY = "00000000-0000-0000-0000-000000000003";
const RECIPIENT = "00000000-0000-0000-0000-000000000004";
const PRIVATE = "PRIVATE_QUEUE_PAYLOAD";
const QUEUE = [
  { id: "queued-one", clientUserMessageId: "client-one", input: [{ type: "text", text: PRIVATE }] },
];

/** Tech reports to itself. */
async function nativeGame(ws: Workspace, sockets: CodexSocket[]): Promise<CodexSocket> {
  ws.writeRegistry({
    schema: 1,
    revision: 1,
    harness: "codex",
    roles: {
      tech: { conversations: { codex: TECH } },
      art: { conversations: { codex: ART } },
      gameplay: { conversations: { codex: GAMEPLAY } },
      "game-coordinator": { conversations: { codex: RECIPIENT } },
    },
  });
  ws.config.git = { main: "main", remote: "origin", github: "" };
  ws.config.schedule = { departures: ["00"], timezone: "America/Toronto" };
  ws.config.deploy = { mode: "none", skipPattern: "" };
  ws.config.reports = { project: "Fixture", recipient: "tech" };
  clearRecipient(ws, TECH);
  const socket = await codexWorld(new CodexSocket(ws), { [TECH]: QUEUE }).listen();
  sockets.push(socket);
  ws.env.CODEX_CONTROL_SOCKET = socket.path;
  return socket;
}

suite("codex observer", () => {
  const workspace = workspaces();
  const sockets: CodexSocket[] = [];
  afterAll(async () => {
    for (const socket of sockets.splice(0)) await socket.close();
  });

  contract(
    "the routed observer uses recipient clearance and deduplicates a slot persistently",
    async () => {
      const ws = workspace();
      const socket = await nativeGame(ws, sockets);
      ws.writeRoute(roleRoute(ws, "codex", RECIPIENT, [TECH, GAMEPLAY]));
      const twenty = at(20);
      const fifty = at(50);
      const first = await tick(ws, twenty);
      const receipt = ws.readJson<Json>(`unblock/${RECIPIENT}-${twenty}.json`);
      expect(receipt.status).toBe("deferred");
      const queues = JSON.parse(readFileSync(receipt.snapshot_path, "utf8")).queues;
      expect(new Set(Object.keys(queues))).toEqual(new Set([RECIPIENT, TECH, GAMEPLAY]));
      expect(queues[TECH][0].input[0].text).toBe(PRIVATE);
      expect(socket.methods().some((method) => method.startsWith("turn/"))).toBe(false);
      clearRecipient(ws, RECIPIENT);
      const next = await tick(ws, fifty);
      expect(next.review[0]!.result.status).toBe("accepted");
      const duplicate = await tick(ws, fifty);
      expect(duplicate.review[0]!.result.status).toBe("deduplicated");
      // 1.0 also delivers health events natively to the recipient; only slot requests count.
      const mutations = socket.slotMutations();
      expect(
        mutations.map((call) => [call.method, call.params.threadId]),
        JSON.stringify(socket.calls.filter(CodexSocket.isEvent).map((c) => c.params.input)),
      ).toEqual([["turn/steer", RECIPIENT]]);
      expect(ws.readJson<Json>(`unblock/${RECIPIENT}-${fifty}.json`).status).toBe("accepted");
      expect(first.stdout + next.stdout + duplicate.stdout).not.toContain(PRIVATE);
    },
  );

  contract("a transport failure reports a generic reason without private bodies", async () => {
    const ws = workspace();
    const socket = await nativeGame(ws, sockets);
    socket.on("initialize", { close: true });
    const result = await cli(ws, ["inbox", "snapshot", "--recipient", TECH]);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("PRIVATE_");
  });
});
