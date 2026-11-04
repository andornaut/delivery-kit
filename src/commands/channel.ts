// `delivery-kit channel`: the Claude channel consumer, a stdio MCP server that the monitor session
// launches from game-dev's node_modules. It drains every game's spool for the registry monitor.
import { mkdirSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";

import { type LineWriter, serve } from "../adapters/claude/channel.ts";
import { EXIT_INVALID, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { gameLayout, loadLayout } from "../layout.ts";
import { MONITOR_ROLE } from "../monitor/wake.ts";
import { resolveConversation } from "../registry/resolve.ts";
import { readRegistry } from "../registry/store.ts";

export interface ChannelStreams {
  readonly input: NodeJS.ReadableStream;
  readonly write: LineWriter;
}

const DEFAULT_POLL_SECONDS = 5;

export async function runChannel(
  streams: ChannelStreams,
  io: Io,
  root: string,
  args: string[],
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { game: { multiple: true, type: "string" }, "poll-seconds": { type: "string" } },
    strict: true,
  });
  const pollSeconds = Number(values["poll-seconds"] ?? DEFAULT_POLL_SECONDS);
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
    io.err("delivery-kit: --poll-seconds must be a positive number\n");
    return EXIT_USAGE;
  }
  const layout = loadLayout(root);
  const games = values.game ?? Object.keys(layout.config.games);
  if (games.length !== new Set(games).size) {
    io.err("delivery-kit: each --game may appear once\n");
    return EXIT_USAGE;
  }
  const busDirs = games.map((game) => gameLayout(layout, game).busDir);
  const registry = readRegistry(layout);
  if (registry.harness !== "claude") {
    io.err("delivery-kit: channel requires the claude harness in var/registry.json\n");
    return EXIT_INVALID;
  }
  const monitor = resolveConversation(registry, MONITOR_ROLE);
  if (monitor === null) {
    io.err("delivery-kit: the monitor role has no claude conversation\n");
    return EXIT_INVALID;
  }
  for (const busDir of busDirs) {
    mkdirSync(busDir, { recursive: true });
  }
  return serve({ pollMs: pollSeconds * 1000 }, streams.input, streams.write, busDirs, monitor);
}

const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/** stdout carries only protocol lines. A synchronous write surfaces a closed channel at once. */
export function writeStdoutLine(line: string): void {
  const bytes = Buffer.from(line, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") {
        throw error;
      }
      Atomics.wait(PAUSE, 0, 0, 10);
    }
  }
}

export const channel: Handler = (io, root, args) =>
  runChannel({ input: process.stdin, write: writeStdoutLine }, io, root, args);
