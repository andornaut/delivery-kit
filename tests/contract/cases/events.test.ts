// Bus event outbox durability, retry, deduplication and completion truth through the runner
// and the legacy Codex queue sink.

import { expect } from "vitest";

import { impl, type Resident, startRunner } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";

import { at, sleep } from "../lib/time.ts";
import { type Workspace } from "../lib/workspace.ts";

const MONITOR = "00000000-0000-4000-8000-000000000001";
const EVERY_MINUTE = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0"));

function bus(ws: Workspace, options: { github?: string } = {}): void {
  ws.config.schedule = { departures: EVERY_MINUTE, timezone: "America/Toronto" };
  ws.config.git = { main: "main", remote: "origin", github: options.github ?? "" };
  ws.writeRegistry({
    schema: 1,
    revision: 1,
    harness: "codex",
    roles: { monitor: { conversations: { codex: MONITOR } } },
  });
  ws.config.reports = { project: "Fixture", recipient: "monitor" };
}

function kinds(ws: Workspace): string[] {
  return ws.events().map((event) => String(event.kind));
}

function start(ws: Workspace, speed = 30): Resident {
  ws.setClock(at(59, 58), speed);
  return startRunner(ws);
}

suite("events", () => {
  const workspace = workspaces();

  contract("empty departures are silent", async () => {
    const ws = workspace();
    bus(ws);
    const runner = start(ws, 60);
    await runner.until(() => ws.virtualNow() >= at(3, 0, 1), 20_000);
    await runner.stop();
    expect(ws.events()).toEqual([]);
  });

  contract("blocked events for one attempt deduplicate across stages", async () => {
    const ws = workspace();
    bus(ws);
    ws.updateControl((c) => (c.docker = { gateFail: true }));
    impl.offer(ws, ["bus/feature"]);
    const runner = start(ws);
    await runner.until(() => kinds(ws).some((kind) => kind.startsWith("blocked-")));
    await sleep(500);
    await runner.stop();
    const blocked = ws.events().filter((event) => String(event.kind).startsWith("blocked-"));
    expect(blocked.length).toBe(1);
    expect(blocked[0]!.kind).toBe("blocked-full-gate");
  });
});
