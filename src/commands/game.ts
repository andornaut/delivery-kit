// App selection for commands backed by the coordinator layout and committed delivery-kit.json.
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
import { APP_OPTIONS } from "./spec.ts";

interface ResolvedGame {
  readonly layout: Layout;
  readonly game: GameLayout;
  readonly config: ProjectConfig;
  readonly values: Record<string, string | boolean | undefined>;
}

type Options = NonNullable<ParseArgsConfig["options"]>;

/** Parse a single app selector, keeping the legacy value key for command handlers. */
export function parseAppOptions(options: Options, args: string[]) {
  const {
    tokens,
    values: { app, game, ...values },
  } = parseArgs({ args, options: { ...options, ...APP_OPTIONS }, strict: true, tokens: true });
  const selectors = tokens.filter(
    (token) => token.kind === "option" && (token.name === "app" || token.name === "game"),
  );
  if (app !== undefined && game !== undefined) {
    throw new Error("--app and --game cannot be used together");
  }
  const selector = app === undefined ? "game" : "app";
  if (selectors.length > 1) {
    throw new Error(`--${selector} is given more than once`);
  }
  return { selector, values: { ...values, game: app ?? game } };
}

/** Resolve the app and extra options, or print the problem and return an exit code. */
export function resolveGame(
  io: Io,
  root: string,
  extra: Options,
  usage: string,
  args: string[],
): ResolvedGame | number {
  let parsed: ReturnType<typeof parseAppOptions>;
  try {
    parsed = parseAppOptions(extra, args);
  } catch (error) {
    io.err(`delivery-kit: ${errorMessage(error)}\n${usage}\n`);
    return EXIT_USAGE;
  }
  const { selector, values } = parsed;
  if (values.game === undefined) {
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
    io.err(`delivery-kit: unknown ${selector}: ${values.game}\n`);
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
