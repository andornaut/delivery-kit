import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { deliverPending } from "../adapters/claude/channel.ts";
import { deliveredDir, spoolDir, spoolReviewBrief } from "../adapters/claude/spool.ts";
import { type FakeControl, startFakeControl } from "../adapters/codex/testControlSocket.ts";
import { slotRequestId } from "../adapters/shared/ids.ts";
import { digest } from "../adapters/shared/pyjson.ts";
import { main } from "../cli.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE } from "../io.ts";
import {
  activeRoute,
  type ClaudeFixture,
  claudeFixture,
  GAME,
  RECIPIENT,
  SLOT,
  TECH,
} from "../review/fixtures.ts";
import { persist } from "../review/store.ts";
import { CODEX_TECH } from "../testFixtures.ts";

const WORKER = "00000000-0000-4000-8000-000000000080";
const OTHER_PARENT = "00000000-0000-4000-8000-000000000081";

describe("inbox verified Codex workers", () => {
  const controls: FakeControl[] = [];
  afterEach(async () => {
    await Promise.all(controls.splice(0).map((control) => control.close()));
  });

  async function workerFixture() {
    const fixture = claudeFixture();
    select(fixture, (registry) => {
      registry.roles["archies-dog-walks/tech"]!.harness = "codex";
    });
    const state = {
      clientId: "message-1",
      deleteMode: "success",
      lineage: CODEX_TECH,
      payload: "handled worker original",
      present: true,
      queueReads: 0,
      readMode: "available",
      reparentBeforeDelete: false,
      sourceParent: CODEX_TECH,
    };
    const control = await startFakeControl(fixture.base, (method, params) => {
      if (method === "thread/read") {
        if (state.readMode === "refused") {
          return { error: { code: -32000, message: "read refused" } };
        }
        if (state.readMode === "unknown") {
          return { result: { thread: null } };
        }
        return {
          result: {
            thread: {
              id: params.threadId,
              parentThreadId: state.lineage,
              source: { subAgent: { thread_spawn: { parent_thread_id: state.sourceParent } } },
              status: { activeFlags: ["waitingOnUserInput"], type: "active" },
            },
          },
        };
      }
      if (method === "thread/queue/list") {
        state.queueReads += 1;
        if (state.readMode === "queue refused") {
          return { error: { code: -32000, message: "queue refused" } };
        }
        if (state.reparentBeforeDelete && state.queueReads === 3) {
          state.lineage = OTHER_PARENT;
        }
        return {
          result: {
            data: state.present
              ? [
                  {
                    clientUserMessageId: state.clientId,
                    id: "worker-q1",
                    input: [{ text: state.payload, type: "text" }],
                  },
                ]
              : [],
            nextCursor: null,
          },
        };
      }
      if (method === "thread/queue/delete") {
        if (state.deleteMode === "ambiguous") {
          state.readMode = "queue refused";
          return { drop: true };
        }
        state.present = false;
        if (state.deleteMode === "lost response") {
          return { error: { code: -32000, message: "response lost" } };
        }
        return { result: { deleted: true } };
      }
      return { error: { code: -32601, message: "unsupported" } };
    });
    controls.push(control);
    const connected = { ...fixture, env: { ...fixture.env, CODEX_CONTROL_SOCKET: control.path } };
    const args = ["--game", GAME, "--recipient", WORKER, "--parent", "archies-dog-walks/tech"];
    const capture = () => run(connected, "inbox", "snapshot", ...args);
    const remove = (snapshotId: string, disposition = "handled", ...extra: string[]) =>
      run(
        connected,
        "inbox",
        "ack",
        ...args,
        "--snapshot",
        snapshotId,
        "--queue-id",
        "worker-q1",
        "--disposition",
        disposition,
        ...extra,
      );
    return { args, capture, control, fixture: connected, remove, state };
  }

  it.each(["handled", "superseded"])(
    "acknowledges a bound worker original as %s on one connection",
    async (disposition) => {
      const { capture, control, fixture, remove, state } = await workerFixture();
      const pendingPath = join(fixture.unblock, "decisions", `${WORKER}.json`);
      const pending = JSON.stringify({
        state: "pending",
        thread_id: WORKER,
        question: "Keep open",
      });
      writeFileSync(pendingPath, pending);
      const parentPath = join(fixture.unblock, "decisions", `${CODEX_TECH}.json`);
      const parentMarker = JSON.stringify({ state: "pending", thread_id: CODEX_TECH });
      writeFileSync(parentPath, parentMarker);
      const snap = await capture();
      expect(snap.code, snap.err).toBe(EXIT_OK);
      const output = JSON.parse(snap.out);
      expect(output.worker_binding).toEqual({
        harness: "codex",
        parent: CODEX_TECH,
        worker: WORKER,
      });
      const persisted = JSON.parse(readFileSync(output.path, "utf8"));
      expect(persisted.worker_binding).toEqual(output.worker_binding);
      expect(persisted.queues[WORKER][0].id).toBe("worker-q1");
      expect(snap.out).not.toContain(state.payload);
      const before = control.calls.length;
      const result = await remove(output.snapshot_id, disposition);
      expect(result.code, result.err + result.out).toBe(EXIT_OK);
      expect(JSON.parse(result.out).results).toEqual([{ queue_id: "worker-q1", state: "deleted" }]);
      expect(state.present).toBe(false);
      const calls = control.calls.slice(before);
      expect(calls.filter((call) => call.method === "initialize")).toHaveLength(1);
      expect(calls.filter((call) => call.method === "thread/queue/delete")).toHaveLength(1);
      expect(
        control
          .methods()
          .every((method) =>
            ["thread/read", "thread/queue/list", "thread/queue/delete"].includes(method),
          ),
      ).toBe(true);
      expect(readFileSync(pendingPath, "utf8")).toBe(pending);
      expect(readFileSync(parentPath, "utf8")).toBe(parentMarker);
    },
  );

  it.each(["wrong parent", "source mismatch", "queue refused"])(
    "refuses worker snapshot with %s without mutation",
    async (failure) => {
      const { capture, control, state } = await workerFixture();
      if (failure === "wrong parent") {
        state.lineage = OTHER_PARENT;
      } else if (failure === "source mismatch") {
        state.sourceParent = OTHER_PARENT;
      } else {
        state.readMode = failure;
      }
      expect((await capture()).code).toBe(EXIT_INVALID);
      expect(control.methods()).not.toContain("thread/queue/delete");
      expect(state.present).toBe(true);
    },
  );

  it.each([
    "reparented",
    "refused",
    "queue refused",
    "changed payload",
    "before delete",
    "changed client ID",
  ])("preserves an original when %s after snapshot", async (failure) => {
    const { capture, control, remove, state } = await workerFixture();
    const snap = JSON.parse((await capture()).out);
    if (failure === "reparented") {
      state.lineage = OTHER_PARENT;
    } else if (failure === "changed payload") {
      state.payload = "new independent work";
    } else if (failure === "changed client ID") {
      state.clientId = "new-client-message";
    } else if (failure === "before delete") {
      state.reparentBeforeDelete = true;
    } else {
      state.readMode = failure;
    }
    const result = await remove(snap.snapshot_id);
    expect(result.code, result.out).toBe(EXIT_INVALID);
    expect(control.methods()).not.toContain("thread/queue/delete");
    expect(state.present).toBe(true);
    if (["changed payload", "changed client ID"].includes(failure)) {
      expect(result.out).toContain("changed_payload");
    }
  });

  it.each(["parent", "worker", "harness"])(
    "rejects mismatched snapshot %s before connecting",
    async (field) => {
      const { capture, control, remove } = await workerFixture();
      const snap = JSON.parse((await capture()).out);
      const record = JSON.parse(readFileSync(snap.path, "utf8"));
      record.worker_binding[field] = field === "harness" ? "claude" : OTHER_PARENT;
      writeFileSync(snap.path, JSON.stringify(record));
      const before = control.calls.length;
      const result = await remove(snap.snapshot_id);
      expect(result.err).toContain("snapshot worker binding mismatch");
      expect(control.calls).toHaveLength(before);
    },
  );

  it.each(["lost response", "ambiguous"])(
    "preserves existing deletion reconciliation for %s",
    async (mode) => {
      const { capture, control, remove, state } = await workerFixture();
      const snap = JSON.parse((await capture()).out);
      state.deleteMode = mode;
      const result = await remove(snap.snapshot_id);
      expect(result.code).toBe(mode === "lost response" ? EXIT_OK : EXIT_INVALID);
      expect(result.out).toContain(mode === "lost response" ? "confirmed_absent" : "ambiguous");
      expect(control.methods().filter((method) => method === "thread/queue/delete")).toHaveLength(
        1,
      );
    },
  );

  it("requires one current registered Codex route parent before any native call", async () => {
    const { control, fixture } = await workerFixture();
    const invalidParents = [
      [],
      [CODEX_TECH],
      ["game-coordinator"],
      ["archies-dog-walks/tech", "game-coordinator"],
    ];
    const results = await Promise.all(
      invalidParents.map((parents) =>
        run(
          fixture,
          "inbox",
          "snapshot",
          "--game",
          GAME,
          "--recipient",
          WORKER,
          ...parents.flatMap((parent) => ["--parent", parent]),
        ),
      ),
    );
    for (const result of results) {
      expect(result.code).toBe(EXIT_USAGE);
    }
    fixture.route({ state: "held" });
    const held = await run(
      fixture,
      "inbox",
      "snapshot",
      "--game",
      GAME,
      "--recipient",
      WORKER,
      "--parent",
      "archies-dog-walks/tech",
    );
    expect(held.code).toBe(EXIT_USAGE);
    expect(control.calls).toHaveLength(0);
  });

  it("keeps registered Codex snapshot and ACK compatible without worker binding or parent", async () => {
    const { control, fixture, state } = await workerFixture();
    const snap = await run(
      fixture,
      "inbox",
      "snapshot",
      "--game",
      GAME,
      "--recipient",
      "archies-dog-walks/tech",
    );
    expect(snap.code, snap.err).toBe(EXIT_OK);
    const output = JSON.parse(snap.out);
    const record = JSON.parse(readFileSync(output.path, "utf8"));
    expect(record.worker_binding).toBeUndefined();
    const result = await run(
      fixture,
      "inbox",
      "ack",
      "--game",
      GAME,
      "--recipient",
      CODEX_TECH,
      "--snapshot",
      output.snapshot_id,
      "--queue-id",
      "worker-q1",
      "--disposition",
      "handled",
    );
    expect(result.code, result.err + result.out).toBe(EXIT_OK);
    expect(state.present).toBe(false);
    expect(
      control.calls.find((call) => call.method === "thread/queue/delete")?.params.threadId,
    ).toBe(CODEX_TECH);
  });

  it("rejects the snapshot after the registered parent moves to a different conversation", async () => {
    const { capture, control, fixture, remove } = await workerFixture();
    const snap = JSON.parse((await capture()).out);
    select(fixture, (registry) => {
      registry.roles["archies-dog-walks/tech"]!.conversations = { codex: OTHER_PARENT };
    });
    const before = control.calls.length;
    expect((await remove(snap.snapshot_id)).code).toBe(EXIT_INVALID);
    expect(control.calls).toHaveLength(before);
  });
});

