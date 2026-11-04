// status --game ID: read-only runner, idle and drain report as one JSON line.
// status --harness <claude|codex>: the handoff readiness probe; exit 0 when ready, 1 when not.
import { dumpsJson, pyJsonDumps } from "../adapters/shared/pyjson.ts";
import { resolveGame } from "../bus/command.ts";
import { busPaths } from "../bus/state.ts";
import { statusReport } from "../bus/status.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { type Layout, loadLayout } from "../layout.ts";
import { harnessReadiness } from "../monitor/readiness.ts";
import type { Registry } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import { commandUsage, SPECS } from "./spec.ts";

const USAGE = commandUsage("status");

async function readiness(io: Io, root: string, harness: string | undefined): Promise<number> {
  if (harness !== "claude" && harness !== "codex") {
    io.err(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  let layout: Layout;
  let registry: Registry;
  try {
    layout = loadLayout(root);
    registry = readRegistry(layout);
  } catch (error) {
    // A missing registry or an invalid layout means not ready, not a usage error.
    io.err(`delivery-kit: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_INVALID;
  }
  const report = await harnessReadiness(io.env, layout, registry, harness);
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
  // --harness is a separate form, read above; the game form takes --game alone.
  const resolved = resolveGame(io, root, { game: SPECS.status.options.game }, USAGE, args);
  if (typeof resolved === "number") {
    return resolved;
  }
  // CI is monitored for every 1.x game: git.remote and git.github are required.
  io.out(`${dumpsJson(statusReport(busPaths(resolved.game.busDir), true))}\n`);
  return EXIT_OK;
};
