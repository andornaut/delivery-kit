import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { messageEnvelope } from "../messages/envelope.ts";
import type { MessageInput } from "../messages/types.ts";
import { ProtocolStore, protocolWorkerRole } from "./core.ts";
import {
  type MessageWriter,
  type ProtocolMessageGuards,
  ProtocolMessages,
  type ProtocolReceiptInput,
  type PublishOriginal,
} from "./messages.ts";
import type { Binding } from "./types.ts";

const AT = "2026-11-16T04:00:00.000Z";
const SENDER = "kits/delivery-kit";
const RECIPIENT = "kits/game-kit";
const FIRST: Binding = { harness: "codex", nativeId: "00000000-0000-4000-8000-000000000001" };
const SECOND: Binding = { harness: "claude", nativeId: "00000000-0000-4000-8000-000000000002" };
const CHILD = "00000000-0000-4000-8000-000000000003";
const NEW: Binding = { harness: "codex", nativeId: "00000000-0000-4000-8000-000000000004" };
const GUARDS: ProtocolMessageGuards = {
  question: "unknown",
  hold: "unknown",
  references: [],
  artifacts: [],
};
const BASES: string[] = [];

function original(change: Partial<MessageInput> = {}): PublishOriginal {
  return {
    envelope: {
      schema: 1,
      id: "message-one",
      fromRole: "delivery-kit",
      toRole: "game-kit",
      intent: "queue",
      body: "\uFEFFExact original \uFFFD\ntrailing newline\n",
      created: AT,
      ...change,
    },
    links: {
      requestIds: ["request-one"],
      clauseIds: ["clause-one"],
      workIds: [],
      messageIds: ["relay-one"],
    },
    guards: GUARDS,
  };
}

async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "protocol-messages-"));
  BASES.push(base);
  const directory = join(base, "state");
  const current = new Map<string, Binding>([
    [SENDER, FIRST],
    [RECIPIENT, SECOND],
  ]);
  const options = {
    directory,
    resolveBinding: (role: string, binding: Binding) =>
      current.get(role)?.harness === binding.harness &&
      current.get(role)?.nativeId === binding.nativeId,
  };
  const store = new ProtocolStore(options);
  const claim = (role: string, binding: Binding) =>
    store.claim({ role, binding, at: AT, expectedEpoch: 0, evidence: "fixture:owner-claim" });
  await claim(SENDER, FIRST);
  await claim(RECIPIENT, SECOND);
  const messages = new ProtocolMessages({ store });
  const writer = (role = SENDER, change: Partial<MessageWriter> = {}): MessageWriter => {
    const state = store.read(role);
    return {
      id: randomUUID(),
      role,
      binding: current.get(role)!,
      epoch: state.epoch,
      expectedRevision: state.revision,
      at: AT,
      ...change,
    };
  };
  const evidence = () => store.putArtifact(Buffer.from("Reviewed synthetic result\n"));
  return { base, directory, options, current, store, messages, writer, evidence };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const base of BASES.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});

