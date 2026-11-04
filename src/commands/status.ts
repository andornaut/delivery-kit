// status --game ID: read-only runner, idle and drain report as one JSON line.
// status --harness <claude|codex>: the handoff readiness probe; exit 0 when ready, 1 when not.
import { pyJsonDumps } from "../adapters/shared/pyjson.ts";
import { resolveGame } from "../bus/command.ts";
import { busPaths, pyDumps } from "../bus/state.ts";
import { statusReport } from "../bus/status.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { loadLayout } from "../layout.ts";
import { harnessReadiness } from "../monitor/readiness.ts";
import { readRegistry } from "../registry/store.ts";

const USAGE = "usage: delivery-kit status --game ID | --harness claude|codex";

async function readiness(io: Io, root: string, harness: string | undefined): Promise<number> {
  if (harness !== "claude" && harness !== "codex") {
    io.err(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  const layout = loadLayout(root);
  const report = await harnessReadiness(io.env, layout, readRegistry(layout), harness);
  const ordered = Object.fromEntries([
    ["harness", report.harness],
    [
      "adapter",
      Object.fromEntries([
        ["status", report.adapter.status],
        ["reason", report.adapter.reason],
      ]),
    ],
    [
      "roles",
      report.roles.map((row) =>
        Object.fromEntries([
          ["role", row.role],
          ["conversation", row.conversation],
          ["status", row.status],
        ]),
      ),
    ],
    ["ready", report.ready],
  ]);
  io.out(`${pyJsonDumps(ordered)}\n`);
  return report.ready ? EXIT_OK : EXIT_INVALID;
}

export const status: Handler = (io, root, args) => {
  if (args[0] === "--harness") {
    return readiness(io, root, args.length === 2 ? args[1] : undefined);
  }
  const resolved = resolveGame(io, root, {}, USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  // CI is monitored for every 1.x game: git.remote and git.github are required.
  io.out(`${pyDumps(statusReport(busPaths(resolved.game.busDir), true))}\n`);
  return EXIT_OK;
};
