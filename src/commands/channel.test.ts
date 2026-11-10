import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Io } from "../io.ts";
import { loadLayout } from "../layout.ts";
import { claudeFixture, MONITOR } from "../monitor/fixtures.ts";
import type { Registry } from "../registry/schema.ts";
import { createRegistry, updateRegistry } from "../registry/store.ts";
import { makeFixture, registryInput } from "../testFixtures.ts";
import { runChannel } from "./channel.ts";

function io(): Io & { errors: string[] } {
  const errors: string[] = [];
  return { cwd: "/", env: {}, err: (text) => void errors.push(text), errors, out: () => undefined };
}

describe("claude channel options", () => {
  it("serves a Claude monitor while the global default is Codex", async () => {
    const fixture = claudeFixture();
    updateRegistry(fixture.layout, 1, (draft) => {
      draft.harness = "codex";
      draft.roles["game-dev"]!.harness = "claude";
    });
    const input = new PassThrough();
    const lines: string[] = [];
    const done = runChannel(
      { input, write: (line) => void lines.push(line) },
      io(),
      fixture.layout.root,
      [],
    );
    input.write(`${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "ping" })}\n`);
    input.end();
    expect(await done).toBe(EXIT_OK);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { id: 1, jsonrpc: "2.0", result: {} },
    ]);
  });

  it("refuses a Codex monitor even while the global default is Claude", async () => {
    const fixture = claudeFixture();
    updateRegistry(fixture.layout, 1, (draft) => {
      draft.roles["game-dev"]!.harness = "codex";
      draft.roles["game-dev"]!.conversations.codex = MONITOR;
    });
    const errors = io();
    expect(
      await runChannel(
        { input: new PassThrough(), write: () => undefined },
        errors,
        fixture.layout.root,
        [],
      ),
    ).toBe(EXIT_INVALID);
    expect(errors.errors.join("")).toContain("claude harness for the monitor role");
  });

  it("rejects a repeated state directory, a relative one and a noncanonical monitor", async () => {
    const fixture = claudeFixture();
    const dir = join(fixture.game.busDir, "unblock");
    mkdirSync(dir, { recursive: true });
    const streams = { input: new PassThrough(), write: () => undefined };
    for (const args of [
      ["--monitor", MONITOR, "--state-dir", dir, "--state-dir", dir],
      ["--monitor", MONITOR, "--state-dir", "relative"],
      ["--monitor", MONITOR.toUpperCase().replace("0", "A"), "--state-dir", dir],
      ["--state-dir", dir, "--game", "archies-dog-walks"],
      ["--unknown"],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await runChannel(streams, io(), fixture.layout.root, args), args.join(" ")).toBe(
        EXIT_USAGE,
      );
    }
  });

  it("serves explicit state directories for an explicit monitor until input ends", async () => {
    const fixture = claudeFixture();
    const dir = join(fixture.game.busDir, "unblock");
    const input = new PassThrough();
    const lines: string[] = [];
    const done = runChannel(
      { input, write: (line) => void lines.push(line) },
      io(),
      fixture.layout.root,
      ["--monitor", MONITOR, "--poll-seconds", "0.05", "--state-dir", dir],
    );
    input.write(`${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "ping" })}\n`);
    input.end();
    expect(await done).toBe(EXIT_OK);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { id: 1, jsonrpc: "2.0", result: {} },
    ]);
  });

  it("exits non-zero without a registry and creates nothing", async () => {
    const fixture = makeFixture();
    const errors = io();
    const status = await runChannel(
      { input: new PassThrough(), write: () => undefined },
      errors,
      fixture.root,
      [],
    );
    expect(status).toBe(EXIT_INVALID);
    expect(errors.errors.join("")).toContain("create the registry first");
    expect(existsSync(join(fixture.root, "var"))).toBe(false);
  });

  it("serves before any game state exists without creating a bus directory", async () => {
    const fixture = makeFixture();
    const layout = loadLayout(fixture.root);
    createRegistry(layout, registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">);
    const input = new PassThrough();
    const done = runChannel({ input, write: () => undefined }, io(), fixture.root, [
      "--poll-seconds",
      "0.05",
    ]);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    input.end();
    expect(await done).toBe(EXIT_OK);
    expect(existsSync(join(layout.varDir, "games"))).toBe(false);
  });
});
