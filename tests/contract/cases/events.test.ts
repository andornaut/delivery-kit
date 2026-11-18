// Runner-side bus events: which events a departure records and when the resident observer flushes
// the outbox. Outbox delivery, deduplication, receipts and guards are coordination-kit's contract
// cases, reached through the same flushEvents seam.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect } from "vitest";

import { impl, type Resident, startRunner } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { otherGame } from "../lib/routes.ts";
import { at, sleep } from "../lib/time.ts";
import { Reviewed } from "../lib/unblock-runner.ts";
import { type Workspace } from "../lib/workspace.ts";

const RECIPIENT = "00000000-0000-4000-8000-000000000001";
const EVERY_MINUTE = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0"));
const FIRST = "a".repeat(64);
const SECOND = "b".repeat(64);

function bus(ws: Workspace, options: { github?: string } = {}): void {
  ws.config.schedule = { departures: EVERY_MINUTE, timezone: "America/Toronto" };
  ws.config.git = { main: "main", remote: "origin", github: options.github ?? "" };
  ws.writeRegistry({
    schema: 1,
    revision: 1,
    harness: "codex",
    roles: { "game-coordinator": { conversations: { codex: RECIPIENT } } },
  });
  ws.config.reports = { project: "Fixture", recipient: "game-coordinator" };
}

function kinds(ws: Workspace): string[] {
  return ws.events().map((event) => String(event.kind));
}

function start(ws: Workspace, speed = 30): Resident {
  ws.setClock(at(59, 58), speed);
  return startRunner(ws);
}

/** An unsent outbox entry written directly, so only an observer pass flushes it. */
function seed(ws: Workspace, id: string, created: number): void {
  ws.write(
    `events/${id}.json`,
    JSON.stringify({
      created,
      id,
      kind: "attempt",
      key: `fixture-${id.slice(0, 4)}`,
      message: "Fixture bus: scheduled attempt",
      sent: false,
    }) + "\n",
  );
}

function sent(ws: Workspace, id: string): boolean {
  return ws.exists(`events/${id}.json`) && ws.readJson(`events/${id}.json`).sent === true;
}

suite("events", () => {
  const workspace = workspaces();
  const open: Reviewed[] = [];
  afterEach(async () => {
    for (const reviewed of open.splice(0)) await reviewed.close();
  });

  contract("a failed gate records one blocked event of the gate stage's kind", async () => {
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

  contract("the observer flushes the outbox under the dispatch lock once a minute", async () => {
    const ws = workspace();
    // The route names a different dispatch host, so no review slot is dispatched here.
    const m = await Reviewed.routed(ws, { host: otherGame(ws) });
    open.push(m);
    ws.config.reports = { project: "Fixture", recipient: "game-coordinator" };
    ws.updateCoordinatorConfig({ wakeMinutes: [] });
    // The fake flock counts each admission to the event dispatch lock as one flush pass.
    const flock = join(ws.fakeBin, "flock");
    copyFileSync(new URL("../lib/event-flock.mjs", import.meta.url), flock);
    chmodSync(flock, 0o755);
    const lock = ws.path("events", "dispatch.lock");
    ws.env.DK_EVENT_LOCK = lock;
    ws.env.DK_EVENT_PASSES = join(ws.fakeDir, "event-passes");
    writeFileSync(ws.env.DK_EVENT_PASSES, "");
    const passes = () => readFileSync(ws.env.DK_EVENT_PASSES!, "utf8").split("\n").length - 1;
    /** Admission followed by a free dispatch lock includes all receipt and outbox writes. */
    const completed = (target: number) =>
      m.runner!.until(() => {
        if (passes() < target) return false;
        const probe = spawnSync("/usr/bin/flock", ["-n", "-E", "75", lock, "true"]);
        if (probe.error) throw probe.error;
        if (probe.status === 75) return false;
        if (probe.status !== 0) throw new Error(`dispatch lock probe failed: ${probe.status}`);
        return true;
      });
    seed(ws, FIRST, 1);
    // The runner starts at minute 00 at wall speed; the departure at minute 05 is never reached.
    await m.start();
    await m.runner!.until(() => sent(ws, FIRST));
    await completed(1);
    const before = passes();
    seed(ws, SECOND, 2);
    // Within the same virtual minute no further pass runs.
    await sleep(1_500);
    expect(passes()).toBe(before);
    expect(sent(ws, SECOND)).toBe(false);
    ws.advanceClock(60);
    await completed(before + 1);
    await m.runner!.until(() => sent(ws, SECOND));
    expect(passes()).toBe(before + 1);
    expect(m.world.mutations()).toHaveLength(2);
  });
});
