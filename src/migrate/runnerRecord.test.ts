// CLEANUP (added 2026-11-03): remove with src/migrate/ at convergence (see tree.ts).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GameLayout } from "../layout.ts";
import { writeFixtureJson } from "../testFixtures.ts";
import { type ProcessProbe, runnerFromNodeModules } from "./runnerRecord.ts";

let base: string;
let game: GameLayout;
const cliPath = (): string => join(game.repo, "node_modules/@andornaut/delivery-kit/dist/cli.js");

function probe(overrides: Partial<ProcessProbe> = {}): ProcessProbe {
  return {
    alive: () => true,
    argv: () => ["node", join(game.repo, "node_modules", ".bin", "delivery-kit"), "run"],
    realpath: (path) =>
      path.endsWith(join(".bin", "delivery-kit"))
        ? cliPath()
        : path.includes("node_modules")
          ? path
          : undefined,
    ...overrides,
  };
}

function record(fields: Record<string, unknown> = {}): void {
  writeFixtureJson(join(game.busDir, "runner.json"), {
    cliPath: cliPath(),
    cliSha256: "c".repeat(64),
    pid: 4242,
    schema: 1,
    startedAt: "2026-11-03T00:00:00Z",
    version: "1.0.0",
    ...fields,
  });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "runner-record-"));
  const stateDir = join(base, "var", "games", "game");
  game = {
    busDir: join(stateDir, "bus"),
    configFile: join(base, "game", "delivery-kit.json"),
    id: "game",
    migratedFile: join(stateDir, "migrated.json"),
    name: "Game",
    repo: join(base, "game"),
    stateDir,
  };
  mkdirSync(game.busDir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { force: true, recursive: true });
});

describe("runnerFromNodeModules", () => {
  it("accepts a live runner loading the node_modules copy through its bin link", () => {
    record();
    expect(runnerFromNodeModules(probe(), game)).toMatchObject({ ok: true, record: { pid: 4242 } });
  });

  const cases: [string, () => void, () => ProcessProbe, string][] = [
    ["no record", () => undefined, () => probe(), "no runner record"],
    ["a malformed record", () => record({ cliSha256: "short" }), () => probe(), "not a version 1"],
    [
      "another cli path",
      () => record({ cliPath: "/opt/delivery-kit/dist/cli.js" }),
      () => probe(),
      "not the node_modules copy",
    ],
    ["a dead pid", () => record(), () => probe({ alive: () => false }), "is not running"],
    [
      "unreadable argv",
      () => record(),
      () => probe({ argv: () => undefined }),
      "cannot read the argv",
    ],
    [
      "a reused pid",
      () => record(),
      () => probe({ argv: () => ["sleep", "60"] }),
      "is not running",
    ],
    [
      "a missing package",
      () => record(),
      () => probe({ realpath: () => undefined }),
      "is not installed",
    ],
  ];
  it.each(cases)("rejects %s", (_name, arrange, using, reason) => {
    arrange();
    const result = runnerFromNodeModules(using(), game);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain(reason);
  });
});
