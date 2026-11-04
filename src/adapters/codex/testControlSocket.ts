// A fake Codex control socket for tests: a WebSocket JSON-RPC server on a Unix socket in a scratch
// directory. It answers `initialize` itself, sends an unrelated notification before every
// response so clients must match by id, and records every request and notification it receives.
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { acceptKey, decodeFrames, encodeFrame, MessageAssembler, OPCODE } from "./rpc.ts";

export type FakeReply =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } }
  | { readonly drop: true }
  | { readonly silent: true };

export type FakeHandler = (method: string, params: Record<string, unknown>) => FakeReply;

export interface FakeCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface FakeControl {
  readonly path: string;
  readonly calls: FakeCall[];
  /** Calls other than the initialize handshake. */
  methods(): string[];
  close(): Promise<void>;
}

interface Request {
  readonly id?: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

function frame(socket: Socket, message: unknown): void {
  socket.write(encodeFrame(false, OPCODE.text, Buffer.from(JSON.stringify(message), "utf8")));
}

function answer(socket: Socket, handler: FakeHandler, calls: FakeCall[], text: string): boolean {
  const message = JSON.parse(text) as Request;
  const params = message.params ?? {};
  calls.push({ method: message.method, params });
  if (message.id === undefined) {
    return true;
  }
  const reply = message.method === "initialize" ? { result: {} } : handler(message.method, params);
  if ("drop" in reply) {
    socket.destroy();
    return false;
  }
  if ("silent" in reply) {
    return true;
  }
  frame(socket, { method: "thread/status/changed", params: {} });
  frame(socket, { id: message.id + 1000, result: { unrelated: true } });
  frame(socket, { id: message.id, ...reply });
  return true;
}

function serve(socket: Socket, handler: FakeHandler, calls: FakeCall[]): void {
  let buffer: Buffer = Buffer.alloc(0);
  let open = false;
  const assembler = new MessageAssembler((opcode, payload) =>
    socket.write(encodeFrame(false, opcode, payload)),
  );
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!open) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        return;
      }
      const head = buffer.subarray(0, end).toString("latin1");
      buffer = Buffer.from(buffer.subarray(end + 4));
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${acceptKey(key)}`,
          "",
          "",
        ].join("\r\n"),
      );
      open = true;
    }
    const { frames, rest } = decodeFrames(buffer);
    buffer = rest;
    const messages = assembler.accept(frames);
    if (messages === null) {
      socket.end();
      return;
    }
    for (const text of messages) {
      if (!answer(socket, handler, calls, text)) {
        return;
      }
    }
  });
}

export async function startFakeControl(
  directory: string,
  handler: FakeHandler,
): Promise<FakeControl> {
  const path = join(directory, "control.sock");
  const calls: FakeCall[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serve(socket, handler, calls);
  });
  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });
  return {
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
    methods: () =>
      calls.map((call) => call.method).filter((method) => !method.startsWith("initialize")),
    path,
  };
}
