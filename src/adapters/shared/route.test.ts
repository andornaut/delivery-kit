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
  CLAUDE_COORDINATOR,
  CLAUDE_TECH,
  CODEX_TECH,
  makeFixture,
  registryInput,
} from "../../testFixtures.ts";
import { readRoleRoute, RouteError, routeRecipient, routeScope, sendRoute } from "./route.ts";

const CODEX_COORDINATOR = "00000000-0000-4000-8000-000000000004";

function setup(route: unknown): Layout {
  const layout = loadLayout(makeFixture().root);
  const input = registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">;
  createRegistry(layout, input);
  updateRegistry(layout, 1, (draft) => {
    draft.roles["game-coordinator"]!.conversations.codex = CODEX_COORDINATOR;
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
  it("returns nonhost and held without resolving", () => {
    const layout = setup({ ...ROUTE, state: "held" });
    const route = readRoleRoute(layout)!;
    expect(sendRoute(readRegistry(layout), "game-coordinator", route, "chibis-way-home")).toEqual({
      status: "nonhost",
    });
    expect(sendRoute(readRegistry(layout), "game-coordinator", route, "archies-dog-walks")).toEqual(
      {
        status: "held",
      },
    );
  });

  it("refuses every malformed route", () => {
    const changes: [string, Record<string, unknown>][] = [
      ["an unknown role", { targets: ["archies-dog-walks/qa"] }],
      ["an unknown host", { host: "other-game" }],
      ["duplicate targets", { targets: ["art-kit", "art-kit"] }],
      ["an active route without targets", { targets: [] }],
      ["another schema", { schema: 3 }],
      ["an unknown key", { recipient: "game-coordinator" }],
    ];
    for (const [name, change] of changes) {
      const layout = setup({ ...ROUTE, ...change });
      expect(() => readRoleRoute(layout), name).toThrow(RouteError);
    }
  });

  it("refuses an active route that targets its recipient", () => {
    const layout = setup({ ...ROUTE, targets: ["game-coordinator", "archies-dog-walks/tech"] });
    const route = readRoleRoute(layout)!;
    expect(() => routeRecipient(layout, route)).toThrow(
      "active route targets must not include the recipient game-coordinator",
    );
  });
});

describe("mixed route transports", () => {
  it("keeps the recipient transport independent and resolves changed target overrides at each call", () => {
    const layout = setup(ROUTE);
    const route = readRoleRoute(layout)!;
    const mixed = updateRegistry(layout, 2, (draft) => {
      draft.roles["game-coordinator"]!.harness = "codex";
    });
    const send = sendRoute(mixed, "game-coordinator", route, "archies-dog-walks");
    expect(send).toMatchObject({
      harness: "codex",
      recipient: { conversation: CODEX_COORDINATOR, harness: "codex" },
      targets: [
        { conversation: CLAUDE_TECH, harness: "claude" },
        { conversation: null, harness: "claude" },
      ],
    });
    expect(routeScope(mixed, "game-coordinator", route)).toMatchObject({
      harness: "codex",
      harnesses: { [CODEX_COORDINATOR]: "codex", [CLAUDE_TECH]: "claude" },
      recipient: CODEX_COORDINATOR,
      targets: [{ harness: "claude", sessionId: CLAUDE_TECH }],
    });
    const changed = updateRegistry(layout, mixed.revision, (draft) => {
      draft.roles["archies-dog-walks/tech"]!.harness = "codex";
    });
    expect(routeScope(changed, "game-coordinator", route)!.peers).toEqual([CODEX_TECH]);
    expect(routeScope(changed, "game-coordinator", route)!.harnesses).toEqual({
      [CODEX_COORDINATOR]: "codex",
      [CODEX_TECH]: "codex",
    });
  });

  it("keeps an unavailable selected target null instead of using its inactive ID", () => {
    const layout = setup(ROUTE);
    const registry = updateRegistry(layout, 2, (draft) => {
      draft.roles["archies-dog-walks/tech"]!.harness = "codex";
      draft.roles["archies-dog-walks/tech"]!.conversations.codex = null;
    });
    const scope = routeScope(registry, "game-coordinator", readRoleRoute(layout)!);
    expect(scope!.targets).toEqual([]);
    expect(scope!.harnesses).toEqual({ [CLAUDE_COORDINATOR]: "claude" });
  });

  it("rejects a cross-harness UUID collision between target and recipient", () => {
    const layout = setup(ROUTE);
    const registry = updateRegistry(layout, 2, (draft) => {
      draft.roles["archies-dog-walks/tech"]!.harness = "codex";
      draft.roles["archies-dog-walks/tech"]!.conversations.codex = CLAUDE_COORDINATOR;
    });
    expect(routeScope(registry, "game-coordinator", readRoleRoute(layout)!)).toBeNull();
  });

  it("returns no active scope when only an inactive recipient ID exists", () => {
    const layout = setup(ROUTE);
    const registry = updateRegistry(layout, 2, (draft) => {
      draft.roles["game-coordinator"]!.harness = "codex";
      draft.roles["game-coordinator"]!.conversations.codex = null;
    });
    expect(routeScope(registry, "game-coordinator", readRoleRoute(layout)!)).toBeNull();
  });
});
