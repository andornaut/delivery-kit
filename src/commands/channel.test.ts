import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { spoolReviewBrief } from "../adapters/claude/spool.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Io } from "../io.ts";
import { messageChannelStateDir } from "../messages/paths.ts";
import { claudeMessageTransport } from "../messages/transports.ts";
import { updateRegistry } from "../registry/store.ts";
import { activeRoute, claudeFixture, RECIPIENT, SLOT } from "../review/fixtures.ts";
import { projectConfig, writeFixtureJson } from "../testFixtures.ts";
import { runChannel } from "./channel.ts";

function io(): Io & { errors: string[] } {
  const errors: string[] = [];
  return { cwd: "/", env: {}, err: (text) => void errors.push(text), errors, out: () => undefined };
}

describe("claude channel options", () => {
  it("serves the Claude recipient while the global default is Codex", async () => {
    const fixture = claudeFixture();
    updateRegistry(fixture.layout, 1, (draft) => {
      draft.harness = "codex";
      draft.roles["game-coordinator"]!.harness = "claude";
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

  it("refuses a Codex recipient even while the global default is Claude", async () => {
    const fixture = claudeFixture();
    updateRegistry(fixture.layout, 1, (draft) => {
      draft.roles["game-coordinator"]!.harness = "codex";
      draft.roles["game-coordinator"]!.conversations.codex = RECIPIENT;
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
    expect(errors.errors.join("")).toContain("claude harness for the recipient game-coordinator");
  });

  it("rejects a repeated state directory, a relative one and a noncanonical conversation", async () => {
    const fixture = claudeFixture();
    const dir = join(fixture.game.busDir, "unblock");
    mkdirSync(dir, { recursive: true });
    const streams = { input: new PassThrough(), write: () => undefined };
    for (const args of [
      ["--conversation", RECIPIENT, "--state-dir", dir, "--state-dir", dir],
      ["--conversation", RECIPIENT, "--state-dir", "relative"],
      ["--conversation", RECIPIENT.toUpperCase().replace("0", "A"), "--state-dir", dir],
      ["--state-dir", dir, "--game", "archies-dog-walks"],
      ["--unknown"],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await runChannel(streams, io(), fixture.layout.root, args), args.join(" ")).toBe(
        EXIT_USAGE,
      );
    }
  });

  it("requires one reports.recipient across the selected games without --conversation", async () => {
    const fixture = claudeFixture();
    const config = projectConfig("Chibi");
    (config.reports as Record<string, unknown>).recipient = "archies-dog-walks/tech";
    writeFixtureJson(join(fixture.base, "chibis-way-home/delivery-kit.json"), config);
    const errors = io();
    const streams = { input: new PassThrough(), write: () => undefined };
    expect(await runChannel(streams, errors, fixture.layout.root, [])).toBe(EXIT_INVALID);
    expect(errors.errors.join("")).toContain(
      "the selected games name different reports.recipient roles",
    );
    const input = new PassThrough();
    const done = runChannel({ input, write: () => undefined }, io(), fixture.layout.root, [
      "--game",
      "archies-dog-walks",
    ]);
    input.end();
    expect(await done).toBe(EXIT_OK);
  });
});

describe("Claude channel generic feeds", () => {
  it("preserves game feeds and discovers a generic inbox created after startup", async () => {
    const fixture = claudeFixture();
    const stateDir = messageChannelStateDir(fixture.layout, RECIPIENT);
    expect(existsSync(dirname(stateDir))).toBe(false);
    expect(
      spoolReviewBrief(fixture.env, fixture.game.busDir, activeRoute(fixture), SLOT).status,
    ).toBe("sending");
    const input = new PassThrough();
    const lines: string[] = [];
    const done = runChannel(
      { input, write: (line) => void lines.push(line) },
      io(),
      fixture.layout.root,
      ["--conversation", RECIPIENT],
    );
    expect(existsSync(dirname(stateDir))).toBe(false);
    input.write('{"method":"notifications/initialized"}\n');
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    mkdirSync(join(stateDir, "decisions"), { recursive: true });
    writeFixtureJson(join(stateDir, "decisions", `${RECIPIENT}.json`), {
      state: "clear",
      thread_id: RECIPIENT,
    });
    const transport = claudeMessageTransport({ messageChannelStateDir: stateDir });
    expect(
      (
        await transport.send(join(stateDir, "late-message.json"), {
          requestId: "late-message",
          recipient: RECIPIENT,
          text: "late exact text",
        })
      ).status,
    ).toBe("queued");
    input.write('{"method":"notifications/initialized"}\n');
    await vi.waitFor(() => expect(lines).toHaveLength(2));
    input.end();
    expect(await done).toBe(EXIT_OK);
    expect(lines.map((line) => JSON.parse(line).params.meta.kind)).toEqual(["review", "message"]);
    expect(JSON.parse(lines[1]!).params.content).toBe("late exact text");
  });

  it("keeps explicit state directories exclusive even with generic messages waiting", async () => {
    const fixture = claudeFixture();
    const stateDir = messageChannelStateDir(fixture.layout, RECIPIENT);
    mkdirSync(join(stateDir, "decisions"), { recursive: true });
    writeFixtureJson(join(stateDir, "decisions", `${RECIPIENT}.json`), {
      state: "clear",
      thread_id: RECIPIENT,
    });
    const path = join(stateDir, "explicit-exclusion.json");
    const message = {
      requestId: "explicit-exclusion",
      recipient: RECIPIENT,
      text: "generic waiting",
    };
    const transport = claudeMessageTransport({ messageChannelStateDir: stateDir });
    await transport.send(path, message);
    spoolReviewBrief(fixture.env, fixture.game.busDir, activeRoute(fixture), SLOT);
    const input = new PassThrough();
    const lines: string[] = [];
    const done = runChannel(
      { input, write: (line) => void lines.push(line) },
      io(),
      fixture.layout.root,
      ["--conversation", RECIPIENT, "--state-dir", fixture.unblock],
    );
    input.write('{"method":"notifications/initialized"}\n');
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    input.end();
    expect(await done).toBe(EXIT_OK);
    expect(JSON.parse(lines[0]!).params.meta.kind).toBe("review");
    expect((await transport.send(path, message)).status).toBe("queued");
  });
});