async function run(
  fixture: ClaudeFixture,
  ...argv: string[]
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(
    {
      cwd: "/nonexistent",
      env: fixture.env,
      err: (text) => (err += text),
      out: (text) => (out += text),
    },
    ["--root", fixture.layout.root, ...argv],
  );
  return { code, err, out };
}

async function delivered(): Promise<{ fixture: ClaudeFixture; requestId: string }> {
  const fixture = claudeFixture();
  const route = activeRoute(fixture);
  spoolReviewBrief(fixture.env, fixture.game.busDir, route, SLOT);
  await deliverPending(() => undefined, fixture.game.busDir, RECIPIENT);
  return { fixture, requestId: slotRequestId(RECIPIENT, SLOT) };
}

async function snapshot(fixture: ClaudeFixture): Promise<Record<string, unknown>> {
  const result = await run(fixture, "inbox", "snapshot", "--game", GAME);
  expect(result.code, result.err + result.out).toBe(EXIT_OK);
  return JSON.parse(result.out) as Record<string, unknown>;
}

function ack(fixture: ClaudeFixture, id: string, disposition: string, ...extra: string[]) {
  return async (snapshotId: string) =>
    run(
      fixture,
      "inbox",
      "ack",
      "--game",
      GAME,
      "--snapshot",
      snapshotId,
      "--queue-id",
      id,
      "--disposition",
      disposition,
      ...extra,
    );
}