describe("protocol messages", () => {
  it("discovers one canonical exact original after context and channel loss without writer credentials", async () => {
    const f = await fixture();
    const input = original();
    const writer = f.writer();
    const ref = await f.messages.publish(writer, input);
    expect(await f.messages.publish(writer, input)).toEqual(ref);
    expect(f.store.history(SENDER)).toHaveLength(2);
    expect(f.messages.find(SENDER, input.envelope.id)).toEqual(ref);
    await expect(
      f.messages.publish(f.writer(), original({ body: "Changed body" })),
    ).rejects.toMatchObject({ code: "message-conflict" });
    await f.messages.publish(f.writer(), original({ id: "message-two" }));

    // No channel object exists; a new process context can use the published filesystem alone.
    const readerStore = new ProtocolStore({ directory: f.directory });
    const reader = new ProtocolMessages({ store: readerStore });
    expect(reader.read(ref).envelope).toEqual(messageEnvelope(input.envelope));
    expect(reader.read(ref).guards).toEqual(GUARDS);
    const reads = vi.spyOn(readerStore, "read");
    const inbox = reader.inbox({ recipientRole: RECIPIENT, senders: [SENDER] });
    expect(inbox.scope).toBe("published-only");
    expect(inbox.messages).toHaveLength(2);
    expect(inbox.messages.every((row) => !Object.hasOwn(row.original.envelope, "body"))).toBe(true);
    expect(inbox.messages.every((row) => row.receipts.length === 0)).toBe(true);
    expect(reads.mock.calls.map((args) => args[0]).sort()).toEqual([RECIPIENT, SENDER].sort());
    reads.mockRestore();
    expect(
      reader.inbox({ recipientRole: RECIPIENT, includeBody: true }).messages[0]!.original.envelope
        .body,
    ).toBe(input.envelope.body);
    expect(f.store.history(RECIPIENT)).toHaveLength(1);
  });

  it("lets only the recipient publish handling and retention while preserving exact question guards", async () => {
    const f = await fixture();
    const guards: ProtocolMessageGuards = {
      question: "pending",
      hold: "unknown",
      references: ["question:exact-unanswered"],
      artifacts: [],
    };
    const ref = await f.messages.publish(f.writer(), { ...original(), guards });
    const proof = await f.evidence();
    const retained: ProtocolReceiptInput = {
      id: "retained-one",
      original: ref,
      disposition: "retained",
      evidence: [proof],
      retention: {
        ownerRole: "game-kit",
        reason: "Waiting for the owner's existing decision",
        nextBoundary: "next existing review",
      },
      guards,
    };
    await expect(f.messages.receipt(f.writer(), retained)).rejects.toMatchObject({
      code: "message-recipient-mismatch",
    });
    await expect(
      f.messages.receipt(f.writer(RECIPIENT), { ...retained, retention: null }),
    ).rejects.toMatchObject({ code: "message-retention-required" });
    const first = await f.messages.receipt(f.writer(RECIPIENT), retained);
    expect(f.messages.latestRecipientReceipt(ref)).toEqual({
      reference: first,
      value: { ...retained, schema: 1, kind: "message-receipt", recipientRole: RECIPIENT },
    });
    const handled = {
      ...retained,
      id: "handled-one",
      disposition: "handled" as const,
      retention: null,
    };
    const second = await f.messages.receipt(f.writer(RECIPIENT), handled);
    expect(second.revision).toBe(2);
    expect((await f.messages.receipt(f.writer(RECIPIENT), retained)).revision).toBe(1);
    expect(f.messages.latestRecipientReceipt(ref)?.reference).toEqual(second);
    expect(f.messages.latestRecipientReceipt(ref)?.value.guards).toEqual(guards);
    expect(f.messages.read(ref).guards).toEqual(guards);
    expect(f.store.history(RECIPIENT)).toHaveLength(3);
    await expect(
      f.messages.receipt(f.writer(RECIPIENT), { ...handled, disposition: "accepted" as never }),
    ).rejects.toMatchObject({ code: "invalid-message-receipt" });
  });

  it("keeps imported originals and attempts after cleanup without inventing a receipt or recall", async () => {
    const f = await fixture();
    const input = original();
    const envelope = messageEnvelope(input.envelope);
    const legacy = {
      schema: 1,
      revision: 4,
      envelope,
      state: "handled",
      reason: null,
      retention: null,
      attempts: [
        {
          source: {
            owner: { ...SECOND, parentBinding: null },
            hop: "recipient",
            requestId: "exact-native-request",
          },
          state: "accepted",
          started: AT,
          completed: AT,
          reason: null,
        },
      ],
      evidence: [{ kind: "handled", ref: "legacy:caller-agnostic", source: null, retention: null }],
      opaqueLegacyMetadata: { question: "unknown", originalReference: null },
    };
    const task = join(f.base, "task-worktree");
    mkdirSync(task);
    const bytes = Buffer.from(`${JSON.stringify(legacy, null, 1)}\n`);
    writeFileSync(join(task, "legacy.json"), bytes);
    const artifact = await f.store.putArtifact(readFileSync(join(task, "legacy.json")));
    const ref = await f.messages.publish(f.writer(), {
      ...input,
      imported: { legacyRecord: artifact, evidenceRef: "migration:reviewed-original" },
    });
    rmSync(task, { recursive: true });
    expect(Buffer.from(f.store.readArtifact(artifact.hash))).toEqual(bytes);
    expect(f.messages.read(ref).envelope).toEqual(envelope);
    expect(f.messages.latestRecipientReceipt(ref)).toBeNull();
    await expect(
      f.messages.publish(f.writer(), {
        ...original({ id: "wrong-body", body: "Different" }),
        imported: { legacyRecord: artifact, evidenceRef: "migration:invalid-anchor" },
      }),
    ).rejects.toMatchObject({ code: "legacy-original-mismatch" });
    const ambiguous = await f.store.putArtifact(
      Buffer.from(
        JSON.stringify({
          ...legacy,
          state: "ambiguous",
          attempts: [{ ...legacy.attempts[0], state: "ambiguous", completed: null }],
        }),
      ),
    );
    await f.messages.observeTransport(f.writer(), {
      id: "ambiguous-observation",
      original: ref,
      record: ambiguous,
      guards: GUARDS,
    });
    const observation = f.store
      .read(SENDER)
      .objects.find((row) => (row.value as { kind?: string })?.kind === "message-transport")!;
    expect(JSON.stringify(observation.value)).not.toContain(input.envelope.body);
    await f.messages.withdraw(f.writer(), {
      id: "withdrawal-one",
      original: ref,
      reason: "Sender requests withdrawal only",
      evidenceRef: "owner:withdrawal",
      guards: GUARDS,
    });
    const inbox = f.messages.inbox({ recipientRole: RECIPIENT });
    expect(inbox.messages[0]!.withdrawals[0]!.value).toMatchObject({
      status: "requested",
      recall: "cannot-recall",
    });
    expect(inbox.messages[0]!.receipts).toEqual([]);
    expect(f.messages.read(ref).envelope.payloadHash).toBe(envelope.payloadHash);
    expect(f.store.history(RECIPIENT)).toHaveLength(1);
  });

  it("distinguishes a failed manifest publication from a lost return after a durable commit", async () => {
    const f = await fixture();
    const input = original();
    vi.spyOn(f.store, "transact").mockRejectedValueOnce(new Error("synthetic precommit failure"));
    await expect(f.messages.publish(f.writer(), input)).rejects.toThrow(
      "synthetic precommit failure",
    );
    expect(f.messages.find(SENDER, input.envelope.id)).toBeNull();
    vi.restoreAllMocks();
    const publish = f.writer();
    const transact = f.store.transact.bind(f.store);
    vi.spyOn(f.store, "transact").mockImplementationOnce(async (transaction) => {
      await transact(transaction);
      throw new Error("synthetic lost result");
    });
    await expect(f.messages.publish(publish, input)).rejects.toThrow("synthetic lost result");
    vi.restoreAllMocks();
    const cold = new ProtocolMessages({ store: new ProtocolStore({ directory: f.directory }) });
    const ref = cold.find(SENDER, input.envelope.id)!;
    expect(cold.read(ref).envelope.body).toBe(input.envelope.body);
    expect(await f.messages.publish(publish, input)).toEqual(ref);
    expect(f.store.history(SENDER)).toHaveLength(2);
    const receipt: ProtocolReceiptInput = {
      id: "lost-receipt",
      original: ref,
      disposition: "handled",
      evidence: [await f.evidence()],
      retention: null,
      guards: GUARDS,
    };
    const recipient = f.writer(RECIPIENT);
    vi.spyOn(f.store, "transact").mockImplementationOnce(async (transaction) => {
      await transact(transaction);
      throw new Error("synthetic receipt response loss");
    });
    await expect(f.messages.receipt(recipient, receipt)).rejects.toThrow(
      "synthetic receipt response loss",
    );
    vi.restoreAllMocks();
    const committed = cold.latestRecipientReceipt(ref)!;
    expect(await f.messages.receipt(recipient, receipt)).toEqual(committed.reference);
    expect(f.store.history(RECIPIENT)).toHaveLength(2);
  });

  it("fences immutable-publication and historical-receipt replay after ownership rotation", async () => {
    const f = await fixture();
    const input = original();
    const oldSender = f.writer();
    const ref = await f.messages.publish(oldSender, input);
    const receipt: ProtocolReceiptInput = {
      id: "receipt-before-rotation",
      original: ref,
      disposition: "handled",
      evidence: [await f.evidence()],
      retention: null,
      guards: GUARDS,
    };
    const oldRecipient = f.writer(RECIPIENT);
    const received = await f.messages.receipt(oldRecipient, receipt);
    const rotate = (role: string) => {
      f.current.set(role, NEW);
      return f.store.claim({
        role,
        binding: NEW,
        expectedEpoch: 1,
        evidence: "fixture:approved-owner-rotation",
        at: AT,
      });
    };
    await rotate(SENDER);
    await rotate(RECIPIENT);
    await expect(
      f.messages.publish({ ...oldSender, id: "new-old-sender-command" }, input),
    ).rejects.toMatchObject({ code: "writer-fenced" });
    await expect(
      f.messages.receipt({ ...oldRecipient, id: "new-old-recipient-command" }, receipt),
    ).rejects.toMatchObject({ code: "writer-fenced" });
    expect(await f.messages.publish(f.writer(), input)).toEqual(ref);
    expect(await f.messages.receipt(f.writer(RECIPIENT), receipt)).toEqual(received);
    expect(f.store.history(SENDER)).toHaveLength(3);
    expect(f.store.history(RECIPIENT)).toHaveLength(3);
    const reader = new ProtocolMessages({ store: new ProtocolStore({ directory: f.directory }) });
    expect(reader.find(SENDER, input.envelope.id)).toEqual(ref);
    expect(reader.latestRecipientReceipt(ref)?.reference).toEqual(received);
  });

  it("keeps a worker-target receipt in the child's own fenced namespace instead of its parent's", async () => {
    const f = await fixture();
    const ref = await f.messages.publish(
      f.writer(),
      original({ workerId: CHILD, parentRole: "game-kit" }),
    );
    const childRole = protocolWorkerRole(RECIPIENT, CHILD, 1);
    const binding: Binding = { harness: "codex", nativeId: CHILD };
    f.current.set(childRole, binding);
    await f.store.claim({
      role: childRole,
      binding,
      expectedEpoch: 0,
      at: AT,
      evidence: "fixture:verified-child",
      parent: { role: RECIPIENT, epoch: 1, workerId: CHILD },
    });
    const receipt: ProtocolReceiptInput = {
      id: "child-handled",
      original: ref,
      disposition: "handled",
      evidence: [await f.evidence()],
      retention: null,
      guards: GUARDS,
    };
    await expect(f.messages.receipt(f.writer(RECIPIENT), receipt)).rejects.toMatchObject({
      code: "message-recipient-mismatch",
    });
    const publication = await f.messages.receipt(f.writer(childRole), receipt);
    expect(publication.role).toBe(childRole);
    expect(f.messages.latestRecipientReceipt(ref)?.reference).toEqual(publication);
    expect(f.store.read(RECIPIENT).objects.filter((row) => row.collection === "receipts")).toEqual(
      [],
    );
    expect(
      f.messages.inbox({ recipientRole: RECIPIENT }).messages[0]!.original.envelope.workerId,
    ).toBe(CHILD);
  });
});
