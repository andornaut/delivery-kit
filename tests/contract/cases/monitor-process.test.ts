// Scheduled process-health samples across real wall-clock minutes (from tests/test_monitor.py).
// A sample is valid only within its slot's minute of real time, so these slots are real minutes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, expect } from "vitest";

import { contract, suite, workspaces } from "../lib/cases.ts";
import { clear, health, type Json, launchItem, Native, processJob, TECH, ART, writeCodexRoute } from "../lib/monitor-native.ts";
import { MonitorSchedule } from "../lib/monitor-schedule.ts";
import type { Workspace } from "../lib/workspace.ts";

const REAL_TIME = 240_000;

function readSnapshot(output: Json | undefined): Json {
  return JSON.parse(readFileSync(output!.snapshot_path as string, "utf8")) as Json;
}

suite("monitor scheduled process health", () => {
  const workspace = workspaces();
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup(): Promise<{ ws: Workspace; native: Native; schedule: MonitorSchedule }> {
    const ws = workspace();
    writeCodexRoute(ws);
    const native = await new Native(ws).listen();
    cleanups.push(() => native.close());
    const schedule = new MonitorSchedule(ws, { realtime: true });
    cleanups.push(() => schedule.stop());
    return { ws, native, schedule };
  }

  function manifest(ws: Workspace, jobs: unknown[]): void {
    mkdirSync(dirname(ws.processHealthFile), { recursive: true });
    writeFileSync(ws.processHealthFile, JSON.stringify({ version: 1, jobs }));
  }

  contract(
    "scheduled health stores exact process samples without owner record mutation",
    async () => {
      const { ws, native, schedule } = await setup();
      clear(ws);
      native.queues = { [TECH]: [], [ART]: [] };
      launchItem(native);
      manifest(ws, [processJob(TECH, new Date(Date.now() - 5_000).toISOString())]);
      const before = readFileSync(ws.processHealthFile);
      await schedule.start();
      const first = readSnapshot((await schedule.slot()).output);
      expect(first.process_health[TECH].observations).toHaveLength(1);
      expect(health(ws).process_observations).toEqual(first.process_health[TECH].observations);
      const second = readSnapshot((await schedule.slot()).output);
      expect(health(ws).process_observations).toEqual(second.process_health[TECH].observations);
      expect(second.process_health[TECH].observations[0].slot).not.toBe(first.process_health[TECH].observations[0].slot);
      expect(second.process_health[TECH].observations[0].owner_evidence.confirmed_at).toBe(
        first.process_health[TECH].observations[0].owner_evidence.confirmed_at,
      );
      expect(readFileSync(ws.processHealthFile)).toEqual(before);
    },
    REAL_TIME,
  );

  contract(
    "the real process collector gives scheduled provenance, one closure request and reported closure",
    async () => {
      const { ws, native, schedule } = await setup();
      clear(ws);
      native.queues = { [TECH]: [], [ART]: [] };
      launchItem(native);
      const stamp = new Date(Date.now() - 5_000).toISOString();
      const job = processJob(TECH, stamp);
      manifest(ws, [job]);
      await schedule.start();
      const { output } = await schedule.slot();
      const snap = readSnapshot(output);
      expect(snap.process_health[TECH].jobs[0].identity_provenance).toBe("owner_attested");
      const sample = snap.process_health[TECH].observations[0];
      expect(sample.provenance).toBe("owner_attested");
      expect(Number.isNaN(Date.parse(sample.collected_at))).toBe(false);
      expect(JSON.stringify(snap)).not.toContain("PRIVATE_COMMAND");
      expect(native.reminders().filter((text) => text.includes("Confirmed owner-attested stalled resources"))).toHaveLength(1);
      job.closure = {
        owner_parent_id: TECH,
        kind: "process",
        job_id: "job-1",
        start_identity: "start-1",
        invocation: job.invocation,
        confirmed_by: TECH,
        confirmed_at: stamp,
        provenance: "owner_attested",
        state: "reported_closed",
        evidence_id: "owner-closure-1",
      };
      manifest(ws, [job]);
      const before = readFileSync(ws.processHealthFile);
      const closed = readSnapshot((await schedule.slot()).output);
      expect(closed.process_health[TECH].jobs[0].closure_status).toBe("reported_closed");
      expect(native.reminders().filter((text) => text.includes("Confirmed owner-attested stalled resources"))).toHaveLength(1);
      expect(readFileSync(ws.processHealthFile)).toEqual(before);
    },
    REAL_TIME,
  );

});
