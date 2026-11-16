// Synthetic owner-attested fixtures exercise the public CLI, not native human-history capture.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect } from "vitest";

import { execute, impl, type Result } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { CodexSocket } from "../lib/codex-socket.ts";
import type { Json } from "../lib/json.ts";
import { type Workspace, writeJson } from "../lib/workspace.ts";

const AT = "2026-11-16T00:00:00.000Z";
const OWNER = "game-kit";
const NATIVE = "00000000-0000-4000-8000-000000000031";
const WORKER = "00000000-0000-4000-8000-000000000032";
const SOURCE = {
  origin: "owner-attested",
  reference: "fixture:reviewed-owner-input",
  native: null,
  wordingHash: null,
};

function request(id = randomUUID(), change: Json = {}): Json {
  return {
    id,
    summary: "Synthetic accounting fixture",
    kind: "request",
    reviewed: true,
    source: SOURCE,
    assignment: null,
    parentId: null,
    dependencies: [],
    targets: [
      {
        id: "answer",
        description: "A scoped answer",
        consumers: [],
        criteria: [{ id: "answer", description: "Answer reviewed", requiredEvidence: ["answer"] }],
      },
    ],
    question: null,
    ...change,
  };
}

function fixture(ws: Workspace) {
  if (ws.registry().roles[OWNER] === undefined) {
    ws.writeRegistry({
      schema: 1,
      revision: 1,
      harness: "codex",
      roles: {
        [OWNER]: { conversations: { codex: NATIVE } },
        "art-kit": { conversations: { codex: WORKER } },
      },
    });
  }
  let revision = 0;
  const command = (verb: string, args: string[] = []) =>
    execute(impl.bare(ws, ["ledger", verb, ...args, "--root", ws.coordinator]));
  const transaction = (operation: Json, expectedRevision = revision, actor = OWNER): Json => ({
    schema: 1,
    commandId: randomUUID(),
    expectedRevision,
    actor,
    at: AT,
    source: SOURCE,
    command: operation,
  });
  const send = (input: Json, verb = "apply") => {
    const file = join(ws.root, `accounting-${randomUUID()}.json`);
    writeJson(file, input);
    return command(verb, ["--input-file", file]);
  };
  const value = (result: Result): Json => {
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as Json;
  };
  const apply = async (operation: Json, verb = "apply"): Promise<Json> => {
    const event = value(await send(transaction(operation), verb));
    expect(event.revision).toBe(revision + 1);
    revision = event.revision;
    return event;
  };
  const reject = async (operation: Json, code: string) => {
    const result = await send(transaction(operation));
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ error: { code }, ok: false });
    return result;
  };
  const show = async (id: string) => value(await command("show", ["--id", id]));
  const evidence = (id: string, evidenceId: string, change: Json = {}) =>
    apply({
      type: "evidence",
      id,
      evidence: {
        id: evidenceId,
        targetId: "answer",
        criterionId: "answer",
        kind: "answer",
        consumer: null,
        outcome: "passed",
        reference: `fixture:evidence:${evidenceId}`,
        ...change,
      },
    });
  return { apply, command, evidence, reject, send, show, transaction, value };
}

