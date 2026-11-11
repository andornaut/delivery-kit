import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readDeliveryControl } from "../bus/control.ts";
import { main } from "../cli.ts";
import { gameLayout, loadLayout } from "../layout.ts";
import { createRegistry, type Registry } from "../registry/index.ts";
import { CLAUDE_GAME_DEV, makeFixture, registryInput } from "../testFixtures.ts";

const GAME = "archies-dog-walks";

async function run(root: string, ...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(
    { cwd: "/nonexistent", env: {}, err: (text) => (err += text), out: (text) => (out += text) },
    ["--root", root, ...argv],
  );
  return { code, err, out };
}

function fixture() {
  const { root } = makeFixture();
  const layout = loadLayout(root);
  createRegistry(layout, registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">);
  const store = { dir: gameLayout(layout, GAME).busDir };
  return { file: join(store.dir, "delivery-control.json"), root, store };
}

function args(state = "paused", requester = "game-dev"): string[] {
  return [
    "control",
    "--game",
    GAME,
    "--state",
    state,
    "--reason",
    "operator request",
    "--requester",
    requester,
  ];
}

describe("control command", () => {
  it("explicitly adopts missing control, resolves the role and prints only validated desired JSON", async () => {
    const test = fixture();
    expect(existsSync(test.file)).toBe(false);
    const result = await run(test.root, ...args());
    expect(result).toMatchObject({ code: 0, err: "" });
    const record = readDeliveryControl(test.store);
    expect(JSON.parse(result.out)).toEqual(record.desired);
    expect(record.desired).toMatchObject({
      state: "paused",
      requester: "game-dev",
      reason: "operator request",
    });
    expect(record.observed).toBeNull();
    expect(record.activities).toEqual({});
    expect(existsSync(join(test.store.dir, "runner.lock"))).toBe(false);
    expect(existsSync(join(test.store.dir, "runner.identity.json"))).toBe(false);
    expect(result.out.trim().split("\n")).toHaveLength(1);
  });

  it("requires every option, a supported state and nonempty reason without creating control", async () => {
    const test = fixture();
    for (const flag of ["--game", "--state", "--reason", "--requester"]) {
      const words = args();
      words.splice(words.indexOf(flag), 2);
      // eslint-disable-next-line no-await-in-loop
      expect((await run(test.root, ...words)).code, flag).toBe(2);
    }
    expect((await run(test.root, ...args("stopped"))).code).toBe(2);
    expect((await run(test.root, ...args(), "--unknown")).code).toBe(2);
    for (const reason of ["   ", "x".repeat(4097)]) {
      const words = args();
      words[words.indexOf("--reason") + 1] = reason;
      // eslint-disable-next-line no-await-in-loop
      expect((await run(test.root, ...words)).code).toBe(2);
    }
    expect(existsSync(test.file)).toBe(false);
    expect(existsSync(test.store.dir)).toBe(false);
  });

  it("requires a registered requester role and rejects conversation identifiers", async () => {
    const test = fixture();
    for (const requester of ["missing-role", "monitor", CLAUDE_GAME_DEV]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await run(test.root, ...args("paused", requester));
      expect(result).toMatchObject({ code: 1, out: "" });
      expect(result.err).toContain("no registered role named");
    }
    expect(existsSync(test.file)).toBe(false);
    const { root } = makeFixture();
    expect((await run(root, ...args())).code).toBe(1);
    expect((await run(test.root, ...args("enabled", "archies-dog-walks/tech"))).code).toBe(0);
    expect(readDeliveryControl(test.store).desired.requester).toBe("archies-dog-walks/tech");
  });

  it("increments revisions on explicit updates and refuses to overwrite a corrupt pause", async () => {
    const test = fixture();
    await run(test.root, ...args());
    const paused = readDeliveryControl(test.store);
    const enabled = await run(test.root, ...args("enabled", "game-dev"));
    expect(enabled.code).toBe(0);
    expect(JSON.parse(enabled.out)).toMatchObject({
      state: "enabled",
      revision: paused.desired.revision + 1,
    });
    const corrupt = '{"desired":{"state":"paused"}}\n';
    writeFileSync(test.file, corrupt);
    expect(await run(test.root, ...args("enabled"))).toMatchObject({ code: 1, out: "" });
    expect(readFileSync(test.file, "utf8")).toBe(corrupt);
  });
});
