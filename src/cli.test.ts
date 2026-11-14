import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, main } from "./cli.ts";
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

  it("rejects a project name that differs from config.json and limits checks with --game", async () => {
    const { base, root } = makeFixture();
    writeFixtureJson(join(base, "chibis-way-home/delivery-kit.json"), projectConfig("Archie"));
    expect((await run(root, "check-config")).err).toContain("/reports/project must be Chibi");
    expect((await run(root, "check-config", "--game", "archies-dog-walks")).code).toBe(EXIT_OK);
    expect((await run(root, "check-config", "--game", "nope")).code).toBe(EXIT_USAGE);
  });
});

describe("dispatcher", () => {
  it("prints usage for help and rejects unknown commands", async () => {
    const { root } = makeFixture();
    const help = await run(root, "--help");
    expect(help.code).toBe(EXIT_OK);
    expect(help.out).toContain("message dispatch --id UUID");
    expect(help.out).toContain("message reconcile --id UUID --receipt");
    expect(help.out).toContain("harness doctor");
    expect(await run(root, "scheduled-once")).toMatchObject({ code: EXIT_USAGE });
    expect((await run(root, "check-config", "--unknown")).code).toBe(EXIT_USAGE);
  });
});

describe("cross-directory common messages", () => {
  it("stores and pulls the exact body with root in different argument positions without native admission", async () => {
    const { base, root } = makeFixture();
    withRegistry(root);
    const body = "Exact original payload.\n\n";
    writeFileSync(join(base, "message.txt"), body);
    const id = "00000000-0000-4000-8000-000000000001";
    let out = "";
    let err = "";
    const io = {
      cwd: base,
      env: {},
      err: (text: string) => (err += text),
      out: (text: string) => (out += text),
    };
    expect(
      await main(io, [
        "message",
        "send",
        "--from",
        "game-coordinator",
        "--recipient",
        "archies-dog-walks/tech",
        "--root",
        root,
        "--id",
        id,
        "--body-file",
        "message.txt",
      ]),
    ).toBe(EXIT_OK);
    expect(JSON.parse(out)).toMatchObject({ id, state: "queued" });
    expect(JSON.parse(out)).not.toHaveProperty("body");
    out = "";
    expect(
      await main(io, ["message", "status", "--id", id, "--include-body", "--root", root]),
    ).toBe(EXIT_OK);
    expect(JSON.parse(out)).toMatchObject([{ id, body, state: "queued", attempts: 0 }]);
    expect(err).toBe("");
  });
});

describe("claude ready and codex ready", () => {
  it("reports a missing registry or an unreadable layout as not ready, not as a usage error", async () => {
    const { base, root } = makeFixture();
    const absent = await run(root, "codex", "ready");
    expect(absent.code).toBe(EXIT_INVALID);
    expect(absent.out).toBe("");
    expect(absent.err).toMatch(/^delivery-kit: /);
    const missing = await run(join(base, "no-game-coordinator"), "claude", "ready");
    expect(missing.code).toBe(EXIT_INVALID);
    expect(missing.err).toMatch(/^delivery-kit: /);
    expect((await run(root, "claude", "ready", "--extra")).code).toBe(EXIT_USAGE);
  });
});
