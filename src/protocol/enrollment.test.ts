import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as durable from "../durable.ts";
import { ProtocolStore, protocolWorkerRole } from "./core.ts";
import {
  type EnrollmentContext,
  type EnrollmentInput,
  type EnrollmentParticipant,
  type EnrollmentReference,
  type EnrollmentScope,
  EnrollmentStore,
  type EnrollmentUnknown,
} from "./enrollment.ts";
import type { Binding } from "./types.ts";

const ROLE = "kits/delivery-kit";
const OTHER = "kits/game-kit";
const AT = "2026-11-16T06:00:00.000Z";
const OWNER: Binding = { harness: "codex", nativeId: "00000000-0000-4000-8000-000000000001" };
const CHILD: Binding = { harness: "codex", nativeId: "00000000-0000-4000-8000-000000000002" };
const KNOWN: EnrollmentReference = { key: "request:actual-id", kind: "request" };

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "enrollment-"));
  const bindings = new Map([[ROLE, OWNER]]);
  const protocol = new ProtocolStore({
    directory,
    resolveBinding: (role, binding) =>
      JSON.stringify(bindings.get(role)) === JSON.stringify(binding),
  });
  const store = new EnrollmentStore({ protocol });
  await protocol.claim({
    at: AT,
    binding: OWNER,
    evidence: "owner:claim",
    expectedEpoch: 0,
    role: ROLE,
  });
  const evidence = await protocol.putArtifact(Buffer.from("owner inspection evidence"));
  const participant: EnrollmentParticipant = {
    binding: OWNER,
    epoch: 1,
    knownReferences: [KNOWN],
    parentRole: null,
    requiredUnknownScopes: [],
    role: ROLE,
  };
  const scope: EnrollmentScope = {
    generation: 1,
    ledgerAnchors: [{ hash: null, revision: 0 }],
    participants: [participant],
    phase: "prepared",
    registryRevision: 1,
    workspaceId: "fixture-workspace",
  };
  const input = (selected: EnrollmentScope = scope): EnrollmentInput => ({
    evidence: [evidence],
    generation: selected.generation,
    inspectedAt: AT,
    ledger: selected.ledgerAnchors[0]!,
    phase: selected.phase,
    references: [KNOWN],
    registryRevision: selected.registryRevision,
    unknowns: [],
    workspaceId: selected.workspaceId,
  });
  const context = (id = "enroll", role = ROLE): EnrollmentContext => {
    const state = protocol.read(role);
    return {
      at: AT,
      binding: state.binding!,
      epoch: state.epoch,
      expectedRevision: state.revision,
      id,
      role,
    };
  };
  const unknown = (
    participantRole: string,
    parentRole: string,
    scope = "participant",
  ): EnrollmentUnknown => ({
    evidence: [evidence],
    id: `unknown:${participantRole}:${scope}`,
    nextBoundary: "next owner review",
    parentRole,
    participantRole,
    reason: "supported observation unavailable",
    scope,
  });
  return {
    bindings,
    context,
    directory,
    evidence,
    input,
    participant,
    protocol,
    scope,
    store,
    unknown,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("managed work enrollment", () => {
  it("keeps an absent roster unrepresented and rejects empty or unanchored attestations without writes", async () => {
    const f = await fixture();
    expect(f.store.report(f.scope)).toMatchObject({
      allAdopted: false,
      allRepresented: false,
      coverageComplete: false,
      missing: [ROLE],
    });
    await expect(
      f.store.publish(f.context(), { ...f.input(), references: [] }, f.scope),
    ).rejects.toMatchObject({ code: "empty-enrollment" });
    await expect(
      f.store.publish(
        f.context(),
        { ...f.input(), ledger: { hash: "a".repeat(64), revision: 1 } },
        f.scope,
      ),
    ).rejects.toMatchObject({ code: "enrollment-ledger-mismatch" });
    await expect(
      f.store.publish(
        f.context(),
        { ...f.input(), references: [{ key: "not-observed", kind: "original" }] },
        f.scope,
      ),
    ).rejects.toMatchObject({ code: "enrollment-reference-mismatch" });
    await expect(
      f.store.publish(
        f.context(),
        { ...f.input(), evidence: [{ hash: f.evidence.hash, size: 1 }] },
        f.scope,
      ),
    ).rejects.toMatchObject({ code: "enrollment-evidence-mismatch" });
    expect(f.protocol.read(ROLE).revision).toBe(1);
    expect(f.store.read(ROLE)).toBeUndefined();
    expect(() => f.store.report({ ...f.scope, participants: [] })).toThrow(
      "enrollment-roster-required",
    );
  });

  it("replays after restart and accepts ledger prefixes across unrelated appends", async () => {
    const f = await fixture();
    const context = f.context();
    const event = await f.store.publish(context, f.input(), f.scope);
    const reader = new EnrollmentStore({ protocol: new ProtocolStore({ directory: f.directory }) });
    expect(reader.read(ROLE)).toMatchObject({ epoch: 1, references: [KNOWN] });
    expect(await f.store.publish(context, f.input(), f.scope)).toEqual(event);
    await expect(
      f.store.publish(context, { ...f.input(), inspectedAt: "2026-11-16T05:59:00.000Z" }, f.scope),
    ).rejects.toMatchObject({ code: "transaction-conflict" });
    const later = {
      ...f.scope,
      ledgerAnchors: [...f.scope.ledgerAnchors, { hash: "b".repeat(64), revision: 1 }],
      registryRevision: 2,
    };
    expect(reader.report(later)).toMatchObject({
      allAdopted: false,
      allRepresented: true,
      coverageComplete: true,
    });
    expect(
      reader.report({
        ...later,
        participants: [
          { ...f.participant, knownReferences: [KNOWN, { key: "work:new", kind: "work" }] },
        ],
      }),
    ).toMatchObject({
      allRepresented: true,
      coverageComplete: false,
      omitted: [{ reference: { key: "work:new", kind: "work" }, role: ROLE }],
      uncovered: [{ reference: { key: "work:new", kind: "work" }, role: ROLE }],
    });
    expect(
      reader.report({ ...later, ledgerAnchors: [{ hash: "c".repeat(64), revision: 1 }] }).stale,
    ).toContainEqual({ reason: "enrollment-ledger-mismatch", role: ROLE });
  });

  it("keeps an active receipt adopted for later references but not for references it omitted", async () => {
    const f = await fixture();
    const later: EnrollmentReference = { key: "original:later", kind: "original" };
    const omitted: EnrollmentReference = { key: "work:omitted", kind: "work" };
    const active: EnrollmentScope = {
      ...f.scope,
      participants: [{ ...f.participant, knownReferences: [KNOWN, omitted] }],
      phase: "active",
    };
    await f.store.publish(f.context(), f.input(active), active);
    expect(f.store.report(active)).toMatchObject({
      allAdopted: false,
      allRepresented: false,
      omitted: [{ reference: omitted, role: ROLE }],
      uncovered: [],
    });
    const complete = { ...active, participants: [f.participant] };
    await f.store.publish(f.context("complete"), f.input(complete), complete);
    const grown = {
      ...complete,
      participants: [{ ...f.participant, knownReferences: [KNOWN, later] }],
    };
    expect(f.store.report(grown)).toMatchObject({
      allAdopted: true,
      allRepresented: true,
      coverageComplete: false,
      omitted: [{ reference: later, role: ROLE }],
      uncovered: [{ reference: later, role: ROLE }],
    });
    const anchor = f.protocol
      .read(ROLE)
      .objects.find((object) => object.id === "enrollment-anchor")!;
    // A receipt rewritten without its anchor, as an older writer would, is checked strictly.
    await f.protocol.transact({
      ...f.context("unanchored"),
      mutations: [
        {
          collection: "intake",
          expectedRevision: f.protocol.read(ROLE).objects.find((o) => o.id === "enrollment")!
            .revision,
          id: "enrollment",
          value: {
            ...(f.store.read(ROLE) as unknown as Record<string, never>),
            inspectedAt: "2026-11-16T05:00:00.000Z",
          },
        },
      ],
    });
    expect(f.protocol.read(ROLE).objects.find((o) => o.id === "enrollment-anchor")).toEqual(anchor);
    expect(f.store.report(grown)).toMatchObject({ allAdopted: false, uncovered: [] });
  });

  it("represents an unavailable owner only through its designated parent without fabricating adoption", async () => {
    const f = await fixture();
    const absent: EnrollmentParticipant = {
      binding: null,
      epoch: null,
      knownReferences: [],
      parentRole: ROLE,
      requiredUnknownScopes: ["native-history"],
      role: OTHER,
    };
    const scope = { ...f.scope, participants: [f.participant, absent] };
    const input = { ...f.input(), unknowns: [f.unknown(OTHER, ROLE)] };
    await f.store.publish(f.context(), input, scope);
    expect(f.store.report(scope)).toMatchObject({
      allAdopted: false,
      allRepresented: true,
      coverageComplete: false,
      participants: expect.arrayContaining([
        { adopted: false, represented: true, revision: null, role: OTHER },
      ]),
    });
    expect(f.protocol.read(OTHER)).toMatchObject({ binding: null, epoch: 0, objects: [] });
    await expect(
      f.store.publish(
        f.context("wrong-parent"),
        { ...input, unknowns: [f.unknown(OTHER, OTHER)] },
        scope,
      ),
    ).rejects.toMatchObject({ code: "enrollment-parent-mismatch" });
    const dynamic = {
      ...scope,
      participants: [...scope.participants, { ...absent, role: "kits/art-kit" }],
    };
    expect(f.store.report(dynamic).missing).toEqual(["kits/art-kit"]);
    expect(f.store.report({ ...scope, phase: "active" }).allAdopted).toBe(false);
  });

  it("requires active revalidation and fences a previously adopted owner after native ownership changes", async () => {
    const f = await fixture();
    await f.store.publish(f.context(), f.input(), f.scope);
    const active: EnrollmentScope = { ...f.scope, phase: "active" };
    expect(f.store.report(active)).toMatchObject({ allAdopted: false, allRepresented: false });
    await f.store.publish(f.context("active"), f.input(active), active);
    expect(f.store.report(active)).toMatchObject({
      allAdopted: true,
      allRepresented: true,
      coverageComplete: true,
    });
    const next: Binding = { harness: "claude", nativeId: "00000000-0000-4000-8000-000000000003" };
    f.bindings.set(ROLE, next);
    await f.protocol.claim({
      at: AT,
      binding: next,
      evidence: "owner:handoff",
      expectedEpoch: 1,
      role: ROLE,
    });
    const moved = { ...active, participants: [{ ...f.participant, binding: next, epoch: 2 }] };
    expect(f.store.report(moved)).toMatchObject({
      allAdopted: false,
      stale: [{ reason: "enrollment-binding-mismatch", role: ROLE }],
    });
    await expect(
      f.store.publish({ ...f.context("stale"), binding: OWNER, epoch: 1 }, f.input(active), active),
    ).rejects.toMatchObject({ code: "enrollment-binding-mismatch" });
  });

  it("accounts for verified workers in their own namespace and rejects old parent epochs", async () => {
    const f = await fixture();
    const workerRole = protocolWorkerRole(ROLE, CHILD.nativeId, 1);
    f.bindings.set(workerRole, CHILD);
    await f.protocol.claim({
      at: AT,
      binding: CHILD,
      evidence: "worker:verified-lineage",
      expectedEpoch: 0,
      parent: { epoch: 1, role: ROLE, workerId: CHILD.nativeId },
      role: workerRole,
    });
    const scope: EnrollmentScope = {
      ...f.scope,
      participants: [
        f.participant,
        {
          binding: CHILD,
          epoch: 1,
          knownReferences: [{ key: "submission:child", kind: "submission" }],
          parentRole: ROLE,
          requiredUnknownScopes: [],
          role: workerRole,
        },
      ],
      phase: "active",
    };
    await f.store.publish(f.context(), f.input(scope), scope);
    expect(f.store.report(scope).missing).toEqual([workerRole]);
    const parentBefore = f.protocol.read(ROLE);
    await f.store.publish(
      f.context("worker-enroll", workerRole),
      { ...f.input(scope), references: scope.participants[1]!.knownReferences },
      scope,
    );
    expect(f.protocol.read(ROLE)).toEqual(parentBefore);
    expect(f.store.report(scope).allAdopted).toBe(true);
    await f.protocol.claim({
      at: AT,
      binding: OWNER,
      evidence: "parent:rotate",
      expectedEpoch: 1,
      role: ROLE,
    });
    expect(f.store.report(scope).allAdopted).toBe(false);
    await expect(
      f.store.publish(
        f.context("worker-stale", workerRole),
        { ...f.input(scope), references: scope.participants[1]!.knownReferences },
        scope,
      ),
    ).rejects.toMatchObject({ code: "enrollment-parent-mismatch" });
  });

  it("retains native and worker-census gaps and protected question metadata after adoption", async () => {
    const f = await fixture();
    const question = { key: "native-question:turn/item:pending", kind: "question" as const };
    const hold = { key: "independent-hold:owner-ref", kind: "hold" as const };
    const scope: EnrollmentScope = {
      ...f.scope,
      participants: [
        {
          ...f.participant,
          knownReferences: [KNOWN, question, hold],
          requiredUnknownScopes: ["native-history", "worker-census"],
        },
      ],
      phase: "active",
    };
    await f.store.publish(
      f.context(),
      { ...f.input(scope), references: [KNOWN, question, hold] },
      scope,
    );
    expect(f.store.report(scope).allRepresented).toBe(false);
    const input = {
      ...f.input(scope),
      references: [KNOWN, question, hold],
      unknowns: [f.unknown(ROLE, ROLE, "native-history"), f.unknown(ROLE, ROLE, "worker-census")],
    };
    await f.store.publish(f.context("unknowns"), input, scope);
    expect(f.store.report(scope)).toMatchObject({
      allAdopted: true,
      allRepresented: true,
      coverageComplete: false,
      unknowns: input.unknowns,
    });
    expect(f.store.read(ROLE)?.references).toEqual([KNOWN, question, hold]);
    expect(
      f.protocol
        .read(ROLE)
        .objects.map((object) => [object.collection, object.id])
        .sort(),
    ).toEqual([
      ["intake", "enrollment"],
      ["intake", "enrollment-anchor"],
    ]);
  });

  it("serializes competing attestations and recovers an interrupted publication by exact replay", async () => {
    const f = await fixture();
    const context = f.context();
    const results = await Promise.allSettled([
      f.store.publish(context, f.input(), f.scope),
      f.store.publish({ ...context, id: "competing" }, f.input(), f.scope),
    ]);
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(1);
    const next = f.context("retry-after-interruption");
    const original = durable.writeJsonDurable;
    const spy = vi.spyOn(durable, "writeJsonDurable").mockImplementation((path, value) => {
      if (path.includes("/events/")) {
        throw new Error("fixture publication interrupted");
      }
      original(path, value);
    });
    await expect(f.store.publish(next, f.input(), f.scope)).rejects.toThrow(
      "fixture publication interrupted",
    );
    spy.mockRestore();
    const before = f.protocol.read(ROLE).revision;
    const event = await f.store.publish(next, f.input(), f.scope);
    expect(event.revision).toBe(before + 1);
    expect(await f.store.publish(next, f.input(), f.scope)).toEqual(event);
    expect(
      readFileSync(
        join(
          f.directory,
          "roles",
          ROLE,
          "events",
          `${String(event.revision).padStart(12, "0")}.json`,
        ),
        "utf8",
      ),
    ).toContain('"enrollment"');
  });

  it("refuses a focused report only when the focus role's journal changes during the report", async () => {
    const f = await fixture();
    await f.store.publish(f.context(), f.input(), f.scope);
    const original = f.protocol.read.bind(f.protocol);
    let reads = 0;
    vi.spyOn(f.protocol, "read").mockImplementation((role) => {
      const state = original(role);
      reads += 1;
      return reads >= 3 ? { ...state, revision: state.revision + 1 } : state;
    });
    expect(() => f.store.report(f.scope, { role: ROLE })).toThrow("enrollment-source-changed");
    reads = 0;
    expect(f.store.report(f.scope, { role: OTHER })).toMatchObject({ allRepresented: true });
  });
});
