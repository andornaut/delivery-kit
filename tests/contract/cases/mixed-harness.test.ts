import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { execute, impl } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { CodexSocket } from "../lib/codex-socket.ts";
import type { RoleRecord, Workspace } from "../lib/workspace.ts";

const ARCHIE = "archies-dog-walks";
const CHIBI = "chibis-way-home";
const ADA = "ada-the-navigator";

function configure(ws: Workspace): void {
  const roles: Record<string, RoleRecord> = {
    "art-kit": { conversations: { codex: uuid(90) } },
    "game-dev": { conversations: { codex: uuid(91) }, duties: ["monitor"] },
  };
  const games: Record<string, unknown> = {};
  let index = 1;
  for (const [id, name] of [
    [ARCHIE, "Archie"],
    [CHIBI, "Chibi"],
    [ADA, "Ada the Navigator"],
  ]) {
    games[id!] = { name, path: `../${id}`, roles: ["art", "gameplay", "tech"] };
    for (const role of ["art", "gameplay", "tech"]) {
      roles[`${id}/${role}`] = {
        conversations: { ...(id === ADA ? {} : { claude: uuid(index++) }), codex: uuid(index++) },
      };
    }
  }
  ws.updateGameDevConfig({ games });
  ws.writeRegistry({ schema: 1, revision: 1, harness: "codex", roles });
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

suite("mixed harness CLI", () => {
  const workspace = workspaces();

  contract(
    "target probes and scoped selection preserve unselected owners and delivery state",
    async () => {
      const ws = workspace({ game: ARCHIE });
      configure(ws);
      const before = structuredClone(ws.registry());
      const control = ws.read("delivery-control.json");
      const target = await execute(
        impl.bare(ws, ["claude", "ready", "--game", ARCHIE, "--game", CHIBI]),
      );
      expect(target.code, target.stderr).toBe(0);
      expect(JSON.parse(target.stdout).roles).toHaveLength(6);
      expect(ws.registry()).toEqual(before);
      const selected = await execute(
        impl.bare(ws, [
          "harness",
          "select",
          "--harness",
          "claude",
          "--expected-revision",
          "1",
          "--game",
          ARCHIE,
          "--game",
          CHIBI,
        ]),
      );
      expect(selected.code, selected.stderr).toBe(0);
      expect(JSON.parse(selected.stdout)).toEqual(ws.registry());
      expect(ws.registry().harness).toBe("codex");
      for (const key of [`${ADA}/tech`, "game-dev", "art-kit"]) {
        expect(ws.registry().roles[key]).toEqual(before.roles[key]);
      }
      for (const game of [ARCHIE, CHIBI]) {
        for (const role of ["art", "gameplay", "tech"]) {
          expect(ws.registry().roles[`${game}/${role}`]).toMatchObject({ harness: "claude" });
        }
      }
      expect(ws.read("delivery-control.json")).toBe(control);
      expect(ws.exists("runner.lock")).toBe(false);
      expect(
        ws
          .calls()
          .every((call) => call.tool === "claude" && call.args.join(" ") === "agents --json"),
      ).toBe(true);
    },
  );

  contract("mixed effective probes never query Claude identities through Codex", async () => {
    const ws = workspace({ game: ARCHIE });
    configure(ws);
    const selected = await execute(
      impl.bare(ws, [
        "harness",
        "select",
        "--harness",
        "claude",
        "--expected-revision",
        "1",
        "--game",
        ARCHIE,
      ]),
    );
    expect(selected.code, selected.stderr).toBe(0);
    const socket = await new CodexSocket(ws).listen();
    ws.env.CODEX_CONTROL_SOCKET = socket.path;
    try {
      const before = readFileSync(join(ws.gameDev, "var", "registry.json"), "utf8");
      const result = await execute(
        impl.bare(ws, ["harness", "ready", "--game", ARCHIE, "--game", CHIBI, "--role", "monitor"]),
      );
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        harness: "mixed",
        ready: true,
        adapters: { claude: { status: "available" }, codex: { status: "available" } },
      });
      expect(JSON.parse(result.stdout).roles).toHaveLength(7);
      expect(socket.methods()).toEqual([]);
      expect(readFileSync(join(ws.gameDev, "var", "registry.json"), "utf8")).toBe(before);
      const unavailable = await execute(impl.bare(ws, ["claude", "ready", "--game", ADA]));
      expect(unavailable.code).toBe(1);
      expect(
        JSON.parse(unavailable.stdout).roles.every(
          (row: { status: string }) => row.status === "unavailable",
        ),
      ).toBe(true);
      expect(
        (
          await execute(
            impl.bare(ws, ["harness", "select", "--harness", "codex", "--expected-revision", "2"]),
          )
        ).code,
      ).toBe(2);
      expect((await execute(impl.bare(ws, ["harness", "ready", "--game", "unknown"]))).code).toBe(
        1,
      );
    } finally {
      await socket.close();
    }
  });
});
