import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import * as durable from "../../durable.ts";
import { gameLayout } from "../../layout.ts";
import { holdLock } from "../../lock.ts";
import {
  activeRoute,
  type ClaudeFixture,
  claudeFixture,
  RECIPIENT,
  SLOT,
  TECH,
} from "../../review/fixtures.ts";
import { slotRequestId } from "../shared/ids.ts";
import { deliverPending, handle, serve } from "./channel.ts";
import { deliveredDir, LOCK_FILE, spoolDir, spoolMessage, spoolReviewBrief } from "./spool.ts";

function spool(fixture: ClaudeFixture, busDir = fixture.game.busDir, slot = SLOT): void {
  const route = activeRoute(fixture);
  expect(spoolReviewBrief(fixture.env, busDir, route, slot).status).toBe("sending");
}

function receipt(busDir: string, slot = SLOT): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(busDir, "unblock", `${RECIPIENT}-${slot}.json`), "utf8"),
  ) as Record<string, unknown>;
}

describe("protocol", () => {
  it("answers initialize, ping and unknown requests", () => {
    const lines: string[] = [];
    const write = (line: string): void => void lines.push(line);
    expect(handle(write, { id: 1, method: "initialize", params: {} })).toBe(false);
    expect(handle(write, { id: 2, method: "ping" })).toBe(false);
    expect(handle(write, { id: 3, method: "tools/list" })).toBe(false);
    expect(handle(write, { method: "notifications/initialized" })).toBe(true);
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toMatchObject([
      { id: 1, result: { serverInfo: { name: "delivery-kit-channel" } } },
      { id: 2, result: {} },
      { error: { code: -32601 }, id: 3 },
    ]);
  });
});

