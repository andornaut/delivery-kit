import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { IntakeStore } from "../accounting/intake.ts";
import type { LedgerSource, LedgerTransaction } from "../accounting/types.ts";
import { startFakeControl } from "../adapters/codex/testControlSocket.ts";
import { main } from "../cli.ts";
import { loadLayout } from "../layout.ts";
import { createRegistry, type Registry } from "../registry/index.ts";
import { CODEX_TECH, makeFixture, registryInput, writeFixtureJson } from "../testFixtures.ts";

const AT = "2026-11-16T01:00:00.000Z";
const ROLE = "archies-dog-walks/tech";
const SOURCE: LedgerSource = {
  native: null,
  origin: "unknown",
  reference: null,
  wordingHash: null,
};

function setup() {
  const test = makeFixture();
  const layout = loadLayout(test.root);
  createRegistry(layout, registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">);
  return { ...test, env: {} as NodeJS.ProcessEnv, layout };
}

async function run(test: ReturnType<typeof setup>, ...args: string[]) {
  let out = "";
  let err = "";
  const code = await main(
    {
      cwd: test.base,
      env: { CLAUDE_BIN: "/never/run", CODEX_CONTROL_SOCKET: "/never/connect", ...test.env },
      err: (value) => {
        err += value;
      },
      out: (value) => {
        out += value;
      },
    },
    [...args, "--root", test.root],
  );
  return { code, err, out };
}

function intake(): LedgerTransaction {
  return {
    actor: "game-coordinator",
    at: AT,
    command: {
      request: {
        assignment: null,
        dependencies: [],
        id: "request-one",
        kind: "unknown",
        parentId: null,
        question: null,
        reviewed: false,
        source: SOURCE,
        summary: "A question or request awaiting owner review",
        targets: [],
      },
      type: "register",
    },
    commandId: "intake-one",
    expectedRevision: 0,
    schema: 1,
    source: SOURCE,
  };
}

async function submit(test: ReturnType<typeof setup>, verb: string, input: LedgerTransaction) {
  writeFileSync(join(test.base, "input.json"), JSON.stringify(input));
  return run(test, "ledger", verb, "--input-file", "input.json");
}

describe("ledger public CLI", () => {
  it("preserves an unknown intake, exact deduplication and revision conflicts through the core port", async () => {
    const test = setup();
    const registry = readFileSync(test.layout.registryFile);
    const input = intake();
    const first = await submit(test, "intake", input);
    expect(first).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse(first.out)).toMatchObject({ commandId: input.commandId, revision: 1 });
    expect(await submit(test, "intake", input)).toEqual(first);
    const conflict = await submit(test, "apply", { ...input, commandId: "another-command" });
    expect(conflict).toEqual({
      code: 1,
      err: '{"error":{"code":"stale-revision"},"ok":false}\n',
      out: "",
    });
    const shown = await run(test, "ledger", "show", "--id", "request-one");
    expect(JSON.parse(shown.out)).toMatchObject({
      kind: "unknown",
      ownerBinding: { status: "unassigned" },
      reviewed: false,
      source: SOURCE,
      state: "open",
    });
    const history = await run(test, "ledger", "history", "--id", "request-one");
    expect(JSON.parse(history.out)).toHaveLength(1);
    const report = await run(test, "ledger", "report", "--at", AT);
    expect(JSON.parse(report.out)).toMatchObject({
      at: AT,
      coverageState: "incomplete",
      revision: 1,
      untriaged: ["request-one"],
    });
    const coverage = await submit(test, "reconcile", {
      ...input,
      command: {
        coverage: {
          gaps: [{ from: null, reason: "history unavailable", through: null }],
          id: "history-gap",
          nextBoundary: "next owner review",
          ownerRole: "game-coordinator",
          range: { from: null, through: null },
          source: SOURCE,
          state: "unavailable",
        },
        type: "coverage",
      },
      commandId: "coverage-one",
      expectedRevision: 1,
    });
    expect(coverage).toMatchObject({ code: 0, err: "" });
    const windows = await run(test, "ledger", "coverage", "--owner", "game-coordinator");
    expect(JSON.parse(windows.out)).toMatchObject([{ id: "history-gap", state: "unavailable" }]);
    const offer = new IntakeStore({
      directory: join(test.layout.varDir, "accounting", "intake"),
    }).offer({
      actor: "game-coordinator",
      source: SOURCE,
      command: {
        type: "capture",
        requests: [],
        coverage: [
          {
            gaps: [{ from: null, reason: "history unavailable", through: null }],
            id: "pending-gap",
            nextBoundary: "next owner review",
            ownerRole: "game-coordinator",
            range: { from: null, through: null },
            source: SOURCE,
            state: "unavailable",
          },
        ],
      },
    });
    const pending = {
      status: "available",
      reason: null,
      offers: [
        {
          id: offer.id,
          commandId: `intake-${offer.id}`,
          requiredOwner: "game-coordinator",
        },
      ],
    };
    expect(JSON.parse((await run(test, "ledger", "report", "--at", AT)).out).pendingIntake).toEqual(
      pending,
    );
    expect(
      JSON.parse((await run(test, "ledger", "show", "--id", "request-one")).out).pendingIntake,
    ).toEqual(pending);
    writeFileSync(
      join(test.layout.varDir, "accounting", "events", "000000000001.json"),
      "PRIVATE_CORRUPT_FIXTURE",
    );
    const unavailable = await run(test, "ledger", "report", "--at", AT);
    expect(unavailable.code).toBe(1);
    expect(unavailable.out).toBe("");
    expect(JSON.parse(unavailable.err)).toMatchObject({
      error: { code: "corrupt-ledger" },
      ok: false,
      pendingIntake: { offers: null, reason: "ledger-unavailable", status: "unavailable" },
    });
    expect(unavailable.err).not.toContain("PRIVATE_CORRUPT_FIXTURE");
    expect(readFileSync(test.layout.registryFile)).toEqual(registry);
    expect(existsSync(join(test.layout.reviewDir, "messages"))).toBe(false);
  });

  it("refuses malformed file input and options without exposing input text or creating events", async () => {
    const test = setup();
    const file = join(test.base, "input.json");
    writeFileSync(file, '{"PRIVATE_INPUT":');
    expect(await run(test, "ledger", "intake", "--input-file", "input.json")).toEqual({
      code: 1,
      err: '{"error":{"code":"invalid-ledger-json"},"ok":false}\n',
      out: "",
    });
    writeFileSync(file, Buffer.concat([Buffer.from("PRIVATE_INPUT"), Buffer.from([0xc3, 0x28])]));
    expect(await run(test, "ledger", "apply", "--input-file", "input.json")).toEqual({
      code: 1,
      err: '{"error":{"code":"invalid-ledger-encoding"},"ok":false}\n',
      out: "",
    });
    const duplicate = await run(
      test,
      "ledger",
      "apply",
      "--input-file",
      "input.json",
      "--input-file",
      "input.json",
    );
    expect(duplicate).toEqual({
      code: 2,
      err: '{"error":{"code":"invalid-ledger-options"},"ok":false}\n',
      out: "",
    });
    expect((await run(test, "ledger", "report")).code).toBe(2);
    expect((await run(test, "ledger", "report", "--at", "2026-02-30T00:00:00Z")).code).toBe(2);
    expect(existsSync(join(test.layout.varDir, "accounting", "events"))).toBe(false);
  });

  it("corroborates worker assignments using only fresh native lineage and current parent routing", async () => {
    const test = setup();
    const input = intake();
    const registry = registryInput();
    registry.harness = "codex";
    writeFixtureJson(test.layout.registryFile, { ...registry, revision: 2, updatedAt: AT });
    const assignment = {
      harness: "codex" as const,
      nativeId: CODEX_TECH,
      ownerRole: ROLE,
      worker: null,
    };
    const registered = await submit(test, "intake", {
      ...input,
      actor: ROLE,
      command: {
        request: {
          ...(input.command as Extract<LedgerTransaction["command"], { type: "register" }>).request,
          assignment,
        },
        type: "register",
      },
    });
    expect(registered).toMatchObject({ code: 0, err: "" });
    const current = await run(test, "ledger", "show", "--id", "request-one");
    expect(JSON.parse(current.out)).toMatchObject({
      assignment,
      ownerBinding: {
        currentRole: { harness: "codex", nativeId: CODEX_TECH, role: ROLE },
        registryRevision: 2,
        status: "current",
      },
    });
    registry.harness = "claude";
    writeFixtureJson(test.layout.registryFile, { ...registry, revision: 3, updatedAt: AT });
    const stale = await run(test, "ledger", "report", "--at", AT, "--owner", ROLE);
    expect(JSON.parse(stale.out)).toMatchObject({
      requests: [
        {
          assignment,
          ownerBinding: {
            currentRole: { harness: "claude", role: ROLE },
            reason: "harness-changed",
            registryRevision: 3,
            status: "stale",
          },
        },
      ],
    });
    registry.harness = "codex";
    writeFixtureJson(test.layout.registryFile, { ...registry, revision: 4, updatedAt: AT });
    const workerInput: LedgerTransaction = {
      ...input,
      actor: ROLE,
      command: {
        assignment: {
          ...assignment,
          nativeId: "00000000-0000-4000-8000-000000000099",
          worker: {
            id: "00000000-0000-4000-8000-000000000099",
            parentNativeId: CODEX_TECH,
            parentRole: ROLE,
            verificationRef: "asserted-proof-only",
          },
        },
        id: "request-one",
        type: "assign",
      },
      commandId: "worker-assignment",
      expectedRevision: 1,
    };
    let correct = false;
    const server = await startFakeControl(test.base, (method, params) => {
      expect(method).toBe("thread/read");
      expect(params).toEqual({
        includeTurns: false,
        threadId: "00000000-0000-4000-8000-000000000099",
      });
      const parent = correct ? CODEX_TECH : "00000000-0000-4000-8000-000000000098";
      return {
        result: {
          thread: {
            id: "00000000-0000-4000-8000-000000000099",
            parentThreadId: parent,
            source: { subAgent: { thread_spawn: { parent_thread_id: parent } } },
          },
        },
      };
    });
    test.env.CODEX_CONTROL_SOCKET = server.path;
    try {
      const rejected = await submit(test, "apply", workerInput);
      expect(rejected).toEqual({
        code: 1,
        err: '{"error":{"code":"owner-unavailable"},"ok":false}\n',
        out: "",
      });
      expect(
        JSON.parse((await run(test, "ledger", "history", "--id", "request-one")).out),
      ).toHaveLength(1);
      correct = true;
      const accepted = await submit(test, "apply", workerInput);
      expect(accepted).toMatchObject({ code: 0, err: "" });
      expect(JSON.parse(accepted.out)).toMatchObject({ revision: 2 });
      expect(server.methods()).toEqual(["thread/read", "thread/read", "thread/read"]);
      const workerView = await run(test, "ledger", "show", "--id", "request-one");
      expect(JSON.parse(workerView.out)).toMatchObject({
        ownerBinding: {
          reason: "worker-lineage-unverified",
          status: "unavailable",
          workerLineage: "not-checked",
        },
      });
      expect(server.methods()).toHaveLength(3);
      registry.harness = "claude";
      writeFixtureJson(test.layout.registryFile, { ...registry, revision: 5, updatedAt: AT });
      const changed = await submit(test, "apply", {
        ...workerInput,
        command: {
          id: "request-one",
          nextBoundary: "next owner review",
          reason: "owner began work",
          requiredOwner: ROLE,
          state: "started",
          type: "progress",
        },
        commandId: "work-started",
        expectedRevision: 2,
      });
      expect(changed).toEqual({
        code: 1,
        err: '{"error":{"code":"owner-unavailable"},"ok":false}\n',
        out: "",
      });
      expect(server.methods()).toHaveLength(3);
    } finally {
      await server.close();
    }
  });

  it("captures a role-scoped boundary while reporting incomplete accounting independently", async () => {
    const test = setup();
    const registry = readFileSync(test.layout.registryFile);
    const result = await run(
      test,
      "ledger",
      "boundary",
      "--role",
      "game-coordinator",
      "--phase",
      "resume",
    );
    expect(result).toMatchObject({ code: 1, err: "" });
    expect(JSON.parse(result.out)).toMatchObject({ accounting_ready: false, status: "available" });
    const coverage = JSON.parse((await run(test, "ledger", "coverage")).out) as {
      ownerRole: string;
    }[];
    expect(coverage.length).toBeGreaterThan(0);
    expect(coverage.every((row) => row.ownerRole === "game-coordinator")).toBe(true);
    expect(readFileSync(test.layout.registryFile)).toEqual(registry);
    expect(existsSync(join(test.layout.reviewDir, "messages"))).toBe(false);
    const fakeSnapshot = await run(
      test,
      "ledger",
      "boundary",
      "--role",
      "game-coordinator",
      "--phase",
      "review",
      "--input-file",
      "claimed-history.json",
    );
    expect(fakeSnapshot.code).toBe(2);
    const registered = registryInput();
    registered.harness = "codex";
    writeFixtureJson(test.layout.registryFile, { ...registered, revision: 2, updatedAt: AT });
    let reroute = false;
    const server = await startFakeControl(test.base, (method, params) => {
      expect(method).toBe("thread/items/list");
      expect(params).toEqual({ limit: 100, sortDirection: "desc", threadId: CODEX_TECH });
      if (reroute) {
        writeFixtureJson(test.layout.registryFile, {
          ...registered,
          harness: "claude",
          revision: 3,
          updatedAt: AT,
        });
      }
      return {
        result: {
          data: [
            {
              item: {
                content: [{ text: "PRIVATE_SYNTHETIC_BODY", type: "inputText" }],
                id: reroute ? "observed-before-reroute" : "observed-item",
                type: "userMessage",
              },
              turnId: "observed-turn",
            },
          ],
          nextCursor: null,
        },
      };
    });
    const connected = { ...test, env: { ...test.env, CODEX_CONTROL_SOCKET: server.path } };
    try {
      const captured = await run(
        connected,
        "ledger",
        "boundary",
        "--role",
        ROLE,
        "--phase",
        "startup",
      );
      expect(captured).toMatchObject({ code: 1, err: "" });
      expect(JSON.parse(captured.out)).toMatchObject({
        accounting_ready: false,
        status: "available",
      });
      expect(captured.out).not.toContain("PRIVATE_SYNTHETIC_BODY");
      expect(server.methods()).toEqual(["thread/items/list"]);
      const report = await run(
        connected,
        "ledger",
        "report",
        "--at",
        new Date().toISOString(),
        "--owner",
        ROLE,
      );
      const projection = JSON.parse(report.out) as {
        requests: { kind: string; reviewed: boolean; source: LedgerSource }[];
      };
      expect(report.out).not.toContain("PRIVATE_SYNTHETIC_BODY");
      expect(projection.requests).toHaveLength(1);
      expect(projection.requests[0]).toMatchObject({
        kind: "unknown",
        reviewed: false,
        source: {
          native: {
            harness: "codex",
            threadId: CODEX_TECH,
            turnId: "observed-turn",
            itemId: "observed-item",
          },
          origin: "unknown",
        },
      });
      reroute = true;
      await run(connected, "ledger", "boundary", "--role", ROLE, "--phase", "resume");
      const offers = new IntakeStore({
        directory: join(test.layout.varDir, "accounting", "intake"),
      }).pending([], [ROLE]);
      expect(
        offers.some((offer) =>
          offer.command.requests.some(
            (request) => request.source.native?.itemId === "observed-before-reroute",
          ),
        ),
      ).toBe(true);
      expect(server.methods()).toEqual(["thread/items/list", "thread/items/list"]);
    } finally {
      await server.close();
    }
  });
});
