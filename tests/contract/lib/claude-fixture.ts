// Helpers for Claude route, channel and monitor-tick cases: identities, request IDs, a
// scheduled monitor tick driven through the resident runner, and an MCP channel client.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { type Command, impl, type Resident, type Result, start, startRunner } from "./adapter.ts";
import type { CodexSocket } from "./codex-socket.ts";
import type { Workspace } from "./workspace.ts";
import type { Json } from "./json.ts";

export const MONITOR = "00000000-0000-4000-8000-000000000001";
export const ARCHIE = "00000000-0000-4000-8000-000000000002";
export const CHIBI = "00000000-0000-4000-8000-000000000003";

const URL_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** RFC 4122 version 5 UUID in the URL namespace (Python `uuid.uuid5(uuid.NAMESPACE_URL, name)`). */
export function uuid5(name: string): string {
  const namespace = Buffer.from(URL_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(Buffer.concat([namespace, Buffer.from(name, "utf8")]))
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A brief's target line: the registry role key that holds the conversation, and its ID. */
export function briefTarget(ws: Workspace, name: string, id: string): string {
  const registry = ws.registry();
  const role = Object.entries(registry.roles).find(([, r]) => r.conversations.claude === id)?.[0];
  return `${role ?? name}: ${id}`;
}

export const slotRequestId = (monitor: string, slot: number) =>
  uuid5(`hourly-unblock:${monitor}:${slot}`);
export const eventRequestId = (event: string, recipient: string) =>
  uuid5(`bus-event:${event}:${recipient}`);

/** Python `hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()` for string lists. */
export function pythonDigest(values: string[]): string {
  return createHash("sha256")
    .update(`[${values.map((v) => JSON.stringify(v)).join(", ")}]`)
    .digest("hex");
}

export type Agent = Record<string, unknown>;
const OTHER: Agent = {
  id: "x",
  sessionId: ARCHIE,
  kind: "interactive",
  status: "idle",
  name: "other",
  cwd: "/",
  pid: 1,
  startedAt: 0,
};

/** The fake `claude agents --json` listing modes of the original fixture. */
export function agents(
  ws: Workspace,
  mode: "idle" | "busy" | "blocked" | "missing" | "fail" | Agent[],
): void {
  ws.updateControl((control) => {
    if (mode === "fail") control.claude = { exitCode: 3 };
    else if (Array.isArray(mode)) control.claude = { agents: mode };
    else {
      const rows: Record<string, Agent[]> = {
        idle: [{ sessionId: MONITOR, kind: "interactive", status: "idle" }],
        busy: [{ sessionId: MONITOR, kind: "interactive", status: "busy" }],
        blocked: [{ sessionId: MONITOR, kind: "background", state: "blocked" }],
        missing: [],
      };
      control.claude = { agents: [OTHER, ...rows[mode]!] };
    }
  });
}

export function claudeRoute(
  ws: Workspace,
  change: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 2,
    harness: "claude",
    host_project_root: ws.repo,
    state: "active",
    monitor: { session_id: MONITOR, name: "monitor", ownership: "active" },
    targets: [
      { session_id: ARCHIE, name: "Archie tech", ownership: "active" },
      { session_id: ARCHIE, name: "Archie tech", ownership: "active" },
      { session_id: CHIBI, name: "Chibi tech", ownership: "held" },
    ],
    ...change,
  };
}

export function clear(ws: Workspace, recipient = MONITOR, state = "clear"): void {
  ws.write(`unblock/decisions/${recipient}.json`, JSON.stringify({ thread_id: recipient, state }));
}

/** A Claude-harness game: registry roles, a version 2 route, clearance and an idle monitor. */
export function claudeGame(ws: Workspace, options: { recipient?: boolean } = {}): void {
  ws.writeRegistry({
    schema: 1,
    revision: 1,
    harness: "claude",
    roles: {
      monitor: { conversations: { claude: MONITOR } },
      "archie-tech": { conversations: { claude: ARCHIE } },
      "chibi-tech": { conversations: { claude: CHIBI } },
    },
  });
  ws.config.schedule = { departures: ["05"], timezone: "America/Toronto" };
  ws.config.reports = {
    project: "Fixture",
    ...(options.recipient ? { recipient: "monitor" } : {}),
  };
  ws.writeRoute(claudeRoute(ws));
  clear(ws);
  agents(ws, "idle");
}

export function virtualNow(ws: Workspace): number {
  const clock = JSON.parse(readFileSync(ws.clockFile, "utf8")) as {
    epoch: number;
    realStartMs: number;
    speed: number;
  };
  return clock.epoch + ((Date.now() - clock.realStartMs) * clock.speed) / 1000;
}

export interface Tick extends Result {
  /** Parsed `bus: scheduled monitor SLOT: JSON` lines, in order. */
  monitor: Array<{ slot: number; result: Record<string, unknown> }>;
}

function parseMonitor(stdout: string): Tick["monitor"] {
  const rows: Tick["monitor"] = [];
  for (const match of stdout.matchAll(/bus: scheduled monitor (\d+): (\{.*\})/g)) {
    rows.push({ slot: Number(match[1]), result: JSON.parse(match[2]!) as Record<string, unknown> });
  }
  return rows;
}

/**
 * Run the resident runner from 30 virtual seconds before `slot` until the observer reports that
 * slot (or `done` holds), then stop it. The observer dispatches only the current wall minute.
 * Without a report it settles for `settle` virtual seconds, enough for two observer passes.
 */
export async function tick(
  ws: Workspace,
  slot: number,
  options: {
    done?: (out: { stdout: string; stderr: string }) => boolean;
    settle?: number;
    lead?: number;
  } = {},
): Promise<Tick> {
  ws.setClock(slot - (options.lead ?? 30), 60);
  const runner = startRunner(ws);
  let stdout = "";
  let stderr = "";
  runner.child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  runner.child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const done =
    options.done ??
    (() =>
      stdout.includes(`bus: scheduled monitor ${slot}`) ||
      /monitor (deferred|\d+ unavailable)/.test(stderr));
  const settle = slot + (options.settle ?? 150);
  await runner.until(() => done({ stdout, stderr }) || virtualNow(ws) >= settle, 30_000);
  const result = await runner.stop();
  return { ...result, monitor: parseMonitor(result.stdout) };
}

/** Hold a flock on a state file from another process until released. */
export async function holdLock(path: string): Promise<() => Promise<void>> {
  const holder: ChildProcess = spawn(
    "bash",
    ["-c", 'exec 9>>"$1"; flock -n 9 || exit 9; echo held; read -r _', "holder", path],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  await new Promise<void>((resolve, reject) => {
    holder.stdout!.once("data", (chunk: Buffer) =>
      chunk.toString().includes("held") ? resolve() : reject(new Error("lock not held")),
    );
    holder.once("exit", () => reject(new Error("lock holder exited")));
  });
  return async () => {
    holder.stdin!.end();
    await new Promise((resolve) => holder.once("exit", resolve));
  };
}

export type Message = Json;

/** The stdio MCP channel consumer, driven as a Claude Code client would drive it. */
export class Channel {
  readonly resident: Resident;
  readonly messages: Message[] = [];
  private buffer = "";

  constructor(command: Command) {
    this.resident = start(command);
    this.resident.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim()) this.messages.push(JSON.parse(line) as Message);
      }
    });
  }

  static open(ws: Workspace, stateDirs: string[], monitor = MONITOR): Channel {
    const args = ["--monitor", monitor, "--poll-seconds", "0.05"];
    for (const dir of stateDirs) args.push("--state-dir", dir);
    return new Channel(impl.channel(ws, args));
  }

  send(message: Message): void {
    this.resident.child.stdin.write(JSON.stringify(message) + "\n");
  }

  initialize(protocolVersion = "2025-06-18"): void {
    this.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion, capabilities: {} },
    });
  }

  initialized(): void {
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  channel(): Message[] {
    return this.messages.filter((m) => m.method === "notifications/claude/channel");
  }

  async waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    await this.resident.until(predicate, timeoutMs);
  }

  async collect(ms: number): Promise<Message[]> {
    await new Promise((r) => setTimeout(r, ms));
    return this.messages;
  }

  /** Close stdin (end of session) and wait for a clean exit. */
  async close(): Promise<Result> {
    this.resident.child.stdin.end();
    const timer = setTimeout(() => void this.resident.stop(), 5_000);
    const result = await this.resident.done;
    clearTimeout(timer);
    return result;
  }
}

