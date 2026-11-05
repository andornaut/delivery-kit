// Test scaffolding for the Claude adapter and monitor: a scratch game-dev with a registry, a
// version 2 route, recipient clearance and a fake `claude` executable. Used only by tests.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type ActiveScope, readRoleRoute, routeScope } from "../adapters/shared/route.ts";
import { type GameLayout, gameLayout, type Layout, loadLayout } from "../layout.ts";
import { createRegistry, readRegistry, type Registry } from "../registry/index.ts";
import { CLAUDE_GAME_DEV, CLAUDE_TECH, makeFixture, registryInput } from "../testFixtures.ts";

export const MONITOR = CLAUDE_GAME_DEV;
export const TECH = CLAUDE_TECH;
export const HELD = "00000000-0000-4000-8000-000000000009";
export const GAME = "archies-dog-walks";
export const SLOT = 1793556000;

export interface ClaudeFixture {
  readonly base: string;
  readonly layout: Layout;
  readonly game: GameLayout;
  readonly unblock: string;
  readonly env: NodeJS.ProcessEnv;
  route(change?: Record<string, unknown>): Record<string, unknown>;
  agents(rows: readonly Record<string, unknown>[] | "fail"): void;
  clear(state?: string): void;
}

/** A role-name route hosted by GAME; HELD has no role, so only the Archie tech target resolves. */
function routeValue(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: GAME,
    monitor: "game-dev",
    schema: 1,
    state: "active",
    targets: ["archies-dog-walks/tech", "chibis-way-home/tech"],
    ...change,
  };
}

export function idle(sessionId: string = MONITOR): Record<string, unknown> {
  return { kind: "interactive", sessionId, status: "idle" };
}

export function claudeFixture(): ClaudeFixture {
  const { base, root } = makeFixture();
  const layout = loadLayout(root);
  createRegistry(layout, registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">);
  const game = gameLayout(layout, GAME);
  const unblock = join(game.busDir, "unblock");
  mkdirSync(join(unblock, "decisions"), { recursive: true });
  const fake = join(base, "fake-claude");
  const listing = join(base, "agents.json");
  writeFileSync(
    fake,
    `#!/bin/sh\n[ "$1 $2" = "agents --json" ] || exit 64\n[ -f "${listing}" ] || exit 3\ncat "${listing}"\n`,
  );
  chmodSync(fake, 0o755);
  const fixture: ClaudeFixture = {
    agents(rows) {
      if (rows === "fail") {
        writeFileSync(listing, "");
        chmodSync(fake, 0o755);
        writeFileSync(fake, "#!/bin/sh\nexit 3\n");
        return;
      }
      writeFileSync(
        fake,
        `#!/bin/sh\n[ "$1 $2" = "agents --json" ] || exit 64\ncat "${listing}"\n`,
      );
      writeFileSync(listing, JSON.stringify(rows));
    },
    base,
    clear(state = "clear") {
      writeFileSync(
        join(unblock, "decisions", `${MONITOR}.json`),
        JSON.stringify({ state, thread_id: MONITOR }),
      );
    },
    env: { CLAUDE_BIN: fake, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    game,
    layout,
    route(change = {}) {
      const value = routeValue(change);
      mkdirSync(layout.varDir, { recursive: true });
      writeFileSync(layout.routeFile, JSON.stringify(value));
      return value;
    },
    unblock,
  };
  fixture.route();
  fixture.agents([idle(), idle(TECH)]);
  fixture.clear();
  return fixture;
}

/** The fixture route resolved through the fixture registry, as a send resolves it. */
export function activeRoute(fixture: ClaudeFixture): ActiveScope {
  const route = readRoleRoute(fixture.layout);
  const scope = route === null ? null : routeScope(readRegistry(fixture.layout), route);
  if (scope === null) {
    throw new Error("fixture route must be active");
  }
  return scope;
}
