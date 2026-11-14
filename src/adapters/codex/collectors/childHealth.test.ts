import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { NativeTimeout, type RpcClient } from "../rpc.ts";
import { collectChildHealth, ERROR_CLASSES } from "./childHealth.ts";

type Row = Record<string, unknown>;
type Call = [string, Row];
type Health = {
  budget: Row;
  children: Row[];
  complete: boolean;
  counts: Row;
  diagnostics: string[];
  inventories: Record<string, Row>;
  schema_status: string;
  status: string;
};

function uuid(group: string, n: number): string {
  return `00000000-0000-0000-${group}-${String(n).padStart(12, "0")}`;
}

const P = uuid("0000", 1);
const C = uuid("0000", 2);
const T = uuid("0000", 3);
const N = uuid("0000", 4);
const PRIVATE = "PRIVATE_NATIVE_BODY";
const SOURCE_KINDS = '["subAgentThreadSpawn"]';

function row(child = C, parent = P): Row {
  return {
    id: child,
    parentThreadId: parent,
    source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } },
    status: { type: "idle" },
    updatedAt: 1,
    preview: PRIVATE,
    name: PRIVATE,
    path: PRIVATE,
  };
}

function turn(status = "failed", code: unknown = "contextWindowExceeded", identifier = T): Row {
  return {
    id: identifier,
    status,
    items: [{ text: PRIVATE }],
    error: { codexErrorInfo: code, message: PRIVATE, additionalDetails: PRIVATE },
  };
}

class Native implements RpcClient {
  calls: Call[] = [];
  child: Row = row();
  turn: Row = turn();
  listPages: { active: Row[]; archived: Row[] } = {
    active: [{ data: [this.child], nextCursor: null }],
    archived: [{ data: [], nextCursor: null }],
  };
  failure: string | null = null;
  readCount = 0;
  turnCount = 0;
  freshChild: Row | null = null;
  freshTurn: Row | null = null;
  deadline?: number;

  async call(method: string, params: unknown): Promise<unknown> {
    const request = params as Row;
    this.calls.push([method, structuredClone(request)]);
    if (this.failure === method) {
      throw new Error(PRIVATE);
    }
    if (method === "thread/list") {
      if (request.parentThreadId !== P || json(request.sourceKinds) !== SOURCE_KINDS) {
        throw new Error("unexpected inventory request");
      }
      const pages = request.archived ? this.listPages.archived : this.listPages.active;
      const page = pages["cursor" in request ? Number(request.cursor) : 0];
      if (page === undefined) {
        throw new Error("page out of range");
      }
      return structuredClone(page);
    }
    if (request.threadId !== C) {
      throw new Error("unexpected child");
    }
    if (method === "thread/read") {
      if (request.includeTurns !== false) {
        throw new Error("turns requested");
      }
      this.readCount += 1;
      return { thread: structuredClone(this.freshChild ?? this.child) };
    }
    if (method === "thread/turns/list") {
      if (
        request.itemsView !== "notLoaded" ||
        request.sortDirection !== "desc" ||
        request.limit !== 1
      ) {
        throw new Error("unexpected turn request");
      }
      this.turnCount += 1;
      const latest = this.turnCount > 1 && this.freshTurn !== null ? this.freshTurn : this.turn;
      return { data: [structuredClone(latest)], nextCursor: "older-private-cursor" };
    }
    throw new Error(method);
  }

  close(): void {
    // No transport.
  }
}

class ScopedNative implements RpcClient {
  readonly calls: Call[] = [];
  readonly children: Record<string, string[]> = {};
  readonly parents: string[];
  readonly rows: Record<string, Row> = {};
  readonly turns: Record<string, Row> = {};

  constructor(sizes: number[], failures = 0) {
    this.parents = sizes.map((_, n) => uuid("0001", n));
    sizes.forEach((size, i) => {
      const parent = this.parents[i] ?? "";
      const children = Array.from({ length: size }, (_, n) => uuid("0002", i * 1000 + n));
      this.children[parent] = children;
      children.forEach((child, n) => {
        this.rows[child] = row(child, parent);
        const failed = i === 0 && n < failures;
        this.turns[child] = turn(
          failed ? "failed" : "completed",
          failed ? "serverOverloaded" : null,
          uuid("0003", i * 1000 + n),
        );
      });
    });
  }

