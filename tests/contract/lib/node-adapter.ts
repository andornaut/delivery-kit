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
// - DELIVERY_KIT_TEST_LOADAVG: a decimal load reading. ws.hostLoad "ignore" sets it to 0;
//   "real" leaves it unset, so the host's load applies.
// - The built package is installed into the game's node_modules with a package-lock entry, so
//   the pin guard sees the installed identity equal to the loaded one.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Command, Implementation } from "./adapter.ts";
import { KIT_ROOT, SHA, type Workspace, writeJson } from "./workspace.ts";

const CLI = join(KIT_ROOT, "dist", "cli.js");

/**
 * Complete the 1.0 required fields a case leaves out with neutral defaults. Fields a case sets,
 * including deliberately invalid values, pass through unchanged.
 */
function nodeConfig(ws: Workspace): Record<string, unknown> {
  const c = structuredClone(ws.config) as Record<string, Record<string, unknown>>;
  const fill = (section: string, defaults: Record<string, unknown>) => {
    c[section] = { ...defaults, ...(c[section] ?? {}) };
    for (const key of Object.keys(c[section]!))
      if (c[section]![key] === undefined) delete c[section]![key];
  };
  fill("ci", { requiredNames: ["Test"], pollSeconds: 60, timeoutSeconds: 1800 });
  fill("reports", {
    project: "Fixture",
    scheduledTicks: false,
    recipient: "monitor",
    workerParents: [],
  });
  // Cases spell "no exclusions" as an empty pattern; the configuration omits the field.
  if (c.deploy?.skipPattern === "") delete c.deploy.skipPattern;
  // A slug is required and CI is always watched; an empty slug becomes the fixture slug.
  if (c.git?.github === "") c.git.github = "fixture/game";
  return c;
}

const PACKAGE = "@andornaut/delivery-kit";

