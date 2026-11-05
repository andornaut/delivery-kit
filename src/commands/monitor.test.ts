import { readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deliverPending } from "../adapters/claude/channel.ts";
import { deliveredDir, spoolDir, spoolMonitorBrief } from "../adapters/claude/spool.ts";
import { slotRequestId } from "../adapters/shared/ids.ts";
import { digest } from "../adapters/shared/pyjson.ts";
import { main } from "../cli.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE } from "../io.ts";
import {
  activeRoute,
  type ClaudeFixture,
  claudeFixture,
  GAME,
  MONITOR,
  SLOT,
  TECH,
} from "../monitor/fixtures.ts";
import { persist } from "../monitor/store.ts";

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
  spoolMonitorBrief(fixture.env, fixture.game.busDir, route, SLOT);
  await deliverPending(() => undefined, fixture.game.busDir, MONITOR);
  return { fixture, requestId: slotRequestId(MONITOR, SLOT) };
}

async function snapshot(fixture: ClaudeFixture): Promise<Record<string, unknown>> {
  const result = await run(fixture, "monitor", "snapshot", "--game", GAME);
  expect(result.code, result.err + result.out).toBe(EXIT_OK);
  return JSON.parse(result.out) as Record<string, unknown>;
}

function ack(fixture: ClaudeFixture, id: string, disposition: string, ...extra: string[]) {
  return async (snapshotId: string) =>
    run(
      fixture,
      "monitor", "ack",
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

describe("monitor-snapshot (claude)", () => {
  it("lists delivered entries and reports native state unavailable", async () => {
    const { fixture, requestId } = await delivered();
    const output = await snapshot(fixture);
    expect(Object.keys(output)).toEqual([
      "snapshot_id",
      "path",
      "queue_ids",
      "complete",
      "harness",
      "history",
      "worker_health",
      "question_state_status",
      "session_status",
      "target_queue_status",
      "channel_pending",
    ]);
    expect(output).toMatchObject({
      harness: "claude",
      question_state_status: { [MONITOR]: "unavailable", [TECH]: "unavailable" },
      queue_ids: [requestId],
      session_status: { [MONITOR]: "idle", [TECH]: "idle" },
      target_queue_status: { [TECH]: "unavailable" },
    });
    const record = JSON.parse(readFileSync(output.path as string, "utf8")) as {
      queues: Record<string, { receipt_status: string }[]>;
    };
    expect(record.queues[MONITOR]?.[0]?.receipt_status).toBe("accepted");
  });

  it("refuses a recipient that is not the route monitor", async () => {
    const { fixture } = await delivered();
    const result = await run(
      fixture,
      "monitor", "snapshot",
      "--game",
      GAME,
      "--recipient",
      "archies-dog-walks/tech",
    );
    expect(result.code).toBe(EXIT_INVALID);
    expect(JSON.parse(result.out)).toEqual({
      reason: "inspect local monitor state and retry explicit reconciliation",
      status: "unavailable",
    });
    expect(result.err).toBe("delivery-kit: recipient must be the active route monitor\n");
    expect((await run(fixture, "monitor", "snapshot")).code).toBe(EXIT_USAGE);
  });

  it("reports an unreadable channel spool under the snapshot's errors", async () => {
    const { fixture } = await delivered();
    const spool = spoolDir(fixture.game.busDir);
    rmSync(spool, { force: true, recursive: true });
    writeFileSync(spool, "");
    const result = await run(fixture, "monitor", "snapshot", "--game", GAME);
    expect(result.code).toBe(EXIT_INVALID);
    const output = JSON.parse(result.out) as { complete: boolean; path: string };
    expect(output.complete).toBe(false);
    const record = JSON.parse(readFileSync(output.path, "utf8")) as { errors: unknown };
    expect(record.errors).toEqual({ channel_pending: "channel spool unreadable (ENOTDIR)" });
  });

  it("accepts a registered conversation UUID and refuses an unregistered one", async () => {
    const { fixture } = await delivered();
    const recipient = (id: string) =>
      run(fixture, "monitor", "snapshot", "--game", GAME, "--recipient", id);
    expect((await recipient(MONITOR)).code).toBe(EXIT_OK);
    expect((await recipient("00000000-0000-4000-8000-0000000000ff")).code).toBe(EXIT_USAGE);
  });
});

describe("monitor-ack (claude)", () => {
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
    expect(record.queues[MONITOR]?.[0]?.retained).toBe(true);
  });

  it("records an interrupted removal as ambiguous, then confirmed absent", async () => {
    const { fixture, requestId } = await delivered();
    const id = (await snapshot(fixture)).snapshot_id as string;
    const operation = join(fixture.unblock, "acks", `${digest([MONITOR, id, requestId])}.json`);
    persist(operation, {
      attempt: 1,
      attempts: [{ attempt: 1, state: "deleting" }],
      disposition: "handled",
      harness: "claude",
      history: [],
      queue_id: requestId,
      recipient: MONITOR,
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
