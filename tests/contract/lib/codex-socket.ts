// Fake Codex control socket: a WebSocket JSON-RPC server on a Unix socket, scripted per case.
// Every request is recorded in order; unscripted methods answer a JSON-RPC error.
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import type { Workspace } from "./workspace.ts";

export interface RpcCall {
  method: string;
  params: Record<string, unknown>;
  /** Index into `connections` of the connection that sent the call. */
  connection?: number;
  id?: number;
}

/** A reply: `{result}`, `{error}`, `{hang: true}` (never answer) or `{close: true}` (drop the connection). */
export type Reply =
  | { result: unknown; before?: unknown[] }
  | { error: { code?: number; message: string }; before?: unknown[] }
  | { hang: true }
  | { close: true };

export type Handler = (
  params: Record<string, unknown>,
  call: RpcCall,
  calls: RpcCall[],
) => Reply | unknown;

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  let header: Buffer;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function isReply(value: unknown): value is Reply {
  return (
    typeof value === "object" &&
    value !== null &&
    ("result" in value || "error" in value || "hang" in value || "close" in value)
  );
}

export class CodexSocket {
  readonly path: string;
  readonly calls: RpcCall[] = [];
  readonly connections: number[] = [];
  private readonly handlers = new Map<string, Handler>();
  private server: Server | undefined;

  constructor(ws: Workspace) {
    this.path = join(ws.root, "codex.sock");
    this.on("initialize", () => ({ result: { userAgent: "fake-codex" } }));
  }

  /** Script a method. A plain value is returned as `result`; a Reply object is used as given. */
  on(method: string, handler: Handler | unknown): this {
    this.handlers.set(method, typeof handler === "function" ? (handler as Handler) : () => handler);
    return this;
  }

  /** Answer successive calls of a method with successive replies; the last one repeats. */
  sequence(method: string, replies: unknown[]): this {
    let index = 0;
    return this.on(method, () => replies[Math.min(index++, replies.length - 1)]);
  }

  /** A turn mutation that delivers a bus event (its text carries the `[bus event ID]` suffix). */
  static isEvent(call: RpcCall): boolean {
    const input = call.params.input as Array<{ text?: unknown }> | undefined;
    return (
      call.method.startsWith("turn/") &&
      /\[bus event [0-9a-f]{12}\]/.test(String(input?.[0]?.text ?? ""))
    );
  }

  /** Turn mutations other than bus event deliveries: the scheduled slot requests. */
  slotMutations(): RpcCall[] {
    return this.calls.filter(
      (call) => call.method.startsWith("turn/") && !CodexSocket.isEvent(call),
    );
  }

  /** Connections that delivered a bus event, which 1.0 sends natively to the monitor. */
  eventConnections(): number[] {
    return [
      ...new Set(this.calls.filter(CodexSocket.isEvent).map((call) => call.connection ?? -1)),
    ];
  }

  /** Connections other than those that delivered a bus event. */
  ownConnections(): number {
    return this.connections.length - this.eventConnections().length;
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  callsOf(method: string): RpcCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  async listen(): Promise<this> {
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve) => this.server!.listen(this.path, resolve));
    return this;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    const connection = this.connections.push(Date.now()) - 1;
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 4);
        const key = /Sec-WebSocket-Key:\s*(\S+)/i.exec(head)?.[1] ?? "";
        const accept = createHash("sha1")
          .update(key + GUID)
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        upgraded = true;
      }
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0]! & 0x0f;
        const masked = (buffer[1]! & 0x80) !== 0;
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (masked)
          for (let i = 0; i < payload.length; i++) payload[i]! ^= buffer[maskOffset + (i % 4)]!;
        buffer = buffer.subarray(offset + length);
        if (opcode === 8) {
          socket.end();
          return;
        }
        if (opcode === 1) this.dispatch(socket, payload.toString("utf8"), connection);
      }
    });
  }

  private dispatch(socket: Socket, text: string, connection: number): void {
    const message = JSON.parse(text) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (!message.method) return;
    const call: RpcCall = { method: message.method, params: message.params ?? {} };
    if (message.id !== undefined) call.id = message.id;
    call.connection = connection;
    this.calls.push(call);
    if (message.id === undefined) return;
    const handler = this.handlers.get(message.method);
    const raw = handler
      ? handler(call.params, call, this.calls)
      : { error: { code: -32601, message: `unscripted ${message.method}` } };
    const reply: Reply = isReply(raw) ? raw : { result: raw };
    if ("hang" in reply) return;
    if ("close" in reply) {
      socket.destroy();
      return;
    }
    for (const notification of reply.before ?? [])
      socket.write(frame(JSON.stringify(notification)));
    const body =
      "error" in reply
        ? { id: message.id, error: reply.error }
        : { id: message.id, result: reply.result };
    socket.write(frame(JSON.stringify(body)));
  }
}
