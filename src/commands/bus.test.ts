import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GAME, makeGame, mergeFastForward } from "../bus/testGame.ts";
import { main } from "../cli.ts";

async function run(root: string, ...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(
    { cwd: "/nonexistent", env: {}, err: (text) => (err += text), out: (text) => (out += text) },
    ["--root", root, ...argv],
  );
  return { code, err, out };
}

describe("bus commands", () => {
  it("request captures the main HEAD and requires a game and an ID", async () => {
    const test = makeGame();
    mergeFastForward(test, "feature");
    const result = await run(test.layout.root, "request", "--game", GAME, "--id", "r1");
    expect(result.code).toBe(0);
    expect(readFileSync(join(test.game.busDir, "requests", "r1.json"), "utf8")).toBe(result.out);
    expect((await run(test.layout.root, "request", "--game", GAME)).code).toBe(2);
    expect((await run(test.layout.root, "request", "--game", GAME, "--id", "!")).code).toBe(1);
    expect((await run(test.layout.root, "status", "--game", "unknown")).code).toBe(2);
    expect((await run(test.layout.root, "status")).code).toBe(2);
  });
});
