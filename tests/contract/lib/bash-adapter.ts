// CLEANUP (added 2026-11-04): remove once both games run delivery-kit 1.x and have completed one clean departure cycle.
// Bash 0.9.x adapter: renders delivery-kit.json plus the game-dev layout into bus.conf and
// runs the verified v0.9.1 release's bin/delivery-kit (lib/parity.ts) with --config and
// --state-dir. The state directory is the same
// var/games/<g>/bus/ path the Node implementation uses, so file assertions are shared.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Command, Implementation } from "./adapter.ts";
import { BASH_ROOT, PARITY_WHEEL, parityInstalled } from "./parity.ts";
import { type Workspace, writeJson } from "./workspace.ts";

const ENTRY = join(BASH_ROOT, "bin", "delivery-kit");

function quote(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function list(value: unknown, separator: string): unknown {
  return Array.isArray(value) ? value.join(separator) : value;
}

function resolveRole(ws: Workspace, role: unknown): string {
  if (typeof role !== "string") return String(role ?? "");
  return ws.conversation(role) ?? role;
}

/** Render bus.conf. `undefined` JSON values leave the key unset, as an omitted JSON field does. */
export function renderBusConf(ws: Workspace): string {
  const c = ws.config;
  const lines: string[] = [];
  const set = (key: string, value: unknown) => {
    if (value === undefined || ws.omit.includes(key)) return;
    lines.push(`${key}=${quote(value)}`);
  };
  set("REPO", ws.repo);
  set("MAIN", c.git?.main);
  set("REMOTE", c.git?.remote);
  set("GH_SLUG", c.git?.github);
  set("DEPARTURES", list(c.schedule?.departures, " "));
  set("BUS_TIMEZONE", c.schedule?.timezone);
  set("DEPLOY_SKIP_RE", c.deploy?.skipPattern);
  set("NODE_IMAGE", c.gate?.image);
  set("CONTAINER_PREFIX", "fixture-");
  set("CPUS", c.resources?.cpus);
  // 0.9 requires MAX_WORKERS, which 1.0 removes; a 1.0 configuration renders the 0.9 maximum.
  if (c.resources !== undefined) set("MAX_WORKERS", c.resources.maxWorkers ?? 4);
  // 0.9 reads the real /proc/loadavg and has no override, so hostLoad "ignore" renders an
  // unbounded limit; "real" passes resources.loadLimit through.
  set("LOAD_LIMIT", ws.hostLoad === "ignore" ? 1000000 : c.resources?.loadLimit);
  set("GATE_INSTALL", c.gate?.install);
  if (c.gate?.steps !== undefined && !ws.omit.includes("GATE_STEPS")) {
    const steps = Array.isArray(c.gate.steps) ? c.gate.steps : [];
    const rows = steps.map((step: { name?: unknown; run?: unknown }) =>
      quote(`${step.name}|${step.run}`),
    );
    lines.push(`GATE_STEPS=(${rows.join(" ")})`);
  }
  set("DEPLOY_MODE", c.deploy?.mode);
  set("CI_REQUIRED_NAMES", list(c.ci?.requiredNames, "|"));
  set("CI_POLL_SECONDS", c.ci?.pollSeconds);
  set("CI_TIMEOUT_SECONDS", c.ci?.timeoutSeconds);
  set("REPORT_PROJECT", c.reports?.project);
  if (c.reports?.scheduledTicks !== undefined)
    set("REPORT_SCHEDULED_TICKS", c.reports.scheduledTicks ? 1 : 0);
  if (c.reports?.recipient !== undefined) {
    const key = ws.registry().harness === "claude" ? "REPORT_SESSION_ID" : "REPORT_THREAD";
    set(key, resolveRole(ws, c.reports.recipient));
  }
  if (c.reports?.workerParents !== undefined) {
    const parents = Array.isArray(c.reports.workerParents)
      ? c.reports.workerParents
      : [c.reports.workerParents];
    set("WORKER_PARENT_THREADS", parents.map((p) => resolveRole(ws, p)).join(" "));
  }
  if (existsSync(ws.routeFile)) {
    set("MONITOR_ROUTE_FILE", ws.routeFile);
    const wake = ws.gameDevConfig().wakeMinutes;
    set("MONITOR_MINUTES", list(wake, " "));
  }
  set("CODEX_PYTHON", "/usr/bin/python3");
  set("CLAUDE_PYTHON", "/usr/bin/python3");
  return (
    lines.join("\n") +
    "\n" +
    ws.legacyConf +
    (ws.legacyConf.endsWith("\n") || !ws.legacyConf ? "" : "\n")
  );
}

function confPath(ws: Workspace): string {
  return join(ws.root, "bus.conf");
}

function env(ws: Workspace): Record<string, string> {
  // The release's Codex helpers import `websocket`; the parity wheel provides it.
  return { ...ws.baseEnv(), PYTHONPATH: PARITY_WHEEL, ...ws.env };
}

function contextual(ws: Workspace, words: string[]): Command {
  writeFileSync(confPath(ws), renderBusConf(ws));
  writeJson(ws.configFile, ws.config);
  return {
    argv: ["bash", ENTRY, "--config", confPath(ws), "--state-dir", ws.state, ...words],
    cwd: ws.root,
    env: env(ws),
  };
}

export const bashImplementation: Implementation = {
  name: "bash",
  available: parityInstalled
    ? true
    : "the v0.9.1 parity release is not installed (tests/contract/run.sh installs it)",
  help: (ws, word) => ({ argv: ["bash", ENTRY, word], cwd: ws.root, env: env(ws) }),
  command: contextual,
  bare: (ws, words) => ({ argv: ["bash", ENTRY, ...words], cwd: ws.root, env: env(ws) }),
  offer: (ws, branches) => ws.queue(branches),
  checkConfig: (ws) => contextual(ws, ["check-config"]),
  status: (ws) => contextual(ws, ["status"]),
  resourceReport: (ws) => contextual(ws, ["resource-report"]),
  request: (ws, id) => contextual(ws, ["request-once", "--request-id", id]),
  monitorSnapshot: (ws, args) => contextual(ws, ["monitor-snapshot", ...args]),
  monitorAck: (ws, args) => contextual(ws, ["monitor-ack", ...args]),
  run: (ws) => contextual(ws, ["run"]),
  channel: (ws, args) => ({
    argv: ["/usr/bin/python3", join(BASH_ROOT, "libexec", "claude_channel.py"), ...args],
    cwd: ws.root,
    env: env(ws),
  }),
};
