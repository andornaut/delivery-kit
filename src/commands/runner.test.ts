import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { holdLock } from "@andornaut/coordination-kit/build/shared";
import { describe, expect, it } from "vitest";

import { busPaths } from "../bus/state.ts";
import { SUPERVISION_TOOLS } from "../bus/supervision.ts";
import { GAME, makeGame } from "../bus/testGame.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_REFUSED, EXIT_USAGE, main } from "../cli.ts";
import { installCoordinationKit } from "../testFixtures.ts";

async function cli(env: NodeJS.ProcessEnv, root: string, ...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(
    { cwd: "/nonexistent", env, err: (text) => (err += text), out: (text) => (out += text) },
    ["--root", root, ...argv],
  );
  return { code, err, out };
}

function toolDirectory(tools: readonly string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "delivery-kit-path-"));
  for (const name of tools) {
    writeFileSync(join(directory, name), "#!/bin/sh\n");
    chmodSync(join(directory, name), 0o755);
  }
  return directory;
}

function installCli(repo: string): string {
  const path = join(repo, "node_modules", "@andornaut", "delivery-kit", "dist", "cli.js");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "installed build");
  return path;
}

/** Every file name under a directory, recursively, for a no-write check. */
function tree(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

describe("runner unit", () => {
  it("prints the unit for the game's installed CLI and writes nothing", async () => {
    const test = makeGame();
    const cliPath = installCli(test.repo);
    const tools = toolDirectory(SUPERVISION_TOOLS);
    const before = tree(test.base);
    const result = await cli({ PATH: tools }, test.layout.root, "runner", "unit", "--game", GAME);
    expect(result).toMatchObject({ code: EXIT_OK, err: "" });
    const lines = result.out.split("\n");
    expect(lines).toContain(`WorkingDirectory=${test.repo}`);
    expect(lines).toContain(`Environment="DELIVERY_KIT_ROOT=${test.layout.root}"`);
    expect(lines).toContain(`Environment="PATH=${dirname(process.execPath)}:${tools}"`);
    expect(lines).toContain(`ExecStart=${process.execPath} ${cliPath} run --game ${GAME}`);
    expect(lines).toContain(`RestartPreventExitStatus=${EXIT_REFUSED}`);
    expect(lines).toContain(
      "Description=delivery-kit resident runner for Archie (archies-dog-walks)",
    );
    expect(tree(test.base)).toEqual(before);
  });

  it("fails with the missing tools or CLI and requires a game", async () => {
    const test = makeGame();
    const tools = toolDirectory(["git", "docker"]);
    const root = test.layout.root;
    const missingCli = await cli({ PATH: tools }, root, "runner", "unit", "--game", GAME);
    expect(missingCli.code).toBe(EXIT_INVALID);
    expect(missingCli.err).toContain("node_modules/@andornaut/delivery-kit/dist/cli.js is missing");
    installCli(test.repo);
    expect(await cli({ PATH: tools }, root, "runner", "unit", "--game", GAME)).toEqual({
      code: EXIT_INVALID,
      err: "delivery-kit: runner unit: required tools not found on PATH: gh, flock, claude\n",
      out: "",
    });
    expect((await cli({ PATH: tools }, root, "runner", "unit")).code).toBe(EXIT_USAGE);
    expect((await cli({ PATH: tools }, root, "runner")).code).toBe(EXIT_USAGE);
  });
});

describe("run refusal", () => {
  it("exits with the distinct refusal status while another runner holds the lock", async () => {
    const test = makeGame();
    installCoordinationKit(test.repo);
    const bus = busPaths(test.game.busDir);
    const holder = holdLock(bus.runnerLock);
    try {
      const result = await cli({}, test.layout.root, "run", "--game", GAME);
      expect(result).toEqual({
        code: EXIT_REFUSED,
        err: "delivery-kit: a runner is already active\n",
        out: "",
      });
      expect(EXIT_REFUSED).not.toBe(EXIT_INVALID);
    } finally {
      holder.release();
    }
  });
});

describe("run pin guard", () => {
  it("refuses to start before any lock when coordination-kit is outside the supported range", async () => {
    const test = makeGame();
    const bus = busPaths(test.game.busDir);
    for (const [version, reason] of [
      [undefined, "@andornaut/coordination-kit is not installed in the game's node_modules"],
      ["2.0.0", "@andornaut/coordination-kit 2.0.0 is outside the supported range >=1.0.0 <2.0.0"],
    ] as const) {
      if (version !== undefined) {
        installCoordinationKit(test.repo, version);
      }
      // eslint-disable-next-line no-await-in-loop
      const result = await cli({}, test.layout.root, "run", "--game", GAME);
      expect(result).toMatchObject({ code: EXIT_INVALID, out: "" });
      expect(result.err).toContain(reason);
      expect(readdirSync(bus.dir)).not.toContain("runner.lock");
    }
  });
});
