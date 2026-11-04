import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NativeTimeout, type RpcClient } from "../rpc.ts";
import {
  collectProcessHealth,
  processHealth,
  type ProcessHealthOptions,
  processSample,
} from "./processHealth.ts";

const P = "00000000-0000-0000-0000-000000000001";
const C = "00000000-0000-0000-0000-000000000002";
const OTHER = "00000000-0000-0000-0000-000000000003";
const NOW = 1793682000;
const PRIVATE = "PRIVATE_COMMAND_OUTPUT_ENV_OR_LOG";
const MAX_BYTES = 1048576;

type Json = Record<string, unknown>;

type Health = {
  budget: Json;
  complete: boolean;
  diagnostics: string[];
  jobs: Json[];
  observations: Json[];
  omitted_jobs: number;
  status: string;
};

function timestamp(age = 60): string {
  return `${new Date((NOW - age) * 1000).toISOString().slice(0, 19)}+00:00`;
}

function invocation(thread = C, item = "launch"): Json {
  return { thread_id: thread, turn_id: "turn-one", item_id: item };
}

function evidence(changes: Json = {}): Json {
  return {
    confirmed_by: P,
    confirmed_at: timestamp(),
    identity_verified: true,
    provenance: "owner_attested",
    state: "running",
    episode_id: "episode-1",
    ...changes,
  };
}

function progress(changes: Json = {}): Json {
  return {
    contract_id: "tasks-finished",
    epoch: "epoch-1",
    counter: 10,
    expected_to_advance: true,
    ...changes,
  };
}

function blocked(changes: Json = {}): Json {
  return { confirmed: true, code: "deadlock", evidence_id: "diagnostic-1", ...changes };
}

function job(changes: Json = {}): Json {
  return {
    owner_parent_id: P,
    worker_id: C,
    kind: "process",
    job_id: "job-1",
    start_identity: "owner-start-1",
    invocation: invocation(),
    owner_evidence: evidence(),
    ...changes,
  };
}

function receipt(state: string, changes: Json = {}): Json {
  const { invocation: launched, job_id, kind, owner_parent_id, start_identity } = job();
  return {
    owner_parent_id,
    kind,
    job_id,
    start_identity,
    invocation: launched,
    confirmed_by: P,
    confirmed_at: timestamp(),
    provenance: "owner_attested",
    state,
    evidence_id: "closure-1",
    ...changes,
  };
}

class Native implements RpcClient {
  deadline = 200;
  calls: [string, unknown][] = [];
  failure: string | null = null;
  parent = P;
  sourceParent = P;
  status = "inProgress";
  exitCode: number | null = null;
  verifyStatus = "completed";
  verifyExit = 0;
  missing = false;
  wrongItem = false;
  timeout = false;
  timeoutCalls = 0;

  async call(method: string, params: unknown): Promise<unknown> {
    if (this.timeout) {
      this.timeoutCalls += 1;
      throw new NativeTimeout(PRIVATE);
    }
    this.calls.push([method, structuredClone(params)]);
    if (this.failure === method) {
      throw new Error(PRIVATE);
    }
    const request = params as Json;
    if (method === "thread/read") {
      expect(params).toEqual({ threadId: C, includeTurns: false });
      return {
        thread: {
          id: C,
          parentThreadId: this.parent,
          source: { subAgent: { thread_spawn: { parent_thread_id: this.sourceParent } } },
          preview: PRIVATE,
        },
      };
    }
    if (method === "thread/items/read") {
      expect([P, C]).toContain(request.threadId);
      const itemIds = request.itemIds as string[];
      expect(itemIds).toHaveLength(1);
      if (this.missing) {
        return { data: [] };
      }
      const [itemId] = itemIds;
      const verification = itemId === "verification";
      return {
        data: [
          {
            turnId: request.turnId,
            startedAtMs: 1,
            item: {
              id: this.wrongItem ? "wrong" : itemId,
              type: "commandExecution",
              status: verification ? this.verifyStatus : this.status,
              exitCode: verification ? this.verifyExit : this.exitCode,
              command: PRIVATE,
              cwd: PRIVATE,
              aggregatedOutput: PRIVATE,
              processId: PRIVATE,
              env: PRIVATE,
            },
          },
        ],
      };
    }
    throw new Error("unsupported or mutating native call");
  }

  close(): void {
    // Nothing to release.
  }
}

