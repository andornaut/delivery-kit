import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startFakeControl } from "../adapters/codex/testControlSocket.ts";
import { main } from "../cli.ts";
import { loadLayout } from "../layout.ts";
import { ProtocolStore, protocolWorkerRole } from "../protocol/core.ts";
import type { EnrollmentInput } from "../protocol/enrollment.ts";
import { importProtocolMigration, planProtocolMigration } from "../protocol/migration.ts";
import { createRegistry, type Registry, updateRegistry } from "../registry/index.ts";
import { CLAUDE_COORDINATOR, CODEX_TECH, makeFixture, registryInput } from "../testFixtures.ts";
const AT = "2026-11-16T04:00:00.000Z";
async function fixture() {
  const t = makeFixture();
  const layout = loadLayout(t.root);
  createRegistry(layout, registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">);
  const stateRoot = join(t.base, "external-protocol");
  await importProtocolMigration(
    layout,
    planProtocolMigration(layout, { expectedGeneration: 0, stateRoot, workspaceId: "fixture" }),
  );
  let sequence = 0;
  const env = { CODEX_CONTROL_SOCKET: "/never/connect" };
  const file = (value: unknown) => {
    const path = join(t.base, `input-${sequence++}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  async function run(...args: string[]) {
    let out = "",
      err = "";
    const code = await main(
      {
        cwd: t.base,
        env,
        err: (value) => {
          err += value;
        },
        out: (value) => {
          out += value;
        },
      },
      [...args, "--root", t.root],
    );
    return { code, err, out };
  }
  return { ...t, env, file, layout, run, stateRoot };
}
describe("supported protocol CLI", () => {
  it("enrolls only its verified worker through exact parent reads, retaining partial census", async () => {
    const t = await fixture();
    const parentRole = "games/archies-dog-walks/tech";
    updateRegistry(t.layout, 1, (draft) => {
      draft.roles["archies-dog-walks/tech"]!.harness = "codex";
    });
    const protocol = new ProtocolStore({ directory: t.stateRoot, resolveBinding: () => true });
    await protocol.claim({
      at: AT,
      binding: { harness: "codex", nativeId: CODEX_TECH },
      evidence: "fixture:parent",
      expectedEpoch: 0,
      role: parentRole,
    });
    const id = "00000000-0000-4000-8000-000000000099";
    const role = protocolWorkerRole(parentRole, id, 1);
    const binding = { harness: "codex" as const, nativeId: id };
    await protocol.claim({
      at: AT,
      binding,
      evidence: "fixture:worker",
      expectedEpoch: 0,
      parent: { epoch: 1, role: parentRole, workerId: id },
      role,
    });
    // Active pointer setup is synthetic; migration prerequisites have their own end-to-end fixture.
    const config = {
      generation: 1,
      required: { authorityRef: "fixture:mandatory" },
      schema: 1,
      stateRoot: t.stateRoot,
      workspaceId: "fixture",
    };
    writeFileSync(
      join(t.stateRoot, "workspace.json"),
      JSON.stringify({
        generation: 1,
        required: config.required,
        schema: 1,
        workspaceId: "fixture",
      }),
    );
    for (const name of ["work-protocol-fence.json", "work-protocol.json"]) {
      writeFileSync(join(t.layout.varDir, name), JSON.stringify(config));
    }
    const evidence = await protocol.putArtifact(
      Buffer.from("fixture worker retains unknown source"),
    );
    const input: EnrollmentInput = {
      evidence: [evidence],
      generation: 1,
      inspectedAt: AT,
      ledger: { hash: null, revision: 0 },
      phase: "active",
      references: [],
      registryRevision: 2,
      unknowns: ["external-wip", "native-history"].map((scope, index) => ({
        evidence: [evidence],
        id: `worker-unknown-${index}`,
        nextBoundary: "next parent review",
        parentRole,
        participantRole: role,
        reason: "unavailable",
        scope,
      })),
      workspaceId: "fixture",
    };
    let correct = false;
    const server = await startFakeControl(t.base, (method, params) => {
      expect(method).toBe("thread/read");
      expect(params).toEqual({ includeTurns: false, threadId: id });
      const parent = correct ? CODEX_TECH : "00000000-0000-4000-8000-000000000098";
      return {
        result: {
          thread: {
            id,
            parentThreadId: parent,
            source: { subAgent: { thread_spawn: { parent_thread_id: parent } } },
          },
        },
      };
    });
    t.env.CODEX_CONTROL_SOCKET = server.path;
    const file = t.file({
      context: { at: AT, binding, epoch: 1, expectedRevision: 1, id: "worker-enrollment", role },
      input,
    });
    try {
      const rejected = await t.run(
        "protocol",
        "enroll",
        "--state-root",
        t.stateRoot,
        "--input-file",
        file,
      );
      expect(rejected.code).toBe(1);
      expect(protocol.history(role)).toHaveLength(1);
      correct = true;
      const accepted = await t.run(
        "protocol",
        "enroll",
        "--state-root",
        t.stateRoot,
        "--input-file",
        file,
      );
      expect(accepted, accepted.err).toMatchObject({ code: 0 });
      const value = JSON.parse(accepted.out);
      expect(
        value.report.participants.find((p: { role: string }) => p.role === role),
      ).toMatchObject({ adopted: true, represented: true });
      expect(
        value.scope.participants.find((p: { role: string }) => p.role === parentRole)
          .requiredUnknownScopes,
      ).toContain("worker-census");
      const boundary = await t.run(
        "protocol",
        "boundary",
        "--role",
        "archies-dog-walks/tech",
        "--worker",
        id,
        "--phase",
        "startup",
        "--at",
        AT,
      );
      expect(boundary, boundary.err).toMatchObject({ code: 0 });
      const rows = JSON.parse(boundary.out).enrollment.report.participants;
      expect(rows.find((p: { role: string }) => p.role === role).adopted).toBe(true);
      expect(rows.find((p: { role: string }) => p.role === parentRole).adopted).toBe(false);
      correct = false;
      const staleBoundary = await t.run(
        "protocol",
        "boundary",
        "--role",
        "archies-dog-walks/tech",
        "--worker",
        id,
        "--phase",
        "startup",
        "--at",
        AT,
      );
      expect(staleBoundary.code).toBe(1);
      expect(server.methods().length).toBeGreaterThan(1);
      expect(server.methods().every((method) => method === "thread/read")).toBe(true);
    } finally {
      await server.close();
    }
  });
  it("publishes and reads an exact original with scoped unknown coverage", async () => {
    const t = await fixture();
    const binding = { harness: "claude", nativeId: CLAUDE_COORDINATOR };
    const claim = await t.run(
      "protocol",
      "claim",
      "--state-root",
      t.stateRoot,
      "--input-file",
      t.file({ at: AT, binding, evidence: "fixture:owner", expectedEpoch: 0, role: "coordinator" }),
    );
    expect(claim, claim.err).toMatchObject({ code: 0 });
    const body = "\uFEFFExact reference message\n";
    const published = await t.run(
      "protocol",
      "message-publish",
      "--state-root",
      t.stateRoot,
      "--input-file",
      t.file({
        input: {
          envelope: {
            body,
            created: AT,
            fromRole: "game-coordinator",
            id: "cli-message",
            intent: "queue",
            schema: 1,
            toRole: "archies-dog-walks/tech",
          },
          guards: { artifacts: [], hold: "unknown", question: "unknown", references: [] },
          links: { clauseIds: [], messageIds: [], requestIds: [], workIds: [] },
        },
        writer: {
          at: AT,
          binding,
          epoch: 1,
          expectedRevision: 1,
          id: "cli-publish",
          role: "coordinator",
        },
      }),
    );
    expect(published, published.err).toMatchObject({ code: 0 });
    const result = JSON.parse(published.out) as {
      result: unknown;
      boundary: {
        after: {
          scope: {
            nativeHistory: string;
          };
        };
      };
    };
    expect(result.boundary.after.scope.nativeHistory).toBe("not-collected");
    const reference = t.file(result.result);
    const metadata = await t.run(
      "protocol",
      "message-original",
      "--state-root",
      t.stateRoot,
      "--input-file",
      reference,
    );
    expect(metadata.code).toBe(0);
    expect(metadata.out).not.toContain("Exact reference message");
    const exact = await t.run(
      "protocol",
      "message-original",
      "--state-root",
      t.stateRoot,
      "--input-file",
      reference,
      "--include-body",
    );
    expect(JSON.parse(exact.out).envelope.body).toBe(body);
    const inbox = await t.run(
      "protocol",
      "inbox",
      "--state-root",
      t.stateRoot,
      "--role",
      "games/archies-dog-walks/tech",
      "--sender",
      "coordinator",
    );
    expect(inbox, inbox.err).toMatchObject({ code: 0 });
    expect(inbox.out).toContain("cli-message");
    expect(inbox.out).not.toContain("Exact reference message");
    const boundary = await t.run(
      "protocol",
      "boundary",
      "--state-root",
      t.stateRoot,
      "--role",
      "game-coordinator",
      "--phase",
      "before-cleanup",
      "--at",
      AT,
    );
    expect(boundary, boundary.err).toMatchObject({ code: 0 });
    expect(JSON.parse(boundary.out).phase).toBe("before-cleanup");
    const artifactFile = join(t.base, "evidence.txt");
    writeFileSync(artifactFile, "fixture evidence\n");
    const stored = await t.run(
      "protocol",
      "artifact-put",
      "--state-root",
      t.stateRoot,
      "--file",
      artifactFile,
    );
    expect(stored.code).toBe(0);
    const refused = await t.run(
      "protocol",
      "artifact-put",
      "--state-root",
      t.stateRoot,
      "--file",
      join(t.base, ".vitest-secret-token"),
    );
    expect(JSON.parse(refused.err).error.code).toBe("unsafe-artifact-path");
    const refusedOutput = await t.run(
      "protocol",
      "artifact-read",
      "--state-root",
      t.stateRoot,
      "--hash",
      JSON.parse(stored.out).hash,
      "--output-file",
      join(t.base, ".credentials", "out"),
    );
    expect(JSON.parse(refusedOutput.err).error.code).toBe("unsafe-artifact-path");
    const target = join(t.base, "export.txt");
    const restored = await t.run(
      "protocol",
      "artifact-read",
      "--state-root",
      t.stateRoot,
      "--hash",
      JSON.parse(stored.out).hash,
      "--output-file",
      target,
    );
    expect(restored, restored.err).toMatchObject({ code: 0 });
    expect(readFileSync(target, "utf8")).toBe("fixture evidence\n");
  });
  it("keeps configuration absence distinct and sanitizes invalid source errors without raw file content", async () => {
    const t = await fixture();
    expect(JSON.parse((await t.run("protocol", "status")).out)).toMatchObject({
      status: "not-configured",
    });
    const bad = await t.run(
      "protocol",
      "claim",
      "--state-root",
      t.stateRoot,
      "--input-file",
      t.file({ privateContext: "DO-NOT-PRINT" }),
    );
    expect(bad.code).toBe(1);
    expect(bad.err).not.toContain("DO-NOT-PRINT");
    expect(JSON.parse(bad.err)).toMatchObject({ ok: false });
    const duplicate = await t.run(
      "protocol",
      "status",
      "--state-root",
      t.stateRoot,
      "--state-root",
      t.stateRoot,
    );
    expect(duplicate.code).toBe(2);
  });
});
