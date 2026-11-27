import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { createRegistry, type Registry } from "@andornaut/coordination-kit/build/registry";
import {
  EXIT_INVALID,
  EXIT_OK,
  EXIT_USAGE,
  gameLayout,
  loadLayout,
} from "@andornaut/coordination-kit/build/shared";
import { describe, expect, it } from "vitest";

import { main, USAGE } from "./cli.ts";
import { makeFixture, projectConfig, registryInput, writeFixtureJson } from "./testing/fixtures.ts";

const CHECK_CONFIG_HINT = "Hint: Run delivery-kit check-config --help for accepted syntax.\n";

async function run(
  root: string,
  ...argv: string[]
): Promise<{ code: number; out: string; err: string }> {
  return invoke("--root", root, ...argv);
}

async function invoke(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(
    { cwd: "/nonexistent", env: {}, err: (text) => (err += text), out: (text) => (out += text) },
    argv,
  );
  return { code, err, out };
}

function withRegistry(root: string): void {
  createRegistry(
    () => new Date("2026-11-26T00:00:00Z"),
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

  it("rejects a mismatched reports.project and limits checks with either selector", async () => {
    const { base, root } = makeFixture();
    writeFixtureJson(join(base, "chibis-way-home/delivery-kit.json"), projectConfig("Archie"));
    const result = await run(root, "check-config");
    expect(result.code).toBe(EXIT_INVALID);
    expect(result.err).toContain("/reports/project must be Chibi");
    const legacy = await run(root, "check-config", "--game", "archies-dog-walks");
    expect(legacy).toMatchObject({ code: EXIT_OK, err: "" });
    expect(await run(root, "check-config", "--app=archies-dog-walks")).toEqual(legacy);
    await Promise.all(
      ["app", "game"].map(async (selector) => {
        expect(await run(root, "check-config", `--${selector}`, "nope")).toEqual({
          code: EXIT_USAGE,
          err: `delivery-kit: unknown ${selector}: nope\n${CHECK_CONFIG_HINT}`,
          out: "",
        });
      }),
    );
  });
});

describe("app selection", () => {
  it("identifies app status without changing the legacy response", async () => {
    const { root } = makeFixture();
    const legacy = await run(root, "status", "--game", "archies-dog-walks");
    expect(legacy).toMatchObject({ code: EXIT_OK, err: "" });
    const neutral = await run(root, "status", "--app", "archies-dog-walks");
    expect(neutral).toMatchObject({ code: EXIT_OK, err: "" });
    expect(JSON.parse(neutral.out)).toEqual({
      ...JSON.parse(legacy.out),
      appId: "archies-dog-walks",
    });
    expect(await run(root, "status", "--scope=app:archies-dog-walks")).toEqual(neutral);
    expect(await run(root, "status", "--scope", "archies-dog-walks")).toEqual(neutral);
    const invalidScopes = [
      ["--scope", "kit:archies-dog-walks"],
      ["--scope", "app:"],
      ["--scope", "archies-dog-walks", "--game", "archies-dog-walks"],
      ["--scope", "archies-dog-walks", "--scope=chibis-way-home"],
    ];
    await Promise.all(
      invalidScopes.map(async (args) => {
        expect(await run(root, "status", ...args)).toMatchObject({
          code: EXIT_USAGE,
          err: expect.stringContaining("Hint: Run delivery-kit status --help"),
          out: "",
        });
      }),
    );
  });

  it.each([
    {
      diagnostic: "--app and --game cannot be used together",
      selectors: ["--app", "archies-dog-walks", "--game=archies-dog-walks"],
    },
    {
      diagnostic: "--app is given more than once",
      selectors: ["--app=archies-dog-walks", "--app", "chibis-way-home"],
    },
    {
      diagnostic: "--game is given more than once",
      selectors: ["--game", "archies-dog-walks", "--game=archies-dog-walks"],
    },
  ])(
    "rejects ambiguous selectors without creating delivery state ($diagnostic)",
    async ({ diagnostic, selectors }) => {
      const { root } = makeFixture();
      withRegistry(root);
      const layout = loadLayout(root);
      const result = await run(
        root,
        "control",
        ...selectors,
        "--state",
        "paused",
        "--reason",
        "test",
        "--requester",
        "game-coordinator",
      );
      expect(result).toMatchObject({ code: EXIT_USAGE, out: "" });
      expect(result.err).toContain(diagnostic);
      for (const game of Object.keys(layout.config.games)) {
        expect(existsSync(gameLayout(layout, game).busDir)).toBe(false);
      }
      expect(await run(root, "check-config", ...selectors)).toEqual({
        code: EXIT_USAGE,
        err: `delivery-kit: ${diagnostic}\n${CHECK_CONFIG_HINT}`,
        out: "",
      });
    },
  );
});

describe("dispatcher", () => {
  it("prints help for the named command without loading configuration", async () => {
    expect(await invoke("runner", "stop", "--help")).toEqual({
      code: EXIT_OK,
      err: "",
      out: [
        "usage: delivery-kit runner stop --app ID [--timeout SECONDS]",
        "",
        "wait until the app's runner is idle and drained, then stop it",
        "",
      ].join("\n"),
    });
    expect(await invoke("runner", "stop", "--", "--help")).toMatchObject({
      code: EXIT_USAGE,
      out: "",
    });
  });

  it("accepts an inline root before the terminator and leaves later tokens alone", async () => {
    const { root } = makeFixture();
    const configured = await run(root, "check-config");
    expect(configured.code).toBe(EXIT_OK);
    expect(await invoke("check-config", `--root=${root}`)).toEqual(configured);
    expect(await run(root, "check-config", "--", "--root=unused")).toMatchObject({
      code: EXIT_USAGE,
      err: expect.stringContaining("Hint: Run delivery-kit check-config --help"),
      out: "",
    });
    expect(await run(root, "check-config", "--root=unused")).toMatchObject({
      code: EXIT_USAGE,
      err: expect.stringContaining("--root is given more than once"),
      out: "",
    });
    expect(await invoke("check-config", "--root=")).toMatchObject({
      code: EXIT_USAGE,
      err: expect.stringContaining("--root needs a directory"),
      out: "",
    });
  });

  it("advertises app operations and rejects unknown commands", async () => {
    const { root } = makeFixture();
    const help = await run(root, "--help");
    expect(help.code).toBe(EXIT_OK);
    expect(help.out).toContain("App operations:");
    expect(help.out).toContain("control --app ID --state enabled|paused --reason TEXT");
    expect(help.out).toContain("status --app ID [--resources]");
    expect(help.out).toContain("check-config [--app ID]");
    expect(help.out).toContain("--game ID is a compatibility alias for --app ID.");
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
    expect(await run(root, ...argv)).toEqual({
      code: EXIT_USAGE,
      err: `${USAGE}Hint: Run delivery-kit --help for available commands.\n`,
      out: "",
    });
  });

  it("rejects status --harness as an unknown option", async () => {
    const { root } = makeFixture();
    const result = await run(root, "status", "--game", "archies-dog-walks", "--harness", "codex");
    expect(result).toMatchObject({ code: EXIT_USAGE, out: "" });
    expect(result.err).toContain("Unknown option '--harness'");
    expect(result.err).toContain("usage: delivery-kit status --app ID [--resources]");
  });
});
