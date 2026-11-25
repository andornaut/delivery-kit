// delivery-kit command dispatcher. Every verb is a game operation; the runner group takes a verb.
// Every command resolves game-coordinator from --root (in any position, once), DELIVERY_KIT_ROOT or
// the working directory, in that order.
import { parseArgs } from "node:util";

import {
  type Registry,
  resolveRole,
  validateRegistry,
} from "@andornaut/coordination-kit/build/registry";
import { readRoleRoute, routeRecipient } from "@andornaut/coordination-kit/build/review";
import {
  addressedRoles,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_USAGE,
  gameLayout,
  type Handler,
  type Io,
  type Layout,
  loadLayout,
  loadProjectConfig,
  type ProjectConfig,
  readJsonIfExists,
} from "@andornaut/coordination-kit/build/shared";

import { control } from "./commands/control.ts";
import { request } from "./commands/request.ts";
import { run } from "./commands/run.ts";
import { runnerStart, runnerStop, runnerUnit } from "./commands/runner.ts";
import { type Command, SPECS, synopsis } from "./commands/spec.ts";
import { status } from "./commands/status.ts";
import { workerParentProblems } from "./commands/worker-parents.ts";
import { VERSION } from "./compatibility.ts";
export {
  EXIT_INVALID,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  type Handler,
  type Io,
} from "@andornaut/coordination-kit/build/shared";
export const COMMANDS = [
  "run",
  "runner unit",
  "runner stop",
  "runner start",
  "status",
  "control",
  "check-config",
  "request",
] as const satisfies readonly Command[];
export type { Command };
/** Help text, generated from each command's parser options. */
export const USAGE = [
  "usage: delivery-kit COMMAND [options] [--root COORDINATOR_ROOT]",
  "",
  "Game operations:",
  ...COMMANDS.flatMap((command) => [
    ...synopsis(command).map((line) => `  ${line}`),
    `      ${SPECS[command].summary}`,
  ]),
  "",
  "  help, --help    print this text",
  "  --version       print the version",
  "",
  "game-coordinator is --root (in any position, once), else DELIVERY_KIT_ROOT, else the working directory.",
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
  if (config.reports.project !== undefined && config.reports.project !== entry.name) {
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
/** var/route.json, when present, with its recipient resolved from the host game. */
function checkRoute(layout: Layout): string[] {
  try {
    const route = readRoleRoute(layout);
    if (route !== null) {
      routeRecipient(layout, route);
    }
    return [];
  } catch (error) {
    return [`${layout.routeFile}: ${errorMessage(error)}`];
  }
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
  problems.push(...checkRoute(layout));
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
  control,
  request,
  run,
  "runner start": runnerStart,
  "runner stop": runnerStop,
  "runner unit": runnerUnit,
  status,
};
/** Take every `--root DIR` out of the arguments; at most one is allowed. */
function extractRoot(args: string[]): {
  root?: string;
  error?: string;
} {
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
function commandOf(args: readonly string[]):
  | {
      command: Command;
      rest: string[];
    }
  | undefined {
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
