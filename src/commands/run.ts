// run --game ID: the resident delivery runner for one game.
import { resolveGame } from "../bus/command.ts";
import { busContext } from "../bus/context.ts";
import { RunnerRefused, runRunner } from "../bus/runner.ts";
import { EXIT_OK, type Handler } from "../io.ts";

const USAGE = "usage: delivery-kit run --game ID";

export const run: Handler = async (io, root, args) => {
  const resolved = resolveGame(io, root, {}, USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  const { config, game, layout } = resolved;
  const controller = new AbortController();
  let exit = EXIT_OK;
  const stop = (code: number) => (): void => {
    exit = code;
    controller.abort();
  };
  const onInt = stop(130);
  const onTerm = stop(143);
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  try {
    await runRunner({ signal: controller.signal }, (startCi) =>
      busContext({ startCi }, layout, game, config),
    );
  } catch (error) {
    if (error instanceof RunnerRefused) {
      io.out(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
  return exit;
};
