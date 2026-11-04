// Owner-attested process health (from tests/test_process_health.py). Public observations use
// `monitor-snapshot --recipient R --parent P` (R is outside the route, so the question collector
// makes no native calls); two-sample and scheduled-sample contracts use one scheduled monitor slot
// of the resident runner. The manifest is PROCESS_HEALTH_FILE; prior samples are the
// STATE/unblock/health/<monitor>.json record a previous scheduled slot would have written.
import { expect } from "vitest";

import { contract, RECEIVE_TIMEOUT_LATCHES, suite, workspaces } from "../lib/cases.ts";
import {
  blocked,
  C,
  clone,
  codexRoute,
  evidence,
  invocation,
  iso,
  job,
  M,
  manifest,
  only,
  OTHER,
  P,
  PR_PRIVATE,
  PROCESS_METHODS,
  ProcessNative,
  progress,
  R,
  receipt,
  scheduled,
  snapshot,
  sockets,
  stamp,
} from "../lib/health-native.ts";
import type { CodexSocket } from "../lib/codex-socket.ts";
import type { Workspace } from "../lib/workspace.ts";

type Json = Record<string, unknown>;
type Row = Json & { state: string; requires_owner_action: boolean };
type Health = Json & { jobs: Row[]; observations: Json[]; diagnostics: string[]; budget: Json };

const IDENTITY = ["owner_parent_id", "worker_id", "kind", "job_id", "start_identity", "invocation"];

