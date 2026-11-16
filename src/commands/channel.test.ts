import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { spoolReviewBrief } from "../adapters/claude/spool.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Io } from "../io.ts";
import { holdLock, LockBusy } from "../lock.ts";
import { messageChannelStateDir, messageDirectory } from "../messages/paths.ts";
import * as messageService from "../messages/service.ts";
import { messageExpectation, MessageStore } from "../messages/store.ts";
import { claudeMessageTransport } from "../messages/transports.ts";
import { ProtocolStore } from "../protocol/core.ts";
import {
  acquireProtocolLayout,
  declareProtocolWorkspace,
  protocolPaths,
} from "../protocol/layout.ts";
import { ProtocolMessages } from "../protocol/messages.ts";
import * as protocolSelection from "../protocol/selection.ts";
import { activateProtocolFixture } from "../protocol/testFixtures.ts";
import { resolveConversation } from "../registry/resolve.ts";
import { readRegistry, updateRegistry } from "../registry/store.ts";
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
      {
        beforeMessage: async () => ({ status: "clear" }),
        input,
        write: (line) => void lines.push(line),
      },
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
  it("refreshes a resident through cutover without replaying originals or starving reviews", async () => {
    const fixture = claudeFixture();
    const legacy = messageDirectory(fixture.layout);
    const created = "2026-11-16T06:00:00.000Z";
    const queue = async (id: string, body: string) => {
      const store = new MessageStore({
        layout: fixture.layout,
        resolveOwner: (_role, envelope) =>
          messageService.currentMessageOwner(fixture.layout, envelope),
      });
      const record = await store.enqueue({
        schema: 1,
        id,
        fromRole: "archies-dog-walks/tech",
        toRole: "game-coordinator",
        intent: "queue",
        body,
        created,
      });
      const lease = await store.beginAttempt(messageExpectation(record));
      const source = lease.source;
      lease.close();
      const stateDir = messageChannelStateDir(fixture.layout, RECIPIENT);
      const path = join(stateDir, `${source.requestId}.json`);
      const transport = claudeMessageTransport({ messageChannelStateDir: stateDir });
      const message = { requestId: source.requestId, recipient: RECIPIENT, text: body };
      await vi.waitFor(async () =>
        expect((await transport.send(path, message)).status).toBe("queued"),
      );
      return { message, path, record, source, transport };
    };
    const first = await queue("resident-first", "first exact original\n");
    const input = new PassThrough();
    const lines: string[] = [];
    const guard = messageService.messageConsumeGuard;
    const factory = vi
      .spyOn(messageService, "messageConsumeGuard")
      .mockImplementation((layout, env) => {
        const qualified = guard(layout, env);
        return async (entry) => {
          expect(() => holdLock(protocolPaths(layout).lock, { nonBlocking: true })).toThrow(
            LockBusy,
          );
          return qualified(entry);
        };
      });
    const done = runChannel(
      { input, write: (line) => void lines.push(line) },
      { ...io(), env: fixture.env },
      fixture.layout.root,
      ["--conversation", RECIPIENT, "--poll-seconds", "0.01"],
    );
    try {
      input.write('{"method":"notifications/initialized"}\n');
      await vi.waitFor(() => expect(lines).toHaveLength(1));
      await declareProtocolWorkspace(fixture.layout, {
        authorityRef: "fixture-required",
        expectedGeneration: 0,
        workspaceId: "fixture",
      });
      spoolReviewBrief(fixture.env, fixture.game.busDir, activeRoute(fixture), SLOT);
      fixture.clear("pending");
      const pending = await queue("resident-pending", "pending exact original\n");
      const busy = await acquireProtocolLayout(fixture.layout, null, {
        allowPending: true,
        exclusive: true,
      });
      fixture.clear();
      try {
        await vi.waitFor(() => expect(lines).toHaveLength(2));
        expect(JSON.parse(lines[1]!).params.meta.kind).toBe("review");
        expect(JSON.parse(readFileSync(pending.path, "utf8")).status).toBe("sending");
      } finally {
        busy.release();
      }
      await vi.waitFor(() => expect(lines).toHaveLength(3));
      fixture.clear("pending");
      const switching = await queue("resident-switching", "\uFEFFcanonical exact body\n");
      const cutover = await acquireProtocolLayout(fixture.layout, null, {
        allowPending: true,
        exclusive: true,
      });
      let root: string;
      try {
        root = activateProtocolFixture(fixture.layout, { authorityRef: "fixture-required" });
        cpSync(legacy, join(root, "transport", "messages"), { recursive: true });
        const binding = {
          harness: "claude" as const,
          nativeId: resolveConversation(readRegistry(fixture.layout), "archies-dog-walks/tech")!,
        };
        const protocol = new ProtocolStore({ directory: root, resolveBinding: () => true });
        await protocol.claim({
          at: created,
          binding,
          evidence: "fixture-sender",
          expectedEpoch: 0,
          role: "games/archies-dog-walks/tech",
        });
        const originals = new ProtocolMessages({ store: protocol });
        for (const queued of [first, pending, switching]) {
          // eslint-disable-next-line no-await-in-loop
          await originals.publish(
            {
              at: created,
              binding,
              epoch: 1,
              expectedRevision: protocol.read("games/archies-dog-walks/tech").revision,
              id: queued.record.envelope.id,
              role: "games/archies-dog-walks/tech",
            },
            {
              envelope: queued.record.envelope,
              guards: { artifacts: [], hold: "unknown", question: "unknown", references: [] },
              links: { clauseIds: [], messageIds: [], requestIds: [], workIds: [] },
            },
          );
        }
      } finally {
        cutover.release();
      }
      fixture.clear();
      await vi.waitFor(() => expect(lines).toHaveLength(4));
      expect(JSON.parse(lines[3]!).params.content).toBe(switching.message.text);
      expect(JSON.parse(readFileSync(switching.path, "utf8")).status).toBe("sending");
      const currentPath = join(
        messageChannelStateDir(fixture.layout, RECIPIENT),
        `${switching.source.requestId}.json`,
      );
      expect(currentPath).not.toBe(switching.path);
      expect(JSON.parse(readFileSync(currentPath, "utf8")).status).toBe("accepted");
      expect((await switching.transport.send(switching.path, switching.message)).status).toBe(
        "queued",
      );
      spoolReviewBrief(fixture.env, fixture.game.busDir, activeRoute(fixture), SLOT + 1);
      await vi.waitFor(() => expect(lines).toHaveLength(5));
      expect(JSON.parse(lines[4]!).params.meta.kind).toBe("review");
      expect(
        lines
          .filter((line) => JSON.parse(line).params.meta.kind === "message")
          .map((line) => JSON.parse(line).params.content),
      ).toEqual([first.message.text, pending.message.text, switching.message.text]);
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      input.end();
      expect(await done).toBe(EXIT_OK);
      factory.mockRestore();
    }
  });

  it("keeps an explicit generic directory fixed and refuses it after the canonical root moves", async () => {
    const fixture = claudeFixture();
    const selections = vi.spyOn(protocolSelection, "captureProtocolSelection");
    const stateDir = messageChannelStateDir(fixture.layout, RECIPIENT);
    const transport = claudeMessageTransport({ messageChannelStateDir: stateDir });
    const first = { recipient: RECIPIENT, requestId: "explicit-first", text: "first" };
    expect((await transport.send(join(stateDir, "explicit-first.json"), first)).status).toBe(
      "queued",
    );
    const alias = join(fixture.base, "generic-alias");
    symlinkSync(dirname(stateDir), alias);
    const input = new PassThrough();
    const lines: string[] = [];
    const done = runChannel(
      { beforeMessage: () => ({ status: "clear" }), input, write: (line) => void lines.push(line) },
      io(),
      fixture.layout.root,
      [
        "--conversation",
        RECIPIENT,
        "--state-dir",
        join(alias, "unblock"),
        "--poll-seconds",
        "0.01",
      ],
    );
    try {
      input.write('{"method":"notifications/initialized"}\n');
      await vi.waitFor(() => expect(lines).toHaveLength(1));
      const cutover = await acquireProtocolLayout(fixture.layout, null, { exclusive: true });
      try {
        activateProtocolFixture(fixture.layout);
      } finally {
        cutover.release();
      }
      const oldPath = join(stateDir, "explicit-old.json");
      expect((await transport.send(oldPath, { ...first, requestId: "explicit-old" })).status).toBe(
        "queued",
      );
      const current = messageChannelStateDir(fixture.layout, RECIPIENT);
      const fresh = claudeMessageTransport({ messageChannelStateDir: current });
      const newPath = join(current, "explicit-new.json");
      expect((await fresh.send(newPath, { ...first, requestId: "explicit-new" })).status).toBe(
        "queued",
      );
      const before = selections.mock.calls.length;
      input.write('{"id":5,"method":"ping"}\n');
      await vi.waitFor(() => expect(selections.mock.calls.length).toBeGreaterThan(before + 1));
      await vi.waitFor(() => expect(lines).toHaveLength(2));
      expect(JSON.parse(lines[1]!).id).toBe(5);
      expect(JSON.parse(readFileSync(oldPath, "utf8")).status).toBe("sending");
      expect(JSON.parse(readFileSync(newPath, "utf8")).status).toBe("sending");
    } finally {
      input.end();
      expect(await done).toBe(EXIT_OK);
      selections.mockRestore();
    }
  });

  it("delivers an existing scheduled review spool while required enrollment is pending", async () => {
    const fixture = claudeFixture();
    await declareProtocolWorkspace(fixture.layout, {
      workspaceId: "pending-review-fixture",
      authorityRef: "fixture-managed-authority",
      expectedGeneration: 0,
    });
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
    try {
      input.write('{"method":"notifications/initialized"}\n');
      await vi.waitFor(() => expect(lines).toHaveLength(1));
    } finally {
      input.end();
      expect(await done).toBe(EXIT_OK);
    }
    expect(JSON.parse(lines[0]!).params.meta.kind).toBe("review");
  });

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
      {
        beforeMessage: async () => ({ status: "clear" }),
        input,
        write: (line) => void lines.push(line),
      },
      io(),
      fixture.layout.root,
      ["--conversation", RECIPIENT],
    );
    expect(existsSync(dirname(stateDir))).toBe(false);
    input.write('{"method":"notifications/initialized"}\n');
    await vi.waitFor(() => expect(lines).toHaveLength(1));
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
      {
        beforeMessage: async () => ({ status: "clear" }),
        input,
        write: (line) => void lines.push(line),
      },
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

