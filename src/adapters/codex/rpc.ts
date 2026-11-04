// JSON-RPC over a WebSocket on the local Codex control socket, using only node: builtins.
//
// It connects to ws://localhost/ over the Unix socket, sends
// `initialize` and the `initialized` notification, then matches responses by request id. Server
// notifications and server-initiated requests belong to the existing client and are skipped.
import { createHash, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { performance } from "node:perf_hooks";

import { isRecord } from "../shared/pyjson.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Each socket wait is bounded as well as the whole exchange. */
const STEP_MS = 5000;

export const OPCODE = { binary: 2, close: 8, ping: 9, pong: 10, text: 1 } as const;

export class RpcError extends Error {
  readonly code: unknown;
  readonly staleTurn: boolean;

  constructor(error: unknown) {
    super("native request rejected");
    this.name = "RpcError";
    const record = isRecord(error) ? error : {};
    this.code = record.code;
    const message = typeof record.message === "string" ? record.message : "";
    this.staleTurn = /expectedTurnId.*(?:does not match|mismatch)/i.test(message);
  }
}

export class NativeTimeout extends Error {
  constructor(what: string) {
    super(`native ${what} deadline`);
    this.name = "NativeTimeout";
  }
}

export interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

/** One WebSocket frame. Clients mask their frames; servers do not. */
export function encodeFrame(masked: boolean, opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  if (!masked) {
    return Buffer.concat([header, payload]);
  }
  header[1] = (header[1] ?? 0) | 0x80;
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let index = 0; index < body.length; index += 1) {
    body[index] = (body[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return Buffer.concat([header, mask, body]);
}

/** Splits a byte stream into frames; returns the frames and the unconsumed remainder. */
export function decodeFrames(buffer: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) {
      break;
    }
    const first = buffer[offset] ?? 0;
    const second = buffer[offset + 1] ?? 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) {
        break;
      }
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) {
        break;
      }
      const wide = buffer.readBigUInt64BE(cursor);
      if (wide > BigInt(MAX_MESSAGE_BYTES)) {
        throw new Error("native frame too large");
      }
      length = Number(wide);
      cursor += 8;
    }
    const masked = (second & 0x80) !== 0;
    const maskStart = cursor;
    if (masked) {
      cursor += 4;
    }
    if (buffer.length - cursor < length) {
      break;
    }
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (masked) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (buffer[maskStart + (index % 4)] ?? 0);
      }
    }
    frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
    offset = cursor + length;
  }
  return { frames, rest: Buffer.from(buffer.subarray(offset)) };
}

