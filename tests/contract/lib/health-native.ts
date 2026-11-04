// Scripted native responses and CLI drivers for the question and child health
// collectors. Each Native class mirrors the Python mock of the original unit test and is
// served through the fake control socket, so the collectors run inside the real CLI.
import { readFileSync } from "node:fs";
import { afterEach } from "vitest";

import { cli, type Result, startRunner } from "./adapter.ts";
import { CodexSocket, type RpcCall } from "./codex-socket.ts";
import { sleep } from "./time.ts";
import type { Workspace } from "./workspace.ts";

export const P = "00000000-0000-0000-0000-000000000001";
export const C = "00000000-0000-0000-0000-000000000002";
export const OTHER = "00000000-0000-0000-0000-000000000003";
export const N = "00000000-0000-0000-0000-000000000004";
/** Monitor (route coordinator) and an out-of-route recipient that makes no question calls. */
export const M = "00000000-0000-4000-8000-0000000000aa";
export const R = "00000000-0000-4000-8000-0000000000bb";

type Json = Record<string, unknown>;

/** A listening fake control socket per case, closed afterwards. */
export function sockets(): (ws: Workspace) => Promise<CodexSocket> {
  const open: CodexSocket[] = [];
  afterEach(async () => {
    for (const socket of open.splice(0)) await socket.close();
  });
  return async (ws) => {
    const socket = await new CodexSocket(ws).listen();
    open.push(socket);
    ws.env.CODEX_CONTROL_SOCKET = socket.path;
    // The fake Codex control socket serves a Codex registry on 1.0.
    ws.writeRegistry({ ...ws.registry(), harness: "codex" });
    socket.on("thread/queue/list", { data: [], nextCursor: null });
    socket.on("thread/items/list", { data: [], nextCursor: null });
    return socket;
  };
}

/** An active version 1 route: monitor coordinator plus active targets. */
export function codexRoute(ws: Workspace, targets: string[], monitor = M): void {
  // A Codex route runs under a Codex registry; the Node adapter registers its conversations.
  ws.writeRegistry({ ...ws.registry(), harness: "codex" });
  ws.writeRoute({
    version: 1,
    harness: "codex",
    state: "active",
    host_project_root: ws.repo,
    monitor_thread_id: monitor,
    targets: targets.map((thread_id) => ({ thread_id, ownership: "active" })),
  });
}

export function decision(ws: Workspace, recipient: string, record: unknown): void {
  ws.write(`unblock/decisions/${recipient}.json`, JSON.stringify(record));
}

export interface Snapshot {
  result: Result;
  out: Json;
  record: Json;
  text: string;
}

