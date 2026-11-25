// Shared `--game` resolution for the bus commands: game-coordinator config.json, then the game's
// committed delivery-kit.json. Every bus write goes under var/games/<g>/bus/.
import { parseArgs, type ParseArgsConfig } from "node:util";

import {
  EXIT_INVALID,
  EXIT_USAGE,
  type GameLayout,
  gameLayout,
  type Io,
  type Layout,
  loadLayout,
  loadProjectConfig,
  type ProjectConfig,
} from "@andornaut/coordination-kit/build/shared";

import { errorMessage } from "../lib/values.ts";

interface ResolvedGame {
  readonly layout: Layout;
  readonly game: GameLayout;
  readonly config: ProjectConfig;
  readonly values: Record<string, string | boolean | undefined>;
}

type Options = NonNullable<ParseArgsConfig["options"]>;

/** Resolve `--game ID` plus `extra` options, or print the problem and return an exit code. */
export function resolveGame(
  io: Io,
  root: string,
  extra: Options,
  usage: string,
  args: string[],
): ResolvedGame | number {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args, options: { game: { type: "string" }, ...extra }, strict: true })
      .values as Record<string, string | boolean | undefined>;
  } catch (error) {
    io.err(`delivery-kit: ${errorMessage(error)}\n${usage}\n`);
    return EXIT_USAGE;
  }
  if (typeof values.game !== "string") {
    io.err(`${usage}\n`);
    return EXIT_USAGE;
  }
  let layout: Layout;
  try {
    layout = loadLayout(root);
  } catch (error) {
    io.err(`delivery-kit: ${errorMessage(error)}\n`);
    return EXIT_INVALID;
  }
  if (!Object.hasOwn(layout.config.games, values.game)) {
    io.err(`delivery-kit: unknown game: ${values.game}\n`);
    return EXIT_USAGE;
  }
  const game = gameLayout(layout, values.game);
  try {
    return { config: loadProjectConfig(game.configFile), game, layout, values };
  } catch (error) {
    io.err(`delivery-kit: ${errorMessage(error)}\n`);
    return EXIT_INVALID;
  }
}
