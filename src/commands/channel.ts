// `delivery-kit claude channel`: the Claude channel consumer, a stdio MCP server that the recipient
// session launches from game-coordinator's node_modules. By default it drains every game's spool (or each
// `--game`) plus the resolved conversation's generic message spool. `--conversation UUID` and
// repeatable `--state-dir STATE/unblock` select them explicitly. It creates no state directory:
// only spools that already exist are drained, so a channel started before any game state exists
// leaves var/ untouched.
import { realpathSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { parseArgs } from "node:util";

import {
  type ChannelFeed,
  type LineWriter,
  type MessageChannelGuard,
  serve,
} from "../adapters/claude/channel.ts";
import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { gameRecipients } from "../config.ts";
import { EXIT_INVALID, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { gameLayout, type Layout, loadLayout } from "../layout.ts";
import { messageChannelStateDir } from "../messages/paths.ts";
import { messageConsumeGuard } from "../messages/service.ts";
import { acquireProtocolLayout } from "../protocol/layout.ts";
import { captureProtocolSelection, checkProtocolSelection } from "../protocol/selection.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import { readRegistry, RegistryMissing } from "../registry/store.ts";
import { SPECS } from "./spec.ts";

export interface ChannelStreams {
  readonly beforeMessage?: MessageChannelGuard;
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

function sameDirectory(first: string, second: string): boolean {
  return (
    first === second ||
    (isDirectory(first) && isDirectory(second) && realpathSync(first) === realpathSync(second))
  );
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

function refreshFeed(
  root: string,
  conversation: string,
  explicit?: { directory: string; generic: boolean },
): ChannelFeed[] {
  const layout = loadLayout(root);
  const selection = captureProtocolSelection(layout);
  const generic = dirname(messageChannelStateDir(layout, conversation));
  if (explicit?.generic === true && !sameDirectory(explicit.directory, generic)) {
    return [];
  }
  const busDir = explicit?.directory ?? generic;
  return [
    {
      busDir,
      withLease: async (action) => {
        let lease;
        try {
          lease = await acquireProtocolLayout(layout, selection.protocol, {
            allowPending: selection.management.status === "pending",
            expectedManagement: selection.management,
            nonBlocking: true,
          });
        } catch {
          // A busy or changed generation retries only at the next existing poll.
          return true;
        }
        try {
          checkProtocolSelection(layout, selection);
          return await action();
        } finally {
          lease.release();
        }
      },
    },
  ];
}

/** The Claude conversation of the one reports.recipient the selected (or every) game names. */
function recipientConversation(root: string, games: string[] | undefined): string {
  const layout = loadLayout(root);
  const recipients = gameRecipients(layout, games ?? Object.keys(layout.config.games));
  if (recipients.length !== 1) {
    throw new Error(
      `the selected games name ${recipients.length === 0 ? "no" : "different"} ` +
        "reports.recipient roles; select games with one recipient, or pass --conversation UUID",
    );
  }
  const role = recipients[0] as string;
  let registry;
  try {
    registry = readRegistry(layout);
  } catch (error) {
    if (error instanceof RegistryMissing) {
      throw new Error(
        `${layout.registryFile} does not exist; create the registry first, or pass --conversation UUID`,
        { cause: error },
      );
    }
    throw error;
  }
  if (resolveHarness(registry, role) !== "claude") {
    throw new Error(`channel requires the claude harness for the recipient ${role}`);
  }
  const conversation = resolveConversation(registry, role);
  if (conversation === null) {
    throw new Error(`the recipient ${role} has no claude conversation`);
  }
  return conversation;
}

export async function runChannel(
  streams: ChannelStreams,
  io: Io,
  root: string,
  args: string[],
): Promise<number> {
  let busDirs: string[];
  let conversation: string;
  let pollSeconds: number;
  let refreshFeeds: () => readonly ChannelFeed[];
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
    if (values.conversation !== undefined && !isCanonicalUuid(values.conversation)) {
      throw new ChannelUsage("--conversation must be a canonical session UUID");
    }
    conversation = values.conversation ?? recipientConversation(root, values.game);
    const explicit = values["state-dir"] ?? [];
    busDirs = busDirectories(root, explicit, values.game);
    if (explicit.length === 0) {
      refreshFeeds = () => refreshFeed(root, conversation);
    } else {
      const generic = dirname(messageChannelStateDir(loadLayout(root), conversation));
      const layout = loadLayout(root);
      const games = Object.keys(layout.config.games).map((game) => gameLayout(layout, game).busDir);
      const gameFeed = (directory: string) => games.some((game) => sameDirectory(directory, game));
      const fixed = busDirs
        .filter((directory) => !gameFeed(directory))
        .map((directory) => ({ directory, generic: sameDirectory(directory, generic) }));
      refreshFeeds = () => fixed.flatMap((feed) => refreshFeed(root, conversation, feed));
      busDirs = busDirs.filter(gameFeed);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`delivery-kit: ${message}\n`);
    return error instanceof ChannelUsage ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
      ? EXIT_USAGE
      : EXIT_INVALID;
  }
  return serve(
    {
      beforeMessage: streams.beforeMessage ?? messageConsumeGuard(loadLayout(root), io.env),
      pollMs: pollSeconds * 1000,
      refreshFeeds,
    },
    streams.input,
    streams.write,
    busDirs,
    conversation,
  );
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