suite("process health", () => {
  const workspace = workspaces();
  const socketFor = sockets();

  async function setup(
    native = new ProcessNative(),
  ): Promise<{ ws: Workspace; socket: CodexSocket }> {
    const ws = workspace();
    const socket = await socketFor(ws);
    native.install(socket);
    codexRoute(ws, [P]);
    return { ws, socket };
  }

  /** Public observation (slot None) of P's jobs. */
  async function observe(
    jobs: Json[] | Json = [job()],
    native = new ProcessNative(),
    setupFor?: (ws: Workspace) => void,
  ) {
    const { ws, socket } = await setup(native);
    manifest(ws, jobs);
    setupFor?.(ws);
    const before = ws.read("../process-health.json");
    const shot = await snapshot(ws, R, [P]);
    expect(shot.result.code, shot.result.stderr).toBe(0);
    expect(ws.read("../process-health.json")).toBe(before);
    expect(shot.text).not.toContain(PR_PRIVATE);
    const health = (shot.record.process_health as Record<string, Health>)[P]!;
    return { health, calls: only(socket.calls, PROCESS_METHODS), shot, ws };
  }

  /** A trusted prior sample exactly as a scheduled slot records it. */
  function sample(value: Json, slot: number, collectedAt: number): Json {
    const identity = Object.fromEntries(IDENTITY.map((k) => [k, value[k]]));
    const owner = clone(value.owner_evidence as Json);
    return {
      ...identity,
      slot,
      collected_at: iso(collectedAt),
      provenance: "owner_attested",
      protected: false,
      owner_evidence: owner,
    };
  }

  function prior(ws: Workspace, samples: Json[]): void {
    ws.write(
      `unblock/health/${M}.json`,
      JSON.stringify({ seen_slots: [], process_observations: samples }),
    );
  }

  contract(
    "running is owner attested, never live verified, and reads only scoped metadata",
    async () => {
      const { health, calls } = await observe();
      const row = health.jobs[0]!;
      expect(row.state).toBe("running");
      expect(row.identity_provenance).toBe("owner_attested");
      expect(row.progress_provenance).toBe("owner_attested");
      expect(row.lineage_verified).toBe(true);
      expect(row.invocation_verified).toBe(true);
      expect(row.requires_owner_action).toBe(false);
      expect(health.diagnostics).toContain("live_process_getter_unavailable");
      expect(calls.map((c) => c.method)).toEqual(["thread/read", "thread/items/read"]);
    },
  );

  contract("explicit fresh owner stall requests the exact job episode only", async () => {
    for (const kind of ["process", "container", "browser_job"]) {
      const { health } = await observe([
        job({ kind, owner_evidence: evidence({ confirmed_stalled: true }) }),
      ]);
      const row = health.jobs[0]!;
      expect(row.state).toBe("stalled");
      expect(row.requires_owner_action).toBe(true);
      expect(row.stall_episode).toBe("episode-1");
      expect(row.start_identity).toBe("owner-start-1");
      expect(row.invocation).toEqual(invocation());
    }
  });

  contract("protected, service, question wait and terminal never request closure", async () => {
    const cases = [job({ protected: true, owner_evidence: evidence({ confirmed_stalled: true }) })];
    for (const state of ["service", "waiting_on_user", "terminal", "unknown"]) {
      cases.push(job({ owner_evidence: evidence({ state, confirmed_stalled: true }) }));
    }
    for (const value of cases) {
      const row = (await observe([value])).health.jobs[0]!;
      expect(row.requires_owner_action).toBe(false);
      expect(row.state).not.toBe("stalled");
    }
  });

  contract("the same owner timestamp across slots is not new progress evidence", async () => {
    const { ws, socket } = await setup();
    const run = await scheduled(ws, socket, 0, (slot) => {
      // The previous slot carried the identical owner evidence and confirmation time.
      const value = job({
        owner_evidence: evidence({
          confirmed_at: iso(slot - 100),
          progress: progress(),
          blocked_condition: blocked(),
        }),
      });
      manifest(ws, [value]);
      prior(ws, [sample(value, slot - 60, slot - 55)]);
    });
    const health = (run.record.process_health as Record<string, Health>)[P]!;
    expect(health.jobs[0]!.requires_owner_action).toBe(false);
    expect(health.jobs[0]!.state).not.toBe("stalled");
    expect(health.observations).toHaveLength(1);
    expect((run.health.process_observations as Json[]).map((s) => s.slot)).toEqual([run.slot]);
  });

  contract(
    "two distinct owner observations need expected progress and a corroborated block",
    async () => {
      const { ws, socket } = await setup();
      const fields = { progress: progress(), blocked_condition: blocked() };
      const variants: Array<[string, Json, boolean]> = [
        ["stalled", {}, true],
        ["counter-up", { progress: progress({ counter: 11 }) }, false],
        ["counter-down", { progress: progress({ counter: 9 }) }, false],
        ["epoch", { progress: progress({ epoch: "new" }) }, false],
        ["contract", { progress: progress({ contract_id: "new" }) }, false],
        ["not-expected", { progress: progress({ expected_to_advance: false }) }, false],
        ["bool-counter", { progress: progress({ counter: true }) }, false],
        ["no-block", { blocked_condition: null }, false],
        ["unconfirmed-block", { blocked_condition: blocked({ confirmed: false }) }, false],
        ["other-block", { blocked_condition: blocked({ evidence_id: "different" }) }, false],
        ["episode", { episode_id: "new" }, false],
        ["stale-1900", { confirmed_at: stamp(1900) }, false],
        ["stale", { confirmed_at: stamp(1801) }, false],
      ];
      const run = await scheduled(ws, socket, 0, (slot) => {
        const old = slot - 1800;
        const jobs: Json[] = [];
        const samples: Json[] = [];
        for (const [name, change] of variants) {
          const id = `job-${name}`;
          const previous = job({
            job_id: id,
            owner_evidence: evidence({ confirmed_at: iso(old - 60), ...fields }),
          });
          samples.push(sample(previous, old, old + 5));
          jobs.push(job({ job_id: id, owner_evidence: evidence({ ...fields, ...change }) }));
        }
        // A prior sample from the same slot is not a distinct observation.
        jobs.push(job({ job_id: "job-same-slot", owner_evidence: evidence(fields) }));
        samples.push(
          sample(
            job({
              job_id: "job-same-slot",
              owner_evidence: evidence({ confirmed_at: iso(old - 60), ...fields }),
            }),
            slot,
            slot + 1,
          ),
        );
        // A reused handle with a different start identity is a different resource.
        jobs.push(job({ job_id: "job-reused", owner_evidence: evidence(fields) }));
        samples.push(
          sample(
            job({
              job_id: "job-reused",
              start_identity: "reused-handle-new-start",
              owner_evidence: evidence({ confirmed_at: iso(old - 60), ...fields }),
            }),
            old,
            old + 5,
          ),
        );
        manifest(ws, jobs);
        prior(ws, samples);
      });
      const rows = Object.fromEntries(
        (run.record.process_health as Record<string, Health>)[P]!.jobs.map((r) => [r.job_id, r]),
      );
      for (const [name, , stalled] of variants) {
        expect(rows[`job-${name}`]!.requires_owner_action, name).toBe(stalled);
        if (stalled) expect(rows[`job-${name}`]!.state).toBe("stalled");
      }
      expect(rows["job-same-slot"]!.requires_owner_action).toBe(false);
      expect(rows["job-reused"]!.requires_owner_action).toBe(false);
    },
  );

  contract("prior owner evidence fresh at capture survives thirty-minute jitter", async () => {
    const { ws, socket } = await setup();
    const fields = { progress: progress(), blocked_condition: blocked() };
    type Change = (s: Json, old: number, now: number) => Json;
    const variants: Array<[string, Change, boolean]> = [
      ["valid", (s) => s, true],
      ["collected-late", (s, old) => ({ ...s, collected_at: iso(old + 60) }), false],
      ["collected-future", (s, _, now) => ({ ...s, collected_at: iso(now + 3600) }), false],
      ["slot-unaligned", (s, old) => ({ ...s, slot: old + 1 }), false],
      ["native-provenance", (s) => ({ ...s, provenance: "native_verified" }), false],
      [
        "evidence-stale-at-capture",
        (s, old) => ({
          ...s,
          owner_evidence: evidence({ confirmed_at: iso(old - 1801), ...fields }),
        }),
        false,
      ],
      [
        "evidence-after-capture",
        (s, old) => ({
          ...s,
          owner_evidence: evidence({ confirmed_at: iso(old + 100), ...fields }),
        }),
        false,
      ],
      [
        "no-collected-at",
        (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== "collected_at")),
        false,
      ],
    ];
    const run = await scheduled(ws, socket, 0, (slot) => {
      // Prior evidence is 100 seconds old at capture, so more than 1800 seconds old now.
      const old = slot - 1800;
      const now = Date.now() / 1000;
      const base = (id: string) =>
        sample(
          job({ job_id: id, owner_evidence: evidence({ confirmed_at: iso(old - 90), ...fields }) }),
          old,
          old + 10,
        );
      manifest(
        ws,
        variants.map(([name]) => job({ job_id: `job-${name}`, owner_evidence: evidence(fields) })),
      );
      prior(
        ws,
        variants.map(([name, change]) => change(base(`job-${name}`), old, now)),
      );
    });
    const rows = Object.fromEntries(
      (run.record.process_health as Record<string, Health>)[P]!.jobs.map((r) => [r.job_id, r]),
    );
    for (const [name, , stalled] of variants)
      expect(rows[`job-${name}`]!.requires_owner_action, name).toBe(stalled);
  });

  contract(
    "public observation (no slot) never synthesizes scheduled samples or two-sample stalls",
    async () => {
      const fields = { progress: progress(), blocked_condition: blocked() };
      const minute = Math.floor(Date.now() / 60000) * 60;
      const old = minute - 1800;
      const previous = job({
        owner_evidence: evidence({ confirmed_at: iso(old - 60), ...fields }),
      });
      const first = await observe(
        [job({ owner_evidence: evidence(fields) })],
        new ProcessNative(),
        (w) => prior(w, [sample(previous, old, old + 5)]),
      );
      const ws = first.ws;
      let health = first.health;
      expect(health.observations).toEqual([]);
      expect(health.jobs[0]!.requires_owner_action).toBe(false);
      expect(ws.readJson(`unblock/health/${M}.json`).process_observations).toHaveLength(1);
      ({ health } = await observe([
        job({ owner_evidence: evidence({ confirmed_stalled: true }) }),
      ]));
      expect(health.jobs[0]!.requires_owner_action).toBe(true);
      expect(health.observations).toEqual([]);
    },
  );

  contract("confirmation references do not depend on scheduled sample emission", async () => {
    const value = job({
      owner_evidence: evidence({
        confirmed_stalled: true,
        progress: progress(),
        blocked_condition: blocked(),
        unrelated: PR_PRIVATE,
      }),
    });
    const ownerEvidence = value.owner_evidence as Json;
    const expected = {
      confirmed_by: P,
      confirmed_at: ownerEvidence.confirmed_at,
      episode_id: "episode-1",
      blocked_condition: { code: "deadlock", evidence_id: "diagnostic-1" },
    };
    // Public (no slot), then a scheduled slot observed more than a minute late.
    const { health } = await observe([value]);
    const { ws, socket } = await setup();
    manifest(ws, [value]);
    const run = await scheduled(ws, socket, 60);
    const late = (run.record.process_health as Record<string, Health>)[P]!;
    expect(late.diagnostics).toContain("scheduled_sample_time_unavailable");
    for (const result of [health, late]) {
      expect(result.observations).toEqual([]);
      const row = result.jobs[0]!;
      expect(row.requires_owner_action).toBe(true);
      expect(row.owner_evidence_ref).toEqual(expected);
      expect(row.owner_evidence_ref).not.toHaveProperty("progress");
    }
    const native = new ProcessNative();
    native.parent = OTHER;
    expect((await observe([value], native)).health.jobs[0]!.owner_evidence_ref).toBeNull();
    const stale = clone(value);
    (stale.owner_evidence as Json).confirmed_at = stamp(1801);
    expect((await observe([stale])).health.jobs[0]!.owner_evidence_ref).toBeNull();
  });

  contract("stasis, native status and exit never imply a stall or closure", async () => {
    let native = new ProcessNative();
    native.status = "completed";
    native.exitCode = 0;
    let row = (await observe([job({ owner_evidence: evidence({ progress: progress() }) })], native))
      .health.jobs[0]!;
    expect(row.state).toBe("running");
    expect(row.requires_owner_action).toBe(false);
    expect(row.closure_status).toBe("none");
    native = new ProcessNative();
    native.missing = true;
    row = (await observe([job()], native)).health.jobs[0]!;
    expect(row.state).toBe("unknown");
    expect(row.closure_status).toBe("unknown");
  });

  contract("wrong scope, lineage, invocation and missing identity fail closed", async () => {
    const out = await observe([job({ owner_parent_id: OTHER })]);
    expect(out.calls).toEqual([]);
    for (const changes of [
      { start_identity: "" },
      { worker_id: OTHER },
      { kind: [] },
      { invocation: invocation(OTHER) },
    ]) {
      const { health } = await observe([job(changes)]);
      expect(health.jobs.some((r) => r.requires_owner_action)).toBe(false);
    }
    for (const field of ["parent", "sourceParent"] as const) {
      const native = new ProcessNative();
      native[field] = OTHER;
      const row = (await observe([job()], native)).health.jobs[0]!;
      expect(row.lineage_verified).toBe(false);
      expect(row.requires_owner_action).toBe(false);
    }
    const native = new ProcessNative();
    native.wrongItem = true;
    expect((await observe([job()], native)).health.jobs[0]!.invocation_verified).toBe(false);
  });

  contract("freshness, provenance, owner and identity confirmation are mandatory", async () => {
    for (const change of [
      { confirmed_at: stamp(1801) },
      { confirmed_at: stamp(-120) },
      { confirmed_by: OTHER },
      { identity_verified: false },
      { provenance: "native_verified" },
      { state: [] },
    ]) {
      const row = (
        await observe([job({ owner_evidence: evidence({ confirmed_stalled: true, ...change }) })])
      ).health.jobs[0]!;
      expect(row.state).toBe("unknown");
      expect(row.requires_owner_action).toBe(false);
    }
    // The upper boundary keeps a margin for the delay before the collector runs.
    for (const age of [0, 1790]) {
      const value = job({
        owner_evidence: evidence({ confirmed_at: stamp(age), confirmed_stalled: true }),
      });
      expect((await observe([value])).health.jobs[0]!.requires_owner_action).toBe(true);
    }
  });

  contract("closure outcomes separate delivery, report and owner-verified result", async () => {
    for (const state of ["requested", "delivery_accepted", "ambiguous", "reported_closed"]) {
      const value = job({
        owner_evidence: evidence({ confirmed_stalled: true }),
        closure: receipt(state),
      });
      const row = (await observe([value])).health.jobs[0]!;
      expect(row.closure_status).toBe(state);
      expect(row.closure_provenance).toBe("owner_attested");
      expect(row.closure_evidence_id).toBe("closure-1");
      expect(row.requires_owner_action).toBe(state !== "reported_closed");
    }
    const value = job({
      closure: receipt("verified_closed", {
        owner_verified: true,
        verification_succeeded: true,
        native_result_ref: invocation(P, "verification"),
      }),
    });
    const row = (await observe([value])).health.jobs[0]!;
    expect(row.closure_status).toBe("verified_closed");
    expect(row.closure_provenance).toBe("owner_verified_native_result_corroborated");
    expect((row.closure_result_ref as Json).item_id).toBe("verification");
    for (const changes of [
      { owner_verified: false },
      { verification_succeeded: false },
      { native_result_ref: invocation(OTHER, "verification") },
      { native_result_ref: invocation() },
    ]) {
      const changed = clone(value);
      Object.assign(changed.closure as Json, changes);
      expect((await observe([changed])).health.jobs[0]!.closure_status).toBe("reported_closed");
    }
    const native = new ProcessNative();
    native.verifyExit = 1;
    expect((await observe([value], native)).health.jobs[0]!.closure_status).toBe("reported_closed");
  });

  contract("closure receipts bind exact identity and preserve blocker retention", async () => {
    for (const change of [
      { start_identity: "reused" },
      { job_id: "other" },
      { confirmed_by: OTHER },
      { confirmed_at: stamp(1801) },
      { invocation: invocation(C, "other") },
    ]) {
      const row = (await observe([job({ closure: receipt("reported_closed", change) })])).health
        .jobs[0]!;
      expect(row.closure_status).toBe("unknown");
    }
    for (const state of ["blocked", "retained"]) {
      const value = job({
        owner_evidence: evidence({ confirmed_stalled: true }),
        closure: receipt(state, { reason_code: "owner_question_pending", next_review_slot: 300 }),
      });
      const row = (await observe([value])).health.jobs[0]!;
      expect(row.closure_status).toBe(state);
      expect(row.requires_owner_action).toBe(false);
      expect(row.closure_reason_code).toBe("owner_question_pending");
      if (state === "retained") expect(row.closure_next_review_slot).toBe(300);
      delete (value.closure as Json).reason_code;
      expect((await observe([value])).health.jobs[0]!.closure_status).toBe("unknown");
    }
  });

  contract("bounds, duplicate jobs and unsafe extras never echo raw fields", async () => {
    const value = job({ owner_evidence: evidence({ confirmed_stalled: true }) });
    value.command = PR_PRIVATE;
    (value.owner_evidence as Json).output = PR_PRIVATE;
    let { health } = await observe([value, clone(value)]);
    expect(health.jobs[0]!.requires_owner_action).toBe(false);
    expect(health.observations).toEqual([]);
    const oversized = { version: 1, jobs: [], unknown: "x".repeat(1048576) };
    let shot = (await observe(oversized)).shot;
    expect((shot.record.process_health as Record<string, Health>)[P]!.status).toBe("unavailable");
    expect(shot.out.process_health_source).toEqual({
      status: "unavailable",
      diagnostics: ["process_manifest_size_exceeded"],
    });
    // The CLI refuses a manifest above 100 jobs before collection; 100 are all inspected.
    shot = (await observe(Array.from({ length: 101 }, (_, i) => job({ job_id: `job-${i}` })))).shot;
    expect(shot.out.process_health_source).toEqual({
      status: "unavailable",
      diagnostics: ["process_manifest_schema_unavailable"],
    });
    expect((shot.record.process_health as Record<string, Health>)[P]!.jobs).toEqual([]);
    ({ health } = await observe(
      Array.from({ length: 100 }, (_, i) => job({ job_id: `job-${i}` })),
    ));
    expect(health.jobs).toHaveLength(100);
    expect(health.omitted_jobs).toBe(0);
    shot = (await observe({ version: true, jobs: [] })).shot;
    expect((shot.record.process_health as Record<string, Health>)[P]!.status).toBe("unavailable");
  });

  contract("denied visibility and the shared call budget never bypass or mutate", async () => {
    let native = new ProcessNative();
    native.failure = "thread/read";
    const denied = await observe([job()], native);
    expect(denied.health.jobs[0]!.state).toBe("unknown");
    expect(denied.calls).toHaveLength(1);
    // 100 verified closures need 300 reads. The snapshot's shared 256-call collection budget
    // (also used by the two scoped worker inventory reads) stops collection first.
    const jobs = Array.from({ length: 100 }, (_, i) =>
      job({
        job_id: `job-${i}`,
        closure: receipt("verified_closed", {
          job_id: `job-${i}`,
          owner_verified: true,
          verification_succeeded: true,
          native_result_ref: invocation(P, "verification"),
        }),
      }),
    );
    native = new ProcessNative();
    const { health, calls, shot } = await observe(jobs, native);
    expect(shot.out.collection_budget).toEqual({
      max_calls: 256,
      calls_used: 256,
      reason_code: "collection_call_budget_exhausted",
    });
    expect(calls.length + 2).toBe(256);
    expect(health.budget.exhausted).toBe(true);
    expect(health.jobs.some((r) => r.state === "unknown")).toBe(true);
    expect(health.jobs.some((r) => r.requires_owner_action)).toBe(false);
  });

  contract("a timeout latches the budget and never leaks native failure", async () => {
    const native = new ProcessNative();
    native.hang = "thread/read";
    const { health, calls } = await observe([job(), job({ job_id: "other" })], native);
    if (!RECEIVE_TIMEOUT_LATCHES) {
      // v0.9.1: the timeout is not recognized, so the second job is still read.
      expect(calls.length).toBeGreaterThan(1);
      expect(health.observations).toEqual([]);
      return;
    }
    expect(calls).toHaveLength(1);
    expect(health.budget.reason_code).toBe("native_timeout");
    expect(health.jobs.every((r) => r.state === "unknown")).toBe(true);
    expect(health.observations).toEqual([]);
  });

  contract(
    "a parent-owned invocation needs no child read; out-of-scope parents make no calls",
    async () => {
      const value = job({ worker_id: null, invocation: invocation(P) });
      const { health, calls } = await observe([value]);
      expect(health.jobs[0]!.invocation_verified).toBe(true);
      expect(calls.map((c) => c.method)).toEqual(["thread/items/read"]);
      // A parent outside the active route is refused before any native connection.
      const { ws, socket } = await setup();
      manifest(ws, [job()]);
      const result = await snapshot(ws, R, [OTHER]).catch(() => null);
      expect(result === null || result.result.code !== 0).toBe(true);
      expect(socket.calls).toEqual([]);
      expect(
        (await observe({ version: true, jobs: [] })).shot.out.process_health_source,
      ).toMatchObject({ status: "unavailable" });
    },
  );
});
