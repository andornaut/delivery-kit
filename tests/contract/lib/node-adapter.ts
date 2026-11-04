// Node 1.0 adapter shape: `node dist/cli.js <command> --game <g>` with game-dev as the working
// directory. The CLI resolves config.json, the game's delivery-kit.json and var/ itself.
// Cases are skipped until dist/cli.js exists.
//
// Test hooks the Node implementation must honour (environment overrides, never configuration):
// - DELIVERY_KIT_TEST_CLOCK: JSON file {epoch, realStartMs, speed}, plus optional
//   `clock-offsets` lines in the same directory; virtual seconds = epoch + sum(offsets) +
//   (Date.now() - realStartMs) * speed / 1000. Timers scale by the same speed.
// - CODEX_CONTROL_SOCKET and CLAUDE_AGENTS_COMMAND: adapter overrides (plan: retired keys).
// - PATH supplies fake git, docker, gh, wrangler, claude and codex.
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Command, Implementation } from "./adapter.ts";
import { KIT_ROOT, type Workspace, writeJson } from "./workspace.ts";

const CLI = join(KIT_ROOT, "dist", "cli.js");

/**
 * Complete the 1.0 required fields a case leaves out with neutral defaults. Fields a case sets,
 * including deliberately invalid values, pass through unchanged; `ws.omit` names JSON paths
 * (for example "deploy.mode") a case wants absent.
 */
export function nodeConfig(ws: Workspace): Record<string, unknown> {
  const c = structuredClone(ws.config) as Record<string, Record<string, unknown>>;
  const fill = (section: string, defaults: Record<string, unknown>) => {
    c[section] = { ...defaults, ...(c[section] ?? {}) };
    for (const key of Object.keys(c[section]!)) if (c[section]![key] === undefined) delete c[section]![key];
  };
  fill("ci", { requiredNames: ["Test"], pollSeconds: 60, timeoutSeconds: 1800 });
  fill("reports", { project: "Fixture", scheduledTicks: false, recipient: "monitor", workerParents: [] });
  for (const path of ws.omit) {
    const [section, key] = path.split(".");
    if (section && key && c[section]) delete c[section]![key];
    else if (section) delete c[section];
  }
  return c;
}

function command(ws: Workspace, words: string[]): Command {
  writeJson(ws.configFile, nodeConfig(ws));
  const [verb = "", ...rest] = words;
  return {
    argv: [process.execPath, CLI, verb, "--game", ws.game, ...rest],
    cwd: ws.gameDev,
    env: { ...ws.baseEnv(), DELIVERY_KIT_ROOT: ws.gameDev },
  };
}

export const nodeImplementation: Implementation = {
  name: "node",
  available: existsSync(CLI) ? true : "dist/cli.js is not built; Node cases are pending",
  help: (ws, word) => ({ argv: [process.execPath, CLI, word], cwd: ws.gameDev, env: ws.baseEnv() }),
  command,
  bare: (ws, words) => ({ argv: [process.execPath, CLI, ...words], cwd: ws.gameDev, env: ws.baseEnv() }),
  checkConfig: (ws) => command(ws, ["check-config"]),
  status: (ws) => command(ws, ["status"]),
  resourceReport: (ws) => command(ws, ["resource-report"]),
  request: (ws, id) => command(ws, ["request", "--request-id", id]),
  monitorSnapshot: (ws, args) => command(ws, ["monitor-snapshot", ...args]),
  monitorAck: (ws, args) => command(ws, ["monitor-ack", ...args]),
  run: (ws) => command(ws, ["run"]),
  channel: (ws, args) => ({
    argv: [process.execPath, CLI, "channel", ...args],
    cwd: ws.gameDev,
    env: { ...ws.baseEnv(), DELIVERY_KIT_ROOT: ws.gameDev },
  }),
};
