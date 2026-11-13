// Node 1.0 adapter shape: `node dist/cli.js <command> --game <g>` with game-coordinator as the working
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
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Command, Implementation } from "./adapter.ts";
import { KIT_ROOT, SHA, type Workspace, writeJson } from "./workspace.ts";

const CLI = join(KIT_ROOT, "dist", "cli.js");

/**
 * Complete the 1.0 required fields a case leaves out with neutral defaults. Fields a case sets,
 * including deliberately invalid values, pass through unchanged.
 */
export function nodeConfig(ws: Workspace): Record<string, unknown> {
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
    recipient: "game-coordinator",
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
  const base: Record<string, string> = { ...ws.baseEnv(), DELIVERY_KIT_ROOT: ws.coordinator };
  if (ws.hostLoad === "ignore") base.DELIVERY_KIT_TEST_LOADAVG = "0";
  return base;
}

/**
 * A report recipient must resolve through the registry. A case that names none gets the default
 * "game-coordinator" role with a fixture conversation.
 */
function ensureRecipient(ws: Workspace): void {
  if (ws.config.reports?.recipient !== undefined) return;
  const registry = ws.registry();
  if (registry.roles["game-coordinator"]) return;
  ws.writeRegistry({
    ...registry,
    roles: {
      ...registry.roles,
      "game-coordinator": {
        conversations: { [registry.harness]: "00000000-0000-4000-8000-0000000000ff" },
      },
    },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Harness = "claude" | "codex";

/**
 * Register conversation IDs a fixture uses, so 1.0's registry resolves them. An ID already held
 * by a role (under `harness`) keeps that role; others get a shared role named after the ID.
 * Returns the role name of each ID, in order.
 */
export function registerConversations(
  ws: Workspace,
  harness: Harness,
  ids: readonly string[],
): string[] {
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

/**
 * Register again the `c-<id>` roles a route fixture names, for a case that rewrote the registry
 * after writing its route.
 */
function ensureRouteRoles(ws: Workspace): void {
  let route: unknown;
  try {
    route = JSON.parse(readFileSync(ws.routeFile, "utf8"));
  } catch {
    return;
  }
  if (typeof route !== "object" || route === null) return;
  const { targets } = route as { targets?: unknown };
  const names: unknown[] = Array.isArray(targets) ? targets : [];
  const registry = ws.registry();
  const missing = names.filter(
    (name): name is string =>
      typeof name === "string" &&
      name.startsWith("c-") &&
      UUID.test(name.slice(2)) &&
      registry.roles[name] === undefined,
  );
  if (missing.length === 0) return;
  // By exact name: another role may hold the same conversation since the registry was rewritten.
  const roles = { ...registry.roles };
  for (const name of missing)
    roles[name] = { conversations: { [registry.harness]: name.slice(2) } };
  ws.writeRegistry({ ...registry, roles });
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
  ensureRouteRoles(ws);
  registerUsedConversations(ws, words);
  // A noun group (inbox, harness, claude, codex) takes a verb; the other commands are one word.
  const width = ["inbox", "harness", "claude", "codex"].includes(words[0] ?? "") ? 2 : 1;
  const verb = words.slice(0, width);
  const rest = words.slice(width);
  return {
    argv: [process.execPath, CLI, ...verb, "--game", ws.game, ...rest],
    cwd: ws.coordinator,
    env: env(ws),
  };
}

export const nodeImplementation: Implementation = {
  name: "node",
  available: existsSync(CLI) ? true : "dist/cli.js is not built; Node cases are pending",
  help: (ws, word) => ({
    argv: [process.execPath, CLI, word],
    cwd: ws.coordinator,
    env: ws.baseEnv(),
  }),
  command,
  bare: (ws, words) => ({
    argv: [process.execPath, CLI, ...words],
    cwd: ws.coordinator,
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
  run: (ws) => ({ ...command(ws, ["run"]), logFile: join(ws.state, "runner.log") }),
  channel: (ws, args) => ({
    argv: [process.execPath, CLI, "claude", "channel", ...args],
    cwd: ws.coordinator,
    env: env(ws),
  }),
};
