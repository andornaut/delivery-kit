import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as durable from "../../durable.ts";
import { type RpcClient, RpcError } from "./rpc.ts";
import { deferLocally, deliverReceipt } from "./steer.ts";

vi.mock("./guard.ts", async (original) => ({
  ...(await original<typeof import("./guard.ts")>()),
  nativeQuestionsClear: async () => [true, null],
}));

const recipient = "00000000-0000-4000-8000-000000000001";
const requestId = "one-request";
const seed = { text: "exact input" };
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "guarded-receipt-"));
  roots.push(root);
  const directory = join(root, "guard");
  mkdirSync(join(directory, "decisions"), { recursive: true });
  durable.writeJsonDurable(join(directory, "decisions", `${recipient}.json`), {
    thread_id: recipient,
    state: "clear",
    resolutions: [],
  });
  const path = join(root, "fresh", "recipient", "receipt.json");
  let sends = 0;
  const client: RpcClient = {
    close() {},
    async call(method) {
      if (method === "thread/read") {
        return { thread: { canAcceptDirectInput: true, status: { type: "idle" } } };
      }
      if (method === "thread/turns/list") {
        return { data: [{ id: "previous", status: "completed" }] };
      }
      if (method === "turn/start") {
        sends++;
        expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("sending");
        return { turnId: "accepted-turn" };
      }
      throw new Error("unexpected native method");
    },
  };
  return {
    root,
    path,
    directory,
    client,
    sends: () => sends,
    deliver: () => deliverReceipt(client, directory, path, seed, requestId, recipient, seed.text),
  };
}

describe("guarded receipt preparation", () => {
  it("creates private parents for a fresh recipient and deduplicates accepted input", async () => {
    const f = fixture();
    expect((await f.deliver()).status).toBe("accepted");
    expect(statSync(dirname(f.path)).mode & 0o777).toBe(0o700);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect((await f.deliver()).status).toBe("accepted");
    expect(f.sends()).toBe(1);
  });

  it("creates fresh parents for a local deferral without native input", () => {
    const f = fixture();
    expect(
      deferLocally(join(f.root, "missing-guard"), f.path, seed, requestId, recipient)?.status,
    ).toBe("deferred");
    expect(statSync(dirname(f.path)).mode & 0o777).toBe(0o700);
    expect(f.sends()).toBe(0);
  });

  it.each(["corrupt", "unreadable"])(
    "preserves a %s previous receipt without native input",
    async (mode) => {
      const f = fixture();
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, "invalid JSON");
      if (mode === "unreadable") {
        chmodSync(f.path, 0);
      }
      expect(deferLocally(f.directory, f.path, seed, requestId, recipient)?.status).toBe(
        "ambiguous",
      );
      expect((await f.deliver()).status).toBe("ambiguous");
      expect(f.sends()).toBe(0);
    },
  );

  it("reports preparation failure before native mutation as unavailable", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "fresh"), "not a directory");
    expect((await f.deliver()).status).toBe("unavailable");
    expect(f.sends()).toBe(0);
  });

  it("keeps failed acceptance persistence ambiguous and never sends twice", async () => {
    const f = fixture();
    const write = durable.writeDurable;
    let writes = 0;
    const spy = vi.spyOn(durable, "writeDurable").mockImplementation((...args) => {
      if (++writes === 2) {
        throw new Error("acceptance persistence unavailable");
      }
      return write(...args);
    });
    expect((await f.deliver()).status).toBe("ambiguous");
    spy.mockRestore();
    expect((await f.deliver()).status).toBe("ambiguous");
    expect(f.sends()).toBe(1);
  });

  it("keeps a lost native response ambiguous and never sends twice", async () => {
    const f = fixture();
    const call = f.client.call;
    vi.spyOn(f.client, "call").mockImplementation(async (method, params) => {
      const result = await call(method, params);
      if (method === "turn/start") {
        throw new Error("lost response after admission");
      }
      return result;
    });
    expect((await f.deliver()).status).toBe("ambiguous");
    expect((await f.deliver()).status).toBe("ambiguous");
    expect(f.sends()).toBe(1);
  });
});

describe("durable safe native refusal", () => {
  it("keeps an allowlisted refusal on the receipt and deduplicates without a second send", async () => {
    const test = fixture();
    let sends = 0;
    const client: RpcClient = {
      close() {},
      async call(method, params) {
        if (method === "turn/start") {
          sends++;
          throw new RpcError({
            code: -32600,
            message: "direct app-server input not allowed: private-fixture",
          });
        }
        return test.client.call(method, params);
      },
    };
    const deliver = () =>
      deliverReceipt(client, test.directory, test.path, seed, requestId, recipient, seed.text);
    const first = await deliver();
    const diagnostic = {
      stage: "native-send",
      category: "direct-input-not-allowed",
      classification: "native-rejected",
      method: "turn/start",
      rpcCode: -32600,
    };
    expect(first).toMatchObject({ status: "rejected", diagnostic });
    expect(JSON.parse(readFileSync(test.path, "utf8"))).toMatchObject({
      status: "rejected",
      diagnostic,
      attempts: [{ diagnostic }],
    });
    expect(await deliver()).toMatchObject({ status: "rejected", diagnostic });
    expect(sends).toBe(1);
    expect(readFileSync(test.path, "utf8")).not.toContain("private-fixture");
  });
});
