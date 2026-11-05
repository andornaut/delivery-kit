// Schema 1 role-name route fixtures. A conversation ID becomes the registry role that holds it,
// or a `c-<id>` role registered for it.
import { join } from "node:path";

import { type Harness, nodeConfig, registerConversations } from "./node-adapter.ts";
import { type Workspace, writeJson } from "./workspace.ts";

const OTHER_GAME = "fixture-other";

/** A second game in config.json, with a valid delivery-kit.json, to host a route elsewhere. */
export function otherGame(ws: Workspace): string {
  const config = ws.gameDevConfig() as { games: Record<string, unknown> };
  if (!config.games[OTHER_GAME]) {
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

/** An active route hosted by this game; `change` overrides any field, including invalid ones. */
export function roleRoute(
  ws: Workspace,
  harness: Harness,
  monitor: string,
  targets: readonly string[],
  change: Record<string, unknown> = {},
): Record<string, unknown> {
  const [monitorRole] = registerConversations(ws, harness, [monitor]);
  const targetRoles = [...new Set(registerConversations(ws, harness, [...new Set(targets)]))];
  return {
    host: ws.game,
    monitor: monitorRole,
    schema: 1,
    state: "active",
    targets: targetRoles,
    ...change,
  };
}

/** The role a conversation ID routes as. */
export function routeRole(ws: Workspace, harness: Harness, id: string): string {
  return registerConversations(ws, harness, [id])[0] ?? "";
}
