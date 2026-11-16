import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../cli.ts";
import { loadLayout } from "../layout.ts";
import { importProtocolMigration, planProtocolMigration } from "../protocol/migration.ts";
import { createRegistry, type Registry } from "../registry/index.ts";
import { CLAUDE_COORDINATOR, makeFixture, registryInput } from "../testFixtures.ts";

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
        env: { CODEX_CONTROL_SOCKET: "/never/connect" },
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
  return { ...t, file, run, stateRoot };
}

describe("supported protocol CLI", () => {
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
      boundary: { after: { scope: { nativeHistory: string } } };
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
