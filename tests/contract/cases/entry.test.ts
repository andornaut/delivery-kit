// Delivery control and the runner's startup preconditions.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { cli, execute, impl } from "../lib/adapter.ts";
import { contract, EXIT_INVALID, suite, workspaces } from "../lib/cases.ts";
import { bundledCoordinationKit } from "../lib/node-adapter.ts";
import type { Workspace } from "../lib/workspace.ts";

const FIRST = "00000000-0000-0000-0000-000000000001";

function minimal(ws: Workspace): void {
  ws.config = {
    schema: 1,
    git: { main: "main", remote: "origin", github: "" },
    schedule: { departures: ["00"] },
    gate: { image: "unused", install: "", steps: [] },
    resources: { cpus: 4, loadLimit: 24, memoryMiB: 4096 },
    deploy: { mode: "none", skipPattern: "" },
    reports: {},
  };
}

function roles(ws: Workspace, ids: Record<string, string>): void {
  ws.writeRegistry({
    schema: 1,
    revision: 1,
    harness: "claude",
    roles: Object.fromEntries(
      Object.entries(ids).map(([role, id]) => [role, { conversations: { claude: id } }]),
    ),
  });
}

suite("entry", () => {
  const workspace = workspaces();

  contract("control explicitly adopts a missing record without starting a runner", async () => {
    const ws = workspace({ deliveryState: null });
    minimal(ws);
    ws.writeRegistry({
      schema: 1,
      revision: 1,
      harness: "claude",
      roles: { "game-coordinator": { conversations: {} } },
    });
    const result = await cli(ws, [
      "control",
      "--state",
      "paused",
      "--reason",
      "operator pause",
      "--requester",
      "game-coordinator",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      state: "paused",
      requester: "game-coordinator",
      reason: "operator pause",
      revision: 1,
    });
    expect(ws.readJson("delivery-control.json")).toMatchObject({
      schema: 1,
      desired: { state: "paused" },
      observed: null,
      activities: {},
    });
    expect(ws.exists("runner.lock")).toBe(false);
    expect(ws.exists("runner.identity.json")).toBe(false);
    expect(ws.calls()).toEqual([]);
  });

  contract(
    "control requires explicit options and registered role names and preserves corrupt state",
    async () => {
      const ws = workspace({ deliveryState: null });
      minimal(ws);
      roles(ws, { "game-coordinator": FIRST });
      const valid = [
        "control",
        "--state",
        "enabled",
        "--reason",
        "operator enable",
        "--requester",
        "game-coordinator",
      ];
      for (const flag of ["--state", "--reason", "--requester"]) {
        const words = [...valid];
        words.splice(words.indexOf(flag), 2);
        expect((await cli(ws, words)).code).toBe(2);
      }
      for (const requester of ["unknown-role", FIRST]) {
        const words = [...valid];
        words[words.length - 1] = requester;
        expect((await cli(ws, words)).code).toBe(1);
      }
      expect(ws.exists("delivery-control.json")).toBe(false);
      const corrupt = '{"desired":{"state":"paused"}}\n';
      ws.write("delivery-control.json", corrupt);
      const refused = await cli(ws, valid);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(ws.read("delivery-control.json")).toBe(corrupt);
      expect(ws.calls()).toEqual([]);
    },
  );

  contract("missing memoryMiB rejects runner startup before any container activity", async () => {
    const ws = workspace();
    minimal(ws);
    delete ws.config.resources!.memoryMiB;
    const before = ws.list();
    const result = await execute(impl.run(ws));
    expect(result.code, result.stderr).toBe(EXIT_INVALID);
    expect(result.stderr).toContain("/resources/memoryMiB: is required");
    expect(ws.list()).toEqual(before);
    expect(ws.calls()).toEqual([]);
  });

  contract(
    "status reports the bundled coordination-kit, which the game does not install",
    async () => {
      const ws = workspace();
      minimal(ws);
      const status = await execute(impl.status(ws));
      expect(status.code, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout).coordination_kit).toEqual({
        bundled: bundledCoordinationKit(),
        supported: ">=1.0.1 <2.0.0",
      });
      // Every runner case starts with no coordination-kit package in the game.
      expect(existsSync(join(ws.repo, "node_modules", "@andornaut", "coordination-kit"))).toBe(
        false,
      );
    },
  );
});