/** Install the built bundle as the game's pinned package, once per workspace. */
function installPackage(ws: Workspace): void {
  const installed = join(ws.repo, "node_modules", PACKAGE);
  if (existsSync(join(installed, "dist", "cli.js"))) return;
  const manifest = JSON.parse(readFileSync(join(KIT_ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  mkdirSync(join(installed, "dist"), { recursive: true });
  copyFileSync(CLI, join(installed, "dist", "cli.js"));
  writeJson(join(installed, "package.json"), {
    name: PACKAGE,
    type: "module",
    version: manifest.version,
  });
  const integrity = `sha512-${createHash("sha512").update(readFileSync(CLI)).digest("base64")}`;
  writeJson(join(ws.repo, "package-lock.json"), {
    lockfileVersion: 3,
    name: ws.game,
    packages: {
      "": { devDependencies: { [PACKAGE]: manifest.version }, name: ws.game },
      [`node_modules/${PACKAGE}`]: { dev: true, integrity, version: manifest.version },
    },
  });
}

function env(ws: Workspace): Record<string, string> {
  const base: Record<string, string> = { ...ws.baseEnv(), DELIVERY_KIT_ROOT: ws.gameDev };
  if (ws.hostLoad === "ignore") base.DELIVERY_KIT_TEST_LOADAVG = "0";
  return base;
}

/**
 * A report recipient must resolve through the registry. A case that names none gets the default
 * "monitor" role with a fixture conversation.
 */
function ensureRecipient(ws: Workspace): void {
  if (ws.config.reports?.recipient !== undefined) return;
  const registry = ws.registry();
  if (registry.roles.monitor) return;
  ws.writeRegistry({
    ...registry,
    roles: {
      ...registry.roles,
      monitor: { conversations: { [registry.harness]: "00000000-0000-4000-8000-0000000000ff" } },
    },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OTHER_GAME = "fixture-other";

type Harness = "claude" | "codex";

/**
 * Register conversation IDs a fixture uses, so 1.0's registry resolves them. An ID already held
 * by a role (under `harness`) keeps that role; others get a shared role named after the ID.
 * Returns the role name of each ID, in order.
 */
function registerConversations(ws: Workspace, harness: Harness, ids: string[]): string[] {
  const registry = ws.registry();
  const roles = { ...registry.roles };
  let changed = false;
  const names = ids.map((id) => {
    const found = Object.entries(roles).find(([, role]) => role.conversations[harness] === id);
    if (found) return found[0];
    const name = `c-${id}`;
    roles[name] = { conversations: { ...(roles[name]?.conversations ?? {}), [harness]: id } };
    changed = true;
    return name;
  });
  if (changed) ws.writeRegistry({ ...registry, roles });
  return names;
}

/** Make a nonhost route's host a real game in config.json. */
function otherGame(ws: Workspace): string {
  const config = ws.gameDevConfig() as { games: Record<string, unknown> };
  if (!config.games[OTHER_GAME]) {
    // A real checkout with a valid delivery-kit.json, so validating every game still passes.
    writeJson(join(ws.root, OTHER_GAME, "delivery-kit.json"), nodeConfig(ws));
    ws.updateGameDevConfig({
      games: {
        ...config.games,
        [OTHER_GAME]: { name: "Other", path: `../${OTHER_GAME}`, roles: ["tech"] },
      },
    });
  }
  return OTHER_GAME;
}

interface Endpoint {
  id: unknown;
  ownership: unknown;
}

/**
 * Translate the case's ID-based route fixture into the role-name route (schema 1): IDs become
 * registered role names, the host project becomes a game key, and held targets are dropped. An
 * invalid fixture (an unknown shape, a noncanonical ID or a conflicting duplicate) is written so
 * the schema check fails.
 */
function applyRoute(ws: Workspace): void {
  const legacy = ws.legacyRoute as Record<string, unknown> | string | undefined;
  if (legacy === undefined) return;
  const invalid = () => writeFileSync(ws.routeFile, JSON.stringify({ schema: 1, invalid: legacy }));
  if (
    typeof legacy === "string" ||
    legacy === null ||
    typeof legacy !== "object" ||
    Array.isArray(legacy)
  ) {
    if (typeof legacy === "string") writeFileSync(ws.routeFile, legacy);
    else invalid();
    return;
  }
  let harness: Harness;
  let monitor: unknown;
  let endpoints: Endpoint[];
  if (legacy.version === 1 && legacy.harness === "codex" && Array.isArray(legacy.targets)) {
    harness = "codex";
    monitor = legacy.monitor_thread_id;
    endpoints = (legacy.targets as Record<string, unknown>[]).map((t) => ({
      id: t?.thread_id,
      ownership: t?.ownership,
    }));
  } else if (
    legacy.version === 2 &&
    legacy.harness === "claude" &&
    Array.isArray(legacy.targets) &&
    typeof legacy.monitor === "object" &&
    legacy.monitor !== null
  ) {
    harness = "claude";
    monitor = (legacy.monitor as Record<string, unknown>).session_id;
    endpoints = (legacy.targets as Record<string, unknown>[]).map((t) => ({
      id: t?.session_id,
      ownership: t?.ownership,
    }));
  } else {
    invalid();
    return;
  }
  const state = legacy.state;
  const ownerships = new Map<unknown, unknown>();
  for (const { id, ownership } of endpoints) {
    if (ownerships.has(id) && ownerships.get(id) !== ownership) return invalid();
    ownerships.set(id, ownership);
  }
  const ids = [...ownerships.keys()];
  const monitorId = monitor === null && state === "held" ? undefined : monitor;
  if (
    (state !== "active" && state !== "held") ||
    ids.some((id) => typeof id !== "string" || !UUID.test(id)) ||
    [...ownerships.values()].some((o) => o !== "active" && o !== "held") ||
    (monitorId !== undefined && (typeof monitorId !== "string" || !UUID.test(monitorId)))
  ) {
    return invalid();
  }
  const active = ids.filter((id) => ownerships.get(id) === "active") as string[];
  let monitorRole: string;
  if (monitorId === undefined) {
    // A held fixture route may name no monitor; the route still names a monitor role.
    monitorRole = "monitor";
    const registry = ws.registry();
    if (!registry.roles.monitor) {
      ws.writeRegistry({
        ...registry,
        roles: { ...registry.roles, monitor: { conversations: {} } },
      });
    }
  } else {
    [monitorRole] = registerConversations(ws, harness, [monitorId as string]) as [string];
  }
  const targets = registerConversations(ws, harness, active);
  const root = legacy.host_project_root ?? legacy.hostProjectRoot;
  const host = root === ws.repo ? ws.game : otherGame(ws);
  writeJson(ws.routeFile, { host, monitor: monitorRole, schema: 1, state, targets });
}

/** Register the conversation IDs a command names (--recipient, --parent) and the process manifest. */
function registerUsedConversations(ws: Workspace, words: string[]): void {
  const harness = ws.registry().harness;
  const ids = new Set<string>();
  words.forEach((word, index) => {
    if ((word === "--recipient" || word === "--parent") && UUID.test(words[index + 1] ?? "")) {
      ids.add(words[index + 1]!);
    }
  });
  if (ids.size) registerConversations(ws, harness, [...ids]);
}

function command(ws: Workspace, words: string[]): Command {
  writeJson(ws.configFile, nodeConfig(ws));
  installPackage(ws);
  ensureRecipient(ws);
  applyRoute(ws);
  registerUsedConversations(ws, words);
  // A noun group (monitor, claude, codex) takes a verb; the other commands are one word.
  const width = ["monitor", "claude", "codex"].includes(words[0] ?? "") ? 2 : 1;
  const verb = words.slice(0, width);
  const rest = words.slice(width);
  return {
    argv: [process.execPath, CLI, ...verb, "--game", ws.game, ...rest],
    cwd: ws.gameDev,
    env: env(ws),
  };
}

export const nodeImplementation: Implementation = {
  name: "node",
  available: existsSync(CLI) ? true : "dist/cli.js is not built; Node cases are pending",
  help: (ws, word) => ({ argv: [process.execPath, CLI, word], cwd: ws.gameDev, env: ws.baseEnv() }),
  command,
  bare: (ws, words) => ({
    argv: [process.execPath, CLI, ...words],
    cwd: ws.gameDev,
    env: ws.baseEnv(),
  }),
  offer: (ws, branches) =>
    ws.updateControl((c) => {
      c.git = { ...c.git, localMain: branches.length ? (c.sha ?? SHA) : ws.remoteHead };
    }),
  checkConfig: (ws) => command(ws, ["check-config"]),
  status: (ws) => command(ws, ["status"]),
  resourceReport: (ws) => command(ws, ["status", "--resources"]),
  request: (ws, id) => command(ws, ["request", "--id", id]),
  monitorSnapshot: (ws, args) => command(ws, ["monitor", "snapshot", ...args]),
  monitorAck: (ws, args) => command(ws, ["monitor", "ack", ...args]),
  run: (ws) => ({ ...command(ws, ["run"]), logFile: join(ws.state, "runner.log") }),
  channel: (ws, args) => ({
    argv: [process.execPath, CLI, "claude", "channel", ...args],
    cwd: ws.gameDev,
    env: env(ws),
  }),
};