type Collect = {
  jobs?: unknown[];
  manifest?: Json;
  maxCalls?: number;
  native?: Native;
  now?: number;
  prior?: readonly unknown[] | null;
  slot?: number | null;
};

function clock(now = NOW, maxCalls?: number): ProcessHealthOptions {
  const options = { monotonic: () => 100, now: () => now };
  return maxCalls === undefined ? options : { ...options, maxCalls };
}

async function collect(args: Collect = {}): Promise<Health> {
  const native = args.native ?? new Native();
  const manifest = args.manifest ?? { version: 1, jobs: args.jobs ?? [job()] };
  const before = structuredClone(manifest);
  const output = await collectProcessHealth(
    native,
    manifest,
    [P],
    args.slot === undefined ? NOW : args.slot,
    args.prior ?? null,
    clock(args.now, args.maxCalls),
  );
  const result = output[P];
  expect(manifest).toEqual(before);
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  expect(native.deadline).toBe(200);
  return result as unknown as Health;
}

function first(result: Health): Json {
  const [row] = result.jobs;
  if (row === undefined) {
    throw new Error("no job row");
  }
  return row;
}

async function row(args: Collect = {}): Promise<Json> {
  return first(await collect(args));
}

describe("collectProcessHealth", () => {
  it("reports running as owner attested from scoped metadata only", async () => {
    const native = new Native();
    const result = await collect({ native });
    const entry = first(result);
    expect(entry.state).toBe("running");
    expect(entry.identity_provenance).toBe("owner_attested");
    expect(entry.progress_provenance).toBe("owner_attested");
    expect(entry.lineage_verified).toBe(true);
    expect(entry.invocation_verified).toBe(true);
    expect(entry.requires_owner_action).toBe(false);
    expect(result.diagnostics).toContain("live_process_getter_unavailable");
    expect(native.calls.map(([method]) => method)).toEqual(["thread/read", "thread/items/read"]);
  });

  it("requests a fresh owner-confirmed stall for its exact job episode", async () => {
    const kinds = ["process", "container", "browser_job"];
    const entries = await Promise.all(
      kinds.map((kind) =>
        row({ jobs: [job({ kind, owner_evidence: evidence({ confirmed_stalled: true }) })] }),
      ),
    );
    for (const entry of entries) {
      expect(entry.state).toBe("stalled");
      expect(entry.requires_owner_action).toBe(true);
      expect(entry.stall_episode).toBe("episode-1");
      expect(entry.start_identity).toBe("owner-start-1");
      expect(entry.invocation).toEqual(invocation());
    }
  });

  it("never requests closure of protected, service, waiting or terminal jobs", async () => {
    const states = ["service", "waiting_on_user", "terminal", "unknown"];
    const cases = [
      job({ protected: true, owner_evidence: evidence({ confirmed_stalled: true }) }),
      ...states.map((state) =>
        job({ owner_evidence: evidence({ state, confirmed_stalled: true }) }),
      ),
    ];
    const entries = await Promise.all(cases.map((value) => row({ jobs: [value] })));
    for (const entry of entries) {
      expect(entry.requires_owner_action).toBe(false);
      expect(entry.state).not.toBe("stalled");
    }
  });

  it("does not treat the same owner timestamp across slots as new progress evidence", async () => {
    const value = job({
      owner_evidence: evidence({ progress: progress(), blocked_condition: blocked() }),
    });
    const before = await collect({ jobs: [value], slot: NOW, now: NOW + 5 });
    const after = await collect({
      jobs: [value],
      slot: NOW + 60,
      now: NOW + 65,
      prior: before.observations,
    });
    expect(first(before).requires_owner_action).toBe(false);
    expect(first(after).requires_owner_action).toBe(false);
    expect(first(after).state).not.toBe("stalled");
  });

  it("needs two distinct observations of expected progress and a corroborated block", async () => {
    const old = job({
      owner_evidence: evidence({
        confirmed_at: timestamp(1860),
        progress: progress(),
        blocked_condition: blocked(),
      }),
    });
    const { observations: prior } = await collect({
      jobs: [old],
      slot: NOW - 1800,
      now: NOW - 1795,
    });
    const current = job({
      owner_evidence: evidence({ progress: progress(), blocked_condition: blocked() }),
    });
    const stalled = await row({ jobs: [current], slot: NOW, now: NOW + 5, prior });
    expect(stalled.requires_owner_action).toBe(true);
    expect(stalled.state).toBe("stalled");
    const changes: Json[] = [
      { progress: progress({ counter: 11 }) },
      { progress: progress({ counter: 9 }) },
      { progress: progress({ epoch: "new" }) },
      { progress: progress({ contract_id: "new" }) },
      { progress: progress({ expected_to_advance: false }) },
      { progress: progress({ counter: true }) },
      { blocked_condition: null },
      { blocked_condition: blocked({ confirmed: false }) },
      { blocked_condition: blocked({ evidence_id: "different" }) },
      { episode_id: "new" },
      { confirmed_at: timestamp(1900) },
      { confirmed_at: timestamp(1801) },
    ];
    const rows = await Promise.all(
      changes.map((change) => {
        const fields = { progress: progress(), blocked_condition: blocked(), ...change };
        return row({ jobs: [job({ owner_evidence: evidence(fields) })], prior });
      }),
    );
    expect(rows.map((entry) => entry.requires_owner_action)).toEqual(changes.map(() => false));
    const early = await row({ jobs: [current], slot: NOW - 1800, now: NOW - 1795, prior });
    expect(early.requires_owner_action).toBe(false);
    const changed = structuredClone(prior);
    (changed[0] as Json).start_identity = "reused-handle-new-start";
    expect((await row({ jobs: [current], prior: changed })).requires_owner_action).toBe(false);
  });

  it("accepts prior owner evidence fresh at capture across thirty minutes of jitter", async () => {
    const oldSlot = NOW - 1800;
    const old = job({
      owner_evidence: evidence({
        confirmed_at: timestamp(1900),
        progress: progress(),
        blocked_condition: blocked(),
      }),
    });
    const { observations: prior } = await collect({
      jobs: [old],
      slot: oldSlot,
      now: oldSlot + 10,
    });
    expect(prior).toHaveLength(1);
    const [sample] = prior as [Json];
    const confirmedAt = (sample.owner_evidence as Json).confirmed_at as string;
    expect(NOW + 15 - Date.parse(confirmedAt) / 1000).toBeGreaterThan(1800);
    const current = job({
      owner_evidence: evidence({ progress: progress(), blocked_condition: blocked() }),
    });
    const result = await collect({ jobs: [current], slot: NOW, now: NOW + 15, prior });
    expect(first(result).requires_owner_action).toBe(true);
    const variants: Json[] = [
      { collected_at: timestamp(1790 + 60) },
      { collected_at: timestamp(-60) },
      { slot: oldSlot + 1 },
      { provenance: "native_verified" },
      {
        owner_evidence: evidence({
          confirmed_at: timestamp(3701),
          progress: progress(),
          blocked_condition: blocked(),
        }),
      },
      {
        owner_evidence: evidence({
          confirmed_at: timestamp(1700),
          progress: progress(),
          blocked_condition: blocked(),
        }),
      },
    ];
    const rows = await Promise.all(
      variants.map((changes) =>
        row({
          jobs: [current],
          slot: NOW,
          now: NOW + 15,
          prior: [{ ...structuredClone(sample), ...changes }],
        }),
      ),
    );
    expect(rows.map((entry) => entry.requires_owner_action)).toEqual(variants.map(() => false));
    const missing = structuredClone(sample);
    delete missing.collected_at;
    expect((await row({ jobs: [current], prior: [missing] })).requires_owner_action).toBe(false);
  });

  it("never synthesizes scheduled samples for a null slot", async () => {
    const old = job({
      owner_evidence: evidence({
        confirmed_at: timestamp(1860),
        progress: progress(),
        blocked_condition: blocked(),
      }),
    });
    const { observations: prior } = await collect({
      jobs: [old],
      slot: NOW - 1800,
      now: NOW - 1795,
    });
    const current = job({
      owner_evidence: evidence({ progress: progress(), blocked_condition: blocked() }),
    });
    const observed = await collect({ jobs: [current], slot: null, prior });
    expect(observed.observations).toEqual([]);
    expect(first(observed).requires_owner_action).toBe(false);
    const confirmed = await collect({
      jobs: [job({ owner_evidence: evidence({ confirmed_stalled: true }) })],
      slot: null,
    });
    expect(first(confirmed).requires_owner_action).toBe(true);
    expect(confirmed.observations).toEqual([]);
  });

  it("keeps confirmation references independent of scheduled sample emission", async () => {
    const value = job({
      owner_evidence: evidence({
        confirmed_stalled: true,
        progress: progress(),
        blocked_condition: blocked(),
        unrelated: PRIVATE,
      }),
    });
    const expected = {
      confirmed_by: P,
      confirmed_at: timestamp(),
      episode_id: "episode-1",
      blocked_condition: { code: "deadlock", evidence_id: "diagnostic-1" },
    };
    const cases: [number | null, number][] = [
      [null, NOW],
      [NOW, NOW + 61],
    ];
    const results = await Promise.all(
      cases.map(([slot, now]) => collect({ jobs: [value], slot, now })),
    );
    for (const result of results) {
      expect(result.observations).toEqual([]);
      const entry = first(result);
      expect(entry.requires_owner_action).toBe(true);
      expect(entry.owner_evidence_ref).toEqual(expected);
      expect(entry.owner_evidence_ref).not.toHaveProperty("progress");
    }
    const native = new Native();
    native.parent = OTHER;
    expect((await row({ jobs: [value], native })).owner_evidence_ref).toBeNull();
    (value.owner_evidence as Json).confirmed_at = timestamp(1801);
    expect((await row({ jobs: [value] })).owner_evidence_ref).toBeNull();
  });

  it("never infers a stall or closure from stasis, native status or exit code", async () => {
    const native = new Native();
    native.status = "completed";
    native.exitCode = 0;
    const completed = await row({
      jobs: [job({ owner_evidence: evidence({ progress: progress() }) })],
      native,
    });
    expect(completed.state).toBe("running");
    expect(completed.requires_owner_action).toBe(false);
    expect(completed.closure_status).toBe("none");
    native.missing = true;
    const missing = await row({ native });
    expect(missing.state).toBe("unknown");
    expect(missing.closure_status).toBe("unknown");
  });

  it("fails closed on wrong scope, lineage, invocation or missing identity", async () => {
    const native = new Native();
    await collect({ jobs: [job({ owner_parent_id: OTHER })], native });
    expect(native.calls).toEqual([]);
    const results = await Promise.all(
      [
        { start_identity: "" },
        { worker_id: OTHER },
        { kind: [] },
        { invocation: invocation(OTHER) },
      ].map((changes) => collect({ jobs: [job(changes)] })),
    );
    for (const result of results) {
      expect(result.jobs.some((entry) => entry.requires_owner_action)).toBe(false);
    }
    const parent = new Native();
    parent.parent = OTHER;
    const source = new Native();
    source.sourceParent = OTHER;
    for (const entry of await Promise.all([row({ native: parent }), row({ native: source })])) {
      expect(entry.lineage_verified).toBe(false);
      expect(entry.requires_owner_action).toBe(false);
    }
    const wrong = new Native();
    wrong.wrongItem = true;
    expect((await row({ native: wrong })).invocation_verified).toBe(false);
  });

  it("requires fresh, owner-confirmed, identity-verified owner attestation", async () => {
    const invalid = await Promise.all(
      [
        { confirmed_at: timestamp(1801) },
        { confirmed_at: timestamp(-1) },
        { confirmed_by: OTHER },
        { identity_verified: false },
        { provenance: "native_verified" },
        { state: [] },
      ].map((change) =>
        row({ jobs: [job({ owner_evidence: evidence({ confirmed_stalled: true, ...change }) })] }),
      ),
    );
    for (const entry of invalid) {
      expect(entry.state).toBe("unknown");
      expect(entry.requires_owner_action).toBe(false);
    }
    const fresh = [0, 1800].map((age) =>
      job({ owner_evidence: evidence({ confirmed_at: timestamp(age), confirmed_stalled: true }) }),
    );
    const valid = await Promise.all(fresh.map((value) => row({ jobs: [value] })));
    expect(valid.map((entry) => entry.requires_owner_action)).toEqual([true, true]);
  });

  it("reports owner-attested delivery and closure reports", async () => {
    const states = ["requested", "delivery_accepted", "ambiguous", "reported_closed"];
    const stalled = evidence({ confirmed_stalled: true });
    const value = (state: string) => job({ closure: receipt(state), owner_evidence: stalled });
    const entries = await Promise.all(states.map((state) => row({ jobs: [value(state)] })));
    expect(entries.map((entry) => entry.closure_status)).toEqual(states);
    for (const [index, entry] of entries.entries()) {
      expect(entry.closure_provenance).toBe("owner_attested");
      expect(entry.closure_evidence_id).toBe("closure-1");
      expect(entry.requires_owner_action).toBe(states[index] !== "reported_closed");
    }
  });

  it("separates an owner-verified closure corroborated by its native result", async () => {
    const value = job({
      closure: receipt("verified_closed", {
        owner_verified: true,
        verification_succeeded: true,
        native_result_ref: invocation(P, "verification"),
      }),
    });
    const verified = await row({ jobs: [value] });
    expect(verified.closure_status).toBe("verified_closed");
    expect(verified.closure_provenance).toBe("owner_verified_native_result_corroborated");
    expect(verified.closure_result_ref).toMatchObject({ item_id: "verification" });
    const downgraded = await Promise.all(
      [
        { owner_verified: false },
        { verification_succeeded: false },
        { native_result_ref: invocation(OTHER, "verification") },
        { native_result_ref: invocation() },
      ].map((changes) => {
        const changed = structuredClone(value);
        Object.assign(changed.closure as Json, changes);
        return row({ jobs: [changed] });
      }),
    );
    expect(downgraded.map((entry) => entry.closure_status)).toEqual(
      Array(4).fill("reported_closed"),
    );
    const native = new Native();
    native.verifyExit = 1;
    expect((await row({ jobs: [value], native })).closure_status).toBe("reported_closed");
  });

  it("binds closure receipts to the exact identity and keeps blocker and retention", async () => {
    const unbound = await Promise.all(
      [
        { start_identity: "reused" },
        { job_id: "other" },
        { confirmed_by: OTHER },
        { confirmed_at: timestamp(1801) },
        { invocation: invocation(C, "other") },
      ].map((change) => row({ jobs: [job({ closure: receipt("reported_closed", change) })] })),
    );
    expect(unbound.map((entry) => entry.closure_status)).toEqual(Array(5).fill("unknown"));
    for (const state of ["blocked", "retained"]) {
      const value = job({
        owner_evidence: evidence({ confirmed_stalled: true }),
        closure: receipt(state, { reason_code: "owner_question_pending", next_review_slot: 300 }),
      });
      // The second read depends on removing the reason code after the first.
      // eslint-disable-next-line no-await-in-loop
      const entry = await row({ jobs: [value] });
      expect(entry.closure_status).toBe(state);
      expect(entry.requires_owner_action).toBe(false);
      expect(entry.closure_reason_code).toBe("owner_question_pending");
      if (state === "retained") {
        expect(entry.closure_next_review_slot).toBe(300);
      }
      delete (value.closure as Json).reason_code;
      // This read follows the removal above.
      // eslint-disable-next-line no-await-in-loop
      expect((await row({ jobs: [value] })).closure_status).toBe("unknown");
    }
  });

  it("bounds jobs and bytes, rejects duplicates and never echoes raw fields", async () => {
    const value = job({ owner_evidence: evidence({ confirmed_stalled: true }), command: PRIVATE });
    (value.owner_evidence as Json).output = PRIVATE;
    const duplicated = await collect({ jobs: [value, structuredClone(value)] });
    expect(first(duplicated).requires_owner_action).toBe(false);
    expect(duplicated.observations).toEqual([]);
    const oversized = { version: 1, jobs: [], unknown: "x".repeat(MAX_BYTES) };
    expect((await collect({ manifest: oversized })).status).toBe("unavailable");
    const many = Array.from({ length: 101 }, (_, index) => job({ job_id: `job-${index}` }));
    const bounded = await collect({ jobs: many });
    expect(bounded.jobs).toHaveLength(100);
    expect(bounded.omitted_jobs).toBe(1);
    expect(bounded.complete).toBe(false);
  });

  it("never bypasses denied visibility, the deadline or the shared call budget", async () => {
    const denied = new Native();
    denied.failure = "thread/read";
    expect((await row({ native: denied })).state).toBe("unknown");
    expect(denied.calls).toHaveLength(1);
    const late = new Native();
    late.deadline = 99;
    const output = await collectProcessHealth(
      late,
      { version: 1, jobs: [job()] },
      [P],
      200,
      null,
      clock(),
    );
    expect(late.calls).toEqual([]);
    expect(late.deadline).toBe(99);
    expect(first(output[P] as unknown as Health).state).toBe("unknown");
    const native = new Native();
    const budget = await collect({ native, maxCalls: 1 });
    expect(native.calls).toHaveLength(1);
    expect(budget.budget.exhausted).toBe(true);
    expect(first(budget).requires_owner_action).toBe(false);
  });

  it("latches a timeout across jobs without leaking the native failure", async () => {
    const native = new Native();
    native.timeout = true;
    const result = await collect({ jobs: [job(), job({ job_id: "other" })], native });
    expect(native.timeoutCalls).toBe(1);
    expect(result.budget.reason_code).toBe("native_timeout");
    expect(result.jobs.every((entry) => entry.state === "unknown")).toBe(true);
    expect(result.observations).toEqual([]);
  });

  it("reads no child for a parent-owned invocation and validates scope first", async () => {
    const native = new Native();
    const value = job({ worker_id: null, invocation: invocation(P) });
    expect((await row({ jobs: [value], native })).invocation_verified).toBe(true);
    expect(native.calls.map(([method]) => method)).toEqual(["thread/items/read"]);
    for (const parents of [[P, P], ["invalid"], [null]]) {
      const scoped = new Native();
      const pending = collectProcessHealth(scoped, {}, parents as string[], 200, null, clock());
      // Each rejection is checked before its client's calls.
      // eslint-disable-next-line no-await-in-loop
      await expect(pending).rejects.toThrow("invalid_parent_scope");
      expect(scoped.calls).toEqual([]);
    }
    const manifest = { version: true, jobs: [] };
    expect((await collect({ manifest })).status).toBe("unavailable");
  });
});

