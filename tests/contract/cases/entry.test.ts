// CLI entry, usage and offline configuration validation.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { cli, execute, impl } from "../lib/adapter.ts";
import { contract, EXIT_INVALID, suite, workspaces } from "../lib/cases.ts";
import type { Workspace } from "../lib/workspace.ts";

const FIRST = "00000000-0000-0000-0000-000000000001";
const SECOND = "abcdefab-1234-5678-9012-abcdefabcdef";
// The one-off request command.
const REQUEST_WORD = "request";

function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      out.push(path);
      try {
        walk(path);
      } catch {
        // Not a directory.
      }
    }
  };
  walk(root);
  return out;
}

function minimal(ws: Workspace): void {
  ws.config = {
    schema: 1,
    git: { main: "main", remote: "origin", github: "" },
    schedule: { departures: ["00"] },
    gate: { image: "unused", install: "", steps: [] },
    resources: { cpus: 4, loadLimit: 24 },
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
      roles: { "game-dev": { conversations: {}, duties: ["coordinator"] } },
    });
    const result = await cli(ws, [
      "control",
      "--state",
      "paused",
      "--reason",
      "operator pause",
      "--requester",
      "coordinator",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      state: "paused",
      requester: "game-dev",
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
      roles(ws, { "game-dev": FIRST });
      const valid = [
        "control",
        "--state",
        "enabled",
        "--reason",
        "operator enable",
        "--requester",
        "game-dev",
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

  contract("help requires no configuration, state or runtime writes", async () => {
    const ws = workspace();
    // Build command lines first: adapters may prepare scratch support files.
    const commands = ["--help", "help"].map((word) => impl.help(ws, word));
    const before = tree(ws.root);
    for (const command of commands) {
      const result = await execute(command);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(REQUEST_WORD);
      expect(result.stdout).toContain("--parent UUID");
      expect(result.stderr).toBe("");
    }
    expect(tree(ws.root)).toEqual(before);
    for (const command of [impl.bare(ws, ["invalid"]), impl.command(ws, ["invalid"])]) {
      const result = await execute(command);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("usage:");
    }
  });

  contract("check-config has no runtime side effects", async () => {
    const ws = workspace();
    minimal(ws);
    const before = ws.list();
    const result = await execute(impl.checkConfig(ws));
    expect(result.code, result.stderr).toBe(0);
    expect(ws.list()).toEqual(before);
    expect(ws.calls()).toEqual([]);
  });

  contract(
    "worker parents must resolve to canonical, unique conversation IDs offline",
    async () => {
      const ws = workspace();
      minimal(ws);
      const before = ws.list();
      const valid: string[][] = [[], [FIRST], [FIRST, SECOND]];
      for (const ids of valid) {
        roles(ws, Object.fromEntries(ids.map((id, i) => [`parent-${i}`, id])));
        ws.config.reports = { workerParents: ids.map((_, i) => `parent-${i}`) };
        const result = await execute(impl.checkConfig(ws));
        expect(result.code, `${ids} ${result.stderr}`).toBe(0);
      }
      const invalid: string[][] = [
        ["invalid"],
        [SECOND.toUpperCase()],
        [FIRST.replace(/-/g, "")],
        [FIRST, FIRST],
        ["*"],
        [FIRST + ","],
      ];
      for (const ids of invalid) {
        roles(ws, Object.fromEntries(ids.map((id, i) => [`parent-${i}`, id])));
        ws.config.reports = { workerParents: ids.map((_, i) => `parent-${i}`) };
        const result = await execute(impl.checkConfig(ws));
        expect(result.code, `${ids} ${result.stderr}`).toBe(EXIT_INVALID);
        expect(result.stderr).toMatch(/workerParents/);
      }
      expect(ws.calls()).toEqual([]);
      expect(ws.list()).toEqual(before);
    },
  );

  contract("manual departure and unpinned revision flags are rejected", async () => {
    const ws = workspace();
    minimal(ws);
    expect((await cli(ws, ["depart"])).code).toBe(2);
    const command = impl.checkConfig(ws);
    const index = command.argv.indexOf("check-config");
    command.argv.splice(index, 0, "--revision", "a".repeat(40));
    expect((await execute(command)).code).toBe(2);
  });

  contract("deployment mode requires an explicit supported value", async () => {
    const ws = workspace();
    minimal(ws);
    const before = ws.list();
    for (const mode of [undefined, "workers-builds", ""]) {
      ws.config.deploy = { mode, skipPattern: "" };
      expect((await execute(impl.checkConfig(ws))).code, String(mode)).toBe(EXIT_INVALID);
    }
    for (const mode of ["none", "wrangler"]) {
      ws.config.deploy = { mode, skipPattern: "" };
      expect((await execute(impl.checkConfig(ws))).code, mode).toBe(0);
    }
    expect(ws.list()).toEqual(before);
  });

  contract("resource caps require integers from 1 through 4 without runtime activity", async () => {
    const ws = workspace();
    minimal(ws);
    const before = ws.list();
    for (const value of [0, -1, 5, 1.5, "invalid", "2+2", "", "04"]) {
      ws.config.resources = { cpus: value, loadLimit: 24 };
      const result = await execute(impl.checkConfig(ws));
      expect(result.code, `cpus=${value} ${result.stderr}`).toBe(EXIT_INVALID);
    }
    for (const value of [1, 4]) {
      ws.config.resources = { cpus: value, loadLimit: 24 };
      const result = await execute(impl.checkConfig(ws));
      expect(result.code, `cpus=${value} ${result.stderr}`).toBe(0);
    }
    expect(ws.list()).toEqual(before);
    expect(ws.calls()).toEqual([]);
  });

  contract("resources.maxWorkers is an unknown key", async () => {
    const ws = workspace();
    minimal(ws);
    const before = ws.list();
    ws.config.resources = { cpus: 4, maxWorkers: 4, loadLimit: 24 };
    const result = await execute(impl.checkConfig(ws));
    expect(result.code, result.stderr).toBe(EXIT_INVALID);
    expect(`${result.stdout}${result.stderr}`).toContain("/resources/maxWorkers: unknown key");
    expect(ws.list()).toEqual(before);
    expect(ws.calls()).toEqual([]);
  });
});
