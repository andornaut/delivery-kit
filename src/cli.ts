// delivery-kit command dispatcher. The runner command group takes a verb.
// Every command resolves the coordinator from --root, DELIVERY_KIT_ROOT or
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
import { type Command, commandUsage, SPECS, synopsis } from "./commands/spec.ts";
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
  "App operations:",
  ...COMMANDS.flatMap((command) => [
    ...synopsis(command).map((line) => `  ${line}`),
    `      ${SPECS[command].summary}`,
  ]),
  "",
  "  help, --help      print this text",
  "  COMMAND --help    print help for one command",
  "  --version         print the version",
  "",
  "--game ID is a compatibility alias for --app ID.",
  "Set the coordinator root once with --root DIR or --root=DIR before --.",
  "The default is DELIVERY_KIT_ROOT, then the working directory.",
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
/** Extract one global root option before the option terminator. */
function extractRoot(args: string[]): {
  root?: string;
  error?: string;
} {
  let root: string | undefined;
  for (let at = 0; at < args.length; at++) {
    const token = args[at]!;
    if (token === "--") {
      break;
    }
    const separate = token === "--root";
    if (!separate && !token.startsWith("--root=")) {
      continue;
    }
    if (root !== undefined) {
      return { error: "--root is given more than once" };
    }
    const value = separate ? args[at + 1] : token.slice("--root=".length);
    if (value === undefined || value === "" || (separate && value.startsWith("--"))) {
      return { error: "--root needs a directory" };
    }
    root = value;
    args.splice(at, separate ? 2 : 1);
    at--;
  }
  return root === undefined ? {} : { root };
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
    io.err(`delivery-kit: ${extracted.error}\n${USAGE}Hint: Use --root DIR or --root=DIR once.\n`);
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
    io.err(`${USAGE}Hint: Run delivery-kit --help for available commands.\n`);
    return EXIT_USAGE;
  }
  const { command, rest } = found;
  if (rest.length === 1 && rest[0] === "--help") {
    io.out(`${commandUsage(command)}\n\n${SPECS[command].summary}\n`);
    return EXIT_OK;
  }
  let code: number;
  try {
    code = await HANDLERS[command](io, root, rest);
  } catch (error) {
    io.err(`delivery-kit: ${errorMessage(error)}\n`);
    code = EXIT_USAGE;
  }
  if (code === EXIT_USAGE) {
    io.err(`Hint: Run delivery-kit ${command} --help for accepted syntax.\n`);
  }
  return code;
}