/** Public `monitor-snapshot`; returns stdout JSON and the persisted snapshot record. */
export async function snapshot(
  ws: Workspace,
  recipient: string,
  parents: string[] = [],
): Promise<Snapshot> {
  const result = await cli(
    ws,
    ["monitor-snapshot", "--recipient", recipient, ...parents.flatMap((p) => ["--parent", p])],
    {
      timeoutMs: 60_000,
    },
  );
  let out: Json;
  try {
    out = JSON.parse(result.stdout) as Json;
  } catch {
    throw new Error(
      `snapshot stdout is not JSON\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  const text = typeof out.path === "string" ? readFileSync(out.path, "utf8") : "{}";
  return { result, out, record: JSON.parse(text) as Json, text: text + result.stdout };
}

export interface Scheduled {
  slot: number;
  receipt: Json;
  record: Json;
  health: Json;
  text: string;
}

/**
 * One scheduled monitor slot through the resident runner. The collector compares the slot
 * with the real wall clock, so the virtual slot is the current real minute (lag 0) or an
 * earlier one (lag in seconds). Waits for the slot's health record, then stops the runner.
 */
export async function scheduled(
  ws: Workspace,
  socket: CodexSocket,
  lag = 0,
  prepare: (slot: number) => void = () => undefined,
): Promise<Scheduled> {
  let slot = 0;
  for (;;) {
    const now = Date.now() / 1000;
    const minute = Math.floor(now / 60) * 60;
    if (lag > 0 || now - minute < 40) {
      slot = minute - lag;
      break;
    }
    await sleep((minute + 60 - now) * 1000 + 200);
  }
  prepare(slot);
  const wake = Math.floor(slot / 60) % 60;
  ws.updateGameDevConfig({ wakeMinutes: [wake] });
  ws.config.schedule = {
    departures: [String((wake + 30) % 60).padStart(2, "0")],
    timezone: "America/Toronto",
  };
  ws.env.CODEX_CONTROL_SOCKET = socket.path;
  // Start one virtual minute early so the runner's observer is polling before the slot.
  ws.setClock(slot - 60, 60);
  const runner = startRunner(ws);
  const healthName = `unblock/health/${M}.json`;
  try {
    await runner.until(() => {
      try {
        return (ws.readJson<{ seen_slots?: number[] }>(healthName).seen_slots ?? []).includes(slot);
      } catch {
        return false;
      }
    }, 40_000);
  } finally {
    await runner.stop();
  }
  const receipt = ws.readJson(`unblock/${M}-${slot}.json`);
  const text = readFileSync(String(receipt.snapshot_path), "utf8");
  return { slot, receipt, record: JSON.parse(text) as Json, health: ws.readJson(healthName), text };
}

export function only(calls: RpcCall[], methods: string[]): RpcCall[] {
  return calls.filter((call) => methods.includes(call.method));
}

export function iso(epochSeconds: number, zulu = false): string {
  const text = new Date(epochSeconds * 1000).toISOString();
  return zulu ? text : text.replace("Z", "+00:00");
}

export const clone = <T>(value: T): T => structuredClone(value);

// Question state (tests/test_question_state.py Native).
export const Q_PRIVATE = "PRIVATE_UNRELATED_BODY";

export function question(item = "question", turn = "current", questions?: unknown): Json {
  return {
    turnId: turn,
    item: {
      id: item,
      type: "agentMessage",
      text: Q_PRIVATE,
      questions:
        questions === undefined
          ? [{ title: "Choose a licence", options: ["MIT", "Apache"] }]
          : questions,
    },
  };
}

export function reply(item = "reply", turn = "current"): Json {
  return { turnId: turn, item: { id: item, type: "userMessage", content: [Q_PRIVATE] } };
}

export class QuestionNative {
  pages: Json[];
  latestPages: Json[] | null = null;
  failure: string | null = null;
  waiting = true;
  latest = "current";
  freshLatest: string | null = null;
  updatedAt: unknown = 1;
  contextReads = 0;
  /** Never answer the n-th thread/items/list call (1-based), forcing a client timeout. */
  hangItemsCall = 0;
  private itemsCalls = 0;

  constructor(entries?: Json[]) {
    this.pages = [{ data: entries ?? [question()] }];
  }

  install(socket: CodexSocket): this {
    socket.on("thread/items/list", (params: Json) => {
      this.itemsCalls += 1;
      if (this.hangItemsCall === this.itemsCalls) return { hang: true };
      if (this.failure === "thread/items/list") return { error: { message: Q_PRIVATE } };
      if (params.threadId !== P) return { error: { message: "unscoped recipient" } };
      const index = Number(params.cursor ?? "0");
      const latest = "turnId" in params && this.latestPages !== null;
      const pages = latest ? this.latestPages! : this.pages;
      if (!(index in pages)) return { error: { message: "no such page" } };
      const page = clone(pages[index]!);
      if ("turnId" in params && this.latestPages === null) {
        page.data = (page.data as Json[]).filter(
          (entry) => !("turnId" in entry) || entry.turnId === params.turnId,
        );
      }
      return { result: page };
    });
    socket.on("thread/read", (params: Json) => {
      if (this.failure === "thread/read") return { error: { message: Q_PRIVATE } };
      if (params.threadId !== P || params.includeTurns !== false)
        return { error: { message: "unexpected" } };
      this.contextReads += 1;
      return {
        thread: {
          id: P,
          updatedAt: this.updatedAt,
          status: { type: "active", activeFlags: this.waiting ? ["waitingOnUserInput"] : [] },
        },
      };
    });
    socket.on("thread/turns/list", () => {
      const latest = this.contextReads > 1 && this.freshLatest ? this.freshLatest : this.latest;
      return { data: [{ id: latest, status: "inProgress" }] };
    });
    return this;
  }
}

/** Calls made by the question collector: everything after the snapshot's own history read. */
export function questionCalls(socket: CodexSocket): RpcCall[] {
  const first = socket.calls.findIndex((call) => call.method === "thread/items/list");
  return first < 0 ? [] : socket.calls.slice(first + 1);
}

// Child health (tests/test_child_health.py Native and ScopedNative).
export const CH_PRIVATE = "PRIVATE_NATIVE_BODY";
export const T = "00000000-0000-0000-0000-000000000003";
export const CHILD_METHODS = ["thread/list", "thread/read", "thread/turns/list"];
export const ERROR_CLASSES: Record<string, string> = {
  contextWindowExceeded: "context_exhaustion",
  sessionBudgetExceeded: "session_budget_exhaustion",
  usageLimitExceeded: "usage_limit",
  rateLimitExceeded: "rate_limit",
  flexUnavailable: "flex_capacity",
  serverOverloaded: "server_capacity",
  modelNotFound: "model_unavailable",
  policyCapacityUnavailable: "model_capacity",
};

export function row(child = C, parent = P): Json {
  return {
    id: child,
    parentThreadId: parent,
    source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } },
    status: { type: "idle" },
    updatedAt: 1,
    preview: CH_PRIVATE,
    name: CH_PRIVATE,
    path: CH_PRIVATE,
  };
}

export function turn(
  status = "failed",
  code: unknown = "contextWindowExceeded",
  identifier = T,
): Json {
  return {
    id: identifier,
    status,
    items: [{ text: CH_PRIVATE }],
    error: { codexErrorInfo: code, message: CH_PRIVATE, additionalDetails: CH_PRIVATE },
  };
}

export class ChildNative {
  child: Json = row();
  turn: Json = turn();
  listPages: Record<"false" | "true", Json[]> = {
    false: [{ data: [this.child], nextCursor: null }],
    true: [{ data: [], nextCursor: null }],
  };
  failure: string | null = null;
  hang: string | null = null;
  readCount = 0;
  turnCount = 0;
  freshChild: Json | null = null;
  freshTurn: Json | null = null;
  /** Override the newest-turn page entirely. */
  turnsPage: Json | null = null;

  install(socket: CodexSocket): this {
    socket.on("thread/list", (params: Json) => {
      if (this.hang === "thread/list") return { hang: true };
      if (this.failure === "thread/list") return { error: { message: CH_PRIVATE } };
      if (![P, N].includes(String(params.parentThreadId)))
        return { error: { message: "unexpected parent" } };
      if (params.parentThreadId === N) return { data: [], nextCursor: null };
      const pages = this.listPages[String(params.archived) as "false" | "true"];
      const index = params.cursor === undefined ? 0 : Number(params.cursor);
      if (!(index in pages)) return { error: { message: "no such page" } };
      return clone(pages[index]!);
    });
    socket.on("thread/read", (params: Json) => {
      if (this.failure === "thread/read") return { error: { message: CH_PRIVATE } };
      if (params.threadId !== C || params.includeTurns !== false)
        return { error: { message: "unexpected" } };
      this.readCount += 1;
      return { thread: clone(this.freshChild ?? this.child) };
    });
    socket.on("thread/turns/list", (params: Json) => {
      if (this.failure === "thread/turns/list") return { error: { message: CH_PRIVATE } };
      if (params.threadId !== C) return { error: { message: "unexpected" } };
      this.turnCount += 1;
      if (this.turnsPage) return clone(this.turnsPage);
      const latest = this.turnCount > 1 && this.freshTurn ? this.freshTurn : this.turn;
      return { data: [clone(latest)], nextCursor: "older-private-cursor" };
    });
    return this;
  }
}

export class ScopedNative {
  parents: string[];
  children: Record<string, string[]> = {};
  rows: Record<string, Json> = {};
  turns: Record<string, Json> = {};

  constructor(sizes: number[], failures = 0) {
    const hex = (n: number) => n.toString().padStart(12, "0");
    this.parents = sizes.map((_, n) => `00000000-0000-0000-0001-${hex(n)}`);
    sizes.forEach((size, i) => {
      const parent = this.parents[i]!;
      const children = Array.from(
        { length: size },
        (_, n) => `00000000-0000-0000-0002-${hex(i * 1000 + n)}`,
      );
      this.children[parent] = children;
      children.forEach((child, n) => {
        this.rows[child] = row(child, parent);
        const failed = i === 0 && n < failures;
        this.turns[child] = turn(
          failed ? "failed" : "completed",
          failed ? "serverOverloaded" : null,
          `00000000-0000-0000-0003-${hex(i * 1000 + n)}`,
        );
      });
    });
  }

  install(socket: CodexSocket): this {
    socket.on("thread/list", (params: Json) => {
      const parent = String(params.parentThreadId);
      if (!this.parents.includes(parent)) return { error: { message: "unexpected parent" } };
      const children = params.archived ? [] : this.children[parent]!;
      const start = Number(params.cursor ?? 0);
      const end = start + Number(params.limit);
      return {
        data: children.slice(start, end).map((c) => clone(this.rows[c])),
        nextCursor: end < children.length ? String(end) : null,
      };
    });
    socket.on("thread/read", (params: Json) => {
      const child = String(params.threadId);
      if (!(child in this.rows)) return { error: { message: "unexpected" } };
      return { thread: clone(this.rows[child]) };
    });
    socket.on("thread/turns/list", (params: Json) => {
      const child = String(params.threadId);
      if (!(child in this.turns)) return { error: { message: "unexpected" } };
      return { data: [clone(this.turns[child])], nextCursor: "privateOlderHistory" };
    });
    return this;
  }
}
