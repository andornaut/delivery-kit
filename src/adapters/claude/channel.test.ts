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

import { describe, expect, it } from "vitest";

import { gameLayout } from "../../layout.ts";
import {
  activeRoute,
  type ClaudeFixture,
  claudeFixture,
  MONITOR,
  SLOT,
  TECH,
} from "../../monitor/fixtures.ts";
import { slotRequestId } from "../shared/ids.ts";
import { deliverPending, handle, serve } from "./channel.ts";
import { channelNotification, initializeResult } from "./protocol.ts";
import { deliveredDir, spoolDir, spoolMonitorBrief } from "./spool.ts";

function spool(fixture: ClaudeFixture, busDir = fixture.game.busDir, slot = SLOT): void {
  const route = activeRoute(fixture);
  expect(spoolMonitorBrief(fixture.env, busDir, route, slot).status).toBe("sending");
}

function receipt(busDir: string, slot = SLOT): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(busDir, "unblock", `${MONITOR}-${slot}.json`), "utf8"),
  ) as Record<string, unknown>;
}

describe("protocol", () => {
  it("isolates the notification and initialize shapes", () => {
    expect(
      channelNotification({
        kind: "monitor",
        receipt: "unblock/x.json",
        recipient: MONITOR,
        requestId: "r",
        slot: 5,
        text: "t",
      }),
    ).toEqual({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: { content: "t", meta: { kind: "monitor", request_id: "r", slot: "5" } },
    });
    expect(initializeResult({ protocolVersion: "2025-03-26" })).toMatchObject({
      capabilities: { experimental: { "claude/channel": {} } },
      protocolVersion: "2025-03-26",
    });
    expect(initializeResult({ protocolVersion: "2099-01-01" }).protocolVersion).toBe("2025-06-18");
  });

  it("answers initialize, ping and unknown requests", () => {
    const lines: string[] = [];
    const write = (line: string): void => void lines.push(line);
    expect(handle(write, { id: 1, method: "initialize", params: {} })).toBe(false);
    expect(handle(write, { id: 2, method: "ping" })).toBe(false);
    expect(handle(write, { id: 3, method: "tools/list" })).toBe(false);
    expect(handle(write, { method: "notifications/initialized" })).toBe(true);
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toMatchObject([
      { id: 1, result: { serverInfo: { name: "delivery-kit-monitor" } } },
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
      await deliverPending((line) => void lines.push(line), fixture.game.busDir, MONITOR),
    ).toBe(true);
    expect(
      await deliverPending((line) => void lines.push(line), fixture.game.busDir, MONITOR),
    ).toBe(true);
    expect(lines).toHaveLength(1);
    const state = receipt(fixture.game.busDir);
    expect(state.status).toBe("accepted");
    expect(state.acceptedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const requestId = slotRequestId(MONITOR, SLOT);
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
    expect(await deliverPending(broken, fixture.game.busDir, MONITOR)).toBe(false);
    expect(receipt(fixture.game.busDir).status).toBe("ambiguous");
    const lines: string[] = [];
    expect(
      await deliverPending((line) => void lines.push(line), fixture.game.busDir, MONITOR),
    ).toBe(true);
    expect(lines).toEqual([]);
    spool(fixture, fixture.game.busDir, SLOT + 1);
    const directory = spoolDir(fixture.game.busDir);
    const pending = readdirSync(directory).find((name) => name.endsWith(".json")) as string;
    renameSync(join(directory, pending), join(directory, pending.replace(/\.json$/, ".claimed")));
    await deliverPending((line) => void lines.push(line), fixture.game.busDir, MONITOR);
    expect(lines).toEqual([]);
    expect(receipt(fixture.game.busDir, SLOT + 1).status).toBe("ambiguous");
  });
});

describe("serve", () => {
  it("delivers nothing before initialization and each entry once across projects", async () => {
    const fixture = claudeFixture();
    spool(fixture);
    const other = gameLayout(fixture.layout, "chibis-way-home");
    mkdirSync(join(other.busDir, "unblock", "decisions"), { recursive: true });
    writeFileSync(
      join(other.busDir, "unblock", "decisions", `${MONITOR}.json`),
      JSON.stringify({ state: "clear", thread_id: MONITOR }),
    );
    spool(fixture, other.busDir);
    const input = new PassThrough();
    const lines: string[] = [];
    const done = serve(
      { pollMs: 20 },
      input,
      (line) => void lines.push(line),
      [fixture.game.busDir, other.busDir],
      MONITOR,
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
