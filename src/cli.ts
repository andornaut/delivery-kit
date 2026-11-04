// delivery-kit command dispatcher. Every command resolves game-dev from --root,
// DELIVERY_KIT_ROOT or the working directory, in that order.
import { parseArgs } from "node:util";

import { workerParentProblems } from "./bus/parents.ts";
import { channel } from "./commands/channel.ts";
import { monitorAck, monitorSnapshot } from "./commands/monitor.ts";
import { request } from "./commands/request.ts";
import { resourceReport } from "./commands/resourceReport.ts";
import { run } from "./commands/run.ts";
import { type Command, SPECS, synopsis } from "./commands/spec.ts";
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
  "check-config",
  "request",
  "status",
  "resource-report",
  "channel",
  "monitor-snapshot",
  "monitor-ack",
] as const satisfies readonly Command[];
export type { Command };

/** Help text, generated from each command's parser options. */
export const USAGE = [
  "usage: delivery-kit [--root GAME_DEV_ROOT] COMMAND [options]",
  "",
  "Commands:",
  ...COMMANDS.flatMap((command) => [
    ...synopsis(command).map((line) => `  ${line}`),
    `      ${SPECS[command].summary}`,
  ]),
  "",
  "--recipient and --parent take a role name resolved through var/registry.json, or a",
  "conversation UUID registered for the active harness. Repeat --parent UUID for each parent.",
  "",
  "  help, --help    print this text",
  "  --version       print the version",
  "",
  "game-dev is --root, else DELIVERY_KIT_ROOT, else the working directory.",
  "",
].join("\n");

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
  channel,
  "check-config": checkConfig,
  "monitor-ack": monitorAck,
  "monitor-snapshot": monitorSnapshot,
  request,
  "resource-report": resourceReport,
  run,
  status,
};

export async function main(io: Io, argv: readonly string[]): Promise<number> {
  const args = [...argv];
  let root = io.env.DELIVERY_KIT_ROOT ?? io.cwd;
  if (args[0] === "--root") {
    if (args[1] === undefined) {
      io.err(USAGE);
      return EXIT_USAGE;
    }
    root = args[1];
    args.splice(0, 2);
  }
  const [command, ...rest] = args;
  if (command === "help" || command === "--help") {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (command === "--version") {
    io.out(`${VERSION}\n`);
    return EXIT_OK;
  }
  if (command === undefined || !(COMMANDS as readonly string[]).includes(command)) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  try {
    return await HANDLERS[command as Command](io, root, rest);
  } catch (error) {
    io.err(`delivery-kit: ${errorMessage(error)}\n`);
    return EXIT_USAGE;
  }
}
