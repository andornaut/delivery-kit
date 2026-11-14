import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LockBusy } from "../lock.ts";
import { messageChannelStateDir } from "./paths.ts";
import { messageEnvelope, messageExpectation, MessageStore, messageSummary } from "./store.ts";
import type {
  MessageAttemptSource,
  MessageEnvelope,
  MessageExpectation,
  MessageInput,
  MessageOwner,
  MessageRecord,
} from "./types.ts";

const CHILD = "00000000-0000-4000-8000-000000000001";
const PARENT = "00000000-0000-4000-8000-000000000002";
const REPLACEMENT = "00000000-0000-4000-8000-000000000003";
const NOW = "2026-11-14T20:00:00.000Z";
const INPUT: MessageInput = {
  schema: 1,
  id: "task:001",
  fromRole: "game-kit",
  toRole: "fixture/tech",
  intent: "queue",
  body: "Full original message.\nSecond line: é.",
  created: NOW,
};
const OWNER: MessageOwner = {
  harness: "codex",
  nativeId: CHILD,
  parentBinding: { role: "game-kit", nativeId: PARENT },
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true });
  }
});

function setup(
  resolveOwner: (role: string, envelope: MessageEnvelope) => MessageOwner | null = () => OWNER,
) {
  const reviewDir = mkdtempSync(join(tmpdir(), "messages-"));
  roots.push(reviewDir);
  const context = { layout: { reviewDir }, resolveOwner, now: () => NOW };
  return { context, directory: join(reviewDir, "messages"), store: new MessageStore(context) };
}

function expected(record: MessageRecord): MessageExpectation {
  return messageExpectation(record);
}

function disk(directory: string): string {
  const path = readdirSync(directory).find((name) => name.endsWith(".json"));
  if (path === undefined) {
    throw new Error("missing fixture record");
  }
  return join(directory, path);
}

