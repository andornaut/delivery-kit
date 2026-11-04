// CLI entry, usage and offline configuration validation (from tests/test_entry.py).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { cli, execute, impl } from "../lib/adapter.ts";
import {
  bashConfig,
  bashOnly,
  contract,
  EXIT_INVALID_CONFIG,
  MAX_WORKERS_REMOVED,
  suite,
  workspaces,
} from "../lib/cases.ts";
import { BASH_ROOT } from "../lib/parity.ts";
import type { Workspace } from "../lib/workspace.ts";

const FIRST = "00000000-0000-0000-0000-000000000001";
const SECOND = "abcdefab-1234-5678-9012-abcdefabcdef";
// The one-off request command: `request-once` in 0.9, `request` in 1.0 (decision 2).
const REQUEST_WORD = impl.name === "bash" ? "request-once" : "request";

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
        expect(result.code, `${ids} ${result.stderr}`).toBe(EXIT_INVALID_CONFIG);
        expect(result.stderr).toMatch(
          impl.name === "bash" ? /WORKER_PARENT_THREADS/ : /workerParents/,
        );
      }
      expect(ws.calls()).toEqual([]);
      expect(ws.list()).toEqual(before);
    },
  );

  bashConfig(
    "WORKER_PARENT_THREADS accepts whitespace-separated lists and never calls the interpreter",
    async () => {
      const ws = workspace();
      minimal(ws);
      const marker = join(ws.root, "unexpected-native-call");
      const interpreter = join(ws.root, "unexpected-python");
      execFileSync("sh", [
        "-c",
        `printf '#!/bin/sh\\ntouch "%s"\\nexit 99\\n' "$1" > "$2"; chmod +x "$2"`,
        "x",
        marker,
        interpreter,
      ]);
      const base = `CODEX_PYTHON="${interpreter}"\n`;
      for (const value of ["", " \t\n ", FIRST, ` \t${FIRST}\n${SECOND} `]) {
        ws.legacyConf = base + `WORKER_PARENT_THREADS='${value}'\n`;
        expect((await execute(impl.checkConfig(ws))).code).toBe(0);
      }
      for (const value of [`${FIRST} ${FIRST}`, `${FIRST}\n${FIRST}`]) {
        ws.legacyConf = base + `WORKER_PARENT_THREADS='${value}'\n`;
        const result = await execute(impl.checkConfig(ws));
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("WORKER_PARENT_THREADS");
      }
      expect(existsSync(marker)).toBe(false);
    },
  );

  bashOnly(
    "monitor-snapshot forwards only explicit repeated --parent flags to the native entrypoint",
    async () => {
      const ws = workspace();
      minimal(ws);
      const second = "00000000-0000-0000-0000-000000000002";
      const interpreter = join(ws.root, "native-python");
      execFileSync("sh", [
        "-c",
        `printf '#!%s\\nconsole.log(JSON.stringify(process.argv.slice(2)))\\n' "$2" > "$1"; chmod +x "$1"`,
        "x",
        interpreter,
        process.execPath,
      ]);
      ws.legacyConf = `CODEX_PYTHON="${interpreter}"\nWORKER_PARENT_THREADS=${second}\n`;
      for (const parents of [[], ["--parent", FIRST, "--parent", second]]) {
        const result = await cli(ws, ["monitor-snapshot", "--recipient", FIRST, ...parents]);
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([
          join(BASH_ROOT, "libexec/monitor.py"),
          "snapshot",
          "--state-dir",
          ws.path("unblock"),
          "--control-socket",
          "",
          "--recipient",
          FIRST,
          ...parents,
        ]);
      }
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

  bashOnly("exported snapshot enforces its exact revision and refuses overwrite", async () => {
    const ws = workspace();
    minimal(ws);
    const source = join(ws.root, "source");
    mkdirSync(source);
    for (const name of ["bin", "libexec", "scripts"])
      cpSync(join(BASH_ROOT, name), join(source, name), { recursive: true });
    // Export uses the real Git; fakes stay off PATH for this packaging step.
    const env = { ...ws.baseEnv(), PATH: "/usr/local/bin:/usr/bin:/bin" };
    const git = (...args: string[]) =>
      execFileSync("/usr/bin/git", ["-C", source, ...args], { env, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("add", "--", "bin", "libexec", "scripts");
    git("-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "Fixture");
    const revision = git("rev-parse", "HEAD");
    const snapshot = join(ws.root, "snapshot");
    const exported = {
      argv: ["bash", join(source, "scripts/export.sh"), revision, snapshot],
      cwd: ws.root,
      env,
    };
    expect((await execute(exported)).code).toBe(0);
    expect(readFileSync(join(snapshot, "SOURCE_COMMIT"), "utf8").trim()).toBe(revision);
    expect((await execute(exported)).code).not.toBe(0);
    const command = impl.checkConfig(ws);
    command.argv[1] = join(snapshot, "bin/delivery-kit");
    command.argv.splice(command.argv.indexOf("check-config"), 0, "--revision", revision);
    expect((await execute(command)).code).toBe(0);
    command.argv[command.argv.indexOf(revision)] = "0".repeat(40);
    expect((await execute(command)).code).toBe(2);
  });

  contract("deployment mode requires an explicit supported value", async () => {
    const ws = workspace();
    minimal(ws);
    const before = ws.list();
    for (const mode of [undefined, "workers-builds", ""]) {
      ws.config.deploy = { mode, skipPattern: "" };
      expect((await execute(impl.checkConfig(ws))).code, String(mode)).toBe(EXIT_INVALID_CONFIG);
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
      expect(result.code, `cpus=${value} ${result.stderr}`).toBe(EXIT_INVALID_CONFIG);
    }
    for (const value of [1, 4]) {
      ws.config.resources = { cpus: value, loadLimit: 24 };
      const result = await execute(impl.checkConfig(ws));
      expect(result.code, `cpus=${value} ${result.stderr}`).toBe(0);
    }
    expect(ws.list()).toEqual(before);
    expect(ws.calls()).toEqual([]);
  });

  contract("resources.maxWorkers is an unknown key in 1.0", async () => {
    const ws = workspace();
    minimal(ws);
    const before = ws.list();
    ws.config.resources = MAX_WORKERS_REMOVED
      ? { cpus: 4, maxWorkers: 4, loadLimit: 24 }
      : { cpus: 4, loadLimit: 24 };
    const result = await execute(impl.checkConfig(ws));
    if (MAX_WORKERS_REMOVED) {
      expect(result.code, result.stderr).toBe(EXIT_INVALID_CONFIG);
      expect(`${result.stdout}${result.stderr}`).toContain("/resources/maxWorkers: unknown key");
    } else {
      // 0.9 requires MAX_WORKERS from 1 through 4.
      expect(result.code, result.stderr).toBe(0);
      ws.config.resources = { cpus: 4, maxWorkers: 5, loadLimit: 24 };
      expect((await execute(impl.checkConfig(ws))).code).toBe(EXIT_INVALID_CONFIG);
    }
    expect(ws.list()).toEqual(before);
    expect(ws.calls()).toEqual([]);
  });
});
