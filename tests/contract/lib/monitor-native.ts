// Native fixture for monitor cases: queues, history and delivery targets scripted on the fake
// Codex control socket, plus monitor-snapshot and monitor-ack wrappers.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { cli, type Result } from "./adapter.ts";
import { CodexSocket, type Reply } from "./codex-socket.ts";
import type { Workspace } from "./workspace.ts";

import type { Json } from "./json.ts";

export type { Json };

export const TECH = "00000000-0000-0000-0000-000000000001";
export const ART = "00000000-0000-0000-0000-000000000002";

export interface Entry {
  id: string;
  clientUserMessageId: string;
  input: unknown[];
  [key: string]: unknown;
}

export function entry(identity: string): Entry {
  return {
    id: identity,
    clientUserMessageId: "client-" + identity,
    input: [{ type: "text", text: "private payload " + identity }],
  };
}

/** Python `json.dumps(value, sort_keys=True)` with default separators and ASCII escaping. */
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  if (typeof value === "string") {
    return JSON.stringify(value).replace(
      /[\u007f-￿]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
    );
  }
  if (Array.isArray(value)) return "[" + value.map(pyJson).join(", ") + "]";
  const object = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(object)
      .sort()
      .map((key) => pyJson(key) + ": " + pyJson(object[key]))
      .join(", ") +
    "}"
  );
}

export function digest(value: unknown): string {
  return createHash("sha256").update(pyJson(value)).digest("hex");
}

export function payloadSignature(value: Entry): string {
  return digest([value.clientUserMessageId, value.input]);
}

export function retentionName(recipient: string, identity: string): string {
  return join("unblock", "retentions", digest([recipient, identity]) + ".json");
}

export interface NativeOptions {
  monitor?: string;
  targets?: string[];
}

/** Queue, history and target state behind the fake socket, mirroring the Python NativeFixture. */
export class Native {
  readonly socket: CodexSocket;
  queues: Record<string, Entry[]> = { [TECH]: [entry("one"), entry("two")], [ART]: [entry("art")] };
  deleteResult = true;
  /** Answer deletion with a native error (a failed call with unknown outcome). */
  deleteError = false;
  removeOnError = false;
  queueError: Set<string> = new Set();
  beforeDelete: (params: Record<string, unknown>) => void = () => undefined;
  /** thread/items/list handler; the default is an empty complete page. */
  items: (params: Record<string, unknown>) => Reply | unknown = () => ({ data: [] });
  threads: Record<string, unknown> = {};
  turns: Record<string, unknown[]> = {};
  turnCount = 0;

  constructor(ws: Workspace) {
    this.socket = new CodexSocket(ws);
    ws.env.CODEX_CONTROL_SOCKET = this.socket.path;
    this.socket.on("thread/queue/list", (params: Record<string, unknown>) => {
      const thread = String(params.threadId);
      if (this.queueError.has(thread))
        return { error: { code: -32000, message: "PRIVATE_TRANSPORT_BODY" } };
      const offset = Number(params.cursor ?? "0");
      const values = this.queues[thread] ?? [];
      const page: Record<string, unknown> = {
        data: structuredClone(values.slice(offset, offset + 1)),
      };
      if (offset + 1 < values.length) page.nextCursor = String(offset + 1);
      return { result: page };
    });
    this.socket.on("thread/items/list", (params: Record<string, unknown>) => this.items(params));
    this.socket.on("thread/queue/delete", (params: Record<string, unknown>) => {
      this.beforeDelete(params);
      const thread = String(params.threadId);
      const identity = params.queuedSubmissionId;
      if (this.deleteResult || this.removeOnError) {
        this.queues[thread] = (this.queues[thread] ?? []).filter((row) => row.id !== identity);
      }
      if (this.deleteError)
        return { error: { code: -32000, message: "private transport diagnostic" } };
      return { result: { deleted: this.deleteResult } };
    });
    this.socket.on("thread/read", (params: Record<string, unknown>) => {
      const thread = String(params.threadId);
      const value = this.threads[thread];
      if (value === undefined) {
        return {
          result: {
            thread: {
              id: thread,
              canAcceptDirectInput: true,
              status: { type: "idle" },
              updatedAt: 1,
            },
          },
        };
      }
      return typeof value === "function"
        ? (value as (p: unknown) => unknown)(params)
        : { result: value };
    });
    this.socket.on("thread/turns/list", (params: Record<string, unknown>) => ({
      result: {
        data: this.turns[String(params.threadId)] ?? [{ id: "latest-turn", status: "completed" }],
      },
    }));
    this.socket.on("turn/start", () => ({
      result: { turn: { id: `started-${++this.turnCount}` } },
    }));
  }