/** Deliver every spooled entry once through a short consumer session, as `deliver_pending` did. */
export async function deliver(
  ws: Workspace,
  stateDirs = [ws.path("unblock")],
  monitor = MONITOR,
): Promise<Message[]> {
  const spool = (dir: string) =>
    existsSync(`${dir}/claude-spool`)
      ? readdirSync(`${dir}/claude-spool`).filter((n) => n.endsWith(".json"))
      : [];
  const channel = Channel.open(ws, stateDirs, monitor);
  channel.initialize();
  channel.initialized();
  await channel.waitFor(
    () => stateDirs.every((dir) => spool(dir).length === 0) && channel.messages.length > 0,
  );
  await channel.collect(200);
  await channel.close();
  return channel.channel();
}

/** The default Codex world of the original fixtures: active coordinator mid-turn, empty history. */
export function codexWorld(
  socket: CodexSocket,
  queues: Record<string, unknown[]> = {},
): CodexSocket {
  return socket
    .on("thread/queue/list", (params: Record<string, unknown>) => ({
      data: queues[String(params.threadId)] ?? [],
      nextCursor: null,
    }))
    .on("thread/read", {
      thread: { status: { type: "active", activeFlags: [] }, canAcceptDirectInput: true },
    })
    .on("thread/turns/list", { data: [{ id: "turn-one", status: "inProgress" }], nextCursor: null })
    .on("thread/items/list", { data: [], nextCursor: null })
    .on("thread/list", { data: [], nextCursor: null })
    .on("turn/steer", { turnId: "turn-one" });
}

/** Distinct thread IDs in first-call order for a method and parameter. */
export function threads(socket: CodexSocket, method: string, key = "threadId"): string[] {
  return [...new Set(socket.callsOf(method).map((call) => String(call.params[key])))];
}
