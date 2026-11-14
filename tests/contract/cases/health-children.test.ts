// Scoped child (worker) health through `inbox snapshot --recipient R --parent ...`
//. R is outside the active route, so only the child
// collector makes scoped native calls; parents must be active route members.
import { expect } from "vitest";

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
});
