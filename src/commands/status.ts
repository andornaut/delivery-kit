// status --game ID [--resources]: the read-only runner, idle and drain report as one JSON line, or
// with --resources the reporting-only resource information.
import { dumpsJson } from "../adapters/shared/pyjson.ts";
import { resolveGame } from "../bus/command.ts";
import { busContext } from "../bus/context.ts";
import { resourceReport } from "../bus/resources.ts";
import { busPaths } from "../bus/state.ts";
import { statusReport } from "../bus/status.ts";
import { testOptions } from "../bus/testOverrides.ts";
import { EXIT_OK, type Handler } from "../io.ts";
import { commandUsage, SPECS } from "./spec.ts";

const USAGE = commandUsage("status");

export const status: Handler = async (io, root, args) => {
  const resolved = resolveGame(io, root, SPECS.status.options, USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  const { config, game, layout, values } = resolved;
  if (values.resources === true) {
    const context = busContext(
      { ...testOptions(io.env), log: (line) => io.err(`${line}\n`) },
      layout,
      game,
      config,
    );
    io.out(await resourceReport(context));
    return EXIT_OK;
  }
  io.out(`${dumpsJson(statusReport(busPaths(game.busDir), game.repo))}\n`);
  return EXIT_OK;
};
