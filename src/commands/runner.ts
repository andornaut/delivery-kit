// The runner group. `runner unit --game ID` prints the explicit systemd user unit for one game's
// resident runner and installs nothing. `runner stop` and `runner start` stop a game's runner once
// it is idle and drained and start a single instance (src/supervision/lifecycle.ts).
import { statSync } from "node:fs";
import { homedir } from "node:os";

import {
  dumpsJson,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_USAGE,
  type Handler,
} from "@andornaut/coordination-kit/build/shared";

import { VERSION } from "../compatibility.ts";
import { busPaths } from "../state/paths.ts";
import {
  type Lifecycle,
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
import { commandUsage, SPECS } from "./spec.ts";

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

/** The process, systemctl and clock seams; tests replace them. */
export type LifecycleFactory = (paths: ReturnType<typeof busPaths>, repo: string) => Lifecycle;

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
}

export function runnerStopWith(makeLifecycle: LifecycleFactory): Handler {
  const usage = commandUsage("runner stop");
  return async (io, root, args) => {
    const resolved = resolveGame(io, root, SPECS["runner stop"].options, usage, args);
    if (typeof resolved === "number") {
      return resolved;
    }
    const { game, values } = resolved;
    let timeout = STOP_TIMEOUT_SECONDS;
    if (values.timeout !== undefined) {
      const text = String(values.timeout);
      if (!/^[1-9]\d{0,6}$/u.test(text)) {
        io.err(`delivery-kit: --timeout must be a positive whole number of seconds\n${usage}\n`);
        return EXIT_USAGE;
      }
      timeout = Number(text);
    }
    const paths = busPaths(game.busDir);
    const result = await stopRunner(
      makeLifecycle(paths, game.repo),
      { game: game.id, paths, unitFile: unitFile(home(io.env), game.id) },
      timeout,
    );
    io.out(`${dumpsJson(result)}\n`);
    return result.stopped && result.locksFree ? EXIT_OK : EXIT_INVALID;
  };
}

export function runnerStartWith(makeLifecycle: LifecycleFactory): Handler {
  const usage = commandUsage("runner start");
  return async (io, root, args) => {
    const resolved = resolveGame(io, root, SPECS["runner start"].options, usage, args);
    if (typeof resolved === "number") {
      return resolved;
    }
    const { game, layout } = resolved;
    const paths = busPaths(game.busDir);
    try {
      const result = await startRunner(makeLifecycle(paths, game.repo), {
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
      io.out(`${dumpsJson(result)}\n`);
      return EXIT_OK;
    } catch (error) {
      if (error instanceof StartRefused) {
        io.err(`delivery-kit: runner start: ${error.message}\n`);
        return EXIT_INVALID;
      }
      throw error;
    }
  };
}

export const runnerStop: Handler = runnerStopWith(systemLifecycle);
export const runnerStart: Handler = runnerStartWith(systemLifecycle);
