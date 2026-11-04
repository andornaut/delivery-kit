// status --game ID: read-only runner, idle and drain report as one JSON line.
import { resolveGame } from "../bus/command.ts";
import { busPaths, pyDumps } from "../bus/state.ts";
import { statusReport } from "../bus/status.ts";
import { EXIT_OK, type Handler } from "../io.ts";

const USAGE = "usage: delivery-kit status --game ID";

export const status: Handler = (io, root, args) => {
  const resolved = resolveGame(io, root, {}, USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  // CI is monitored for every 1.x game: git.remote and git.github are required.
  io.out(`${pyDumps(statusReport(busPaths(resolved.game.busDir), true))}\n`);
  return EXIT_OK;
};
