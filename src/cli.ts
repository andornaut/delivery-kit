// delivery-kit command dispatcher. Every verb is a game operation; the runner group takes a verb.
// Every command resolves game-coordinator from --root (in any position, once), DELIVERY_KIT_ROOT or
// the working directory, in that order.
import {
  EXIT_OK,
  EXIT_USAGE,
  type Handler,
  type Io,
} from "@andornaut/coordination-kit/build/shared";

import { checkConfig } from "./commands/check-config.ts";
import { control } from "./commands/control.ts";
import { request } from "./commands/request.ts";
import { run } from "./commands/run.ts";
import { runnerStart, runnerStop, runnerUnit } from "./commands/runner.ts";
import { type Command, SPECS, synopsis } from "./commands/spec.ts";
import { status } from "./commands/status.ts";
import { VERSION } from "./compatibility.ts";
import { errorMessage } from "./lib/values.ts";
const COMMANDS = [
  "run",
  "runner unit",
  "runner stop",
  "runner start",
  "status",
  "control",
  "check-config",
  "request",
] as const satisfies readonly Command[];
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
