// Snapshot-bound explicit acknowledgements through `monitor ack`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect } from "vitest";

import { contract, suite, workspaces } from "../lib/cases.ts";
import {
  ack,
  ART,
  entry,
  Native,
  payloadSignature,
  receipt,
  retentionName,
  snapshot,
  snapshotFiles,
  TECH,
  writeCodexRoute,
  writeDecision,
} from "../lib/monitor-native.ts";
import type { Workspace } from "../lib/workspace.ts";

suite("monitor acknowledgements", () => {
  const workspace = workspaces();
  const natives: Native[] = [];
  afterEach(async () => {
    for (const native of natives.splice(0)) await native.close();
  });

  async function setup(): Promise<{ ws: Workspace; native: Native; id: string }> {
    const ws = workspace();
    writeCodexRoute(ws);
    const native = await new Native(ws).listen();
    natives.push(native);
    const taken = await snapshot(ws, TECH);
    expect(taken.result.code, taken.result.stderr + taken.result.stdout).toBe(0);
    return { ws, native, id: taken.public.snapshot_id as string };
  }

  contract("explicit ack deletes the exact ID even with a pending recipient", async () => {
    const { ws, native, id } = await setup();
    writeDecision(ws, TECH, { thread_id: TECH, state: "pending" });
    const seen: Array<{ receipt: Record<string, unknown>; params: Record<string, unknown> }> = [];
    native.beforeDelete = (params) => seen.push({ receipt: receipt(ws), params });
    const first = await ack(ws, TECH, id, ["one"], "handled");
    expect(first.result.code).toBe(0);
    expect(first.rows).toEqual([{ queue_id: "one", state: "deleted" }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.receipt.state).toBe("deleting");
    expect(seen[0]!.receipt.disposition).toBe("handled");
    expect(seen[0]!.params).toEqual({ threadId: TECH, queuedSubmissionId: "one" });
    expect(native.queues[TECH]!.map((row) => row.id)).toEqual(["two"]);
    expect(native.queues[ART]).toEqual([entry("art")]);
    expect(native.deletions()).toHaveLength(1);
    expect(native.socket.methods().some((method) => method.startsWith("turn/"))).toBe(false);
    await ack(ws, TECH, id, ["one"], "handled");
    expect(native.deletions()).toHaveLength(1);
  });

  contract("recipient, ID and snapshot binding reject before mutation", async () => {
    const { ws, native, id } = await setup();
    for (const [recipient, queueId] of [
      [ART, "one"],
      [TECH, "not-snapshotted"],
    ] as const) {
      const result = await ack(ws, recipient, id, [queueId], "handled");
      expect(result.result.code).toBe(1);
      expect(JSON.parse(result.result.stdout).status).toBe("unavailable");
    }
    const path = ws.path("unblock", "snapshots", id + ".json");
    const altered = JSON.parse(readFileSync(path, "utf8"));
    altered.snapshot_id = "11111111-1111-4111-8111-111111111111";
    writeFileSync(path, JSON.stringify(altered));
    expect((await ack(ws, TECH, id, ["one"], "handled")).result.code).toBe(1);
    expect(native.deletions()).toEqual([]);
  });

  contract("the same ID with changed input or client ID refuses deletion", async () => {
    const { ws, native, id } = await setup();
    for (const [field, value] of [
      ["input", []],
      ["clientUserMessageId", "edited"],
    ] as const) {
      native.queues[TECH]![0] = { ...entry("one"), [field]: value };
      const result = await ack(ws, TECH, id, ["one"], "handled");
      expect(result.rows![0]!.state).toBe("changed_payload");
      expect(result.result.code).toBe(1);
      expect(native.deletions()).toEqual([]);
    }
  });

  contract("an ambiguous result re-lists and an explicit retry preserves history", async () => {
    const { ws, native, id } = await setup();
    native.deleteResult = false;
    native.deleteError = true;
    expect((await ack(ws, TECH, id, ["one"], "handled")).rows![0]!.state).toBe("ambiguous");
    expect(native.deletions()).toHaveLength(1);
    expect((receipt(ws).attempts as Array<{ state: string }>)[0]!.state).toBe("ambiguous");
    native.deleteError = false;
    native.deleteResult = true;
    expect((await ack(ws, TECH, id, ["one"], "handled")).rows![0]!.state).toBe("deleted");
    const record = receipt(ws);
    expect((record.attempts as Array<{ state: string }>).map((row) => row.state)).toEqual([
      "ambiguous",
      "deleted",
    ]);
    expect((record.history as Array<{ state: string }>).map((row) => row.state)).toContain(
      "ambiguous",
    );
    expect(native.deletions()).toHaveLength(2);
  });

  contract("an interrupted or failed delete rechecks absence without replay", async () => {
    const { ws, native, id } = await setup();
    native.deleteError = true;
    native.removeOnError = true;
    expect((await ack(ws, TECH, id, ["one"], "handled")).rows![0]!.state).toBe("confirmed_absent");
    // Simulate a consumer interrupted after persisting `deleting`.
    const name = ws.list("unblock", "acks").find((file) => file.endsWith(".json"))!;
    const record = receipt(ws);
    record.state = "deleting";
    (record.attempts as Array<{ state: string }>).at(-1)!.state = "deleting";
    ws.write(join("unblock", "acks", name), JSON.stringify(record));
    expect((await ack(ws, TECH, id, ["one"], "handled")).rows![0]!.state).toBe("confirmed_absent");
    expect(native.deletions()).toHaveLength(1);
    expect((receipt(ws).history as Array<{ state: string }>).map((row) => row.state)).toContain(
      "ambiguous",
    );
  });

  contract("a false delete requires absence confirmation", async () => {
    const { ws, native, id } = await setup();
    native.deleteResult = false;
    expect((await ack(ws, TECH, id, ["one"], "superseded")).rows![0]!.state).toBe("not_deleted");
    expect(native.queues[TECH]![0]).toEqual(entry("one"));
    native.removeOnError = true;
    expect((await ack(ws, TECH, id, ["one"], "superseded")).rows![0]!.state).toBe(
      "confirmed_absent",
    );
  });

  contract("a retained ack confirms absence and deactivates the matching retention", async () => {
    const { ws, native, id } = await setup();
    await ack(ws, TECH, id, ["one"], "retained", "planned work");
    const retention = retentionName(TECH, "one");
    const before = ws.readJson(retention);
    const operationBefore = receipt(ws);
    native.queues[TECH] = [entry("two")];
    const callsBefore = native.socket.calls.length;
    const snapshotsBefore = snapshotFiles(ws);
    const result = await ack(ws, TECH, id, ["one"], "retained", "planned work");
    expect(result.rows).toEqual([{ queue_id: "one", state: "confirmed_absent" }]);
    const after = ws.readJson(retention);
    expect(after).toEqual({
      ...before,
      active: false,
      history: [...(before.history as unknown[]), { state: "confirmed_absent", snapshot_id: id }],
    });
    const operation = receipt(ws);
    expect(operation.disposition).toBe("retained");
    expect(operation.attempts).toEqual(operationBefore.attempts);
    const history = operation.history as Array<{ state: string }>;
    expect(history.slice(0, -1)).toEqual(operationBefore.history);
    expect(history.at(-1)!.state).toBe("confirmed_absent");
    expect(native.deletions()).toEqual([]);
    const calls = native.socket.calls
      .slice(callsBefore)
      .filter((call) => !call.method.startsWith("initialize"));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.method === "thread/queue/list")).toBe(true);
    expect(snapshotFiles(ws)).toEqual(snapshotsBefore);
    expect((await ack(ws, TECH, id, ["one"], "handled")).result.code).toBe(1);
    await ack(ws, TECH, id, ["one"], "retained", "planned work");
    expect(ws.readJson(retention)).toEqual(after);
  });

  contract("retained absence preserves a different or inactive retention", async () => {
    const { ws, native, id } = await setup();
    const original = entry("one");
    const cases: Array<Record<string, unknown>> = [
      { recipient: ART },
      { queue_id: "two" },
      { payload_signature: payloadSignature({ ...original, input: [] }) },
      { payload_signature: payloadSignature({ ...original, clientUserMessageId: "changed" }) },
      { active: false },
    ];
    const retention = retentionName(TECH, "one");
    for (const changes of cases) {
      native.queues[TECH] = [entry("one"), entry("two")];
      const taken = await snapshot(ws, TECH);
      native.queues[TECH] = [entry("two")];
      const record = {
        active: true,
        recipient: TECH,
        queue_id: "one",
        payload_signature: payloadSignature(original),
        history: [{ state: "retained", snapshot_id: id }],
        ...changes,
      };
      ws.write(retention, JSON.stringify(record));
      const result = await ack(
        ws,
        TECH,
        taken.public.snapshot_id as string,
        ["one"],
        "retained",
        "planned work",
      );
      expect(result.rows![0]!.state, JSON.stringify(changes)).toBe("confirmed_absent");
      expect(ws.readJson(retention)).toEqual(record);
    }
    expect(native.deletions()).toEqual([]);
  });

  contract("a retained ack with a present unchanged or changed identity", async () => {
    const { ws, native } = await setup();
    for (const changes of [{}, { input: [] }, { clientUserMessageId: "changed" }]) {
      native.queues[TECH] = [entry("one")];
      const taken = await snapshot(ws, TECH);
      const id = taken.public.snapshot_id as string;
      await ack(ws, TECH, id, ["one"], "retained", "planned work");
      const retention = retentionName(TECH, "one");
      const before = ws.readJson(retention);
      Object.assign(native.queues[TECH]![0]!, changes);
      const result = await ack(ws, TECH, id, ["one"], "retained", "planned work");
      const changed = Object.keys(changes).length > 0;
      expect(result.rows![0]!.state).toBe(changed ? "changed_payload" : "retained");
      const after = ws.readJson(retention);
      expect(after.active).toBe(true);
      if (changed) expect(after).toEqual(before);
      expect((after.history as Array<{ state: string }>).map((row) => row.state)).not.toContain(
        "confirmed_absent",
      );
    }
    expect(native.deletions()).toEqual([]);
  });
});
