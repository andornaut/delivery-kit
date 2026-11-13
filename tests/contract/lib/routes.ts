// Schema 2 role-name route fixtures. A conversation ID becomes the registry role that holds it,
// or a `c-<id>` role registered for it. The review recipient is the host game's reports.recipient.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type Harness, nodeConfig, registerConversations } from "./node-adapter.ts";
import { type Workspace, writeJson } from "./workspace.ts";

const OTHER_GAME = "fixture-other";

/** A second game in config.json, with a valid delivery-kit.json, to host a route elsewhere. */
export function otherGame(ws: Workspace): string {
  const config = ws.coordinatorConfig() as { games: Record<string, unknown> };
  if (!config.games[OTHER_GAME]) {
    writeJson(join(ws.root, OTHER_GAME, "delivery-kit.json"), nodeConfig(ws));
    ws.updateCoordinatorConfig({
      games: {
        ...config.games,
        [OTHER_GAME]: { name: "Other", path: `../${OTHER_GAME}`, roles: ["tech"] },
      },
    });
  }
  return OTHER_GAME;
}

/** Set `game`'s reports.recipient: this game's configuration, or another game's file. */
export function setRecipient(ws: Workspace, game: string, role: string): void {
  if (game === ws.game) {
    ws.config.reports = { project: "Fixture", ...ws.config.reports, recipient: role };
    return;
  }
  const path = join(ws.root, game, "delivery-kit.json");
  if (!existsSync(path)) return;
  const config = JSON.parse(readFileSync(path, "utf8")) as { reports: Record<string, unknown> };
  writeJson(path, { ...config, reports: { ...config.reports, recipient: role } });
}

/**
 * An active route hosted by this game whose host names `recipient` as its reports.recipient;
 * `change` overrides any field, including invalid ones.
 */
export function roleRoute(
  ws: Workspace,
  harness: Harness,
  recipient: string,
  targets: readonly string[],
  change: Record<string, unknown> = {},
): Record<string, unknown> {
  const [recipientRole] = registerConversations(ws, harness, [recipient]);
  const targetRoles = [...new Set(registerConversations(ws, harness, [...new Set(targets)]))];
  setRecipient(ws, typeof change.host === "string" ? change.host : ws.game, recipientRole ?? "");
  return {
    host: ws.game,
    schema: 2,
    state: "active",
    targets: targetRoles,
    ...change,
  };
}

/** The role a conversation ID routes as. */
export function routeRole(ws: Workspace, harness: Harness, id: string): string {
  return registerConversations(ws, harness, [id])[0] ?? "";
}
