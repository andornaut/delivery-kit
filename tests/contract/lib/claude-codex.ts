// Codex-route fixtures for the cadence and native-interpreter cases: registry roles, a version 1
// route and the fake control socket answering as the original native fixtures did.
import { CodexSocket } from "./codex-socket.ts";
import { codexWorld } from "./claude-fixture.ts";
import type { Workspace } from "./workspace.ts";

export const TECH = "00000000-0000-0000-0000-000000000001";
export const MONITOR = "00000000-0000-0000-0000-000000000002";
export const TARGET = "00000000-0000-0000-0000-000000000003";
export const HELD = "00000000-0000-0000-0000-000000000004";

export function v1Route(
  ws: Workspace,
  change: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    harness: "codex",
    host_project_root: ws.repo,
    state: "active",
    monitor_thread_id: MONITOR,
    targets: [
      { thread_id: TARGET, ownership: "active" },
      { thread_id: TARGET, ownership: "active" },
      { thread_id: HELD, ownership: "held" },
    ],
    ...change,
  };
}

/** Register roles for every ID (role name = `r-<id suffix>` plus the named roles). */
export function codexRoles(ws: Workspace, extra: string[] = []): void {
  const roles: Record<string, { conversations: { codex: string } }> = {
    tech: { conversations: { codex: TECH } },
    monitor: { conversations: { codex: MONITOR } },
    target: { conversations: { codex: TARGET } },
    held: { conversations: { codex: HELD } },
  };
  for (const id of extra) roles[role(id)] = { conversations: { codex: id } };
  ws.writeRegistry({ schema: 1, revision: 1, harness: "codex", roles });
}

export function role(id: string): string {
  return `r-${id.slice(-12)}`;
}

export function clearMonitor(ws: Workspace, recipient = MONITOR): void {
  ws.write(
    `unblock/decisions/${recipient}.json`,
    JSON.stringify({ thread_id: recipient, state: "clear" }),
  );
}

/** A Codex-routed game with the observer at minutes 20 and 50 and departures at 00 and 10. */
export async function codexGame(
  ws: Workspace,
  queues: Record<string, unknown[]> = {},
): Promise<CodexSocket> {
  codexRoles(ws);
  ws.config.git = { main: "main", remote: "", github: "" };
  ws.config.schedule = { departures: ["00", "10"], timezone: "America/Toronto" };
  ws.config.deploy = { mode: "none", skipPattern: "" };
  ws.config.reports = { project: "Fixture", recipient: "tech", scheduledTicks: true };
  ws.writeRoute(v1Route(ws));
  clearMonitor(ws);
  const socket = await codexWorld(new CodexSocket(ws), queues).listen();
  ws.env.CODEX_CONTROL_SOCKET = socket.path;
  return socket;
}
