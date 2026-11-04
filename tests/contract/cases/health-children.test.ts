// Scoped child (worker) health through `monitor-snapshot --recipient R --parent ...`
// (from tests/test_child_health.py). R is outside the active route, so only the child
// collector makes scoped native calls; parents must be active route members.
import { expect } from "vitest";

import { cli } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import type { CodexSocket } from "../lib/codex-socket.ts";
import {
  C,
  CH_PRIVATE,
  CHILD_METHODS,
  ChildNative,
  codexRoute,
  ERROR_CLASSES,
  N,
  only,
  P,
  R,
  row,
  ScopedNative,
  snapshot,
  sockets,
  T,
  turn,
} from "../lib/health-native.ts";

type Json = Record<string, unknown>;
type Child = Json & { requires_parent_action: boolean; error_code: unknown; status: string };
type Health = Json & {
  children: Child[];
  diagnostics: string[];
  counts: Json;
  budget: Json;
  inventories: Record<string, Json>;
};

suite("child health", () => {
  const workspace = workspaces();
  const socketFor = sockets();

  async function collect(
    native: { install(socket: CodexSocket): unknown },
    parents: string[] = [P],
  ) {
    const ws = workspace();
    const socket = await socketFor(ws);
    native.install(socket);
    codexRoute(ws, [...new Set([P, N, ...parents])]);
    const shot = await snapshot(ws, R, parents);
    expect(shot.result.code, shot.result.stderr).toBe(0);
    expect(shot.text).not.toContain(CH_PRIVATE);
    const health = shot.record.worker_health as Record<string, Health>;
    expect(shot.out.worker_health).toEqual(health);
    return {
      health,
      all: health,
      one: health[parents[0]!]!,
      calls: only(socket.calls, CHILD_METHODS),
      shot,
    };
  }

  contract("typed failures are classified and private fields discarded", async () => {
    for (const [code, classification] of Object.entries(ERROR_CLASSES)) {
      const native = new ChildNative();
      native.turn = turn("failed", code);
      const { one, calls, shot } = await collect(native);
      const child = one.children[0]!;
      expect(one.complete).toBe(true);
      expect(child.requires_parent_action).toBe(true);
      expect(child.lineage_verified).toBe(true);
      expect(child.classification).toBe(classification);
      expect(child.error_code).toBe(code);
      expect(child.turn_id).toBe(T);
      expect(shot.text).not.toContain("older-private-cursor");
      expect(calls).toHaveLength(5);
    }
  });

  contract("no status or untyped error inference", async () => {
    for (const status of ["completed", "interrupted", "inProgress", "failed"]) {
      for (const code of [
        null,
        "other",
        { rateLimitExceeded: {} },
        { flexUnavailable: {} },
        { serverOverloaded: {} },
        { unknown: CH_PRIVATE },
        CH_PRIVATE,
      ]) {
        const native = new ChildNative();
        native.turn = turn(status, code);
        const child = (await collect(native)).one.children[0]!;
        expect(child.requires_parent_action).toBe(false);
        expect(child.error_code).toBeNull();
      }
    }
  });

  contract("waiting, retrying and long busy children are not terminal", async () => {
    for (const flags of [[], ["waitingOnApproval"], ["waitingOnUserInput"]]) {
      const native = new ChildNative();
      native.child.status = { type: "active", activeFlags: flags };
      const child = (await collect(native)).one.children[0]!;
      expect(child.requires_parent_action).toBe(false);
      expect(child.thread_status).toBe("active");
    }
  });

  contract("newer success or resumed work supersedes a failure", async () => {
    for (const status of ["completed", "inProgress", "interrupted"]) {
      const native = new ChildNative();
      native.turn = turn(status);
      expect((await collect(native)).one.children[0]!.requires_parent_action).toBe(false);
    }
    let native = new ChildNative();
    native.freshTurn = turn("completed", "contextWindowExceeded", N);
    const { one } = await collect(native);
    expect(one.status).toBe("partial");
    expect(one.children[0]!.requires_parent_action).toBe(false);
    native = new ChildNative();
    native.freshChild = { ...row(), updatedAt: 2 };
    expect((await collect(native)).one.children[0]!.requires_parent_action).toBe(false);
  });

  contract("invalid lineage never reads an unrelated child", async () => {
    for (const change of [
      { parentThreadId: N },
      { parentThreadId: null },
      { source: { subAgent: { thread_spawn: { parent_thread_id: N } } } },
      { id: CH_PRIVATE },
    ]) {
      const native = new ChildNative();
      native.listPages.false[0]!.data = [{ ...row(), ...change }];
      const { one, calls } = await collect(native);
      expect(one.complete).toBe(false);
      expect(one.children).toEqual([]);
      expect(calls).toHaveLength(2);
    }
    const native = new ChildNative();
    native.freshChild = row(C, N);
    expect((await collect(native)).one.children[0]!.lineage_verified).toBe(false);
  });

  contract("active and archived pagination deduplicates children", async () => {
    const native = new ChildNative();
    native.listPages.false = [
      { data: [], nextCursor: "1" },
      { data: [row()], nextCursor: null },
    ];
    native.listPages.true = [{ data: [row()], nextCursor: null }];
    const { one } = await collect(native);
    expect(one.complete).toBe(true);
    expect(one.children).toHaveLength(1);
    expect(one.inventories.active!.pages).toBe(2);
  });

  contract("a partial inventory keeps safe verified facts", async () => {
    // The CLI collector reads at most ten pages per inventory stream.
    const native = new ChildNative();
    native.listPages.false = Array.from({ length: 10 }, (_, i) => ({
      data: i ? [] : [native.child],
      nextCursor: String(i + 1),
    }));
    const { one } = await collect(native);
    expect(one.status).toBe("partial");
    expect(one.diagnostics).toContain("page_bound_reached");
    expect(one.children[0]!.requires_parent_action).toBe(true);
  });

  contract("partial latest history never searches older failures", async () => {
    const native = new ChildNative();
    native.turn = { id: T, status: CH_PRIVATE };
    const { one } = await collect(native);
    expect(one.children[0]!.requires_parent_action).toBe(false);
    expect(one.diagnostics).toContain("turn_schema_unavailable");
  });

  contract("unavailable reads and schema are explicit and private", async () => {
    for (const method of ["thread/list", "thread/read", "thread/turns/list"]) {
      const native = new ChildNative();
      native.failure = method;
      const { one } = await collect(native);
      expect(one.complete).toBe(false);
      expect(one.children.some((c) => c.requires_parent_action)).toBe(false);
    }
    const native = new ChildNative();
    native.listPages.false = [{ data: CH_PRIVATE }];
    expect((await collect(native)).one.schema_status).toBe("unknown");
  });

  contract("repeated cursors and oversized pages are bounded", async () => {
    let native = new ChildNative();
    native.listPages.false = [
      { data: [row()], nextCursor: "1" },
      { data: [row()], nextCursor: "1" },
    ];
    let { one } = await collect(native);
    expect(one.diagnostics).toContain("pagination_invalid");
    expect(one.inventories.active!.pages).toBe(2);
    native = new ChildNative();
    native.listPages.false[0]!.data = Array(51).fill(row());
    ({ one } = await collect(native));
    expect(one.complete).toBe(false);
    expect(one.diagnostics).toContain("page_bound_exceeded");
  });

  contract("conflicting duplicate lineage is excluded", async () => {
    const native = new ChildNative();
    native.listPages.true[0]!.data = [row(C, N)];
    const { one } = await collect(native);
    expect(one.children).toEqual([]);
    expect(one.complete).toBe(false);
  });

  contract("empty or overfull newest-turn pages are explicit", async () => {
    for (const [data, cursor] of [
      [[], null],
      [[], "private"],
      [[turn(), turn()], null],
    ] as Array<[Json[], string | null]>) {
      const native = new ChildNative();
      native.turnsPage = { data, nextCursor: cursor };
      const child = (await collect(native)).one.children[0]!;
      expect(child.requires_parent_action).toBe(false);
      expect(child.complete).toBe(data.length === 0 && cursor === null);
    }
  });

  contract("a timeout halts native work and marks every parent", async () => {
    const native = new ChildNative();
    native.hang = "thread/list";
    const { all, calls } = await collect(native, [P, N]);
    expect(calls).toHaveLength(1);
    for (const health of Object.values(all)) {
      expect(health.diagnostics).toContain("native_timeout");
      expect(health.budget.exhausted).toBe(true);
    }
  });

  contract("every parent inventory precedes child reads, and the call cap is exact", async () => {
    // Round-robin order is observable without a reduced cap: all four inventory streams first.
    const ordered = new ScopedNative([1, 1]);
    let { calls } = await collect(ordered, ordered.parents);
    expect(calls.slice(0, 4).map((c) => c.method)).toEqual(Array(4).fill("thread/list"));
    // 300 children need 309 calls; the collector stops at exactly 256.
    const native = new ScopedNative([100, 100, 100]);
    const out = await collect(native, native.parents);
    calls = out.calls;
    expect(calls).toHaveLength(256);
    const observed = Object.values(out.all).reduce((sum, h) => sum + Number(h.counts.observed), 0);
    expect(observed).toBe(256 - 9);
    for (const health of Object.values(out.all)) {
      expect(health.complete).toBe(false);
      expect(health.diagnostics).toContain("native_call_budget_exhausted");
      expect(health.budget).toMatchObject({ max_calls: 256, calls_used: 256, exhausted: true });
    }
  });

  contract("recognized rate and capacity errors require a terminal failed turn", async () => {
    for (const code of ["rateLimitExceeded", "flexUnavailable", "serverOverloaded"]) {
      for (const status of ["completed", "interrupted", "inProgress"]) {
        const native = new ChildNative();
        native.turn = turn(status, code);
        const child = (await collect(native)).one.children[0]!;
        expect(child.error_code).toBe(code);
        expect(child.requires_parent_action).toBe(false);
      }
      const native = new ChildNative();
      native.turn = turn("failed", code);
      native.child.status = { type: "active", activeFlags: ["waitingOnUserInput"] };
      expect((await collect(native)).one.children[0]!.requires_parent_action).toBe(false);
    }
  });

  contract("an unknown recent error clears earlier typed metadata", async () => {
    let native = new ChildNative();
    native.turn = turn("failed", "unknownFutureCode");
    let child = (await collect(native)).one.children[0]!;
    expect(child.error_code).toBeNull();
    expect(child.requires_parent_action).toBe(false);
    native = new ChildNative();
    native.freshTurn = turn("failed", "unknownFutureCode", N);
    child = (await collect(native)).one.children[0]!;
    expect(child.requires_parent_action).toBe(false);
    expect(child.status).toBe("partial");
    expect(child.error_code).toBeNull();
    expect(child.turn_id).toBe(N);
  });

  contract("125 children across ten parents complete with eight exact failures", async () => {
    const native = new ScopedNative([22, 11, 12, 12, 12, 12, 11, 11, 11, 11], 8);
    const { all, calls, shot } = await collect(native, native.parents);
    expect(calls).toHaveLength(20 + 125 + 2 * 8);
    const sum = (key: string) =>
      Object.values(all).reduce((total, h) => total + Number(h.counts[key]), 0);
    expect(sum("observed")).toBe(125);
    expect(sum("validated")).toBe(8);
    expect(Object.values(all).every((h) => h.complete)).toBe(true);
    for (const parent of native.parents) {
      const count = native.children[parent]!.length;
      expect(all[parent]!.counts).toEqual({
        discovered: count,
        observed: count,
        validated: parent === native.parents[0] ? 8 : 0,
        omitted: 0,
      });
    }
    expect(shot.text).not.toContain("privateOlderHistory");
    expect(calls.filter((c) => c.method === "thread/read")).toHaveLength(8);
    expect(calls.filter((c) => c.method === "thread/turns/list")).toHaveLength(133);
  });

  contract("inventory pages round-robin before any parent's second page", async () => {
    const native = new ScopedNative([120, 120]);
    const { calls } = await collect(native, native.parents);
    const [first, second] = native.parents;
    expect(
      calls.slice(0, 5).map((c) => [c.params.parentThreadId, c.params.archived, c.params.cursor]),
    ).toEqual([
      [first, false, undefined],
      [second, false, undefined],
      [first, true, undefined],
      [second, true, undefined],
      [first, false, "50"],
    ]);
  });

  contract("child observations round-robin across parents", async () => {
    const native = new ScopedNative([3, 3, 3]);
    const { calls } = await collect(native, native.parents);
    expect(calls.slice(6, 9).map((c) => c.params.threadId)).toEqual(
      native.parents.map((p) => native.children[p]![0]),
    );
  });

  contract("discovered counts include listed children beyond the inspection bound", async () => {
    const native = new ScopedNative([125]);
    const { one } = await collect(native, native.parents);
    expect(one.counts).toEqual({ discovered: 125, observed: 100, validated: 0, omitted: 25 });
    expect(one.diagnostics).toContain("child_bound_exceeded");
    expect(one.complete).toBe(false);
  });

  contract("nonfailed and unknown children need only the newest-turn read", async () => {
    for (const [status, code] of [
      ["completed", null],
      ["interrupted", null],
      ["inProgress", "contextWindowExceeded"],
      ["failed", "unknown"],
    ] as Array<[string, string | null]>) {
      const native = new ChildNative();
      native.turn = turn(status, code);
      const { one, calls } = await collect(native);
      expect(calls.map((c) => c.method)).toEqual([
        "thread/list",
        "thread/list",
        "thread/turns/list",
      ]);
      expect(one.counts).toEqual({ discovered: 1, observed: 1, validated: 0, omitted: 0 });
      expect(one.children[0]!.requires_parent_action).toBe(false);
    }
  });

  contract("invalid inventory metadata cannot validate a failure", async () => {
    for (const [key, value] of [
      ["updatedAt", null],
      ["updatedAt", true],
      ["status", { type: "future" }],
    ] as Array<[string, unknown]>) {
      const native = new ChildNative();
      native.child[key] = value;
      const { one, calls } = await collect(native);
      expect(calls).toHaveLength(2);
      expect(one.counts).toEqual({ discovered: 1, observed: 0, validated: 0, omitted: 1 });
      expect(one.complete).toBe(false);
      expect(one.diagnostics).toContain("thread_schema_unavailable");
    }
  });

  contract("an invalid parent scope makes no native calls", async () => {
    for (const parent of [CH_PRIVATE, P.toUpperCase().replace("00000000", "ABCDEFAB")]) {
      const ws = workspace();
      const socket = await socketFor(ws);
      codexRoute(ws, [P]);
      const result = await cli(ws, ["monitor-snapshot", "--recipient", R, "--parent", parent]);
      expect(result.code).toBe(2);
      expect(socket.calls).toEqual([]);
    }
  });

  contract("repeated observations keep the exact dedup identity without delivery", async () => {
    const key = (c: Child) => ["parent_id", "child_id", "turn_id", "error_code"].map((k) => c[k]);
    const first = (await collect(new ChildNative())).one.children[0]!;
    const second = (await collect(new ChildNative())).one.children[0]!;
    expect(key(first)).toEqual(key(second));
    expect(first).not.toHaveProperty("handled");
    const ws = workspace();
    const socket = await socketFor(ws);
    new ChildNative().install(socket);
    codexRoute(ws, [P]);
    const shot = await snapshot(ws, R, []);
    expect(shot.record.worker_health).toEqual({});
    expect(only(socket.calls, CHILD_METHODS)).toEqual([]);
  });

  contract("notLoaded, idle and systemError without a failure are not actionable", async () => {
    for (const status of ["notLoaded", "idle", "systemError"]) {
      const native = new ChildNative();
      native.child.status = { type: status };
      native.turn = turn("completed", null);
      expect((await collect(native)).one.children[0]!.requires_parent_action).toBe(false);
    }
  });
});