suite("request accounting", () => {
  const workspace = workspaces();
  const sockets: CodexSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) await socket.close();
  });

  contract("exact command replay and concurrent CAS survive independent CLI reloads", async () => {
    const ws = workspace();
    const ledger = fixture(ws);
    const original = request();
    const intake = ledger.transaction({ type: "register", request: original });
    const first = ledger.value(await ledger.send(intake, "intake"));
    expect(first.revision).toBe(1);
    expect(ledger.value(await ledger.send(intake, "intake"))).toEqual(first);
    const conflict = await ledger.send({ ...intake, actor: "art-kit" }, "intake");
    expect(conflict.code).not.toBe(0);
    expect(conflict.stderr).toContain("command-conflict");
    expect(conflict.stdout).toBe("");

    const candidates = [request(), request()];
    const contenders = candidates.map((item) =>
      ledger.transaction({ type: "register", request: item }, 1),
    );
    const results = await Promise.all(contenders.map((input) => ledger.send(input, "intake")));
    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    expect(results.filter((result) => result.code !== 0)).toHaveLength(1);
    const winner = results.findIndex((result) => result.code === 0);
    const accepted = ledger.value(results[winner]!);
    expect(accepted).toMatchObject({ revision: 2, previousHash: first.hash });
    const loser = results.find((result) => result.code !== 0)!;
    expect(loser.stderr).toContain("stale-revision");
    expect(loser.stdout).toBe("");
    expect(ledger.value(await ledger.send(contenders[winner]!, "intake"))).toEqual(accepted);

    const report = ledger.value(await ledger.command("report", ["--at", AT]));
    expect(report).toMatchObject({ initialized: true, revision: 2, hash: accepted.hash });
    expect(report.requests.map((item: Json) => item.id).sort()).toEqual(
      [original.id, candidates[winner]!.id].sort(),
    );
    const history = await ledger.command("history", ["--id", original.id]);
    expect(history.code, history.stderr).toBe(0);
    expect(JSON.parse(history.stdout)).toEqual([first]);
  });

  contract(
    "mixed targets and consumers close only after scoped cancellation and sibling evidence",
    async () => {
      const ledger = fixture(workspace());
      const parent = request(randomUUID(), {
        targets: [
          {
            id: "sdk",
            description: "SDK and consumer adoption",
            consumers: ["archie/tech", "chibi/tech"],
            criteria: [
              {
                id: "delivery",
                description: "Checked adoption",
                requiredEvidence: ["check", "consumer-adoption"],
              },
            ],
          },
          {
            id: "docs",
            description: "Reviewed operating instructions",
            consumers: [],
            criteria: [
              { id: "review", description: "Instructions reviewed", requiredEvidence: ["review"] },
            ],
          },
        ],
      });
      const cancelled = request(randomUUID(), { parentId: parent.id });
      const sibling = request(randomUUID(), { parentId: parent.id });
      await ledger.apply({ type: "register", request: parent }, "intake");
      await ledger.apply({
        type: "progress",
        id: parent.id,
        state: "ready",
        reason: "Fixture handoff ready",
        requiredOwner: null,
        nextBoundary: null,
      });
      await ledger.reject(
        { type: "close", id: parent.id, evidenceIds: [], reason: "Ready is not complete" },
        "incomplete-evidence",
      );
      await ledger.evidence(parent.id, "check", {
        targetId: "sdk",
        criterionId: "delivery",
        kind: "check",
      });
      await ledger.evidence(parent.id, "archie", {
        targetId: "sdk",
        criterionId: "delivery",
        kind: "consumer-adoption",
        consumer: "archie/tech",
      });
      await ledger.evidence(parent.id, "docs", {
        targetId: "docs",
        criterionId: "review",
        kind: "review",
      });
      await ledger.reject(
        {
          type: "close",
          id: parent.id,
          evidenceIds: ["check", "archie", "docs"],
          reason: "Chibi remains unadopted",
        },
        "incomplete-evidence",
      );
      await ledger.evidence(parent.id, "chibi", {
        targetId: "sdk",
        criterionId: "delivery",
        kind: "consumer-adoption",
        consumer: "chibi/tech",
      });
      for (const item of [cancelled, sibling])
        await ledger.apply({ type: "register", request: item }, "intake");
      await ledger.apply({
        type: "cancel",
        id: cancelled.id,
        descendants: [],
        reason: "Only this child withdrawn",
        authorityRef: "fixture:explicit-scoped-cancellation",
      });
      expect((await ledger.show(cancelled.id)).state).toBe("cancelled");
      expect((await ledger.show(sibling.id)).state).toBe("open");
      const closeParent = {
        type: "close",
        id: parent.id,
        evidenceIds: ["check", "archie", "chibi", "docs"],
        reason: "Every required target proved",
      };
      await ledger.reject(closeParent, "unresolved-children");
      await ledger.evidence(sibling.id, "answer");
      await ledger.apply({
        type: "close",
        id: sibling.id,
        evidenceIds: ["answer"],
        reason: "Scoped answer supplied",
      });
      await ledger.apply(closeParent);
      expect((await ledger.show(parent.id)).state).toBe("completed");
      await ledger.reject(
        {
          type: "reopen",
          id: sibling.id,
          reason: "Answer needs revision",
          evidenceRef: "fixture:regression",
        },
        "reopen-dependent-first",
      );
      await ledger.apply({
        type: "reopen",
        id: parent.id,
        reason: "Child regression",
        evidenceRef: "fixture:regression",
      });
      await ledger.apply({
        type: "reopen",
        id: sibling.id,
        reason: "Answer needs revision",
        evidenceRef: "fixture:regression",
      });
      expect((await ledger.show(parent.id)).state).toBe("open");
      expect((await ledger.show(cancelled.id)).state).toBe("cancelled");
      const history = await ledger.command("history", ["--id", parent.id]);
      expect(history.code, history.stderr).toBe(0);
      expect(JSON.parse(history.stdout).map((event: Json) => event.command.type)).toContain(
        "close",
      );
    },
  );

  contract(
    "owner identity and pending questions remain guarded without mutating native state",
    async () => {
      const ws = workspace();
      ws.writeRegistry({
        schema: 1,
        revision: 1,
        harness: "codex",
        roles: { [OWNER]: { conversations: { codex: NATIVE } } },
      });
      let parent = "00000000-0000-4000-8000-000000000099";
      const socket = new CodexSocket(ws).on("thread/read", (params: Json) => {
        expect(params).toEqual({ includeTurns: false, threadId: WORKER });
        return {
          thread: {
            id: WORKER,
            parentThreadId: parent,
            source: { subAgent: { thread_spawn: { parent_thread_id: parent } } },
          },
        };
      });
      await socket.listen();
      sockets.push(socket);
      ws.env.CODEX_CONTROL_SOCKET = socket.path;
      const ledger = fixture(ws);
      const decisionPath = join("unblock", "decisions", `${NATIVE}.json`);
      const decision = JSON.stringify({ thread_id: NATIVE, state: "pending", fixtureOnly: true });
      ws.write(decisionPath, decision);
      const item = request(randomUUID(), {
        question: {
          native: null,
          text: "Synthetic unresolved decision",
          options: ["Keep", "Change"],
          status: "pending",
          resolutionRef: null,
        },
      });
      await ledger.apply({ type: "register", request: item }, "intake");
      const assignment = { ownerRole: OWNER, harness: "codex", nativeId: NATIVE, worker: null };
      await ledger.apply({ type: "assign", id: item.id, assignment });
      const before = await ledger.show(item.id);
      const wrongOwner = await ledger.send(
        ledger.transaction({
          type: "assign",
          id: item.id,
          assignment: { ...assignment, nativeId: WORKER },
        }),
      );
      expect(wrongOwner.code).not.toBe(0);
      expect(wrongOwner.stdout).toBe("");
      expect(await ledger.show(item.id)).toEqual(before);
      const unverifiedWorker = await ledger.send(
        ledger.transaction({
          type: "assign",
          id: item.id,
          assignment: {
            ...assignment,
            nativeId: WORKER,
            worker: {
              id: WORKER,
              parentRole: OWNER,
              parentNativeId: NATIVE,
              verificationRef: "fixture:unverified-claim",
            },
          },
        }),
      );
      expect(unverifiedWorker.code).not.toBe(0);
      expect(await ledger.show(item.id)).toEqual(before);
      parent = NATIVE;
      const workerAssignment = {
        ...assignment,
        nativeId: WORKER,
        worker: {
          id: WORKER,
          parentRole: OWNER,
          parentNativeId: NATIVE,
          verificationRef: "fixture:dual-parent-lineage",
        },
      };
      await ledger.apply({ type: "assign", id: item.id, assignment: workerAssignment });
      expect((await ledger.show(item.id)).assignment).toEqual(workerAssignment);
      await ledger.evidence(item.id, "answer");
      await ledger.reject(
        {
          type: "close",
          id: item.id,
          evidenceIds: ["answer"],
          reason: "Evidence does not answer the question",
        },
        "question-guarded",
      );
      const registry = readFileSync(join(ws.coordinator, "var", "registry.json"), "utf8");
      const beforeReroute = await ledger.show(item.id);
      const rerouted = "00000000-0000-4000-8000-000000000099";
      ws.writeRegistry({
        ...ws.registry(),
        revision: 2,
        roles: { [OWNER]: { conversations: { codex: rerouted } } },
      });
      await ledger.reject(
        { type: "assign", id: item.id, assignment: { ...assignment, nativeId: rerouted } },
        "owner-unavailable",
      );
      const afterReroute = await ledger.show(item.id);
      expect(afterReroute.ownerBinding).toEqual({
        status: "stale",
        reason: "worker-parent-changed",
        registryRevision: 2,
        currentRole: { role: OWNER, harness: "codex", nativeId: rerouted },
        workerLineage: "not-checked",
      });
      expect({ ...afterReroute, ownerBinding: beforeReroute.ownerBinding }).toEqual(beforeReroute);
      writeFileSync(join(ws.coordinator, "var", "registry.json"), registry);
      await ledger.apply({
        type: "cancel",
        id: item.id,
        descendants: [],
        reason: "Work withdrawn, not a native answer",
        authorityRef: "fixture:scoped-user-cancellation",
      });
      expect((await ledger.show(item.id)).question).toEqual(item.question);
      expect(
        ledger.value(await ledger.command("report", ["--at", AT])).protectedQuestions,
      ).toContain(item.id);
      expect(readFileSync(join(ws.coordinator, "var", "registry.json"), "utf8")).toBe(registry);
      expect(ws.read(decisionPath)).toBe(decision);
      expect(ws.calls("claude")).toEqual([]);
      expect(socket.callsOf("thread/read").length).toBeGreaterThan(1);
      expect(
        socket
          .methods()
          .every((method) => ["initialize", "initialized", "thread/read"].includes(method)),
      ).toBe(true);
    },
  );

  contract(
    "unknown intake and unsupported Claude history cannot imply complete human coverage",
    async () => {
      const ledger = fixture(workspace());
      const absent = ledger.value(await ledger.command("report", ["--at", AT]));
      expect(absent).toMatchObject({ initialized: false, revision: 0, coverageState: "unknown" });
      const unknown = { origin: "unknown", reference: null, native: null, wordingHash: null };
      const item = request(randomUUID(), {
        source: unknown,
        kind: "unknown",
        reviewed: false,
        targets: [],
      });
      await ledger.apply({ type: "register", request: item }, "intake");
      await ledger.apply({
        type: "coverage",
        coverage: {
          id: "claude-history",
          ownerRole: OWNER,
          source: SOURCE,
          range: { from: null, through: null },
          state: "unavailable",
          gaps: [{ from: null, through: null, reason: "No supported native Claude history API" }],
          nextBoundary: "Owner review at the next normal boundary",
        },
      });
      const report = ledger.value(await ledger.command("report", ["--at", AT]));
      expect(report.coverageState).toBe("incomplete");
      expect(report.unknownSource).toContain(item.id);
      expect(report.untriaged).toContain(item.id);
      expect((await ledger.show(item.id)).source.native).toBeNull();
      await ledger.reject(
        {
          type: "coverage",
          coverage: {
            id: "fabricated-complete",
            ownerRole: OWNER,
            source: unknown,
            range: { from: null, through: null },
            state: "covered",
            gaps: [],
            nextBoundary: null,
          },
        },
        "invalid-coverage",
      );
      const coverage = await ledger.command("coverage", ["--owner", OWNER]);
      expect(coverage.code, coverage.stderr).toBe(0);
      expect(JSON.parse(coverage.stdout)).toHaveLength(1);
      expect(JSON.parse(coverage.stdout)[0]).toMatchObject({
        state: "unavailable",
        range: { from: null, through: null },
      });
      await ledger.apply({
        type: "classify",
        id: item.id,
        kind: "request",
        reviewed: true,
        reason: "Explicit synthetic owner review, not native human-origin inference",
      });
      await ledger.apply({
        type: "amend",
        id: item.id,
        summary: "A bounded owner-reviewed answer",
        targets: request().targets,
        dependencies: [],
        reason: "Define criteria after intake without rewriting provenance",
      });
      await ledger.apply({
        type: "link",
        id: item.id,
        link: {
          id: "owner-attestation",
          relation: "attestation",
          source: SOURCE,
          candidateId: null,
        },
      });
      const reviewed = await ledger.show(item.id);
      expect(reviewed.source).toEqual(unknown);
      expect(reviewed.sources).toContainEqual({
        id: "owner-attestation",
        relation: "attestation",
        source: SOURCE,
        candidateId: null,
      });
      expect(ledger.value(await ledger.command("report", ["--at", AT])).coverageState).toBe(
        "incomplete",
      );
    },
  );
});