/** The Sec-WebSocket-Accept value for a handshake key. */
export function acceptKey(key: string): string {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

/** Reassembles text messages from frames and answers pings. */
export class MessageAssembler {
  private fragments: Buffer[] = [];
  private readonly reply: (opcode: number, payload: Buffer) => void;

  constructor(reply: (opcode: number, payload: Buffer) => void) {
    this.reply = reply;
  }

  /** Returns completed messages, or null when the peer closed the connection. */
  accept(frames: readonly Frame[]): string[] | null {
    const messages: string[] = [];
    for (const frame of frames) {
      if (frame.opcode === OPCODE.close) {
        return null;
      }
      if (frame.opcode === OPCODE.ping) {
        this.reply(OPCODE.pong, frame.payload);
      } else if (frame.opcode !== OPCODE.pong) {
        this.fragments.push(frame.payload);
        if (frame.fin) {
          messages.push(Buffer.concat(this.fragments).toString("utf8"));
          this.fragments = [];
        }
      }
    }
    return messages;
  }
}

export interface RpcClient {
  /** Send one request and wait for its response within the client deadline. */
  call(method: string, params: unknown): Promise<unknown>;
  close(): void;
}

interface Handshake {
  readonly key: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

class Connection implements RpcClient {
  private readonly socket: Socket;
  private readonly deadline: number;
  private readonly assembler: MessageAssembler;
  private readonly messages: string[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private open = false;
  private failure: Error | undefined;
  private wake: (() => void) | undefined;
  private sequence = 0;
  private handshake: Handshake | undefined;

  constructor(deadline: number, socket: Socket) {
    this.deadline = deadline;
    this.socket = socket;
    this.assembler = new MessageAssembler((opcode, payload) => this.sendFrame(opcode, payload));
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("native connection closed")));
  }

  upgrade(): Promise<void> {
    const key = randomBytes(16).toString("base64");
    return new Promise((resolve, reject) => {
      this.handshake = { key, reject, resolve };
      this.socket.write(
        [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      if (!this.open) {
        this.finishHandshake();
      }
      if (this.open) {
        const { frames, rest } = decodeFrames(this.buffer);
        this.buffer = rest;
        const messages = this.assembler.accept(frames);
        if (messages === null) {
          this.fail(new Error("native connection closed"));
          return;
        }
        this.messages.push(...messages);
        this.notify();
      }
    } catch (error) {
      this.fail(error as Error);
    }
  }

  private finishHandshake(): void {
    const end = this.buffer.indexOf("\r\n\r\n");
    if (end < 0 || this.handshake === undefined) {
      return;
    }
    const { key, reject, resolve } = this.handshake;
    this.handshake = undefined;
    const head = this.buffer.subarray(0, end).toString("latin1");
    const [status = "", ...headers] = head.split("\r\n");
    this.buffer = Buffer.from(this.buffer.subarray(end + 4));
    const accept = headers
      .map((line) => line.split(/:\s*/, 2))
      .find(([name]) => name?.toLowerCase() === "sec-websocket-accept")?.[1];
    if (!/^HTTP\/1\.1 101\b/.test(status) || accept !== acceptKey(key)) {
      reject(new Error("native upgrade refused"));
      return;
    }
    this.open = true;
    resolve();
  }

  private fail(error: Error): void {
    const failure = this.failure ?? error;
    this.failure = failure;
    if (this.handshake !== undefined) {
      this.handshake.reject(failure);
      this.handshake = undefined;
    }
    this.notify();
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    this.socket.write(encodeFrame(true, opcode, payload));
  }

  private remaining(what: string): number {
    const remaining = this.deadline - performance.now();
    if (remaining <= 0) {
      throw new NativeTimeout(what);
    }
    return Math.min(STEP_MS, remaining);
  }

  send(message: unknown): void {
    this.remaining("request");
    if (this.failure !== undefined) {
      throw this.failure;
    }
    this.sendFrame(OPCODE.text, Buffer.from(JSON.stringify(message), "utf8"));
  }

  private async next(): Promise<string> {
    const waitMs = this.remaining("response");
    const queued = this.messages.shift();
    if (queued !== undefined) {
      return queued;
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
    let timer: NodeJS.Timeout | undefined;
    const woken = await new Promise<boolean>((resolve) => {
      this.wake = () => resolve(true);
      timer = setTimeout(() => resolve(false), waitMs);
    });
    clearTimeout(timer);
    this.wake = undefined;
    if (!woken) {
      throw new NativeTimeout("response");
    }
    return this.next();
  }

  async call(method: string, params: unknown): Promise<unknown> {
    this.sequence += 1;
    const id = this.sequence;
    this.send({ id, method, params });
    for (;;) {
      // Responses arrive one at a time on one connection.
      // eslint-disable-next-line no-await-in-loop
      const message = JSON.parse(await this.next()) as unknown;
      if (typeof message !== "object" || message === null) {
        continue;
      }
      const record = message as Record<string, unknown>;
      if (record.id !== id || "method" in record) {
        continue;
      }
      if ("error" in record) {
        throw new RpcError(record.error);
      }
      return record.result;
    }
  }

  close(): void {
    this.socket.destroy();
  }
}

/** Connect, upgrade and initialize within `deadline` (a performance.now() value). */
export async function connectControl(deadline: number, socketPath: string): Promise<RpcClient> {
  const socket = createConnection({ path: socketPath });
  const connection = new Connection(deadline, socket);
  try {
    const timeout = Math.max(0, Math.min(STEP_MS, deadline - performance.now()));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      connection.upgrade(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new NativeTimeout("connect")), timeout);
      }),
    ]).finally(() => clearTimeout(timer));
    await connection.call("initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: { name: "hourly-unblock", version: "1" },
    });
    connection.send({ method: "initialized" });
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}
