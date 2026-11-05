// `delivery-kit claude channel`: the Claude channel consumer, a stdio MCP server that the monitor session
// launches from game-dev's node_modules. By default it drains every game's spool for the
// registry monitor. `--monitor UUID` and repeatable `--state-dir STATE/unblock` select them
// explicitly. It creates no state directory: only spools that already
// exist are drained, so a channel started before any game state exists leaves var/ untouched.
import { realpathSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { parseArgs } from "node:util";

import { type LineWriter, serve } from "../adapters/claude/channel.ts";
import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { EXIT_INVALID, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { gameLayout, type Layout, loadLayout } from "../layout.ts";
import { MONITOR_ROLE } from "../monitor/wake.ts";
import { resolveConversation } from "../registry/resolve.ts";
import { readRegistry, RegistryMissing } from "../registry/store.ts";
import { SPECS } from "./spec.ts";

export interface ChannelStreams {
  readonly input: NodeJS.ReadableStream;
  readonly write: LineWriter;
}

const DEFAULT_POLL_SECONDS = 5;

class ChannelUsage extends Error {}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Bus directories from explicit STATE/unblock paths, or from every (or each named) game. */
function busDirectories(root: string, stateDirs: string[], games: string[] | undefined): string[] {
  if (stateDirs.length > 0) {
    if (games !== undefined) {
      throw new ChannelUsage("--state-dir and --game are exclusive");
    }
    if (stateDirs.some((dir) => !isAbsolute(dir) || !isDirectory(dir))) {
      throw new ChannelUsage(
        "each --state-dir must name an existing absolute STATE/unblock directory",
      );
    }
    if (new Set(stateDirs.map((dir) => realpathSync(dir))).size !== stateDirs.length) {
      throw new ChannelUsage("each --state-dir must be distinct");
    }
    return stateDirs.map((dir) => dirname(dir));
  }
  const layout: Layout = loadLayout(root);
  const selected = games ?? Object.keys(layout.config.games);
  if (selected.length !== new Set(selected).size) {
    throw new ChannelUsage("each --game may appear once");
  }
  return selected.map((game) => gameLayout(layout, game).busDir);
}

function registryMonitor(root: string): string {
  const layout = loadLayout(root);
  let registry;
  try {
    registry = readRegistry(layout);
  } catch (error) {
    if (error instanceof RegistryMissing) {
      throw new Error(
        `${layout.registryFile} does not exist; create the registry first, or pass --monitor UUID`,
        { cause: error },
      );
    }
    throw error;
  }
  if (registry.harness !== "claude") {
    throw new Error("channel requires the claude harness in var/registry.json");
  }
  const monitor = resolveConversation(registry, MONITOR_ROLE);
  if (monitor === null) {
    throw new Error("the monitor role has no claude conversation");
  }
  return monitor;
}

export async function runChannel(
  streams: ChannelStreams,
  io: Io,
  root: string,
  args: string[],
): Promise<number> {
  let busDirs: string[];
  let monitor: string;
  let pollSeconds: number;
  try {
    const { values } = parseArgs({
      args,
      options: SPECS["claude channel"].options,
      strict: true,
    });
    pollSeconds = Number(values["poll-seconds"] ?? DEFAULT_POLL_SECONDS);
    if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
      throw new ChannelUsage("--poll-seconds must be a positive number");
    }
    if (values.monitor !== undefined && !isCanonicalUuid(values.monitor)) {
      throw new ChannelUsage("--monitor must be a canonical session UUID");
    }
    busDirs = busDirectories(root, values["state-dir"] ?? [], values.game);
    monitor = values.monitor ?? registryMonitor(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`delivery-kit: ${message}\n`);
    return error instanceof ChannelUsage ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
      ? EXIT_USAGE
      : EXIT_INVALID;
  }
  return serve({ pollMs: pollSeconds * 1000 }, streams.input, streams.write, busDirs, monitor);
}

const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/** stdout carries only protocol lines. A synchronous write surfaces a closed channel at once. */
function writeStdoutLine(line: string): void {
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
