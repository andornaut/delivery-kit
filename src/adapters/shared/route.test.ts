import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { type Layout, loadLayout } from "../../layout.ts";
import {
  createRegistry,
  readRegistry,
  type Registry,
  updateRegistry,
} from "../../registry/index.ts";
import {
  CLAUDE_GAME_DEV,
  CLAUDE_TECH,
  CODEX_TECH,
  makeFixture,
  registryInput,
} from "../../testFixtures.ts";
import { readRoleRoute, RouteError, routeScope, sendRoute } from "./route.ts";

const CODEX_GAME_DEV = "00000000-0000-4000-8000-000000000004";

function setup(route: unknown): Layout {
  const layout = loadLayout(makeFixture().root);
  const input = registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">;
  createRegistry(layout, input);
  updateRegistry(layout, 1, (draft) => {
    draft.roles["game-dev"]!.conversations.codex = CODEX_GAME_DEV;
  });
  writeFileSync(layout.routeFile, JSON.stringify(route));
  return layout;
}

const ROUTE = {
  host: "archies-dog-walks",
  monitor: "game-dev",
  schema: 1,
  state: "active",
  targets: ["archies-dog-walks/tech", "archies-dog-walks/art"],
};

describe("role-name route", () => {
  it("resolves roles through the registry's active harness at each call", () => {
    const layout = setup(ROUTE);
    const route = readRoleRoute(layout)!;
    const claude = sendRoute(readRegistry(layout), route, "archies-dog-walks");
    expect(claude).toEqual({
      harness: "claude",
      monitor: { conversation: CLAUDE_GAME_DEV, role: "game-dev" },
      status: "active",
      targets: [
        { conversation: CLAUDE_TECH, role: "archies-dog-walks/tech" },
        { conversation: null, role: "archies-dog-walks/art" },
      ],
    });
    const registry = readRegistry(layout);
    updateRegistry(layout, registry.revision, (draft) => {
      draft.harness = "codex";
    });
    expect(routeScope(readRegistry(layout), route)).toEqual({
      coordinator: CODEX_GAME_DEV,
      monitorName: "game-dev",
      peers: [CODEX_TECH],
      status: "active",
      targets: [{ name: "archies-dog-walks/tech", sessionId: CODEX_TECH }],
    });
  });

  it("returns nonhost and held without resolving", () => {
    const layout = setup({ ...ROUTE, state: "held" });
    const route = readRoleRoute(layout)!;
    expect(sendRoute(readRegistry(layout), route, "chibis-way-home")).toEqual({
      status: "nonhost",
    });
    expect(sendRoute(readRegistry(layout), route, "archies-dog-walks")).toEqual({
      status: "held",
    });
  });

  it("refuses every malformed route", () => {
    const changes: [string, Record<string, unknown>][] = [
      ["a conversation ID as monitor", { monitor: CLAUDE_GAME_DEV }],
      ["an unknown role", { targets: ["archies-dog-walks/qa"] }],
      ["an unknown host", { host: "other-game" }],
      ["the monitor as a target", { targets: ["game-dev"] }],
      ["duplicate targets", { targets: ["art-kit", "art-kit"] }],
      ["an active route without targets", { targets: [] }],
      ["another schema", { schema: 2 }],
      ["a 0.x key", { monitor_thread_id: CLAUDE_GAME_DEV }],
    ];
    for (const [name, change] of changes) {
      const layout = setup({ ...ROUTE, ...change });
      expect(() => readRoleRoute(layout), name).toThrow(RouteError);
    }
  });

  it("is null when no route is declared", () => {
    const layout = loadLayout(makeFixture().root);
    expect(readRoleRoute(layout)).toBeNull();
  });
});
