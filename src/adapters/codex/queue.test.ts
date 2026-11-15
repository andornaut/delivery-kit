import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as durable from "../../durable.ts";
import { codexQueueTransport, type NativeMessage } from "../../messages/transports.ts";
import { type QueueGuards, queueMessage } from "./queue.ts";
import { type RpcClient, RpcError } from "./rpc.ts";

const message: NativeMessage = {
  requestId: "stable-request",
  recipient: "00000000-0000-4000-8000-000000000001",
  text: " exact\nmessage \n",
};
const clear: QueueGuards = { beforeAdd: async () => ({ status: "clear" }) };
function fixture(add?: (params: unknown) => unknown) {
  const path = join(mkdtempSync(join(tmpdir(), "queue-transport-")), "receipt.json");
  const calls: string[] = [];
  let entries: unknown[] = [];
  let child = false;
  const client: RpcClient = {
    close() {},
    async call(method, params) {
      calls.push(method);
      if (method === "thread/read") {
        return {
          thread: { id: message.recipient, parentThreadId: child ? "parent" : null, source: "cli" },
        };
      }
      if (method === "thread/queue/list") {
        return { data: entries };
      }
      if (method === "thread/queue/add") {
        expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
          status: "sending",
          text: message.text,
        });
        const submission = {
          id: "native-queue-id",
          clientUserMessageId: message.requestId,
          input: [{ type: "text", text: message.text, text_elements: [] }],
        };
        entries = [submission];
        return add === undefined ? { queuedSubmission: submission } : add(params);
      }
      throw new Error("unexpected native method");
    },
  };
  return {
    path,
    calls,
    client,
    child: () => {
      child = true;
    },
    entries: (value: unknown[]) => {
      entries = value;
    },
  };
}

