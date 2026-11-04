// run --game ID: the resident delivery runner for one game.
import { resolveGame } from "../bus/command.ts";
import { busContext } from "../bus/context.ts";
import { RunnerRefused, runRunner } from "../bus/runner.ts";
import { testOptions } from "../bus/testOverrides.ts";
import { EXIT_INVALID, EXIT_OK, type Handler } from "../io.ts";
import { readRegistry, RegistryMissing } from "../registry/store.ts";
import { commandUsage, SPECS } from "./spec.ts";

const USAGE = commandUsage("run");

export const run: Handler = async (io, root, args) => {
  const resolved = resolveGame(io, root, SPECS.run.options, USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  const { config, game, layout } = resolved;
  // A registry with non-canonical conversation IDs stops the runner before any native call;
  // every send still resolves the registry again at send time.
  try {
    readRegistry(layout);
  } catch (error) {
    if (!(error instanceof RegistryMissing)) {
      io.err(`delivery-kit: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_INVALID;
    }
  }
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
      busContext({ ...testOptions(io.env), startCi }, layout, game, config),
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
