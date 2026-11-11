// Readiness probes send nothing and change no registry or activation state.
import { parseArgs } from "node:util";

import { pyJsonDumps } from "../adapters/shared/pyjson.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { type Layout, loadLayout } from "../layout.ts";
import type { Harness, Registry } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import { effectiveReadiness, harnessReadiness, type ReadinessScope } from "../review/readiness.ts";
import { commandUsage, SPECS } from "./spec.ts";

async function readiness(
  io: Io,
  root: string,
  harness: Harness | "mixed",
  scope?: ReadinessScope,
): Promise<number> {
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
  let report;
  try {
    report =
      harness === "mixed"
        ? await effectiveReadiness(io.env, layout, registry, scope)
        : await harnessReadiness(io.env, layout, registry, harness, scope);
  } catch (error) {
    io.err(`delivery-kit: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_INVALID;
  }
  if (report.harness === "mixed") {
    io.out(`${pyJsonDumps(report)}\n`);
    return report.ready ? EXIT_OK : EXIT_INVALID;
  }
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
          ...(scope === undefined
            ? []
            : [
                ["current_harness", row.current_harness],
                ["probed_harness", row.probed_harness],
              ]),
        ]),
      ),
    ],
    ["ready", report.ready],
  ]);
  io.out(`${pyJsonDumps(ordered)}\n`);
  return report.ready ? EXIT_OK : EXIT_INVALID;
}

function ready(harness: Harness | "mixed"): Handler {
  return (io, root, args) => {
    const command =
      harness === "mixed" ? "harness ready" : harness === "claude" ? "claude ready" : "codex ready";
    let values;
    try {
      ({ values } = parseArgs({ args, options: SPECS[command].options, strict: true }));
    } catch (error) {
      io.err(
        `delivery-kit: ${error instanceof Error ? error.message : String(error)}\n${commandUsage(command)}\n`,
      );
      return EXIT_USAGE;
    }
    const { game, role } = values;
    const scope =
      game === undefined && role === undefined
        ? undefined
        : {
            ...(game === undefined ? {} : { games: game }),
            ...(role === undefined ? {} : { roles: role }),
          };
    return readiness(io, root, harness, scope);
  };
}

export const claudeReady = ready("claude");
export const codexReady = ready("codex");
export const harnessReady = ready("mixed");
