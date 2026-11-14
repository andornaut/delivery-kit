import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type FakeControl, startFakeControl } from "../adapters/codex/testControlSocket.ts";
import { main } from "../cli.ts";
import { loadLayout } from "../layout.ts";
import {
  createRegistry,
  readRegistry,
  type Registry,
  type RegistryDraft,
  type RoleRecord,
} from "../registry/index.ts";
import {
  coordinatorConfig,
  makeFixture,
  projectConfig,
  registryInput,
  writeFixtureJson,
} from "../testFixtures.ts";

const ARCHIE = "archies-dog-walks";
const CHIBI = "chibis-way-home";
const ADA = "ada-the-navigator";
const controls: FakeControl[] = [];

afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.close()));
});

function setup() {
  const { base, root } = makeFixture();
  const config = coordinatorConfig();
  (config.games as Record<string, unknown>)[ADA] = {
    name: "Ada the Navigator",
    path: `../${ADA}`,
    roles: ["art", "gameplay", "tech"],
  };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  mkdirSync(join(base, ADA));
  writeFixtureJson(join(base, ADA, "delivery-kit.json"), projectConfig("Ada the Navigator"));
  const layout = loadLayout(root);
  const input = registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">;
  const roles: Record<string, RoleRecord> = {
    "art-kit": { conversations: { codex: uuid(90) }, ownership: "active", worktree: "../art-kit" },
    "game-coordinator": {
      ...input.roles["game-coordinator"]!,
      conversations: { codex: uuid(91) },
    },
  };
  let index = 1;
  for (const game of [ARCHIE, CHIBI, ADA]) {
    for (const role of ["art", "gameplay", "tech"]) {
      const key = `${game}/${role}`;
      roles[key] = {
        ...input.roles[key],
        conversations: {
          ...(game === ADA ? {} : { claude: uuid(index++) }),
          codex: uuid(index++),
        },
        ownership: "active",
        worktree: `../${game}/.worktrees/${role}`,
      };
    }
  }
  createRegistry(layout, { ...input, harness: "codex", roles });
  const claude = join(base, "claude.mjs");
  const claudeCalls = join(base, "claude-calls");
  writeFileSync(
    claude,
    `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\n` +
      `appendFileSync(${JSON.stringify(claudeCalls)}, 'probe\\n');\nprocess.stdout.write('[]\\n');\n`,
    { mode: 0o755 },
  );
  return { base, claudeCalls, env: { CLAUDE_BIN: claude } as NodeJS.ProcessEnv, layout, root };
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

async function run(test: ReturnType<typeof setup>, ...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(
    { cwd: test.root, env: test.env, err: (text) => (err += text), out: (text) => (out += text) },
    argv,
  );
  return { code, err, out };
}

function select(...scope: string[]): string[] {
  return ["harness", "select", "--harness", "claude", "--expected-revision", "1", ...scope];
}

describe("harness select", () => {
  it("atomically selects Archie and Chibi while preserving Ada, shared Codex roles and all other fields", async () => {
    const test = setup();
    const before = readRegistry(test.layout);
    const result = await run(
      test,
      ...select("--game", ARCHIE, "--game", CHIBI, "--role", `${ARCHIE}/tech`),
    );
    expect(result).toMatchObject({ code: 0, err: "" });
    const after = JSON.parse(result.out) as Registry;
    const expected = structuredClone(before) as RegistryDraft;
    expected.revision += 1;
    expected.updatedAt = after.updatedAt;
    for (const game of [ARCHIE, CHIBI]) {
      for (const role of ["art", "gameplay", "tech"]) {
        expected.roles[`${game}/${role}`]!.harness = "claude";
      }
    }
    expect(after).toEqual(expected);
    expect(readRegistry(test.layout)).toEqual(after);
    expect(result.out.trim().split("\n")).toHaveLength(1);
  });

  it("selects shared roles and default removes only the selected override", async () => {
    const test = setup();
    const selected = await run(test, ...select("--role", `${ARCHIE}/tech`));
    expect(selected.code).toBe(0);
    const reset = await run(
      test,
      "harness",
      "select",
      "--harness",
      "default",
      "--expected-revision",
      "2",
      "--role",
      `${ARCHIE}/tech`,
    );
    expect(reset.code).toBe(0);
    expect(readRegistry(test.layout).roles[`${ARCHIE}/tech`]).not.toHaveProperty("harness");
    const shared = await run(
      test,
      "harness",
      "select",
      "--harness",
      "codex",
      "--expected-revision",
      "3",
      "--role",
      "game-coordinator",
    );
    expect(shared.code).toBe(0);
    expect(readRegistry(test.layout).roles["game-coordinator"]!.harness).toBe("codex");
  });

  it("fails closed for missing selected roles, target IDs, invalid games and stale revisions", async () => {
    const test = setup();
    const before = readFileSync(test.layout.registryFile, "utf8");
    for (const scope of [
      ["--game", "unknown"],
      ["--role", "unknown"],
      ["--game", ADA],
      ["--game", ARCHIE, "--game", ARCHIE],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await run(test, ...select(...scope))).code).toBe(1);
    }
    const stale = select("--game", ARCHIE);
    stale[stale.indexOf("--expected-revision") + 1] = "0";
    expect((await run(test, ...stale)).code).toBe(1);
    expect(readFileSync(test.layout.registryFile, "utf8")).toBe(before);
  });
});

describe("scoped and mixed readiness", () => {
  it("probes effective per-role adapters once without sending or changing selection", async () => {
    const test = setup();
    expect((await run(test, ...select("--game", ARCHIE))).code).toBe(0);
    const control = await startFakeControl(test.base, () => ({ result: {} }));
    controls.push(control);
    test.env.CODEX_CONTROL_SOCKET = control.path;
    const before = readFileSync(test.layout.registryFile, "utf8");
    const result = await run(
      test,
      "harness",
      "ready",
      "--game",
      ARCHIE,
      "--game",
      CHIBI,
      "--role",
      "game-coordinator",
    );
    expect(result).toMatchObject({ code: 0, err: "" });
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({
      harness: "mixed",
      ready: true,
      adapters: { claude: { status: "available" }, codex: { status: "available" } },
    });
    expect(report.roles).toHaveLength(7);
    expect(
      report.roles.find((row: { role: string }) => row.role === "game-coordinator"),
    ).toMatchObject({
      current_harness: "codex",
      probed_harness: "codex",
    });
    expect(readFileSync(test.claudeCalls, "utf8")).toBe("probe\n");
    expect(control.methods()).toEqual([]);
    expect(readFileSync(test.layout.registryFile, "utf8")).toBe(before);
  });

  it("reports unavailable adapters and missing selected conversations, and rejects invalid scopes", async () => {
    const test = setup();
    test.env.CLAUDE_BIN = "/unavailable/claude";
    const missing = await run(test, "claude", "ready", "--game", ADA);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out)).toMatchObject({
      ready: false,
      adapter: { status: "unavailable" },
    });
    expect(
      JSON.parse(missing.out).roles.every(
        (row: { conversation: unknown }) => row.conversation === null,
      ),
    ).toBe(true);
    const effective = await run(test, "harness", "ready", "--game", CHIBI);
    expect(effective.code).toBe(1);
    expect(JSON.parse(effective.out)).toMatchObject({
      ready: false,
      adapters: { codex: { status: "unavailable" } },
    });
    expect((await run(test, "harness", "ready", "--game", "unknown")).code).toBe(1);
    expect((await run(test, "codex", "ready", "--unknown")).code).toBe(2);
  });
});