describe("guarded native queue transport", () => {
  it("reports a failed pre-send receipt write as unavailable without native add", async () => {
    const f = fixture();
    const spy = vi.spyOn(durable, "writeJsonDurable").mockImplementation(() => {
      throw new Error("prewrite failed");
    });
    try {
      expect((await queueMessage(f.client, f.path, message, clear)).status).toBe("unavailable");
      expect(f.calls).not.toContain("thread/queue/add");
    } finally {
      spy.mockRestore();
    }
  });

  it("preserves uncertainty for a corrupt previous receipt without native input", async () => {
    const f = fixture();
    writeFileSync(f.path, "invalid JSON");
    expect((await queueMessage(f.client, f.path, message, clear)).status).toBe("ambiguous");
    expect(f.calls).toEqual([]);
  });

  it("defaults to local pending without connecting or probing, and honours fresh HOLD clearance", async () => {
    const f = fixture();
    let connections = 0;
    const transport = codexQueueTransport({
      connect: async () => {
        connections++;
        return f.client;
      },
    });
    expect((await transport.send(f.path, message)).status).toBe("blocked");
    expect(transport.capability).toBe("guard-required");
    expect(
      (
        await codexQueueTransport({
          connect: async () => {
            connections++;
            return f.client;
          },
          guards: clear,
          canConnect: () => false,
        }).send(f.path, message)
      ).status,
    ).toBe("blocked");
    expect(connections).toBe(0);
    expect((await queueMessage(f.client, f.path, message)).status).toBe("blocked");
    expect(f.calls).toEqual([]);
    let guards = 0;
    expect(
      (
        await queueMessage(f.client, f.path, message, {
          beforeAdd: async () => ({ status: ++guards === 1 ? "clear" : "blocked" }),
        })
      ).status,
    ).toBe("blocked");
    expect(f.calls).toEqual(["thread/read"]);
  });

  it("persists exact binding before add and accepts only the schema's exact queued submission", async () => {
    const f = fixture((params) => {
      expect(params).toEqual({
        threadId: message.recipient,
        clientUserMessageId: message.requestId,
        input: [{ type: "text", text: message.text, text_elements: [] }],
      });
      return {
        queuedSubmission: {
          id: "q",
          clientUserMessageId: message.requestId,
          input: [{ type: "text", text: message.text }],
        },
      };
    });
    expect(await queueMessage(f.client, f.path, message, clear)).toMatchObject({
      status: "accepted",
      queueId: "q",
    });
    expect(
      (await queueMessage(f.client, f.path, { ...message, text: "changed" }, clear)).status,
    ).toBe("blocked");
    expect((await queueMessage(f.client, f.path, message, clear)).status).toBe("accepted");
    expect(f.calls).toEqual(["thread/read", "thread/queue/add"]);
  });

  it("reconciles a lost reply by client ID and exact input without adding twice", async () => {
    const f = fixture(() => {
      throw new Error("lost reply");
    });
    expect((await queueMessage(f.client, f.path, message, clear)).status).toBe("ambiguous");
    expect((await queueMessage(f.client, f.path, message, clear)).status).toBe("accepted");
    expect(f.calls.filter((method) => method === "thread/queue/add")).toHaveLength(1);
  });

  it.each(["missing", "blocked", "unavailable", "sending"])(
    "preserves lost-response ambiguity when %s clearance prevents reconciliation",
    async (mode) => {
      const f = fixture(() => {
        throw new Error("lost reply");
      });
      expect((await queueMessage(f.client, f.path, message, clear)).status).toBe("ambiguous");
      if (mode === "sending") {
        const state = JSON.parse(readFileSync(f.path, "utf8"));
        writeFileSync(f.path, JSON.stringify({ ...state, status: "sending" }));
      }
      const before = [...f.calls];
      const guards: QueueGuards | undefined =
        mode === "missing" || mode === "sending"
          ? undefined
          : {
              beforeAdd: async () => ({ status: mode === "blocked" ? "blocked" : "unavailable" }),
            };
      expect((await queueMessage(f.client, f.path, message, guards)).status).toBe("ambiguous");
      expect(JSON.parse(readFileSync(f.path, "utf8")).status).toBe("ambiguous");
      let connections = 0;
      const transport = codexQueueTransport({
        connect: async () => {
          connections++;
          return f.client;
        },
        guards: clear,
        canConnect: () => false,
      });
      expect((await transport.send(f.path, message)).status).toBe("ambiguous");
      expect(connections).toBe(0);
      expect(
        (
          await codexQueueTransport({
            connect: async () => {
              throw new Error("connect failed");
            },
            guards: clear,
            canConnect: () => true,
          }).send(f.path, message)
        ).status,
      ).toBe("ambiguous");
      expect(
        (await codexQueueTransport({ connect: async () => f.client }).send(f.path, message)).status,
      ).toBe("ambiguous");
      expect(f.calls).toEqual(before);
      expect(f.calls.filter((method) => method === "thread/queue/add")).toHaveLength(1);
    },
  );

  it("retains ambiguity for absent or changed queue entries and rejects workers without input", async () => {
    const f = fixture(() => {
      throw new Error("lost reply");
    });
    await queueMessage(f.client, f.path, message, clear);
    f.entries([]);
    expect((await queueMessage(f.client, f.path, message, clear)).status).toBe("ambiguous");
    f.entries([
      {
        id: "q",
        clientUserMessageId: message.requestId,
        input: [{ type: "text", text: "changed" }],
      },
    ]);
    expect((await queueMessage(f.client, f.path, message, clear)).status).toBe("ambiguous");
    expect(f.calls.filter((method) => method === "thread/queue/add")).toHaveLength(1);
    const worker = fixture();
    worker.child();
    expect((await queueMessage(worker.client, worker.path, message, clear)).status).toBe("blocked");
    expect(worker.calls).toEqual(["thread/read"]);
  });

  it.each([-32601, -32000])(
    "reports native refusal %s without raw details or retries",
    async (code) => {
      const f = fixture(() => {
        throw new RpcError({ code, message: "private diagnostic" });
      });
      const outcome = await queueMessage(f.client, f.path, message, clear);
      expect(outcome.status).toBe(code === -32601 ? "unsupported" : "rejected");
      expect(JSON.stringify(outcome)).not.toContain("private diagnostic");
      await queueMessage(f.client, f.path, message, clear);
      expect(f.calls.filter((method) => method === "thread/queue/add")).toHaveLength(1);
    },
  );
});
