// status --app ID [--resources]: the read-only runner, idle and drain report as one JSON line, or
// with --resources the reporting-only resource information.
import { dumpsJson, EXIT_OK, type Handler } from "@andornaut/coordination-kit/build/shared";

import { APP_COORDINATOR_CLI_RANGE } from "../compatibility.ts";
import { testOptions } from "../lib/overrides.ts";
import { busContext } from "../runner/context.ts";
import { resourceReport } from "../runner/resources.ts";
import { busPaths } from "../state/paths.ts";
import { statusReport } from "../status/status.ts";
import { resolveGame } from "./game.ts";
import { commandUsage, SPECS } from "./spec.ts";

const USAGE = commandUsage("status");

export const status: Handler = async (io, root, args) => {
  const resolved = resolveGame(io, root, SPECS.status.options, USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  const { config, game, layout, selector, values } = resolved;
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
  const report = statusReport(
    busPaths(game.busDir),
    game.repo,
    layout.mode === "app" ? APP_COORDINATOR_CLI_RANGE : undefined,
  );
  io.out(`${dumpsJson(selector === "app" ? { ...report, appId: game.id } : report)}\n`);
  return EXIT_OK;
};
