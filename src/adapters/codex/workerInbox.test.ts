import { describe, expect, it, vi } from "vitest";

import type { RpcClient } from "./rpc.ts";
import { verifyWorker, type WorkerBinding, workerInboxAdapter } from "./workerInbox.ts";

const binding: WorkerBinding = {
  harness: "codex",
  parent: "00000000-0000-4000-8000-000000000001",
  worker: "00000000-0000-4000-8000-000000000002",
};

function thread(): Record<string, unknown> {
  return {
    id: binding.worker,
    parentThreadId: binding.parent,
    source: { subAgent: { thread_spawn: { parent_thread_id: binding.parent } } },
  };
}

describe("worker inbox native lineage proof", () => {
  it("accepts explicit native lineage even while the worker has a pending question", async () => {
    const call = vi.fn<RpcClient["call"]>(async () => ({
      thread: { ...thread(), status: { activeFlags: ["waitingOnUserInput"], type: "active" } },
    }));
    await verifyWorker({ call, close: vi.fn() }, binding);
    expect(call.mock.calls).toEqual([
      ["thread/read", { includeTurns: false, threadId: binding.worker }],
    ]);
  });

  it.each([
    ["unrelated identity", { ...thread(), id: binding.parent }],
    ["wrong parent", { ...thread(), parentThreadId: binding.worker }],
    ["unknown parent", { ...thread(), parentThreadId: null }],
    ["missing source", { ...thread(), source: undefined }],
    ["unknown source", { ...thread(), source: "unknown" }],
    [
      "inconsistent source",
      {
        ...thread(),
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: binding.worker,
            },
          },
        },
      },
    ],
  ])("rejects %s", async (_name, nativeThread) => {
    const call = vi.fn<RpcClient["call"]>(async () => ({ thread: nativeThread }));
    await expect(verifyWorker({ call, close: vi.fn() }, binding)).rejects.toThrow(/worker inbox/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("preserves native refusal without attempting a load or resume", async () => {
    const call = vi.fn<RpcClient["call"]>(async () => {
      throw new Error("refused");
    });
    await expect(verifyWorker({ call, close: vi.fn() }, binding)).rejects.toThrow("refused");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("reports blocked when fresh lineage fails before deletion without reconciling a delete attempt", async () => {
    const call = vi.fn<RpcClient["call"]>(async (method) => {
      if (method === "thread/queue/list") {
        return {
          data: [
            {
              clientUserMessageId: "message",
              id: "q1",
              input: [{ text: "handled", type: "text" }],
            },
          ],
        };
      }
      throw new Error("lineage read refused");
    });
    const adapter = workerInboxAdapter({ call, close: vi.fn() }, binding);
    await expect(adapter.ack(binding.worker, "q1", "handled", "handled")).resolves.toMatchObject({
      reason: "unavailable",
      status: "blocked",
    });
    expect(call.mock.calls.map(([method]) => method)).toEqual(["thread/queue/list", "thread/read"]);
  });
});