  async call(method: string, params: unknown): Promise<unknown> {
    const request = params as Row;
    this.calls.push([method, structuredClone(request)]);
    if (method === "thread/list") {
      const parent = request.parentThreadId as string;
      const listed = this.children[parent];
      if (listed === undefined || json(request.sourceKinds) !== SOURCE_KINDS) {
        throw new Error("unexpected inventory request");
      }
      const children = request.archived ? [] : listed;
      const start = Number(request.cursor ?? 0);
      const end = start + (request.limit as number);
      return {
        data: children.slice(start, end).map((child) => structuredClone(this.rows[child])),
        nextCursor: end < children.length ? String(end) : null,
      };
    }
    const child = request.threadId as string;
    const known = this.rows[child];
    if (known === undefined) {
      throw new Error("unknown child");
    }
    if (method === "thread/read") {
      if (request.includeTurns !== false) {
        throw new Error("turns requested");
      }
      return { thread: structuredClone(known) };
    }
    const expected = { itemsView: "notLoaded", limit: 1, sortDirection: "desc", threadId: child };
    if (method !== "thread/turns/list" || JSON.stringify(request) !== JSON.stringify(expected)) {
      throw new Error("unexpected turn request");
    }
    return { data: [structuredClone(this.turns[child])], nextCursor: "privateOlderHistory" };
  }

  close(): void {
    // No transport.
  }
}

async function collect(
  client: RpcClient,
  parents: readonly string[],
  maxPages?: number,
  maxCalls?: number,
): Promise<Record<string, Health>> {
  return (await collectChildHealth(client, parents, maxPages, maxCalls)) as Record<string, Health>;
}

async function snapshot(
  native: RpcClient = new Native(),
  maxPages?: number,
  maxCalls?: number,
): Promise<Health> {
  const result = (await collect(native, [P], maxPages, maxCalls))[P];
  if (result === undefined) {
    throw new Error("parent missing");
  }
  return result;
}

