// request --game ID --id SAFE_ID: an operator-authorized one-off departure of the
// current local main HEAD. It records the request only; the resident runner departs it under
// the same rules as a scheduled departure.
import {
  EXIT_INVALID,
  EXIT_OK,
  EXIT_USAGE,
  type Handler,
} from "@andornaut/coordination-kit/build/shared";

import { spawnExec } from "../lib/exec.ts";
import { captureRequest } from "../runner/requests.ts";
import { busPaths } from "../state/paths.ts";
import { resolveGame } from "./game.ts";
import { commandUsage, SPECS } from "./spec.ts";

const USAGE = commandUsage("request");

export const request: Handler = async (io, root, args) => {
  const resolved = resolveGame(io, root, SPECS.request.options, USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  const id = resolved.values.id;
  if (typeof id !== "string") {
    io.err(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  try {
    const store = {
      exec: spawnExec,
      main: resolved.config.git.main,
      paths: busPaths(resolved.game.busDir),
      repo: resolved.game.repo,
    };
    io.out(await captureRequest(store, id));
    return EXIT_OK;
  } catch (error) {
    io.err(`delivery-kit: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_INVALID;
  }
};
