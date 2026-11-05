import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMMANDS, EXIT_INVALID, EXIT_OK, EXIT_USAGE, main, USAGE } from "./cli.ts";
import { SPECS } from "./commands/spec.ts";
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
  it("has a handler for every command", async () => {
    const { root } = makeFixture();
    for (const command of COMMANDS) {
      // eslint-disable-next-line no-await-in-loop
      const result = await run(root, ...command.split(" "), "--help-unknown-option");
      expect(result.err, command).not.toContain("not implemented");
    }
  });

  it("prints usage for help and rejects unknown commands", async () => {
    const { root } = makeFixture();
    expect(await run(root, "--help")).toMatchObject({ code: EXIT_OK });
    expect(await run(root, "scheduled-once")).toMatchObject({ code: EXIT_USAGE });
    expect((await run(root, "check-config", "--unknown")).code).toBe(EXIT_USAGE);
  });

  it("accepts --root once, in any position", async () => {
    const { root } = makeFixture();
    const io = () => {
      const seen = { err: "", out: "" };
      const value = {
        cwd: "/nonexistent",
        env: {},
        err: (text: string) => (seen.err += text),
        out: (text: string) => (seen.out += text),
      };
      return { seen, value };
    };
    const after = io();
    expect(await main(after.value, ["check-config", "--root", root])).toBe(EXIT_OK);
    expect(after.seen.out).toContain("configuration accepted");
    const twice = io();
    expect(await main(twice.value, ["--root", root, "check-config", "--root", root])).toBe(
      EXIT_USAGE,
    );
    expect(twice.seen.err).toContain("--root is given more than once");
  });

  it("names the 2.0.0 form of each removed command and runs nothing", async () => {
    const { root } = makeFixture();
    const cases: [string[], string][] = [
      [["channel"], "delivery-kit claude channel"],
      [["monitor-snapshot", "--game", "x"], "delivery-kit monitor snapshot"],
      [["monitor-ack"], "delivery-kit monitor ack"],
      [["resource-report", "--game", "x"], "delivery-kit status --game ID --resources"],
      [["status", "--harness", "codex"], "delivery-kit codex ready"],
      [["status", "--harness", "claude"], "delivery-kit claude ready"],
    ];
    for (const [argv, replacement] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const result = await run(root, ...argv);
      expect(result.code, argv.join(" ")).toBe(EXIT_USAGE);
      expect(result.out, argv.join(" ")).toBe("");
      expect(result.err, argv.join(" ")).toMatch(
        new RegExp(`^delivery-kit: ".*" was removed in 2\\.0\\.0; use "${replacement}"\\n$`),
      );
    }
  });
});

describe("claude ready and codex ready", () => {
  it("reports a missing registry or an unreadable layout as not ready, not as a usage error", async () => {
    const { base, root } = makeFixture();
    const absent = await run(root, "codex", "ready");
    expect(absent.code).toBe(EXIT_INVALID);
    expect(absent.out).toBe("");
    expect(absent.err).toMatch(/^delivery-kit: /);
    const missing = await run(join(base, "no-game-dev"), "claude", "ready");
    expect(missing.code).toBe(EXIT_INVALID);
    expect(missing.err).toMatch(/^delivery-kit: /);
    expect((await run(root, "claude", "ready", "--extra")).code).toBe(EXIT_USAGE);
  });
});

describe("help", () => {
  it("lists every command with every option its parser accepts", () => {
    for (const command of COMMANDS) {
      expect(USAGE).toContain(`  ${command}`);
      for (const option of Object.keys(SPECS[command].options)) {
        expect(USAGE, `${command} --${option}`).toMatch(
          new RegExp(`^  ${command} .*--${option}\\b`, "m"),
        );
      }
    }
    expect(Object.keys(SPECS).sort()).toEqual([...COMMANDS].sort());
    const groups = ["Game operations:", "Monitor (game-dev):", "Harness (claude, codex):"];
    expect(groups.map((heading) => USAGE.indexOf(heading))).toEqual(
      groups.map((heading) => USAGE.indexOf(heading)).sort((x, y) => x - y),
    );
    expect(groups.every((heading) => USAGE.includes(heading))).toBe(true);
  });
});
