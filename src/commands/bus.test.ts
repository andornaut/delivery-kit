import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GAME, makeGame, queueBranch } from "../bus/testGame.ts";
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
  it("status prints the read-only report as one JSON line", async () => {
    const test = makeGame();
    const result = await run(test.layout.root, "status", "--game", GAME);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ idle: true, status: "not running" });
    expect(result.out).toMatch(/^\{"drained": true, /);
  });

  it("request captures the queue and requires a game and an ID", async () => {
    const test = makeGame();
    queueBranch(test, "bus/feature");
    const result = await run(test.layout.root, "request", "--game", GAME, "--request-id", "r1");
    expect(result.code).toBe(0);
    expect(readFileSync(join(test.game.busDir, "requests", "r1.json"), "utf8")).toBe(result.out);
    expect((await run(test.layout.root, "request", "--game", GAME)).code).toBe(2);
    expect((await run(test.layout.root, "request", "--game", GAME, "--request-id", "!")).code).toBe(
      1,
    );
    expect((await run(test.layout.root, "status", "--game", "unknown")).code).toBe(2);
    expect((await run(test.layout.root, "status")).code).toBe(2);
  });

  it("resource-report prints the clock and load lines", async () => {
    const test = makeGame();
    const result = await run(test.layout.root, "resource-report", "--game", GAME);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+\nup .*load average: /);
  });
});