function select(
  fixture: ClaudeFixture,
  change: (registry: { harness: string; roles: Record<string, Record<string, unknown>> }) => void,
): void {
  const registry = JSON.parse(readFileSync(fixture.layout.registryFile, "utf8"));
  change(registry);
  writeFileSync(fixture.layout.registryFile, JSON.stringify(registry));
}

describe("inbox effective harness selection", () => {
  it("distinguishes mixed local inventory success from unavailable requested native queues", async () => {
    const fixture = claudeFixture();
    select(fixture, (registry) => {
      registry.roles["archies-dog-walks/tech"]!.harness = "codex";
    });
    const output = await snapshot(fixture);
    expect(output).toMatchObject({
      channel_queues: { [RECIPIENT]: { count: 0, queue_ids: [], status: "available" } },
      complete: true,
      harness: "claude",
      native_complete: false,
      native_queues: { [RECIPIENT]: { status: "unavailable" } },
      queue_sources: { [RECIPIENT]: "local_channel_delivered" },
    });
  });

  it("keeps mixed channel payloads in the persisted snapshot and out of stdout", async () => {
    const { fixture, requestId } = await delivered();
    const path = join(deliveredDir(fixture.game.busDir), `${requestId}.json`);
    const privateText = `private-channel-body-${"x".repeat(50000)}`;
    const deliveredEntry = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...deliveredEntry, text: privateText }));
    select(fixture, (registry) => {
      registry.roles["archies-dog-walks/tech"]!.harness = "codex";
    });
    const result = await run(fixture, "inbox", "snapshot", "--game", GAME);
    expect(result.code, result.err).toBe(EXIT_OK);
    expect(result.out).not.toContain("private-channel-body");
    expect(result.out).not.toContain('"input"');
    expect(result.out.length).toBeLessThan(5000);
    const output = JSON.parse(result.out);
    expect(output.channel_queues).toEqual({
      [RECIPIENT]: { count: 1, queue_ids: [requestId], status: "available" },
    });
    const persisted = JSON.parse(readFileSync(output.path, "utf8"));
    expect(persisted.channel_queues[RECIPIENT][0].input[0].text).toBe(privateText);
  });

  it("rejects an outside parent before a mixed Claude recipient can query Codex", async () => {
    const fixture = claudeFixture();
    select(fixture, (registry) => {
      registry.roles["archies-dog-walks/tech"]!.harness = "codex";
      registry.roles["game-kit"] = {
        conversations: { codex: "00000000-0000-4000-8000-000000000099" },
        harness: "codex",
        ownership: "active",
        worktree: ".",
      };
    });
    const result = await run(fixture, "inbox", "snapshot", "--game", GAME, "--parent", "game-kit");
    expect(result.code).toBe(EXIT_INVALID);
    expect(result.err).toContain("parent outside active route");
  });

  it("refuses an ambiguous active UUID before choosing either adapter", async () => {
    const fixture = claudeFixture();
    select(fixture, (registry) => {
      registry.roles["game-coordinator"]!.conversations = { claude: TECH };
    });
    const result = await run(fixture, "inbox", "snapshot", "--game", GAME, "--recipient", TECH);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err).toContain("exactly one active registered role");
  });

  it("rejects an old snapshot after a same-ID harness retarget without touching the channel entry", async () => {
    const { fixture, requestId } = await delivered();
    const captured = await snapshot(fixture);
    select(fixture, (registry) => {
      registry.roles["game-coordinator"]!.harness = "codex";
      registry.roles["game-coordinator"]!.conversations = { claude: RECIPIENT, codex: RECIPIENT };
    });
    const result = await ack(fixture, requestId, "handled")(captured.snapshot_id as string);
    expect(result.code).toBe(EXIT_INVALID);
    expect(result.err).toContain("snapshot recipient mismatch");
    expect(
      readFileSync(join(deliveredDir(fixture.game.busDir), `${requestId}.json`), "utf8"),
    ).toContain(requestId);
  });
});