  async listen(): Promise<this> {
    await this.socket.listen();
    return this;
  }

  close(): Promise<void> {
    return this.socket.close();
  }

  deletions(): Record<string, unknown>[] {
    return this.socket.callsOf("thread/queue/delete").map((call) => call.params);
  }

  /** Reminder texts delivered through turn/start or turn/steer. */
  reminders(): string[] {
    return this.socket.calls
      .filter((call) => call.method === "turn/start" || call.method === "turn/steer")
      .map((call) => {
        const input = call.params.input as Array<{ text: string }>;
        return input[0]!.text;
      });
  }
}

export function writeCodexRoute(
  ws: Workspace,
  change: Record<string, unknown> = {},
  targets = [ART],
): void {
  // A Codex route runs under a Codex registry; the Node adapter registers its conversations.
  if (process.env.DK_IMPL === "node") ws.writeRegistry({ ...ws.registry(), harness: "codex" });
  ws.writeRoute({
    version: 1,
    harness: "codex",
    state: "active",
    host_project_root: ws.repo,
    monitor_thread_id: TECH,
    targets: targets.map((thread_id) => ({ thread_id, ownership: "active" })),
    ...change,
  });
}

/** Recipient-bound decision marker in STATE/unblock/decisions/. */
export function writeDecision(
  ws: Workspace,
  recipient: string,
  marker: Record<string, unknown>,
): void {
  ws.write(join("unblock", "decisions", recipient + ".json"), JSON.stringify(marker));
}

export function clear(ws: Workspace, recipient = TECH): void {
  writeDecision(ws, recipient, { thread_id: recipient, state: "clear" });
}

export interface SnapshotOutput {
  result: Result;
  public: Json;
  file: Json | undefined;
}

export async function snapshot(
  ws: Workspace,
  recipient: string,
  extra: string[] = [],
): Promise<SnapshotOutput> {
  const result = await cli(ws, ["monitor-snapshot", "--recipient", recipient, ...extra]);
  let output: Json = {};
  try {
    output = JSON.parse(result.stdout) as Json;
  } catch {
    // Rejected before output.
  }
  const path = output.path as string | undefined;
  const file =
    path && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Json) : undefined;
  return { result, public: output, file };
}

export async function ack(
  ws: Workspace,
  recipient: string,
  snapshotId: string,
  ids: string[],
  disposition: string,
  reason?: string,
): Promise<{ result: Result; rows: Array<{ queue_id: string; state: string }> | undefined }> {
  const args = ["monitor-ack", "--recipient", recipient, "--snapshot", snapshotId];
  for (const id of ids) args.push("--queue-id", id);
  args.push("--disposition", disposition);
  if (reason !== undefined) args.push("--reason", reason);
  const result = await cli(ws, args);
  let rows;
  try {
    rows = (JSON.parse(result.stdout) as { results?: Array<{ queue_id: string; state: string }> })
      .results;
  } catch {
    rows = undefined;
  }
  return { result, rows };
}

/** The single acknowledgement operation record under STATE/unblock/acks/. */
export function receipt(ws: Workspace): Json {
  const names = ws.list("unblock", "acks").filter((name) => name.endsWith(".json"));
  if (names.length !== 1) throw new Error(`expected one ack record, found ${names.join(",")}`);
  return ws.readJson<Json>(join("unblock", "acks", names[0]!));
}

export function ackFiles(ws: Workspace): string[] {
  return ws.list("unblock", "acks").filter((name) => name.endsWith(".json"));
}

export function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

export function snapshotFiles(ws: Workspace): string[] {
  const dir = ws.path("unblock", "snapshots");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

export function health(ws: Workspace, recipient = TECH): Json {
  return ws.readJson<Json>(join("unblock", "health", recipient + ".json"));
}

export function monitorEvents(ws: Workspace): Array<Record<string, unknown>> {
  return ws.events().filter((event) => event.kind === "monitor-stuck");
}