const TECH = "00000000-0000-4000-8000-000000000005";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "process-health-"));
}

function manifestFile(directory: string, jobs: unknown[] = []): string {
  const path = join(directory, "process-health.json");
  writeFileSync(path, JSON.stringify({ version: 1, jobs }));
  return path;
}

describe("processHealth", () => {
  it("is disabled without a manifest path and calls nothing", async () => {
    const native = new Native();
    expect(await processHealth(native, undefined, [TECH], null, null)).toEqual([
      {},
      { status: "disabled", diagnostics: [] },
    ]);
    expect(native.calls).toEqual([]);
  });

  it("reports bad paths, bounds and schemas without reading resources", async () => {
    const directory = scratch();
    const valid = manifestFile(directory);
    const oversized = join(directory, "oversized.json");
    writeFileSync(oversized, "x".repeat(MAX_BYTES + 1));
    const alias = join(directory, "alias.json");
    symlinkSync(valid, alias);
    const invalid = join(directory, "invalid.json");
    writeFileSync(invalid, "{PRIVATE_BAD_JSON");
    const tooMany = join(directory, "too-many.json");
    writeFileSync(tooMany, JSON.stringify({ version: 1, jobs: Array(101).fill({}) }));
    const folder = join(directory, "folder.json");
    mkdirSync(folder);
    const cases: [string, string][] = [
      ["relative.json", "process_manifest_path_invalid"],
      [join(directory, "missing.json"), "process_manifest_unavailable"],
      [oversized, "process_manifest_size_exceeded"],
      [alias, "process_manifest_unavailable"],
      [invalid, "process_manifest_unavailable"],
      [tooMany, "process_manifest_schema_unavailable"],
      [folder, "process_manifest_not_regular"],
    ];
    const native = new Native();
    const results = await Promise.all(
      cases.map(([path]) => processHealth(native, path, [TECH], null, null)),
    );
    expect(results).toEqual(
      cases.map(([, code]) => [
        {
          [TECH]: {
            status: "unavailable",
            complete: false,
            jobs: [],
            observations: [],
            diagnostics: [code],
            omitted_jobs: 0,
          },
        },
        { status: "unavailable", diagnostics: [code] },
      ]),
    );
    expect(JSON.stringify(results)).not.toContain("PRIVATE_BAD_JSON");
    expect(native.calls).toEqual([]);
  });

  it("reports an empty route scope as unavailable", async () => {
    const path = manifestFile(scratch());
    expect(await processHealth(new Native(), path, [], null, null)).toEqual([
      {},
      { status: "unavailable", diagnostics: ["process_route_unavailable"] },
    ]);
  });

  it("returns health only for the scoped parents", async () => {
    const path = manifestFile(scratch());
    const [health, source] = await processHealth(new Native(), path, [TECH], null, null);
    expect(Object.keys(health)).toEqual([TECH]);
    expect(health[TECH]).toMatchObject({ status: "complete", jobs: [], observations: [] });
    expect(source).toEqual({ status: "available", diagnostics: [] });
  });

  it("reports a collector failure for each parent", async () => {
    const path = manifestFile(scratch());
    const [health, source] = await processHealth(new Native(), path, ["invalid"], null, null);
    expect(health).toEqual({
      invalid: {
        status: "unavailable",
        complete: false,
        jobs: [],
        observations: [],
        diagnostics: ["process_collector_unavailable"],
        omitted_jobs: 0,
      },
    });
    expect(source).toEqual({
      status: "unavailable",
      diagnostics: ["process_collector_unavailable"],
    });
  });

  it("keeps public and scheduled provenance and closure through the real collector", async () => {
    const now = 1800000030;
    const slot = 1800000000;
    const stamp = `${new Date((now - 10) * 1000).toISOString().slice(0, 19)}+00:00`;
    const launch = { thread_id: TECH, turn_id: "launch-turn", item_id: "launch-item" };
    const value: Json = {
      owner_parent_id: TECH,
      worker_id: null,
      kind: "process",
      job_id: "job-1",
      start_identity: "start-1",
      invocation: launch,
      owner_evidence: {
        confirmed_by: TECH,
        confirmed_at: stamp,
        identity_verified: true,
        provenance: "owner_attested",
        state: "running",
        confirmed_stalled: true,
        episode_id: "episode-1",
      },
    };
    const directory = scratch();
    const calls: unknown[] = [];
    const client: RpcClient = {
      async call(method: string, params: unknown): Promise<unknown> {
        calls.push(params);
        expect(method).toBe("thread/items/read");
        expect(params).toEqual({
          threadId: TECH,
          turnId: "launch-turn",
          itemIds: ["launch-item"],
        });
        return {
          data: [
            {
              turnId: "launch-turn",
              item: {
                id: "launch-item",
                type: "commandExecution",
                status: "completed",
                exitCode: 0,
                command: "PRIVATE_COMMAND",
                aggregatedOutput: "PRIVATE_COMMAND",
              },
            },
          ],
        };
      },
      close(): void {
        // Nothing to release.
      },
    };
    const path = manifestFile(directory, [value]);
    const at = (seconds: number): ProcessHealthOptions => ({ now: () => seconds });
    const [open] = await processHealth(client, path, [TECH], null, null, at(now));
    const publicHealth = open[TECH] as unknown as Health;
    expect(publicHealth.observations).toEqual([]);
    expect(first(publicHealth).state).toBe("stalled");
    expect(first(publicHealth).closure_status).toBe("none");
    const [scheduled] = await processHealth(client, path, [TECH], slot, null, at(now));
    const health = scheduled[TECH] as unknown as Health;
    expect(first(health).identity_provenance).toBe("owner_attested");
    const [sample] = health.observations;
    expect(sample?.collected_at).toBe(`${new Date(now * 1000).toISOString().slice(0, 19)}+00:00`);
    expect(sample?.provenance).toBe("owner_attested");
    expect(processSample([TECH], sample)).toBe(true);
    expect(processSample([P], sample)).toBe(false);
    expect(processSample([TECH], { ...sample, extra: true })).toBe(false);
    expect(JSON.stringify(scheduled)).not.toContain("PRIVATE_COMMAND");
    const [outside] = await processHealth(client, path, [TECH], slot, null, at(now + 90));
    expect((outside[TECH] as unknown as Health).observations).toEqual([]);
    const { invocation: launched, job_id, kind, owner_parent_id, start_identity } = value;
    value.closure = {
      owner_parent_id,
      kind,
      job_id,
      start_identity,
      invocation: launched,
      confirmed_by: TECH,
      confirmed_at: stamp,
      provenance: "owner_attested",
      state: "reported_closed",
      evidence_id: "owner-closure-1",
    };
    manifestFile(directory, [value]);
    const [closed] = await processHealth(client, path, [TECH], slot, null, at(now));
    expect(first(closed[TECH] as unknown as Health).closure_status).toBe("reported_closed");
    expect(calls.length).toBeGreaterThan(0);
  });
});
