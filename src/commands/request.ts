// request --game ID --request-id SAFE_ID: an operator-authorized one-off departure of the
// current local main HEAD. It records the request only; the resident runner departs it under
// the same rules as a scheduled departure.
import { resolveGame } from "../bus/command.ts";
import { spawnExec } from "../bus/exec.ts";
import { captureRequest } from "../bus/requests.ts";
import { busPaths } from "../bus/state.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler } from "../io.ts";

const USAGE = "usage: delivery-kit request --game ID --request-id SAFE_ID";

export const request: Handler = async (io, root, args) => {
  const resolved = resolveGame(io, root, { "request-id": { type: "string" } }, USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  const id = resolved.values["request-id"];
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
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_INVALID;
  }
};
