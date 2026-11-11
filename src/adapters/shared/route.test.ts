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
import {
  readRoleRoute,
  ROUTE_SCHEMA_1,
  RouteError,
  routeRecipient,
  routeScope,
  sendRoute,
} from "./route.ts";

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
  schema: 2,
  state: "active",
  targets: ["archies-dog-walks/tech", "archies-dog-walks/art"],
};

describe("role-name route", () => {
  it("resolves roles through the registry's active harness at each call", () => {
    const layout = setup(ROUTE);
    const route = readRoleRoute(layout)!;
    expect(routeRecipient(layout, route)).toBe("game-dev");
    const claude = sendRoute(readRegistry(layout), "game-dev", route, "archies-dog-walks");
    expect(claude).toEqual({
      harness: "claude",
      recipient: { conversation: CLAUDE_GAME_DEV, harness: "claude", role: "game-dev" },
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
    expect(routeScope(readRegistry(layout), "game-dev", route)).toEqual({
      harness: "codex",
      harnesses: { [CODEX_GAME_DEV]: "codex", [CODEX_TECH]: "codex" },
      peers: [CODEX_TECH],
      recipient: CODEX_GAME_DEV,
      recipientRole: "game-dev",
      status: "active",
      targets: [{ harness: "codex", name: "archies-dog-walks/tech", sessionId: CODEX_TECH }],
    });
  });

  it("returns nonhost and held without resolving", () => {
    const layout = setup({ ...ROUTE, state: "held" });
    const route = readRoleRoute(layout)!;
    expect(sendRoute(readRegistry(layout), "game-dev", route, "chibis-way-home")).toEqual({
      status: "nonhost",
    });
    expect(sendRoute(readRegistry(layout), "game-dev", route, "archies-dog-walks")).toEqual({
      status: "held",
    });
  });

  it("refuses every malformed route", () => {
    const changes: [string, Record<string, unknown>][] = [
      ["an unknown role", { targets: ["archies-dog-walks/qa"] }],
      ["an unknown host", { host: "other-game" }],
      ["duplicate targets", { targets: ["art-kit", "art-kit"] }],
      ["an active route without targets", { targets: [] }],
      ["another schema", { schema: 3 }],
      ["an unknown key", { recipient: "game-dev" }],
    ];
    for (const [name, change] of changes) {
      const layout = setup({ ...ROUTE, ...change });
      expect(() => readRoleRoute(layout), name).toThrow(RouteError);
    }
  });

  it("names the exact edit for a schema 1 route", () => {
    const legacy = [
      { ...ROUTE, monitor: "game-dev", schema: 1 },
      { ...ROUTE, schema: 1 },
      { ...ROUTE, monitor: "game-dev" },
    ];
    for (const route of legacy) {
      expect(() => readRoleRoute(setup(route))).toThrow(ROUTE_SCHEMA_1);
    }
    expect(ROUTE_SCHEMA_1).toContain('remove "monitor" and set "schema" to 2');
  });

  it("refuses an active route that targets its recipient", () => {
    const layout = setup({ ...ROUTE, targets: ["game-dev", "archies-dog-walks/tech"] });
    const route = readRoleRoute(layout)!;
    expect(() => routeRecipient(layout, route)).toThrow(
      "active route targets must not include the recipient game-dev",
    );
  });

  it("is null when no route is declared", () => {
    const layout = loadLayout(makeFixture().root);
    expect(readRoleRoute(layout)).toBeNull();
  });
});

describe("mixed route transports", () => {
  it("keeps the recipient transport independent and resolves changed target overrides at each call", () => {
    const layout = setup(ROUTE);
    const route = readRoleRoute(layout)!;
    const mixed = updateRegistry(layout, 2, (draft) => {
      draft.roles["game-dev"]!.harness = "codex";
    });
    const send = sendRoute(mixed, "game-dev", route, "archies-dog-walks");
    expect(send).toMatchObject({
      harness: "codex",
      recipient: { conversation: CODEX_GAME_DEV, harness: "codex" },
      targets: [
        { conversation: CLAUDE_TECH, harness: "claude" },
        { conversation: null, harness: "claude" },
      ],
    });
    expect(routeScope(mixed, "game-dev", route)).toMatchObject({
      harness: "codex",
      harnesses: { [CODEX_GAME_DEV]: "codex", [CLAUDE_TECH]: "claude" },
      recipient: CODEX_GAME_DEV,
      targets: [{ harness: "claude", sessionId: CLAUDE_TECH }],
    });
    const changed = updateRegistry(layout, mixed.revision, (draft) => {
      draft.roles["archies-dog-walks/tech"]!.harness = "codex";
    });
    expect(routeScope(changed, "game-dev", route)!.peers).toEqual([CODEX_TECH]);
    expect(routeScope(changed, "game-dev", route)!.harnesses).toEqual({
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
    const scope = routeScope(registry, "game-dev", readRoleRoute(layout)!);
    expect(scope!.targets).toEqual([]);
    expect(scope!.harnesses).toEqual({ [CLAUDE_GAME_DEV]: "claude" });
  });

  it("rejects a cross-harness UUID collision between target and recipient", () => {
    const layout = setup(ROUTE);
    const registry = updateRegistry(layout, 2, (draft) => {
      draft.roles["archies-dog-walks/tech"]!.harness = "codex";
      draft.roles["archies-dog-walks/tech"]!.conversations.codex = CLAUDE_GAME_DEV;
    });
    expect(routeScope(registry, "game-dev", readRoleRoute(layout)!)).toBeNull();
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
    expect(routeScope(registry, "game-dev", readRoleRoute(layout)!)).toBeNull();
  });

  it("returns no active scope when only an inactive recipient ID exists", () => {
    const layout = setup(ROUTE);
    const registry = updateRegistry(layout, 2, (draft) => {
      draft.roles["game-dev"]!.harness = "codex";
      draft.roles["game-dev"]!.conversations.codex = null;
    });
    expect(routeScope(registry, "game-dev", readRoleRoute(layout)!)).toBeNull();
  });
});
