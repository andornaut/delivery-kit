import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deliverPending } from "../adapters/claude/channel.ts";
import { spoolDir } from "../adapters/claude/spool.ts";
import type { HarnessAdapter } from "../adapters/types.ts";
import { claudeFixture, RECIPIENT } from "../review/fixtures.ts";
import { claudeMessageTransport, guardedMessageTransport } from "./transports.ts";

describe("generic message transports", () => {
  it("spools exact text as queued and accepts only channel delivery, preserving pending questions", async () => {
    const f = claudeFixture();
    const message = { requestId: "generic-message", recipient: RECIPIENT, text: " exact\ntext \n" };
    const path = join(f.unblock, "generic-message.json");
    const transport = claudeMessageTransport({ messageChannelStateDir: f.unblock });
    expect((await transport.send(path, message)).status).toBe("queued");
    expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("sending");
    f.clear("pending");
    const lines: string[] = [];
    await deliverPending((line) => void lines.push(line), f.game.busDir, RECIPIENT);
    expect(lines).toEqual([]);
    f.clear();
    await deliverPending((line) => void lines.push(line), f.game.busDir, RECIPIENT);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/claude/channel",
        params: { content: message.text, meta: { kind: "message", request_id: message.requestId } },
      },
    ]);
    expect((await transport.send(path, message)).status).toBe("accepted");
    expect((await transport.send(path, { ...message, text: "changed" })).status).toBe("blocked");
  });

  it("does not deliver a tampered spool payload or infer acceptance from a missing spool", async () => {
    const f = claudeFixture();
    const message = { requestId: "tampered", recipient: RECIPIENT, text: "original" };
    const path = join(f.unblock, "tampered.json");
    const transport = claudeMessageTransport({ messageChannelStateDir: f.unblock });
    await transport.send(path, message);
    const pending = join(spoolDir(f.game.busDir), "tampered.json");
    const entry = JSON.parse(readFileSync(pending, "utf8"));
    writeFileSync(pending, JSON.stringify({ ...entry, text: "changed" }));
    const lines: string[] = [];
    await deliverPending((line) => void lines.push(line), f.game.busDir, RECIPIENT);
    expect(lines).toEqual([]);
    expect((await transport.send(path, message)).status).toBe("ambiguous");
  });

  it("delegates unblock to the existing adapter and preserves a deferred guard result", async () => {
    const calls: unknown[][] = [];
    const adapter = {
      deliver: async (...args: unknown[]) => {
        calls.push(args);
        return { requestId: "id", status: "deferred" };
      },
    } as unknown as HarnessAdapter;
    const message = { requestId: "id", recipient: RECIPIENT, text: "exact" };
    expect(await guardedMessageTransport(adapter).send("receipt", message)).toEqual({
      requestId: "id",
      status: "deferred",
    });
    expect(calls).toEqual([["receipt", "id", RECIPIENT, "exact"]]);
  });
});
