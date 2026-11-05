// claude ready and codex ready: the handoff readiness probe for one harness; exit 0 when ready,
// 1 when not.
import { pyJsonDumps } from "../adapters/shared/pyjson.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { type Layout, loadLayout } from "../layout.ts";
import { harnessReadiness } from "../monitor/readiness.ts";
import type { Harness, Registry } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import { commandUsage } from "./spec.ts";

async function readiness(io: Io, root: string, harness: Harness): Promise<number> {
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

function ready(harness: Harness): Handler {
  return (io, root, args) => {
    if (args.length > 0) {
      io.err(`${commandUsage(harness === "claude" ? "claude ready" : "codex ready")}\n`);
      return Promise.resolve(EXIT_USAGE);
    }
    return readiness(io, root, harness);
  };
}

export const claudeReady = ready("claude");
export const codexReady = ready("codex");
