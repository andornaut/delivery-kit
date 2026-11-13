// User-authorized one-off requests with real scratch Git. A request
// departs the local main HEAD it captured.

import { expect } from "vitest";

import { execute, impl } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";

import type { Workspace } from "../lib/workspace.ts";

const RECIPIENT = "00000000-0000-4000-8000-000000000001";

function setup(
  ws: Workspace,
  options: { reports?: boolean; mode?: "none" | "wrangler"; remote?: string } = {},
): void {
  ws.config = {
    schema: 1,
    git: { main: "main", remote: options.remote ?? "", github: "" },
    schedule: { departures: ["00"], timezone: "UTC" },
    gate: { image: "unused", install: "", steps: [{ name: "test", run: "true" }] },
    resources: { cpus: 4, loadLimit: 24, memoryMiB: 4096 },
    deploy: { mode: options.mode ?? "none", skipPattern: "" },
    reports: {},
  };
  if (options.reports) {
    ws.writeRegistry({
      schema: 1,
      revision: 1,
      harness: "codex",
      roles: { "game-coordinator": { conversations: { codex: RECIPIENT } } },
    });
    ws.config.reports = { project: "Fixture", recipient: "game-coordinator" };
  }
}

async function capture(ws: Workspace, id: string) {
  return execute(impl.request(ws, id));
}

/** Docker calls other than the resource reporter's `docker ps`. */
function containers(ws: Workspace) {
  return ws.calls("docker").filter((call) => call.args[0] !== "ps");
}

suite("requests", () => {
  const workspace = workspaces();

  contract(
    "request IDs must be 1 to 64 safe characters and an invalid ID departs nothing",
    async () => {
      const ws = workspace({ realGit: true });
      // Validation needs no integration; a remote keeps the configuration valid for 1.0.
      setup(ws, { remote: "origin" });
      for (const id of ["../escape", "-option", "a".repeat(65), ""]) {
        const result = await capture(ws, id);
        expect(result.code, id).not.toBe(0);
      }
      expect(ws.list("requests").filter((name) => name.endsWith(".json"))).toEqual([]);
      expect(containers(ws)).toEqual([]);
    },
  );
});
