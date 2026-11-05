// delivery-kit command dispatcher. Top-level verbs are game operations; the monitor, claude and
// codex groups take a verb. Every command resolves game-dev from --root (in any position, once),
// DELIVERY_KIT_ROOT or the working directory, in that order.
import { parseArgs } from "node:util";

import { workerParentProblems } from "./bus/parents.ts";
import { channel } from "./commands/channel.ts";
import { monitorAck, monitorSnapshot } from "./commands/monitor.ts";
import { claudeReady, codexReady } from "./commands/ready.ts";
import { request } from "./commands/request.ts";
import { run } from "./commands/run.ts";
import { type Command, GROUPS, SPECS, synopsis } from "./commands/spec.ts";
import { status } from "./commands/status.ts";
import { addressedRoles, loadProjectConfig, type ProjectConfig } from "./config.ts";
import { readJsonIfExists } from "./durable.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "./io.ts";
import { gameLayout, type Layout, loadLayout } from "./layout.ts";
import { resolveRole } from "./registry/resolve.ts";
import { type Registry, validateRegistry } from "./registry/schema.ts";

declare const __DK_VERSION__: string;

export { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "./io.ts";
export const VERSION = typeof __DK_VERSION__ === "string" ? __DK_VERSION__ : "0.0.0-source";

export const COMMANDS = [
  "run",
  "status",
  "check-config",
  "request",
  "monitor snapshot",
  "monitor ack",
  "claude ready",
  "codex ready",
  "claude channel",
] as const satisfies readonly Command[];
export type { Command };

const GROUP_ORDER = ["game", "monitor", "harness"] as const;

/** Help text, generated from each command's parser options and grouped by audience. */
export const USAGE = [
  "usage: delivery-kit COMMAND [options] [--root GAME_DEV_ROOT]",
  ...GROUP_ORDER.flatMap((group) => [
    "",
    `${GROUPS[group][0]?.toUpperCase() ?? ""}${GROUPS[group].slice(1)}:`,
    ...COMMANDS.filter((command) => SPECS[command].group === group).flatMap((command) => [
      ...synopsis(command).map((line) => `  ${line}`),
      `      ${SPECS[command].summary}`,
    ]),
  ]),
  "",
  "--recipient and --parent take a role name resolved through var/registry.json, or a",
  "conversation UUID registered for the active harness. Repeat --parent UUID for each parent.",
  "",
  "  help, --help    print this text",
  "  --version       print the version",
  "",
  "game-dev is --root (in any position, once), else DELIVERY_KIT_ROOT, else the working directory.",
  "",
].join("\n");

/** Removed 1.x command forms and the 2.0.0 form that replaces each. */
const REMOVED: Readonly<Record<string, string>> = {
  channel: "delivery-kit claude channel",
  "monitor-ack": "delivery-kit monitor ack",
  "monitor-snapshot": "delivery-kit monitor snapshot",
  "resource-report": "delivery-kit status --game ID --resources",
};

/** The removed form a command line uses, with its replacement, or undefined. */
function removedForm(args: readonly string[]): string | undefined {
  const [first] = args;
  if (first === undefined) {
    return undefined;
  }
  if (first === "status" && args.includes("--harness")) {
    const harness = args[args.indexOf("--harness") + 1];
    const word = harness === "codex" ? "codex" : "claude";
    return `"status --harness" was removed in 2.0.0; use "delivery-kit ${word} ready"`;
  }
  const replacement = REMOVED[first];
  return replacement === undefined
    ? undefined
    : `"${first}" was removed in 2.0.0; use "${replacement}"`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkGame(
  layout: Layout,
  registry: Registry | undefined,
  rawRegistry: unknown,
  game: string,
): string[] {
  const entry = gameLayout(layout, game);
  let config: ProjectConfig;
  try {
    config = loadProjectConfig(entry.configFile);
  } catch (error) {
    return [errorMessage(error)];
  }
  const problems: string[] = [];
  if (config.reports.project !== entry.name) {
    problems.push(
      `${entry.configFile}: /reports/project must be ${entry.name}, the name in config.json`,
    );
  }
  problems.push(...workerParentProblems(entry.configFile, config, rawRegistry));
  if (registry !== undefined) {
    for (const role of addressedRoles(config)) {
      try {
        resolveRole(registry, role);
      } catch (error) {
        problems.push(`${entry.configFile}: ${errorMessage(error)}`);
      }
    }
  }
  return problems;
}

function checkConfig(io: Io, root: string, args: string[]): number {
  const { values } = parseArgs({ args, options: SPECS["check-config"].options, strict: true });
  let layout: Layout;
  try {
    layout = loadLayout(root);
  } catch (error) {
    io.err(`delivery-kit: ${errorMessage(error)}\n`);
    return EXIT_INVALID;
  }
  const problems: string[] = [];
  let registry: Registry | undefined;
  let rawRegistry: unknown;
  try {
    rawRegistry = readJsonIfExists(layout.registryFile);
    registry = rawRegistry === undefined ? undefined : validateRegistry(layout.config, rawRegistry);
  } catch (error) {
    problems.push(errorMessage(error));
  }
  const games = values.game === undefined ? Object.keys(layout.config.games) : [values.game];
  for (const game of games) {
    if (!Object.hasOwn(layout.config.games, game)) {
      io.err(`delivery-kit: unknown game: ${game}\n`);
      return EXIT_USAGE;
    }
    problems.push(...checkGame(layout, registry, rawRegistry, game));
  }
  if (problems.length > 0) {
    io.err(problems.map((problem) => `delivery-kit: ${problem}\n`).join(""));
    return EXIT_INVALID;
  }
  const registryNote =
    registry === undefined
      ? "registry absent; role names not resolved"
      : `registry revision ${registry.revision}`;
  io.out(
    `delivery-kit: configuration accepted (${games.join(", ") || "no games"}; ${registryNote})\n`,
  );
  return EXIT_OK;
}

const HANDLERS: Readonly<Record<Command, Handler>> = {
  "check-config": checkConfig,
  "claude channel": channel,
  "claude ready": claudeReady,
  "codex ready": codexReady,
  "monitor ack": monitorAck,
  "monitor snapshot": monitorSnapshot,
  request,
  run,
  status,
};

/** Take every `--root DIR` out of the arguments; at most one is allowed. */
function extractRoot(args: string[]): { root?: string; error?: string } {
  const at = args.indexOf("--root");
  if (at < 0) {
    return {};
  }
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) {
    return { error: "--root needs a directory" };
  }
  args.splice(at, 2);
  if (args.includes("--root")) {
    return { error: "--root is given more than once" };
  }
  return { root: value };
}

/** The command a line names: two words for a noun group, otherwise one. */
function commandOf(args: readonly string[]): { command: Command; rest: string[] } | undefined {
  const [first = "", second = ""] = args;
  const pair = `${first} ${second}`;
  if ((COMMANDS as readonly string[]).includes(pair)) {
    return { command: pair as Command, rest: args.slice(2) };
  }
  if ((COMMANDS as readonly string[]).includes(first)) {
    return { command: first as Command, rest: args.slice(1) };
  }
  return undefined;
}

export async function main(io: Io, argv: readonly string[]): Promise<number> {
  const args = [...argv];
  const extracted = extractRoot(args);
  if (extracted.error !== undefined) {
    io.err(`delivery-kit: ${extracted.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const root = extracted.root ?? io.env.DELIVERY_KIT_ROOT ?? io.cwd;
  const [word] = args;
  if (word === "help" || word === "--help") {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (word === "--version") {
    io.out(`${VERSION}\n`);
    return EXIT_OK;
  }
  const removed = removedForm(args);
  if (removed !== undefined) {
    io.err(`delivery-kit: ${removed}\n`);
    return EXIT_USAGE;
  }
  const found = commandOf(args);
  if (found === undefined) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  try {
    return await HANDLERS[found.command](io, root, found.rest);
  } catch (error) {
    io.err(`delivery-kit: ${errorMessage(error)}\n`);
    return EXIT_USAGE;
  }
}