describe("durable role inbox", () => {
  it("queues the entire original idempotently across restarts and refuses conflicting IDs unchanged", async () => {
    let resolutions = 0;
    const { context, directory, store } = setup(() => {
      resolutions++;
      return null;
    });
    const input = { ...INPUT, body: `${"original-text\n".repeat(16000)}é` };
    const queued = await store.enqueue(input);
    expect(queued.state).toBe("queued");
    expect(resolutions).toBe(0);
    const restarted = new MessageStore(context);
    expect(await restarted.enqueue(input)).toEqual(queued);
    expect(restarted.inbox(INPUT.toRole)[0]?.envelope.body).toBe(input.body);
    expect(restarted.inbox(INPUT.fromRole)).toEqual([]);
    expect(restarted.read(INPUT.id)?.envelope).toEqual(messageEnvelope(input));
    expect(JSON.stringify(restarted.status(INPUT.id))).not.toContain("original-text");
    expect(restarted.status(INPUT.id)).not.toHaveProperty("payloadHash");
    expect(restarted.status(INPUT.id)).not.toHaveProperty("nativeId");
    const summary = messageSummary(context.layout);
    expect(summary).toMatchObject({
      status: "available",
      counts: { queued: 1 },
      messages: [{ id: INPUT.id, state: "queued" }],
    });
    expect(JSON.stringify(summary)).not.toContain("original-text");
    expect(resolutions).toBe(0);
    const before = readFileSync(disk(directory), "utf8");
    await expect(store.enqueue({ ...input, body: `${input.body}changed` })).rejects.toThrow(
      "id-conflict",
    );
    await expect(store.enqueue({ ...input, fromRole: "art-kit" })).rejects.toThrow("id-conflict");
    expect(readFileSync(disk(directory), "utf8")).toBe(before);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(disk(directory)).mode & 0o777).toBe(0o600);
  });

  it("retains guarded local work until explicit release and supports direct recipient handling", async () => {
    const { store } = setup(() => null);
    const queued = await store.enqueue(INPUT);
    const retention = {
      ownerRole: INPUT.toRole,
      reason: "owner has an unanswered question",
      nextBoundary: ":20 review",
    };
    const held = await store.hold(expected(queued), retention);
    expect(held.state).toBe("held");
    await expect(store.release(expected(queued))).rejects.toThrow("binding-conflict");
    await expect(store.beginAttempt(expected(held))).rejects.toThrow("retry-not-permitted");
    const released = await store.release(expected(held));
    await expect(store.beginAttempt(expected(released))).rejects.toThrow("owner-unavailable");
    expect(store.status(INPUT.id)?.state).toBe("blocked");
    const record = store.read(INPUT.id)!;
    const retained = await store.reconcile(expected(record), {
      kind: "retained",
      ref: "owner-review:1",
      source: null,
      retention,
    });
    expect(retained.state).toBe("retained");
    expect(retained.retention).toEqual(retention);
    const ready = await store.release(expected(retained));
    const handled = await store.reconcile(expected(ready), {
      kind: "handled",
      ref: "recipient-reply:1",
      source: null,
      retention: null,
    });
    expect(handled.state).toBe("handled");
    expect(handled.attempts).toEqual([]);
    expect(handled.envelope.body).toBe(INPUT.body);
    expect(await store.reconcile(expected(handled), handled.evidence.at(-1)!)).toEqual(handled);
  });

  it("persists before action, resolves ownership on each attempt and separates acceptance from handling", async () => {
    let owner = OWNER;
    let resolutions = 0;
    const { directory, store } = setup(() => {
      resolutions++;
      return owner;
    });
    const queued = await store.enqueue({ ...INPUT, intent: "unblock" });
    const first = await store.beginAttempt(expected(queued));
    expect(store.read(INPUT.id)).toMatchObject({
      state: "sending",
      attempts: [{ source: first.source, state: "sending" }],
    });
    await expect(store.recover(expected(store.read(INPUT.id)!))).rejects.toBeInstanceOf(LockBusy);
    const refused = first.complete({ source: first.source, state: "blocked", reason: "refused" });
    owner = { harness: "claude", nativeId: REPLACEMENT, parentBinding: null };
    const second = await store.beginAttempt(expected(refused));
    expect(resolutions).toBe(2);
    expect(second.source.owner).toEqual(owner);
    expect(second.source.requestId).not.toBe(first.source.requestId);
    const before = readFileSync(disk(directory), "utf8");
    expect(() =>
      second.complete({ source: first.source, state: "accepted", reason: null }),
    ).toThrow("binding-conflict");
    expect(readFileSync(disk(directory), "utf8")).toBe(before);
    const accepted = second.complete({ source: second.source, state: "accepted", reason: null });
    expect(accepted.state).toBe("accepted");
    expect(accepted.attempts[0]?.source.owner).toEqual(OWNER);
    expect(accepted.evidence).toEqual([]);
    expect(store.status(INPUT.id)).toMatchObject({
      revision: accepted.revision,
      outbox: [
        { requestId: first.source.requestId, hop: "recipient", state: "blocked" },
        { requestId: second.source.requestId, hop: "recipient", state: "accepted" },
      ],
    });
    expect(JSON.stringify(store.status(INPUT.id))).not.toContain(REPLACEMENT);
    await expect(store.beginAttempt(expected(accepted))).rejects.toThrow("retry-not-permitted");
    const handled = await store.reconcile(expected(accepted), {
      kind: "handled",
      ref: "recipient-reply:2",
      source: second.source,
      retention: null,
    });
    expect(handled.state).toBe("handled");
  });

  it("preserves direct worker refusal and never treats parent-hop acceptance as child delivery", async () => {
    const { store } = setup(() => ({ ...OWNER, extraMetadata: "not part of binding" }));
    const queued = await store.enqueue({
      ...INPUT,
      intent: "unblock",
      toRole: "game-kit",
      parentRole: "game-kit",
      workerId: CHILD,
    });
    const direct = await store.beginAttempt(expected(queued));
    const refused = direct.complete({
      source: direct.source,
      state: "parent-required",
      reason: "worker-parent-required",
    });
    expect(refused.envelope.body).toBe(INPUT.body);
    await expect(
      store.reconcile(expected(refused), {
        kind: "not-delivered",
        ref: "direct-refusal:1",
        source: direct.source,
        retention: null,
      }),
    ).rejects.toThrow("parent-hop-required");
    await expect(store.beginAttempt(expected(refused))).rejects.toThrow("parent-hop-required");
    const parent = await store.beginAttempt(expected(refused), "parent");
    expect(parent.source.owner.parentBinding).toEqual(OWNER.parentBinding);
    expect(parent.source.hop).toBe("parent");
    const accepted = parent.complete({ source: parent.source, state: "accepted", reason: null });
    expect(accepted.state).toBe("parent-required");
    expect(accepted.attempts.at(-1)?.state).toBe("accepted");
    await expect(store.beginAttempt(expected(accepted), "parent")).rejects.toThrow(
      "retry-not-permitted",
    );
    await expect(
      store.reconcile(expected(accepted), {
        kind: "accepted",
        ref: "parent-receipt",
        source: direct.source,
        retention: null,
      }),
    ).rejects.toThrow("binding-conflict");
    expect(store.inbox("game-kit")[0]?.envelope.body).toBe(INPUT.body);
  });

  it("recovers an interrupted sender as ambiguous and requires exact evidence before any retry", async () => {
    const { context, store } = setup();
    const queued = await store.enqueue({ ...INPUT, intent: "unblock" });
    const script = `import {MessageStore} from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
      const store = new MessageStore({
        layout:${JSON.stringify(context.layout)},
        resolveOwner:()=>(${JSON.stringify(OWNER)}),
        now:()=>${JSON.stringify(NOW)}
      });
      const record=store.read(${JSON.stringify(INPUT.id)});
      const lease=await store.beginAttempt({envelope:record.envelope,source:null,revision:record.revision});
      process.stdout.write(JSON.stringify(lease.source)); process.exit(0);`;
    const source = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }),
    ) as MessageAttemptSource;
    expect(store.status(INPUT.id)?.state).toBe("sending");
    const guard = { envelope: queued.envelope, revision: store.read(INPUT.id)!.revision, source };
    const recovered = await new MessageStore(context).recover(guard);
    expect(recovered.state).toBe("ambiguous");
    expect(recovered.attempts.at(-1)?.reason).toBe("interrupted");
    await expect(store.beginAttempt(expected(recovered))).rejects.toThrow("retry-not-permitted");
    await expect(
      store.reconcile(
        {
          ...expected(recovered),
          envelope: messageEnvelope({ ...INPUT, intent: "unblock", body: "changed" }),
        },
        { kind: "not-delivered", ref: "receipt:1", source, retention: null },
      ),
    ).rejects.toThrow("binding-conflict");
    const reconciled = await store.reconcile(expected(recovered), {
      kind: "accepted",
      ref: "native-receipt:1",
      source,
      retention: null,
    });
    expect(reconciled.state).toBe("accepted");
    const held = await store.hold(expected(reconciled), {
      ownerRole: INPUT.toRole,
      reason: "independent hold",
      nextBoundary: ":50 review",
    });
    const released = await store.release(expected(held));
    expect(released.state).toBe("accepted");
    await expect(store.beginAttempt(expected(released))).rejects.toThrow("retry-not-permitted");
  });

  it("closes a lost-response attempt ambiguously, permits evidence-backed retry and preserves corruption", async () => {
    const { directory, store } = setup();
    const queued = await store.enqueue(INPUT);
    const lease = await store.beginAttempt(expected(queued));
    lease.close();
    lease.close();
    const lost = store.read(INPUT.id)!;
    expect(lost.state).toBe("ambiguous");
    const held = await store.hold(expected(lost), {
      ownerRole: INPUT.toRole,
      reason: "independent question hold",
      nextBoundary: ":20 review",
    });
    const reconciled = await store.reconcile(expected(held), {
      kind: "not-delivered",
      ref: "transport-proof:1",
      source: lease.source,
      retention: null,
    });
    expect(reconciled.state).toBe("held");
    expect(reconciled.retention).toEqual(held.retention);
    const retryable = await store.release(expected(reconciled));
    const retry = await store.beginAttempt(expected(retryable));
    const blocked = retry.complete({
      source: retry.source,
      state: "blocked",
      reason: "transport-unavailable",
    });
    expect(blocked.attempts).toHaveLength(2);
    const superseded = await store.reconcile(expected(blocked), {
      kind: "superseded",
      ref: "replacement-task:2",
      source: retry.source,
      retention: null,
    });
    expect(superseded.envelope).toEqual(queued.envelope);
    const path = disk(directory);
    const corrupt = '{"unreadable-message-body":"not-a-valid-record"';
    writeFileSync(path, corrupt);
    expect(() => store.status(INPUT.id)).toThrow("unreadable-record");
    expect(store.summary()).toEqual({
      schema: 1,
      status: "unavailable",
      reason: "unreadable-inbox",
      counts: null,
      messages: null,
    });
    await expect(store.enqueue(INPUT)).rejects.toThrow("unreadable-record");
    expect(readFileSync(path, "utf8")).toBe(corrupt);
  });

  it("locates channel state within the shared message tree without creating or guessing identities", () => {
    const { context } = setup();
    expect(messageChannelStateDir(context.layout, CHILD)).toBe(
      join(context.layout.reviewDir, "messages", "recipients", CHILD, "unblock"),
    );
    expect(() => messageChannelStateDir(context.layout, "../../other-session")).toThrow(
      "canonical session UUID required",
    );
    expect(messageSummary(context.layout)).toMatchObject({ status: "available", messages: [] });
    expect(readdirSync(context.layout.reviewDir)).toEqual([]);
  });

  it("persists the exact worker target across restarts and refuses target conflicts or resolver drift", async () => {
    let owner = OWNER;
    let resolved: MessageEnvelope | undefined;
    const { context, directory, store } = setup((role, envelope) => {
      expect(role).toBe("game-kit");
      resolved = envelope;
      return owner;
    });
    const input: MessageInput = {
      ...INPUT,
      toRole: "game-kit",
      parentRole: "game-kit",
      workerId: CHILD,
    };
    const queued = await store.enqueue(input);
    const restarted = new MessageStore(context);
    expect(restarted.read(input.id)?.envelope).toMatchObject({
      workerId: CHILD,
      parentRole: "game-kit",
    });
    const before = readFileSync(disk(directory), "utf8");
    await expect(restarted.enqueue({ ...input, workerId: REPLACEMENT })).rejects.toThrow(
      "id-conflict",
    );
    expect(readFileSync(disk(directory), "utf8")).toBe(before);
    expect(() => messageEnvelope({ ...INPUT, parentRole: "game-kit" })).toThrow(
      "invalid-worker-target",
    );
    const first = await restarted.beginAttempt(expected(queued));
    expect(resolved).toEqual(queued.envelope);
    const blocked = first.complete({ source: first.source, state: "blocked", reason: "refused" });
    owner = { ...OWNER, nativeId: REPLACEMENT };
    await expect(restarted.beginAttempt(expected(blocked))).rejects.toThrow("owner-unavailable");
    expect(restarted.read(input.id)).toMatchObject({
      envelope: { workerId: CHILD, parentRole: "game-kit", body: input.body },
      attempts: [blocked.attempts[0]],
    });
    expect(restarted.status(input.id)).toMatchObject({ workerId: CHILD, parentRole: "game-kit" });
  });
});
