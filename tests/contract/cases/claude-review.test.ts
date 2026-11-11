// Claude inbox inventory and acknowledgements over delivered channel entries. One brief is
// dispatched and delivered first.
import { rmSync, writeFileSync } from "node:fs";
import { expect } from "vitest";

import { cli } from "../lib/adapter.ts";
import {
  agents,
  ARCHIE,
  claudeGame,
  deliver,
  RECIPIENT,
  pythonDigest,
  slotRequestId,
  tick,
} from "../lib/claude-fixture.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { at } from "../lib/time.ts";
import type { Workspace } from "../lib/workspace.ts";
import type { Json } from "../lib/json.ts";

const SLOT = at(20);
const REQUEST = slotRequestId(RECIPIENT, SLOT);

async function delivered(ws: Workspace): Promise<void> {
  claudeGame(ws);
  await tick(ws, SLOT);
  await deliver(ws);
}

async function snapshot(ws: Workspace, recipient = RECIPIENT): Promise<Json> {
  const result = await cli(ws, ["inbox", "snapshot", "--recipient", recipient]);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function stored(ws: Workspace, output: Json): Json {
  return ws.readJson(`unblock/snapshots/${output.snapshot_id}.json`);
}

async function ack(
  ws: Workspace,
  output: Json,
  disposition: string,
  extra: string[] = [],
  ids = [REQUEST],
) {
  const args = [
    "--recipient",
    RECIPIENT,
    "--snapshot",
    output.snapshot_id,
    "--disposition",
    disposition,
    ...extra,
  ];
  for (const id of ids) args.push("--queue-id", id);
  const result = await cli(ws, ["inbox", "ack", ...args]);
  return {
    ...result,
    json: result.stdout ? (JSON.parse(result.stdout) as Json) : {},
  };
}

function deliveredPath(ws: Workspace): string {
  return ws.path("unblock", "claude-delivered", `${REQUEST}.json`);
}

suite("claude inbox inventory", () => {
  const workspace = workspaces();

  contract("a snapshot lists delivered entries and reports native state unavailable", async () => {
    const ws = workspace();
    await delivered(ws);
    const output = await snapshot(ws);
    const record = stored(ws, output);
    expect(record.queues[RECIPIENT].map((entry: { id: string }) => entry.id)).toEqual([REQUEST]);
    expect(record.queues[RECIPIENT][0].receipt_status).toBe("accepted");
    expect(new Set(Object.values(record.history).map((row) => (row as Json).status))).toEqual(
      new Set(["unavailable"]),
    );
    expect(output.question_state_status).toEqual({
      [RECIPIENT]: "unavailable",
      [ARCHIE]: "unavailable",
    });
    expect(output.session_status).toEqual({ [RECIPIENT]: "idle", [ARCHIE]: "idle" });
    expect(output.target_queue_status[ARCHIE]).toBe("unavailable");
    for (const [rows, expected] of [
      [
        [
          { sessionId: RECIPIENT, status: "idle" },
          { sessionId: ARCHIE, status: "waiting" },
        ],
        "waiting",
      ],
      [
        [
          { sessionId: RECIPIENT, status: "idle" },
          { sessionId: ARCHIE, status: "Bad value" },
        ],
        "unknown",
      ],
      [[{ sessionId: RECIPIENT, status: "idle" }], "missing"],
    ] as const) {
      agents(ws, [...rows]);
      expect((await snapshot(ws)).session_status[ARCHIE]).toBe(expected);
    }
    agents(ws, "fail");
    expect((await snapshot(ws)).session_status[RECIPIENT]).toBe("unavailable");
    agents(ws, "idle");
    const other = await cli(ws, ["inbox", "snapshot", "--recipient", ARCHIE]);
    expect(other.code).toBe(1);
    expect(JSON.parse(other.stdout).status).toBe("unavailable");
  });

  contract("a handled acknowledgement removes the exact entry once", async () => {
    const ws = workspace();
    await delivered(ws);
    const output = await snapshot(ws);
    expect((await ack(ws, output, "handled")).json).toEqual({
      results: [{ queue_id: REQUEST, state: "deleted" }],
    });
    expect((await ack(ws, output, "handled")).json).toEqual({
      results: [{ queue_id: REQUEST, state: "deleted" }],
    });
    expect((await snapshot(ws)).queue_ids).toEqual([]);
    const changed = await ack(ws, output, "superseded");
    expect(changed.code).toBe(1);
    expect(changed.json.status).toBe("unavailable");
    const unknown = await ack(ws, output, "handled", [], ["unknown"]);
    expect(unknown.code).toBe(1);
    expect(unknown.json.status).toBe("unavailable");
  });

  contract("a changed payload and a retention require the exact unchanged entry", async () => {
    const ws = workspace();
    await delivered(ws);
    const output = await snapshot(ws);
    const original = ws.read("unblock", "claude-delivered", `${REQUEST}.json`);
    writeFileSync(deliveredPath(ws), JSON.stringify({ ...JSON.parse(original), text: "changed" }));
    const changed = await ack(ws, output, "handled");
    expect(changed.json.results[0].state).toBe("changed_payload");
    expect(ws.exists("unblock", "claude-delivered", `${REQUEST}.json`)).toBe(true);
    writeFileSync(deliveredPath(ws), original);
    const fresh = await snapshot(ws);
    expect((await ack(ws, fresh, "retained", ["--reason", " "])).code).not.toBe(0);
    const retained = await ack(ws, fresh, "retained", ["--reason", "waiting on Archie tech"]);
    expect(retained.json.results[0].state).toBe("retained");
    expect(stored(ws, await snapshot(ws)).queues[RECIPIENT][0].retained).toBe(true);
    writeFileSync(
      deliveredPath(ws),
      JSON.stringify({ ...JSON.parse(original), text: "changed again" }),
    );
    expect(stored(ws, await snapshot(ws)).queues[RECIPIENT][0].retained).toBe(false);
  });

  contract("an interrupted removal is recorded ambiguous, then confirmed absent", async () => {
    const ws = workspace();
    await delivered(ws);
    const output = await snapshot(ws);
    // Crash state: the operation was persisted as deleting and the entry already removed.
    const operation = `unblock/acks/${pythonDigest([RECIPIENT, output.snapshot_id, REQUEST])}.json`;
    ws.write(
      operation,
      JSON.stringify({
        recipient: RECIPIENT,
        snapshot_id: output.snapshot_id,
        queue_id: REQUEST,
        harness: "claude",
        disposition: "handled",
        attempt: 1,
        state: "deleting",
        attempts: [{ attempt: 1, state: "deleting" }],
        history: [],
      }),
    );
    rmSync(deliveredPath(ws));
    expect((await ack(ws, output, "handled")).json.results[0].state).toBe("confirmed_absent");
    const record = ws.readJson<Json>(operation);
    expect(record.attempts.at(-1).state).toBe("ambiguous");
    expect(record.history).toContainEqual({ attempt: 1, state: "ambiguous" });
  });

  contract("the public CLI selects the Claude recipient for its route", async () => {
    const ws = workspace();
    await delivered(ws);
    const result = await cli(ws, ["inbox", "snapshot", "--recipient", RECIPIENT]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect([output.harness, output.queue_ids]).toEqual(["claude", [REQUEST]]);
    expect(result.stdout + result.stderr).not.toContain("CODEX");
    expect((await ack(ws, output, "handled")).json).toEqual({
      results: [{ queue_id: REQUEST, state: "deleted" }],
    });
  });
});
