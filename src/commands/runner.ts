// The runner group. `runner unit --game ID` prints the explicit systemd user unit for one game's
// resident runner and installs nothing. `runner stop` and `runner start` stop a game's runner once
// it is idle and drained and start a single instance (src/supervision/lifecycle.ts).
import { homedir } from "node:os";

import {
  dumpsJson,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_USAGE,
  type Handler,
} from "@andornaut/coordination-kit/build/shared";

import { VERSION } from "../compatibility.ts";
import { isDirectory, isFile } from "../lib/files.ts";
import { errorMessage } from "../lib/values.ts";
import { busPaths } from "../state/paths.ts";
import {
  StartRefused,
  startRunner,
  STOP_TIMEOUT_SECONDS,
  stopRunner,
  systemLifecycle,
  unitFile,
} from "../supervision/lifecycle.ts";
import {
  installedCli,
  renderRunnerUnit,
  resolveTools,
  SUPERVISION_TOOLS,
  unitPath,
  UnitUnavailable,
} from "../supervision/unit.ts";
import { resolveGame } from "./game.ts";
import { deliveryOperator } from "./operator.ts";
import { commandUsage, SPECS } from "./spec.ts";

const UNIT_USAGE = commandUsage("runner unit");

function runnerResult<T extends { readonly game: string }>(result: T, selector: "app" | "game") {
  if (selector === "game") {
    return result;
  }
  const { game: appId, ...status } = result;
  return { ...status, appId };
}

export const runnerUnit: Handler = (io, root, args) => {
  const resolved = resolveGame(io, root, SPECS["runner unit"].options, UNIT_USAGE, args);
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

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
}

const STOP_USAGE = commandUsage("runner stop");

/** `--timeout` in seconds: 1 to 9999999, or the default when it is omitted; undefined otherwise. */
export function stopTimeout(value: string | boolean | undefined): number | undefined {
  if (value === undefined) {
    return STOP_TIMEOUT_SECONDS;
  }
  const text = String(value);
  return /^[1-9]\d{0,6}$/u.test(text) ? Number(text) : undefined;
}

export const runnerStop: Handler = async (io, root, args) => {
  const resolved = resolveGame(io, root, SPECS["runner stop"].options, STOP_USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  const { game, layout, selector, values } = resolved;
  const timeout = stopTimeout(values.timeout);
  if (timeout === undefined) {
    io.err(`delivery-kit: --timeout must be a positive whole number of seconds\n${STOP_USAGE}\n`);
    return EXIT_USAGE;
  }
  const paths = busPaths(game.busDir);
  try {
    deliveryOperator(layout, io.env, game.appId);
  } catch (error) {
    io.err(`delivery-kit: runner stop: ${errorMessage(error)}\n`);
    return EXIT_INVALID;
  }
  const result = await stopRunner(
    systemLifecycle(paths, game.repo),
    { game: game.id, paths, unitFile: unitFile(home(io.env), game.id) },
    timeout,
  );
  io.out(`${dumpsJson(runnerResult(result, selector))}\n`);
  return result.stopped && result.locksFree ? EXIT_OK : EXIT_INVALID;
};

const START_USAGE = commandUsage("runner start");

export const runnerStart: Handler = async (io, root, args) => {
  const resolved = resolveGame(io, root, SPECS["runner start"].options, START_USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  const { game, layout, selector } = resolved;
  const paths = busPaths(game.busDir);
  try {
    deliveryOperator(layout, io.env, game.appId, true);
  } catch (error) {
    io.err(`delivery-kit: runner start: ${errorMessage(error)}\n`);
    return EXIT_INVALID;
  }
  try {
    const result = await startRunner(systemLifecycle(paths, game.repo), {
      game: game.id,
      paths,
      spawn: {
        cliPath: installedCli(game.repo),
        coordinatorRoot: layout.root,
        cwd: game.repo,
        env: io.env,
        node: process.execPath,
      },
      unitFile: unitFile(home(io.env), game.id),
    });
    io.out(`${dumpsJson(runnerResult(result, selector))}\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof StartRefused) {
      io.err(`delivery-kit: runner start: ${error.message}\n`);
      return EXIT_INVALID;
    }
    throw error;
  }
};