describe("inbox snapshot (claude)", () => {
  it("refuses a recipient that is not the route recipient", async () => {
    const { fixture } = await delivered();
    const result = await run(
      fixture,
      "inbox",
      "snapshot",
      "--game",
      GAME,
      "--recipient",
      "archies-dog-walks/tech",
    );
    expect(result.code).toBe(EXIT_INVALID);
    expect(JSON.parse(result.out)).toEqual({
      reason: "inspect local inbox state and retry explicit reconciliation",
      status: "unavailable",
    });
    expect(result.err).toBe("delivery-kit: recipient must be the active route's recipient\n");
    expect((await run(fixture, "inbox", "snapshot")).code).toBe(EXIT_USAGE);
  });

  it("reports an unreadable channel spool under the snapshot's errors", async () => {
    const { fixture } = await delivered();
    const spool = spoolDir(fixture.game.busDir);
    rmSync(spool, { force: true, recursive: true });
    writeFileSync(spool, "");
    const result = await run(fixture, "inbox", "snapshot", "--game", GAME);
    expect(result.code).toBe(EXIT_INVALID);
    const output = JSON.parse(result.out) as { complete: boolean; path: string };
    expect(output.complete).toBe(false);
    const record = JSON.parse(readFileSync(output.path, "utf8")) as { errors: unknown };
    expect(record.errors).toEqual({ channel_pending: "channel spool unreadable (ENOTDIR)" });
  });
});

