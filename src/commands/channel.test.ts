import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { EXIT_OK, EXIT_USAGE, type Io } from "../io.ts";
import { claudeFixture, MONITOR } from "../monitor/fixtures.ts";
import { runChannel } from "./channel.ts";

function io(): Io & { errors: string[] } {
  const errors: string[] = [];
  return { cwd: "/", env: {}, err: (text) => void errors.push(text), errors, out: () => undefined };
}

describe("channel options", () => {
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
});
