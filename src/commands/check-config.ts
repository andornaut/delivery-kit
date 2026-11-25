// check-config: validate config.json, var/registry.json, var/route.json and each game's
// delivery-kit.json, and report every problem found.
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
  type Layout,
  loadLayout,
  loadProjectConfig,
  type ProjectConfig,
  readJsonIfExists,
} from "@andornaut/coordination-kit/build/shared";

import { errorMessage } from "../lib/values.ts";
import { SPECS } from "./spec.ts";
import { workerParentProblems } from "./worker-parents.ts";

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
  problems.push(...workerParentProblems(rawRegistry, entry.configFile, config));
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
export const checkConfig: Handler = (io, root, args) => {
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
};
