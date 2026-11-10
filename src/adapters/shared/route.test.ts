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
      monitor: { conversation: CLAUDE_GAME_DEV, harness: "claude", role: "game-dev" },
      status: "active",
      targets: [
        { conversation: CLAUDE_TECH, harness: "claude", role: "archies-dog-walks/tech" },
        { conversation: null, harness: "claude", role: "archies-dog-walks/art" },
      ],
    });
    const registry = readRegistry(layout);
    updateRegistry(layout, registry.revision, (draft) => {
      draft.harness = "codex";
    });
    expect(routeScope(readRegistry(layout), route)).toEqual({
      coordinator: CODEX_GAME_DEV,
      harness: "codex",
      harnesses: { [CODEX_GAME_DEV]: "codex", [CODEX_TECH]: "codex" },
      monitorName: "game-dev",
      peers: [CODEX_TECH],
      status: "active",
      targets: [{ harness: "codex", name: "archies-dog-walks/tech", sessionId: CODEX_TECH }],
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

describe("mixed route transports", () => {
  it("keeps the monitor transport independent and resolves changed target overrides at each call", () => {
    const layout = setup(ROUTE);
    const route = readRoleRoute(layout)!;
    const mixed = updateRegistry(layout, 2, (draft) => {
      draft.roles["game-dev"]!.harness = "codex";
    });
    const send = sendRoute(mixed, route, "archies-dog-walks");
    expect(send).toMatchObject({
      harness: "codex",
      monitor: { conversation: CODEX_GAME_DEV, harness: "codex" },
      targets: [
        { conversation: CLAUDE_TECH, harness: "claude" },
        { conversation: null, harness: "claude" },
      ],
    });
    expect(routeScope(mixed, route)).toMatchObject({
      harness: "codex",
      coordinator: CODEX_GAME_DEV,
      harnesses: { [CODEX_GAME_DEV]: "codex", [CLAUDE_TECH]: "claude" },
      targets: [{ harness: "claude", sessionId: CLAUDE_TECH }],
    });
    const changed = updateRegistry(layout, mixed.revision, (draft) => {
      draft.roles["archies-dog-walks/tech"]!.harness = "codex";
    });
    expect(routeScope(changed, route)!.peers).toEqual([CODEX_TECH]);
    expect(routeScope(changed, route)!.harnesses).toEqual({
      [CODEX_GAME_DEV]: "codex",
      [CODEX_TECH]: "codex",
    });
  });

  it("keeps an unavailable selected target null instead of using its inactive ID", () => {
    const layout = setup(ROUTE);
    const registry = updateRegistry(layout, 2, (draft) => {
      draft.roles["archies-dog-walks/tech"]!.harness = "codex";
      draft.roles["archies-dog-walks/tech"]!.conversations.codex = null;
    });
    const scope = routeScope(registry, readRoleRoute(layout)!);
    expect(scope!.targets).toEqual([]);
    expect(scope!.harnesses).toEqual({ [CLAUDE_GAME_DEV]: "claude" });
  });

  it("rejects a cross-harness UUID collision between target and monitor", () => {
    const layout = setup(ROUTE);
    const registry = updateRegistry(layout, 2, (draft) => {
      draft.roles["archies-dog-walks/tech"]!.harness = "codex";
      draft.roles["archies-dog-walks/tech"]!.conversations.codex = CLAUDE_GAME_DEV;
    });
    expect(routeScope(registry, readRoleRoute(layout)!)).toBeNull();
  });

  it("rejects a cross-harness UUID collision between distinct targets", () => {
    const layout = setup(ROUTE);
    const registry = updateRegistry(layout, 2, (draft) => {
      draft.roles["archies-dog-walks/art"] = {
        conversations: { codex: CLAUDE_TECH },
        harness: "codex",
        ownership: "active",
        worktree: ".",
      };
    });
    expect(routeScope(registry, readRoleRoute(layout)!)).toBeNull();
  });

  it("returns no active scope when only an inactive monitor ID exists", () => {
    const layout = setup(ROUTE);
    const registry = updateRegistry(layout, 2, (draft) => {
      draft.roles["game-dev"]!.harness = "codex";
      draft.roles["game-dev"]!.conversations.codex = null;
    });
    expect(routeScope(registry, readRoleRoute(layout)!)).toBeNull();
  });
});
