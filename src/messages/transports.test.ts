import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deliverPending } from "../adapters/claude/channel.ts";
import { spoolDir } from "../adapters/claude/spool.ts";
import { decisionClear } from "../adapters/shared/decisions.ts";
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
    await deliverPending((line) => void lines.push(line), f.game.busDir, RECIPIENT, {
      beforeMessage: async () => ({
        status: decisionClear(f.unblock, RECIPIENT) ? "clear" : "blocked",
      }),
    });
    expect(lines).toEqual([]);
    f.clear();
    await deliverPending((line) => void lines.push(line), f.game.busDir, RECIPIENT, {
      beforeMessage: async () => ({
        status: decisionClear(f.unblock, RECIPIENT) ? "clear" : "blocked",
      }),
    });
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

  it("keeps generic messages pending after an enqueue-time owner is held or rerouted", async () => {
    const f = claudeFixture();
    const message = { requestId: "owner-race", recipient: RECIPIENT, text: "exact race body" };
    const path = join(f.unblock, "owner-race.json");
    const transport = claudeMessageTransport({ messageChannelStateDir: f.unblock });
    await transport.send(path, message);
    const lines: string[] = [];
    const write = (line: string) => void lines.push(line);
    await deliverPending(write, f.game.busDir, RECIPIENT);
    let held = true;
    let owner = RECIPIENT;
    const options = {
      beforeMessage: async (actual: typeof message) => ({
        status:
          actual.requestId === message.requestId &&
          actual.recipient === message.recipient &&
          actual.text === message.text &&
          !held &&
          owner === RECIPIENT
            ? ("clear" as const)
            : ("blocked" as const),
      }),
    };
    await deliverPending(write, f.game.busDir, RECIPIENT, options);
    held = false;
    owner = "00000000-0000-4000-8000-000000000099";
    await deliverPending(write, f.game.busDir, RECIPIENT, options);
    expect(lines).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("sending");
    expect((await transport.send(path, message)).status).toBe("queued");
    owner = RECIPIENT;
    await deliverPending(write, f.game.busDir, RECIPIENT, options);
    expect(lines).toHaveLength(1);
    expect((await transport.send(path, message)).status).toBe("accepted");
  });

  it("rechecks the exact spool after awaiting consume clearance", async () => {
    const f = claudeFixture();
    const message = { requestId: "await-race", recipient: RECIPIENT, text: "original" };
    const path = join(f.unblock, "await-race.json");
    const transport = claudeMessageTransport({ messageChannelStateDir: f.unblock });
    await transport.send(path, message);
    const pending = join(spoolDir(f.game.busDir), "await-race.json");
    const lines: string[] = [];
    await deliverPending((line) => void lines.push(line), f.game.busDir, RECIPIENT, {
      beforeMessage: async () => {
        await Promise.resolve();
        const entry = JSON.parse(readFileSync(pending, "utf8"));
        writeFileSync(pending, JSON.stringify({ ...entry, text: "changed while awaiting" }));
        return { status: "clear" };
      },
    });
    expect(lines).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("sending");
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

  it("reports a deduplicated delivery as accepted with a deduplicated diagnostic", async () => {
    const adapter = {
      deliver: async () => ({ requestId: "id", status: "deduplicated" }),
    } as unknown as HarnessAdapter;
    const message = { requestId: "id", recipient: RECIPIENT, text: "exact" };
    expect(await guardedMessageTransport(adapter).send("receipt", message)).toEqual({
      diagnostic: { category: "deduplicated", classification: "guarded", stage: "receipt" },
      requestId: "id",
      status: "accepted",
    });
  });

  it("keeps an unchanged delivery unaccepted and always names it in the diagnostic", async () => {
    const message = { requestId: "id", recipient: RECIPIENT, text: "exact" };
    const bare = {
      deliver: async () => ({ requestId: "id", status: "unchanged" }),
    } as unknown as HarnessAdapter;
    expect(await guardedMessageTransport(bare).send("receipt", message)).toEqual({
      diagnostic: { category: "unchanged", classification: "guarded", stage: "receipt" },
      requestId: "id",
      status: "blocked",
    });
    const native = {
      deliver: async () => ({
        diagnostic: {
          category: "rpc-refusal",
          classification: "native-rejected",
          method: "turn/steer",
          rpcCode: -32600,
          stage: "native-send",
        },
        requestId: "id",
        status: "unchanged",
      }),
    } as unknown as HarnessAdapter;
    expect(await guardedMessageTransport(native).send("receipt", message)).toEqual({
      diagnostic: {
        category: "unchanged",
        classification: "guarded",
        method: "turn/steer",
        rpcCode: -32600,
        stage: "receipt",
      },
      requestId: "id",
      status: "blocked",
    });
  });
});
