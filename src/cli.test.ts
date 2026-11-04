import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMMANDS, EXIT_INVALID, EXIT_OK, EXIT_USAGE, main } from "./cli.ts";
import { loadLayout } from "./layout.ts";
import { createRegistry, type Registry } from "./registry/index.ts";
import { makeFixture, projectConfig, registryInput, writeFixtureJson } from "./testFixtures.ts";

async function run(
  root: string,
  ...argv: string[]
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(
    { cwd: "/nonexistent", env: {}, err: (text) => (err += text), out: (text) => (out += text) },
    ["--root", root, ...argv],
  );
  return { code, err, out };
}

function withRegistry(root: string): void {
  createRegistry(
    loadLayout(root),
    registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">,
  );
}

describe("check-config", () => {
  it("accepts config.json and every game before a registry exists", async () => {
    const { root } = makeFixture();
    const result = await run(root, "check-config");
    expect(result).toMatchObject({ code: EXIT_OK, err: "" });
    expect(result.out).toContain("archies-dog-walks, chibis-way-home; registry absent");
  });

  it("resolves addressed role names against the registry", async () => {
    const { base, root } = makeFixture();
    withRegistry(root);
    expect((await run(root, "check-config")).out).toContain("registry revision 1");
    const config = projectConfig("Chibi");
    (config.reports as Record<string, unknown>).workerParents = [
      "coordinator",
      "chibis-way-home/tech",
    ];
    writeFixtureJson(join(base, "chibis-way-home/delivery-kit.json"), config);
    const result = await run(root, "check-config");
    expect(result.code).toBe(EXIT_INVALID);
    expect(result.err).toContain("no registered role or duty named chibis-way-home/tech");
  });

  it("names workerParents when parents share a conversation", async () => {
    const { base, root } = makeFixture();
    withRegistry(root);
    const config = projectConfig("Chibi");
    (config.reports as Record<string, unknown>).workerParents = ["monitor", "game-dev"];
    writeFixtureJson(join(base, "chibis-way-home/delivery-kit.json"), config);
    const result = await run(root, "check-config");
    expect(result.code).toBe(EXIT_INVALID);
    expect(result.err).toContain(
      "/reports/workerParents/1: game-dev resolves to the same conversation as workerParents/0",
    );
  });

  it("rejects a project name that differs from config.json and limits checks with --game", async () => {
    const { base, root } = makeFixture();
    writeFixtureJson(join(base, "chibis-way-home/delivery-kit.json"), projectConfig("Archie"));
    expect((await run(root, "check-config")).err).toContain("/reports/project must be Chibi");
    expect((await run(root, "check-config", "--game", "archies-dog-walks")).code).toBe(EXIT_OK);
    expect((await run(root, "check-config", "--game", "nope")).code).toBe(EXIT_USAGE);
  });

  it("reports a missing config.json as invalid", async () => {
    const { base } = makeFixture();
    expect((await run(base, "check-config")).code).toBe(EXIT_INVALID);
  });
});

describe("dispatcher", () => {
  it.each(COMMANDS)("%s has a handler", async (command) => {
    const { root } = makeFixture();
    expect((await run(root, command, "--help-unknown-option")).err).not.toContain(
      "not implemented",
    );
  });

  it("prints usage for help and rejects unknown commands", async () => {
    const { root } = makeFixture();
    expect(await run(root, "--help")).toMatchObject({ code: EXIT_OK });
    expect(await run(root, "scheduled-once")).toMatchObject({ code: EXIT_USAGE });
    expect((await run(root, "check-config", "--unknown")).code).toBe(EXIT_USAGE);
  });
});

describe("status --harness", () => {
  it("reports a missing registry or an unreadable layout as not ready, not as a usage error", async () => {
    const { base, root } = makeFixture();
    const absent = await run(root, "status", "--harness", "codex");
    expect(absent.code).toBe(EXIT_INVALID);
    expect(absent.out).toBe("");
    expect(absent.err).toMatch(/^delivery-kit: /);
    const missing = await run(join(base, "no-game-dev"), "status", "--harness", "claude");
    expect(missing.code).toBe(EXIT_INVALID);
    expect(missing.err).toMatch(/^delivery-kit: /);
    expect((await run(root, "status", "--harness", "other")).code).toBe(EXIT_USAGE);
  });
});