describe("inbox ack (claude)", () => {
  it("removes the exact handled entry once and keeps the durable disposition", async () => {
    const { fixture, requestId } = await delivered();
    const id = (await snapshot(fixture)).snapshot_id as string;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await ack(fixture, requestId, "handled")(id);
      expect(JSON.parse(result.out)).toEqual({
        results: [{ queue_id: requestId, state: "deleted" }],
      });
    }
    expect((await snapshot(fixture)).queue_ids).toEqual([]);
    const changed = await ack(fixture, requestId, "superseded")(id);
    expect(changed.code).toBe(EXIT_INVALID);
    expect((await ack(fixture, "unknown", "handled")(id)).code).toBe(EXIT_INVALID);
  });

  it("requires the exact unchanged payload and a reason to retain", async () => {
    const { fixture, requestId } = await delivered();
    const id = (await snapshot(fixture)).snapshot_id as string;
    const path = join(deliveredDir(fixture.game.busDir), `${requestId}.json`);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, JSON.stringify({ ...(JSON.parse(original) as object), text: "changed" }));
    const changed = await ack(fixture, requestId, "handled")(id);
    expect(JSON.parse(changed.out)).toEqual({
      results: [{ queue_id: requestId, state: "changed_payload" }],
    });
    expect(changed.code).toBe(EXIT_INVALID);
    writeFileSync(path, original);
    const fresh = (await snapshot(fixture)).snapshot_id as string;
    expect((await ack(fixture, requestId, "retained")(fresh)).code).toBe(EXIT_USAGE);
    const kept = await ack(
      fixture,
      requestId,
      "retained",
      "--reason",
      "waiting on Archie tech",
    )(fresh);
    expect(JSON.parse(kept.out)).toEqual({ results: [{ queue_id: requestId, state: "retained" }] });
    const record = JSON.parse(readFileSync((await snapshot(fixture)).path as string, "utf8")) as {
      queues: Record<string, { retained: boolean }[]>;
    };
    expect(record.queues[RECIPIENT]?.[0]?.retained).toBe(true);
  });

  it("records an interrupted removal as ambiguous, then confirmed absent", async () => {
    const { fixture, requestId } = await delivered();
    const id = (await snapshot(fixture)).snapshot_id as string;
    const operation = join(fixture.unblock, "acks", `${digest([RECIPIENT, id, requestId])}.json`);
    persist(operation, {
      attempt: 1,
      attempts: [{ attempt: 1, state: "deleting" }],
      disposition: "handled",
      harness: "claude",
      history: [],
      queue_id: requestId,
      recipient: RECIPIENT,
      snapshot_id: id,
      state: "deleting",
    });
    unlinkSync(join(deliveredDir(fixture.game.busDir), `${requestId}.json`));
    const result = await ack(fixture, requestId, "handled")(id);
    expect(JSON.parse(result.out)).toEqual({
      results: [{ queue_id: requestId, state: "confirmed_absent" }],
    });
    const record = JSON.parse(readFileSync(operation, "utf8")) as {
      attempts: { state: string }[];
      history: unknown[];
    };
    expect(record.attempts.at(-1)?.state).toBe("ambiguous");
    expect(record.history).toContainEqual({ attempt: 1, state: "ambiguous" });
  });
});
