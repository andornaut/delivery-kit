// runner unit --game ID: print the explicit systemd user unit for one game's resident runner.
// It only prints; installing, enabling and starting the unit stay operator actions.
import { statSync } from "node:fs";

import { EXIT_INVALID, EXIT_OK, type Handler } from "@andornaut/coordination-kit/build/shared";

import { resolveGame } from "../bus/command.ts";
import {
  installedCli,
  renderRunnerUnit,
  resolveTools,
  SUPERVISION_TOOLS,
  unitPath,
  UnitUnavailable,
} from "../bus/supervision.ts";
import { commandUsage, SPECS } from "./spec.ts";

declare const __DK_VERSION__: string;
const VERSION = typeof __DK_VERSION__ === "string" ? __DK_VERSION__ : "0.0.0-source";
const USAGE = commandUsage("runner unit");

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export const runnerUnit: Handler = (io, root, args) => {
  const resolved = resolveGame(io, root, SPECS["runner unit"].options, USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  const { game, layout } = resolved;
  const fail = (message: string): number => {
    io.err(`delivery-kit: runner unit: ${message}\n`);
    return EXIT_INVALID;
  };
  if (!isDirectory(game.repo)) {
    return fail(`the game checkout ${game.repo} is not a directory`);
  }
  const cliPath = installedCli(game.repo);
  if (!isFile(cliPath)) {
    return fail(`${cliPath} is missing; run npm ci in the game checkout first`);
  }
  const tools = resolveTools(io.env);
  if (tools.missing.length > 0) {
    return fail(`required tools not found on PATH: ${tools.missing.join(", ")}`);
  }
  const directories = SUPERVISION_TOOLS.flatMap((tool) => tools.directories[tool] ?? []);
  try {
    io.out(
      renderRunnerUnit({
        cliPath,
        coordinatorRoot: layout.root,
        gameId: game.id,
        gameName: game.name,
        nodePath: process.execPath,
        pathDirectories: unitPath(process.execPath, directories),
        repo: game.repo,
        version: VERSION,
      }),
    );
  } catch (error) {
    if (error instanceof UnitUnavailable) {
      return fail(error.message);
    }
    throw error;
  }
  return EXIT_OK;
};