describe("deliverPending", () => {
  it("delivers once, records the delivered copy and accepts the receipt", async () => {
    const fixture = claudeFixture();
    spool(fixture);
    const lines: string[] = [];
    expect(
      await deliverPending((line) => void lines.push(line), fixture.game.busDir, RECIPIENT),
    ).toBe(true);
    expect(
      await deliverPending((line) => void lines.push(line), fixture.game.busDir, RECIPIENT),
    ).toBe(true);
    expect(lines).toHaveLength(1);
    const state = receipt(fixture.game.busDir);
    expect(state.status).toBe("accepted");
    expect(state.acceptedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const requestId = slotRequestId(RECIPIENT, SLOT);
    expect(readdirSync(deliveredDir(fixture.game.busDir))).toEqual([`${requestId}.json`]);
    expect(readdirSync(spoolDir(fixture.game.busDir))).toEqual([]);
  });

  it("emits nothing for another recipient", async () => {
    const fixture = claudeFixture();
    spool(fixture);
    const lines: string[] = [];
    await deliverPending((line) => void lines.push(line), fixture.game.busDir, TECH);
    expect(lines).toEqual([]);
    expect(receipt(fixture.game.busDir).status).toBe("sending");
  });

  it("records a failed write or an interrupted claim as ambiguous and never resends", async () => {
    const fixture = claudeFixture();
    spool(fixture);
    const broken = (): void => {
      throw new Error("closed");
    };
    expect(await deliverPending(broken, fixture.game.busDir, RECIPIENT)).toBe(false);
    expect(receipt(fixture.game.busDir).status).toBe("ambiguous");
    const lines: string[] = [];
    expect(
      await deliverPending((line) => void lines.push(line), fixture.game.busDir, RECIPIENT),
    ).toBe(true);
    expect(lines).toEqual([]);
    spool(fixture, fixture.game.busDir, SLOT + 1);
    const directory = spoolDir(fixture.game.busDir);
    const pending = readdirSync(directory).find((name) => name.endsWith(".json")) as string;
    renameSync(join(directory, pending), join(directory, pending.replace(/\.json$/, ".claimed")));
    await deliverPending((line) => void lines.push(line), fixture.game.busDir, RECIPIENT);
    expect(lines).toEqual([]);
    expect(receipt(fixture.game.busDir, SLOT + 1).status).toBe("ambiguous");
  });
});

describe("durable channel claims", () => {
  it("syncs the renamed claim before output to prevent host-crash replay", async () => {
    const fixture = claudeFixture();
    spool(fixture);
    const events: string[] = [];
    const original = durable.fsyncDirectory;
    const sync = vi.spyOn(durable, "fsyncDirectory").mockImplementation((directory) => {
      expect(directory).toBe(spoolDir(fixture.game.busDir));
      expect(readdirSync(directory).some((name) => name.endsWith(".claimed"))).toBe(true);
      original(directory);
      events.push("durable-claim");
    });
    try {
      await deliverPending(
        () => void events.push("external-write"),
        fixture.game.busDir,
        RECIPIENT,
      );
      expect(events).toEqual(["durable-claim", "external-write"]);
    } finally {
      sync.mockRestore();
    }
  });

  it("does not emit after a claim sync failure and preserves ambiguous evidence without replay", async () => {
    const fixture = claudeFixture();
    spool(fixture);
    const lines: string[] = [];
    const sync = vi.spyOn(durable, "fsyncDirectory").mockImplementation(() => {
      throw new Error("sync failed");
    });
    try {
      expect(
        await deliverPending((line) => void lines.push(line), fixture.game.busDir, RECIPIENT),
      ).toBe(false);
    } finally {
      sync.mockRestore();
    }
    expect(lines).toEqual([]);
    expect(receipt(fixture.game.busDir).status).toBe("ambiguous");
    expect(
      readdirSync(spoolDir(fixture.game.busDir)).some((name) => name.endsWith(".claimed")),
    ).toBe(true);
    await deliverPending((line) => void lines.push(line), fixture.game.busDir, RECIPIENT);
    expect(lines).toEqual([]);
  });
});

describe("serve", () => {
  it("holds a refreshed feed lease before claiming and releases after post-output failure without replay", async () => {
    const fixture = claudeFixture();
    const path = join(fixture.unblock, "generic-io-failure.json");
    const message = {
      recipient: RECIPIENT,
      requestId: "generic-io-failure",
      text: "exact queued body",
    };
    expect(spoolMessage(fixture.game.busDir, path, message).status).toBe("queued");
    const input = new PassThrough();
    const lines: string[] = [];
    const events: string[] = [];
    let leased = false;
    const original = durable.writeJsonDurable;
    const write = vi.spyOn(durable, "writeJsonDurable").mockImplementation((target, value) => {
      expect(leased).toBe(true);
      if (target.startsWith(deliveredDir(fixture.game.busDir))) {
        events.push("post-output-failure");
        throw new Error("fixture disk write failed");
      }
      original(target, value);
    });
    const done = serve(
      {
        beforeMessage: () => {
          expect(leased).toBe(true);
          return { status: "clear" };
        },
        pollMs: 10,
        refreshFeeds: () => [
          {
            busDir: fixture.game.busDir,
            withLease: async (action) => {
              const lock = holdLock(join(fixture.unblock, LOCK_FILE), { nonBlocking: true });
              lock.release();
              leased = true;
              events.push("lease");
              try {
                return await action();
              } finally {
                leased = false;
                events.push("release");
              }
            },
          },
        ],
      },
      input,
      (line) => {
        expect(leased).toBe(true);
        events.push("output");
        lines.push(line);
      },
      [],
      RECIPIENT,
    );
    try {
      input.write('{"method":"notifications/initialized"}\n');
      expect(await done).toBe(1);
      expect(events).toEqual(["lease", "output", "post-output-failure", "release"]);
      expect(lines).toHaveLength(1);
    } finally {
      input.end();
      write.mockRestore();
    }
    expect(readdirSync(spoolDir(fixture.game.busDir))).toContain("generic-io-failure.claimed");
    expect(
      await deliverPending((line) => void lines.push(line), fixture.game.busDir, RECIPIENT),
    ).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("ambiguous");
    expect(lines).toHaveLength(1);
  });

  it("delivers nothing before initialization and each entry once across projects", async () => {
    const fixture = claudeFixture();
    spool(fixture);
    const other = gameLayout(fixture.layout, "chibis-way-home");
    mkdirSync(join(other.busDir, "unblock", "decisions"), { recursive: true });
    writeFileSync(
      join(other.busDir, "unblock", "decisions", `${RECIPIENT}.json`),
      JSON.stringify({ state: "clear", thread_id: RECIPIENT }),
    );
    spool(fixture, other.busDir);
    const input = new PassThrough();
    const lines: string[] = [];
    const done = serve(
      { pollMs: 20 },
      input,
      (line) => void lines.push(line),
      [fixture.game.busDir, other.busDir],
      RECIPIENT,
    );
    input.write(`${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: {} })}\n`);
    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });
    expect(lines).toHaveLength(1);
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    input.end();
    expect(await done).toBe(0);
    const channel = lines
      .map((line) => JSON.parse(line) as { method?: string })
      .filter((message) => message.method === "notifications/claude/channel");
    expect(channel).toHaveLength(2);
    expect(receipt(other.busDir).status).toBe("accepted");
    expect(existsSync(join(deliveredDir(other.busDir)))).toBe(true);
  });
});