describe("qualified generic consume guard", () => {
  it("uses qualified service clearance to block a post-enqueue hold or reroute", async () => {
    const fixture = claudeFixture();
    const store = new MessageStore({
      layout: fixture.layout,
      resolveOwner: (_role, envelope) =>
        messageService.currentMessageOwner(fixture.layout, envelope),
    });
    const record = await store.enqueue({
      schema: 1,
      id: "consume-race",
      fromRole: "game-kit",
      toRole: "game-coordinator",
      intent: "queue",
      body: "exact authoritative body",
      created: "2026-11-14T20:00:00.000Z",
    });
    const lease = await store.beginAttempt(messageExpectation(record));
    const source = lease.source;
    lease.close();
    const stateDir = messageChannelStateDir(fixture.layout, RECIPIENT);
    const path = join(stateDir, `${source.requestId}.json`);
    const transport = claudeMessageTransport({ messageChannelStateDir: stateDir });
    const message = {
      requestId: source.requestId,
      recipient: RECIPIENT,
      text: record.envelope.body,
    };
    expect((await transport.send(path, message)).status).toBe("queued");
    expect(existsSync(join(stateDir, "decisions"))).toBe(false);
    updateRegistry(fixture.layout, 1, (draft) => {
      draft.roles["game-coordinator"]!.phase = "held";
    });
    const outcomes: string[] = [];
    const original = messageService.messageConsumeGuard;
    const factory = vi
      .spyOn(messageService, "messageConsumeGuard")
      .mockImplementation((layout, env) => {
        const guard = original(layout, env);
        return async (entry) => {
          const outcome = await guard(entry);
          outcomes.push(outcome.status);
          return outcome;
        };
      });
    const input = new PassThrough();
    const lines: string[] = [];
    const done = runChannel(
      { input, write: (line) => void lines.push(line) },
      { ...io(), env: fixture.env },
      fixture.layout.root,
      ["--conversation", RECIPIENT],
    );
    try {
      input.write('{"method":"notifications/initialized"}\n');
      await vi.waitFor(() => expect(outcomes).toEqual(["blocked"]));
      updateRegistry(fixture.layout, 2, (draft) => {
        draft.roles["game-coordinator"]!.phase = "active";
        draft.roles["game-coordinator"]!.conversations.claude =
          "00000000-0000-4000-8000-000000000099";
      });
      input.write('{"method":"notifications/initialized"}\n');
      await vi.waitFor(() => expect(outcomes).toEqual(["blocked", "blocked"]));
      expect(lines).toEqual([]);
      expect((await transport.send(path, message)).status).toBe("queued");
      updateRegistry(fixture.layout, 3, (draft) => {
        draft.roles["game-coordinator"]!.conversations.claude = RECIPIENT;
      });
      input.write('{"method":"notifications/initialized"}\n');
      await vi.waitFor(() => expect(lines).toHaveLength(1));
      expect(outcomes).toEqual(["blocked", "blocked", "clear"]);
      expect((await transport.send(path, message)).status).toBe("accepted");
      expect(JSON.parse(lines[0]!).params.content).toBe(record.envelope.body);
    } finally {
      input.end();
      await done;
      factory.mockRestore();
    }
  });
});
