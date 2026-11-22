import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createRegistry, type Registry } from "@andornaut/coordination-kit/build/registry";
import { loadLayout } from "@andornaut/coordination-kit/build/shared";
import { describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, main, USAGE } from "./cli.ts";
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
      "game-coordinator",
      "chibis-way-home/tech",
    ];
    writeFixtureJson(join(base, "chibis-way-home/delivery-kit.json"), config);
    const result = await run(root, "check-config");
    expect(result.code).toBe(EXIT_INVALID);
    expect(result.err).toContain("no registered role named chibis-way-home/tech");
  });

  it("validates var/route.json and names the exact edit for a schema 1 route", async () => {
    const { root } = makeFixture();
    withRegistry(root);
    const layout = loadLayout(root);
    mkdirSync(layout.varDir, { recursive: true });
    const route = {
      host: "archies-dog-walks",
      state: "active",
      targets: ["archies-dog-walks/tech"],
    };
    writeFixtureJson(layout.routeFile, { ...route, schema: 2 });
    expect((await run(root, "check-config")).code).toBe(EXIT_OK);
    writeFixtureJson(layout.routeFile, { ...route, monitor: "game-coordinator", schema: 1 });
    const legacy = await run(root, "check-config");
    expect(legacy.code).toBe(EXIT_INVALID);
    expect(legacy.err).toContain(
      'var/route.json schema 1 is not supported: remove "monitor" and set "schema" to 2',
    );
    writeFixtureJson(layout.routeFile, { ...route, schema: 2, targets: ["game-coordinator"] });
    expect((await run(root, "check-config")).err).toContain(
      "active route targets must not include the recipient game-coordinator",
    );
  });

  it("accepts a game config without reports.project", async () => {
    const { base, root } = makeFixture();
    withRegistry(root);
    const config = projectConfig("Chibi");
    const reports = config.reports as Record<string, unknown>;
    delete reports.project;
    writeFixtureJson(join(base, "chibis-way-home/delivery-kit.json"), config);
    expect(await run(root, "check-config")).toMatchObject({ code: EXIT_OK, err: "" });
  });

  it("rejects a mismatched reports.project and limits checks with --game", async () => {
    const { base, root } = makeFixture();
    writeFixtureJson(join(base, "chibis-way-home/delivery-kit.json"), projectConfig("Archie"));
    const result = await run(root, "check-config");
    expect(result.code).toBe(EXIT_INVALID);
    expect(result.err).toContain("/reports/project must be Chibi");
    expect((await run(root, "check-config", "--game", "archies-dog-walks")).code).toBe(EXIT_OK);
    expect((await run(root, "check-config", "--game", "nope")).code).toBe(EXIT_USAGE);
  });
});

describe("dispatcher", () => {
  it("prints the game operations for help and rejects unknown commands", async () => {
    const { root } = makeFixture();
    const help = await run(root, "--help");
    expect(help.code).toBe(EXIT_OK);
    expect(help.out).toContain("control --game ID --state enabled|paused --reason TEXT");
    expect(help.out).toContain("status --game ID [--resources]");
    expect(help.out).not.toContain("moved to coordination-kit");
    expect(await run(root, "scheduled-once")).toMatchObject({ code: EXIT_USAGE });
    expect((await run(root, "check-config", "--unknown")).code).toBe(EXIT_USAGE);
  });

  it.each([
    ["channel"],
    ["monitor-snapshot"],
    ["monitor-ack"],
    ["resource-report", "--game", "x"],
    ["monitor", "ack"],
    ["monitor", "snapshot"],
    ["migrate"],
    ["protocol", "status"],
    ["inbox", "snapshot", "--game", "x"],
    ["message", "send"],
    ["ledger", "apply"],
    ["harness", "select"],
    ["claude", "ready"],
    ["claude", "channel", "--monitor", "x"],
    ["codex", "ready"],
    ["constructor"],
  ])("prints standard usage for an invalid command %s", async (...argv) => {
    const { root } = makeFixture();
    expect(await run(root, ...argv)).toEqual({ code: EXIT_USAGE, err: USAGE, out: "" });
  });

  it("rejects status --harness as an unknown option", async () => {
    const { root } = makeFixture();
    const result = await run(root, "status", "--game", "archies-dog-walks", "--harness", "codex");
    expect(result).toMatchObject({ code: EXIT_USAGE, out: "" });
    expect(result.err).toContain("Unknown option '--harness'");
    expect(result.err).toContain("usage: delivery-kit status --game ID [--resources]");
  });
});
