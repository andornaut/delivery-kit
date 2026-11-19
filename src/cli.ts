// delivery-kit command dispatcher. Every verb is a game operation; the runner group takes a verb.
// The coordination groups moved to coordination-kit and are refused with the equivalent command.
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

import { workerParentProblems } from "./bus/parents.ts";
import { control } from "./commands/control.ts";
import { request } from "./commands/request.ts";
import { run } from "./commands/run.ts";
import { runnerStart, runnerStop, runnerUnit } from "./commands/runner.ts";
import { type Command, SPECS, synopsis } from "./commands/spec.ts";
import { status } from "./commands/status.ts";
declare const __DK_VERSION__: string;
export {
  EXIT_INVALID,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  type Handler,
  type Io,
} from "@andornaut/coordination-kit/build/shared";
export const VERSION = typeof __DK_VERSION__ === "string" ? __DK_VERSION__ : "0.0.0-source";
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
/** The command groups that moved to coordination-kit in 5.0.0, with their known verbs. */
export const MOVED_GROUPS: Readonly<Record<string, readonly string[]>> = {
  claude: ["channel", "ready"],
  codex: ["ready"],
  harness: ["doctor", "ready", "select"],
  inbox: ["ack", "snapshot"],
  ledger: ["apply", "boundary", "coverage", "history", "intake", "reconcile", "report", "show"],
  message: ["dispatch", "reconcile", "retire-spool", "send", "status"],
  protocol: [
    "activate",
    "artifact-put",
    "artifact-read",
    "backup",
    "boundary",
    "claim",
    "declare",
    "dry-run",
    "enroll",
    "enrollment-report",
    "import",
    "import-originals",
    "inbox",
    "intake",
    "inventory",
    "message-observe",
    "message-original",
    "message-publish",
    "message-receipt",
    "message-withdraw",
    "observer-adoption",
    "restore",
    "role",
    "status",
    "work-accept",
    "work-publish",
    "work-read",
    "work-receipt",
    "work-submit",
  ],
};
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
  "The inbox, message, ledger, harness, protocol, claude and codex groups moved to",
  "coordination-kit: run `coordination-kit GROUP VERB ...` with the same options.",
  "",
  "  help, --help    print this text",
  "  --version       print the version",
  "",
  "game-coordinator is --root (in any position, once), else DELIVERY_KIT_ROOT, else the working directory.",
  "",
].join("\n");
/** Removed 1.x command forms and the current form that replaces each. */
const REMOVED: Readonly<Record<string, string>> = {
  channel: "coordination-kit claude channel",
  "monitor-ack": "coordination-kit inbox ack",
  "monitor-snapshot": "coordination-kit inbox snapshot",
  "resource-report": "delivery-kit status --game ID --resources",
};
/** Command forms removed in 3.0.0, with their replacements. */
const REMOVED_3: Readonly<Record<string, string>> = {
  "monitor ack": "coordination-kit inbox ack",
  "monitor snapshot": "coordination-kit inbox snapshot",
};
/** The removed form a command line uses, with its replacement, or undefined. */
function removedForm(args: readonly string[]): string | undefined {
  const [first, second] = args;
  if (first === undefined) {
    return undefined;
  }
  if (first === "monitor") {
    const form = `monitor ${second ?? ""}`.trim();
    const replacement = REMOVED_3[form] ?? "coordination-kit inbox snapshot|ack";
    return `"${form}" was removed in 3.0.0; use "${replacement}"`;
  }
  if (
    first === "claude" &&
    second === "channel" &&
    args.some((arg) => arg === "--monitor" || arg.startsWith("--monitor="))
  ) {
    return '"claude channel --monitor" was removed in 3.0.0; use "coordination-kit claude channel --conversation UUID"';
  }
  if (first === "status" && args.includes("--harness")) {
    const harness = args[args.indexOf("--harness") + 1];
    const word = harness === "codex" ? "codex" : "claude";
    return `"status --harness" was removed in 2.0.0; use "coordination-kit ${word} ready"`;
  }
  return Object.hasOwn(REMOVED, first)
    ? `"${first}" was removed in 2.0.0; use "${REMOVED[first] ?? ""}"`
    : undefined;
}
/** The one-line hint for a command group that moved to coordination-kit, or undefined. */
function movedForm(args: readonly string[]): string | undefined {
  const [first = "", second = ""] = args;
  if (!Object.hasOwn(MOVED_GROUPS, first)) {
    return undefined;
  }
  const verbs = MOVED_GROUPS[first] ?? [];
  const form = verbs.includes(second) ? `${first} ${second}` : first;
  return `\`${form}\` moved to coordination-kit; run \`coordination-kit ${form} ...\``;
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
  const removed = removedForm(args) ?? movedForm(args);
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
