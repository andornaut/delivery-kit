// resource-report --game ID: reporting-only resource information.
import { resolveGame } from "../bus/command.ts";
import { busContext } from "../bus/context.ts";
import { resourceReport as report } from "../bus/resources.ts";
import { testOptions } from "../bus/testOverrides.ts";
import { EXIT_OK, type Handler } from "../io.ts";

const USAGE = "usage: delivery-kit resource-report --game ID";

export const resourceReport: Handler = async (io, root, args) => {
  const resolved = resolveGame(io, root, {}, USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  const { config, game, layout } = resolved;
  const context = busContext(
    { ...testOptions(io.env), log: (line) => io.err(`${line}\n`) },
    layout,
    game,
    config,
  );
  io.out(await report(context));
  return EXIT_OK;
};