async function firstChild(native: RpcClient): Promise<Row> {
  const child = (await snapshot(native)).children[0];
  if (child === undefined) {
    throw new Error("child missing");
  }
  return child;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe("collectChildHealth", () => {
  it("classifies every typed failure code and discards private fields", async () => {
    for (const [code, classification] of Object.entries(ERROR_CLASSES)) {
      const native = new Native();
      native.turn = turn("failed", code);
      // eslint-disable-next-line no-await-in-loop
      const result = await snapshot(native);
      const child = result.children[0];
      expect(result.complete, code).toBe(true);
      expect(child?.requires_parent_action, code).toBe(true);
      expect(child?.lineage_verified, code).toBe(true);
      expect(child?.classification, code).toBe(classification);
      expect(child?.error_code, code).toBe(code);
      expect(child?.turn_id, code).toBe(T);
      expect(json(result), code).not.toContain(PRIVATE);
      expect(json(result), code).not.toContain("older-private-cursor");
      expect(native.calls, code).toHaveLength(5);
    }
  });

  it("treats waiting, retrying and long busy threads as nonterminal", async () => {
    await Promise.all(
      [[], ["waitingOnApproval"], ["waitingOnUserInput"]].map(async (flags) => {
        const native = new Native();
        native.child.status = { type: "active", activeFlags: flags };
        const child = await firstChild(native);
        expect(child.requires_parent_action).toBe(false);
        expect(child.thread_status).toBe("active");
      }),
    );
  });

  it("lets a newer success or resumed work supersede a failure", async () => {
    await Promise.all(
      ["completed", "inProgress", "interrupted"].map(async (status) => {
        const native = new Native();
        native.turn = turn(status);
        expect((await firstChild(native)).requires_parent_action).toBe(false);
      }),
    );
    const resumed = new Native();
    resumed.freshTurn = turn("completed", "contextWindowExceeded", N);
    const result = await snapshot(resumed);
    expect(result.status).toBe("partial");
    expect(result.children[0]?.requires_parent_action).toBe(false);
    const updated = new Native();
    updated.freshChild = { ...row(), updatedAt: 2 };
    expect((await firstChild(updated)).requires_parent_action).toBe(false);
  });

  it("never reads a child whose listed lineage is invalid", async () => {
    const changes: Row[] = [
      { parentThreadId: N },
      { parentThreadId: null },
      { source: { subAgent: { thread_spawn: { parent_thread_id: N } } } },
      { id: PRIVATE },
    ];
    await Promise.all(
      changes.map(async (change) => {
        const native = new Native();
        native.listPages.active = [{ data: [{ ...row(), ...change }], nextCursor: null }];
        const result = await snapshot(native);
        expect(result.complete).toBe(false);
        expect(result.children).toEqual([]);
        expect(native.calls).toHaveLength(2);
      }),
    );
    const native = new Native();
    native.freshChild = row(C, N);
    expect((await firstChild(native)).lineage_verified).toBe(false);
  });

  it("paginates active and archived inventories and deduplicates children", async () => {
    const native = new Native();
    native.listPages.active = [
      { data: [], nextCursor: "1" },
      { data: [row()], nextCursor: null },
    ];
    native.listPages.archived = [{ data: [row()], nextCursor: null }];
    const result = await snapshot(native);
    expect(result.complete).toBe(true);
    expect(result.children).toHaveLength(1);
    expect(result.inventories.active?.pages).toBe(2);
  });

  it("never searches older history for a failure behind a partial latest turn", async () => {
    const native = new Native();
    native.turn = { id: T, status: PRIVATE };
    const result = await snapshot(native);
    expect(result.children[0]?.requires_parent_action).toBe(false);
    expect(result.diagnostics).toContain("turn_schema_unavailable");
    expect(json(result)).not.toContain(PRIVATE);
  });

  it("reports unavailable reads and schema explicitly and privately", async () => {
    await Promise.all(
      ["thread/list", "thread/read", "thread/turns/list"].map(async (method) => {
        const native = new Native();
        native.failure = method;
        const result = await snapshot(native);
        expect(result.complete).toBe(false);
        expect(json(result)).not.toContain(PRIVATE);
        expect(result.children.some((child) => child.requires_parent_action)).toBe(false);
      }),
    );
    const native = new Native();
    native.listPages.active = [{ data: PRIVATE }];
    expect((await snapshot(native)).schema_status).toBe("unknown");
  });

  it("bounds a repeated cursor and an oversized page", async () => {
    const repeated = new Native();
    repeated.listPages.active = [
      { data: [row()], nextCursor: "1" },
      { data: [row()], nextCursor: "1" },
    ];
    const paged = await snapshot(repeated);
    expect(paged.diagnostics).toContain("pagination_invalid");
    expect(paged.inventories.active?.pages).toBe(2);
    const oversized = new Native();
    oversized.listPages.active = [
      { data: Array.from({ length: 51 }, () => row()), nextCursor: null },
    ];
    const bounded = await snapshot(oversized);
    expect(bounded.complete).toBe(false);
    expect(bounded.diagnostics).toContain("page_bound_exceeded");
  });

  it("excludes a child listed with conflicting lineage", async () => {
    const native = new Native();
    native.listPages.archived = [{ data: [row(C, N)], nextCursor: null }];
    const result = await snapshot(native);
    expect(result.children).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it("reports an empty or overfull latest turn page explicitly", async () => {
    const cases: [Row[], string | null][] = [
      [[], null],
      [[], "private"],
      [[turn(), turn()], null],
    ];
    await Promise.all(
      cases.map(async ([data, cursor]) => {
        const native = new Native();
        const original = native.call.bind(native);
        native.call = async (method, params) =>
          method === "thread/turns/list" ? { data, nextCursor: cursor } : original(method, params);
        const child = await firstChild(native);
        expect(child.requires_parent_action).toBe(false);
        expect(child.complete).toBe(data.length === 0 && cursor === null);
      }),
    );
  });

  it("stops calls at a shared deadline and keeps every parent result", async () => {
    const native = new Native();
    native.deadline = performance.now() - 1000;
    const results = await collect(native, [P, N]);
    expect(native.calls).toEqual([]);
    for (const result of Object.values(results)) {
      expect(result.status).toBe("unavailable");
      expect(result.complete).toBe(false);
      expect(result.diagnostics).toContain("native_deadline_exhausted");
      expect(result.budget.calls_used).toBe(0);
    }
  });

  it("halts native work on a timeout and marks omissions", async () => {
    let calls = 0;
    const native: RpcClient = {
      call: async () => {
        calls += 1;
        throw new NativeTimeout(PRIVATE);
      },
      close: () => undefined,
    };
    const results = await collect(native, [P, N]);
    expect(calls).toBe(1);
    for (const result of Object.values(results)) {
      expect(result.diagnostics).toContain("native_timeout");
      expect(result.budget.exhausted).toBe(true);
      expect(json(result)).not.toContain(PRIVATE);
    }
  });

  it("lists every parent inventory before any child read and honours the call cap", async () => {
    const calls: Call[] = [];
    const many: RpcClient = {
      call: async (method, params) => {
        const request = params as Row;
        calls.push([method, request]);
        if (method === "thread/list") {
          const parent = request.parentThreadId as string;
          return { data: request.archived ? [] : [row(C, parent)] };
        }
        throw new Error(PRIVATE);
      },
      close: () => undefined,
    };
    const results = await collect(many, [P, N]);
    expect(calls.slice(0, 4).map(([method]) => method)).toEqual(Array(4).fill("thread/list"));
    expect(Object.values(results).some((result) => result.complete)).toBe(false);
    const native = new Native();
    const result = await snapshot(native, 10, 3);
    expect(native.calls).toHaveLength(3);
    const child = result.children[0];
    expect(child?.lineage_verified).toBe(true);
    expect(child?.status).toBe("partial");
    expect(child?.requires_parent_action).toBe(false);
    expect(result.diagnostics).toContain("native_call_budget_exhausted");
    expect(result.budget.max_calls).toBe(3);
    expect(result.counts).toEqual({ discovered: 1, observed: 1, validated: 0, omitted: 0 });
  });

  it("never alerts when the deadline expires during a call", async () => {
    const native = new Native();
    native.deadline = performance.now() + 100_000;
    const original = native.call.bind(native);
    native.call = async (method, params) => {
      const response = await original(method, params);
      if (method === "thread/read") {
        native.deadline = performance.now() - 1000;
      }
      return response;
    };
    const result = await snapshot(native);
    expect(native.calls).toHaveLength(4);
    expect(result.diagnostics).toContain("native_deadline_exhausted");
    expect(result.children[0]?.requires_parent_action).toBe(false);
  });

  it("clears earlier typed metadata on an unknown recent error", async () => {
    const native = new Native();
    native.turn = turn("failed", "unknownFutureCode");
    const unknown = await firstChild(native);
    expect(unknown.error_code).toBeNull();
    expect(unknown.requires_parent_action).toBe(false);
    const changed = new Native();
    changed.freshTurn = turn("failed", "unknownFutureCode", N);
    const child = await firstChild(changed);
    expect(child.requires_parent_action).toBe(false);
    expect(child.status).toBe("partial");
    expect(child.error_code).toBeNull();
    expect(child.turn_id).toBe(N);
  });

  it("observes children round-robin under the call bound", async () => {
    const native = new ScopedNative([3, 3, 3]);
    const results = await collect(native, native.parents, 10, 9);
    expect(native.calls.slice(6).map(([, params]) => params.threadId)).toEqual(
      native.parents.map((parent) => native.children[parent]?.[0]),
    );
    for (const result of Object.values(results)) {
      expect(result.counts).toEqual({ discovered: 3, observed: 1, validated: 0, omitted: 2 });
      expect(result.complete).toBe(false);
    }
  });

  it("never validates a failure from invalid inventory metadata", async () => {
    const cases: [string, unknown][] = [
      ["updatedAt", null],
      ["updatedAt", true],
      ["status", { type: "future" }],
    ];
    await Promise.all(
      cases.map(async ([key, value]) => {
        const native = new Native();
        native.child[key] = value;
        const result = await snapshot(native);
        expect(native.calls).toHaveLength(2);
        expect(result.counts).toEqual({ discovered: 1, observed: 0, validated: 0, omitted: 1 });
        expect(result.complete).toBe(false);
        expect(result.diagnostics).toContain("thread_schema_unavailable");
      }),
    );
  });
});
