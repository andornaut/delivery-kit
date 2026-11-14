import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { decisionClear } from "../adapters/shared/decisions.ts";
import { writeJsonDurable } from "../durable.ts";
import { gameLayout, loadLayout } from "../layout.ts";
import { createRegistry, readRegistry, type Registry } from "../registry/index.ts";
import { CLAUDE_COORDINATOR, CODEX_TECH, makeFixture, registryInput } from "../testFixtures.ts";
import { messageChannelStateDir } from "./paths.ts";
import { messageConsumeGuard, messageGuardDirectory, MessageService } from "./service.ts";
import { messageExpectation, MessageStore } from "./store.ts";
import type { MessageTransport, NativeMessage } from "./transports.ts";

const GAME = "archies-dog-walks";
const ROLE = `${GAME}/tech`;
const ID = "00000000-0000-4000-8000-000000000010";
const SECOND = "00000000-0000-4000-8000-000000000011";
const WORKER = "00000000-0000-4000-8000-000000000012";
const REPLACEMENT = "00000000-0000-4000-8000-000000000013";
const NOW = "2026-11-14T22:00:00.000Z";
const BODY = "\ufeff  Full original é.\nLast line.\n";
const bases: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const base of bases.splice(0)) {
    rmSync(base, { recursive: true });
  }
});

function fixture() {
  const { base, root } = makeFixture();
  bases.push(base);
  const layout = loadLayout(root);
  createRegistry(layout, registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">);
  return { base, layout, root };
}

function codex(test: ReturnType<typeof fixture>): void {
  const registry = readRegistry(test.layout);
  writeJsonDurable(test.layout.registryFile, {
    ...registry,
    harness: "codex",
    roles: {
      ...registry.roles,
      "game-coordinator": {
        ...registry.roles["game-coordinator"],
        conversations: { codex: CLAUDE_COORDINATOR },
      },
    },
  });
}

function marker(directory: string, recipient: string, state = "clear"): void {
  const path = join(directory, "decisions", `${recipient}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeJsonDurable(path, { resolutions: [], state, thread_id: recipient });
}

function receipt(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeJsonDurable(path, value);
}

function input(recipient = ROLE, id = ID) {
  return { body: BODY, fromRole: "game-coordinator", id, recipient };
}

describe("message service", () => {
  it("keeps both harnesses local without probes and exposes exact bodies only on explicit reads", async () => {
    const test = fixture();
    let connects = 0;
    const context = {
      layout: test.layout,
      env: {},
      now: () => NOW,
      connect: async () => {
        connects++;
        throw new Error("must remain local");
      },
    };
    const service = new MessageService(context);
    const first = await service.send(input());
    expect(first.state).toBe("queued");
    codex(test);
    const restarted = new MessageService({ ...context, now: () => "2026-11-14T23:00:00.000Z" });
    expect(await restarted.send(input())).toEqual(first);
    await restarted.send(input(ROLE, SECOND));
    expect(connects).toBe(0);
    const metadata = restarted.status({ recipient: ROLE });
    expect(metadata).toHaveLength(2);
    expect(metadata[0]).not.toHaveProperty("body");
    expect(metadata[0]).not.toHaveProperty("payloadHash");
    expect(restarted.status({ recipient: ROLE, includeBody: true }).map((row) => row.body)).toEqual(
      [BODY, BODY],
    );
    expect(restarted.status({ id: ID, includeBody: true })[0]?.body).toBe(BODY);
    expect(restarted.store.summary()).toMatchObject({ status: "available", counts: { queued: 2 } });
    await expect(restarted.send({ ...input(), body: `${BODY}changed` })).rejects.toThrow(
      "id-conflict",
    );
  });

  it("requires existing clearance before dispatch and keeps acceptance distinct from handling", async () => {
    const test = fixture();
    codex(test);
    const sent: NativeMessage[] = [];
    const transport: MessageTransport = {
      send: async (_path, message) => {
        expect(service.store.status(ID)?.state).toBe("sending");
        sent.push(message);
        return { requestId: message.requestId, status: "accepted" };
      },
    };
    const service = new MessageService({
      layout: test.layout,
      env: {},
      transport: () => transport,
    });
    await service.send(input());
    expect((await service.dispatch(ID)).state).toBe("blocked");
    expect(service.store.read(ID)?.attempts).toEqual([]);
    expect(sent).toEqual([]);
    const directory = messageGuardDirectory(test.layout, ROLE)!;
    marker(directory, CODEX_TECH);
    const accepted = await service.dispatch(ID);
    expect(accepted.state).toBe("accepted");
    expect(sent[0]?.text).toBe(BODY);
    expect((await service.dispatch(ID)).state).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(accepted.evidence).toEqual([]);
    const handled = await service.reconcile({
      id: ID,
      expectedRevision: accepted.revision,
      disposition: "handled",
      evidence: "recipient-reply:1",
    });
    expect(handled.state).toBe("handled");
    expect(service.status({ id: ID, includeBody: true })[0]?.body).toBe(BODY);
  });

  it("never turns a lost-response receipt and later blocked guard into another add or native identity", async () => {
    const test = fixture();
    codex(test);
    const directory = messageGuardDirectory(test.layout, ROLE)!;
    marker(directory, CODEX_TECH);
    let adds = 0;
    const service = new MessageService({
      layout: test.layout,
      env: {},
      transport: () => ({
        send: async (path, message) => {
          adds++;
          receipt(path, {
            clientUserMessageId: message.requestId,
            recipient: message.recipient,
            text: message.text,
            status: "ambiguous",
          });
          return { requestId: message.requestId, status: "blocked" };
        },
      }),
    });
    await service.send(input());
    const unknown = await service.dispatch(ID);
    expect(unknown.state).toBe("ambiguous");
    const source = unknown.attempts[0]!.source;
    marker(directory, CODEX_TECH, "pending");
    const registry = readRegistry(test.layout);
    writeJsonDurable(test.layout.registryFile, {
      ...registry,
      roles: {
        ...registry.roles,
        [ROLE]: { ...registry.roles[ROLE], conversations: { codex: REPLACEMENT } },
      },
    });
    const again = await service.dispatch(ID);
    expect(again.state).toBe("ambiguous");
    expect(again.attempts).toHaveLength(1);
    expect(again.attempts[0]!.source).toEqual(source);
    expect(again.attempts[0]!.source.owner.nativeId).toBe(CODEX_TECH);
    expect(adds).toBe(1);
    await expect(
      service.reconcile({
        id: ID,
        expectedRevision: again.revision,
        disposition: "accepted",
        evidence: "queue-absence",
      }),
    ).rejects.toThrow("acceptance-unproven");
    await expect(
      service.reconcile({
        id: ID,
        expectedRevision: again.revision,
        disposition: "not-delivered",
        evidence: "queue-absence",
      } as unknown as Parameters<typeof service.reconcile>[0]),
    ).rejects.toThrow("invalid-disposition");
    expect(service.store.read(ID)?.state).toBe("ambiguous");
    expect(adds).toBe(1);
  });

  it("dispatches a persisted worker target as a parent request without claiming child delivery", async () => {
    const test = fixture();
    codex(test);
    writeJsonDurable(test.layout.routeFile, {
      schema: 2,
      state: "active",
      host: GAME,
      targets: [ROLE],
    });
    marker(join(gameLayout(test.layout, GAME).busDir, "unblock"), CLAUDE_COORDINATOR);
    const sent: NativeMessage[] = [];
    const context = {
      layout: test.layout,
      env: {},
      transport: () => ({
        send: async (_path: string, message: NativeMessage) => {
          sent.push(message);
          return { requestId: message.requestId, status: "accepted" as const };
        },
      }),
    };
    await new MessageService(context).send({ ...input(WORKER), parent: "game-coordinator" });
    const service = new MessageService(context);
    const result = await service.dispatch(ID);
    expect(result.state).toBe("parent-required");
    expect(result.envelope).toMatchObject({
      workerId: WORKER,
      parentRole: "game-coordinator",
      body: BODY,
    });
    expect(result.attempts[0]!.source.hop).toBe("parent");
    expect(sent[0]?.recipient).toBe(CLAUDE_COORDINATOR);
    expect(JSON.parse(sent[0]!.text)).toMatchObject({ workerId: WORKER, body: BODY });
    expect((await service.dispatch(ID)).state).toBe("parent-required");
    expect(sent).toHaveLength(1);
  });

  it("reconciles only exact bound accepted receipts without probing or inferring handling", async () => {
    const test = fixture();
    codex(test);
    let connects = 0;
    const service = new MessageService({
      layout: test.layout,
      env: {},
      connect: async () => {
        connects++;
        throw new Error("read only");
      },
    });
    const queued = await service.send(input());
    const lease = await service.store.beginAttempt(messageExpectation(queued));
    lease.close();
    const path = join(
      messageChannelStateDir(test.layout, CODEX_TECH),
      `${lease.source.requestId}.json`,
    );
    receipt(path, {
      requestId: lease.source.requestId,
      recipient: CODEX_TECH,
      text: `${BODY}changed`,
      status: "accepted",
    });
    expect((await service.reconcileReceipt(ID)).state).toBe("ambiguous");
    receipt(path, {
      requestId: lease.source.requestId,
      recipient: CODEX_TECH,
      text: BODY,
      status: "accepted",
    });
    const accepted = await service.reconcileReceipt(ID);
    expect(accepted.state).toBe("accepted");
    expect(accepted.evidence[0]?.kind).toBe("accepted");
    expect(connects).toBe(0);
    expect(accepted.envelope.body).toBe(BODY);
  });

  it("blocks consumption when the shared route becomes held during the supported listing read", async () => {
    const test = fixture();
    writeJsonDurable(test.layout.routeFile, {
      schema: 2,
      state: "active",
      host: GAME,
      targets: [ROLE],
    });
    const directory = join(gameLayout(test.layout, GAME).busDir, "unblock");
    marker(directory, CLAUDE_COORDINATOR);
    const executable = join(test.base, "listing.mjs");
    const heldRoute = { schema: 2, state: "held", host: GAME, targets: [ROLE] };
    const listing = JSON.stringify([{ sessionId: CLAUDE_COORDINATOR, status: "idle" }]);
    writeFileSync(
      executable,
      `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
      const path=${JSON.stringify(test.layout.routeFile)};
      const route=${JSON.stringify(heldRoute)};
      writeFileSync(path,JSON.stringify(route));
      process.stdout.write(${JSON.stringify(listing)});\n`,
    );
    chmodSync(executable, 0o700);
    const env = { CLAUDE_BIN: executable };
    const service = new MessageService({ layout: test.layout, env });
    const queued = await service.send(input("game-coordinator"));
    const lease = await service.store.beginAttempt(messageExpectation(queued));
    const pending = lease.complete({
      source: lease.source,
      state: "ambiguous",
      reason: "transport-pending",
    });
    const before = service.store.read(ID);
    const outcome = await messageConsumeGuard(
      test.layout,
      env,
    )({
      requestId: lease.source.requestId,
      recipient: CLAUDE_COORDINATOR,
      text: BODY,
    });
    expect(outcome.status).toBe("blocked");
    expect(JSON.parse(readFileSync(test.layout.routeFile, "utf8")).state).toBe("held");
    expect(decisionClear(directory, CLAUDE_COORDINATOR)).toBe(true);
    expect(service.store.read(ID)).toEqual(before);
    expect(service.store.read(ID)?.revision).toBe(pending.revision);
    expect(
      existsSync(join(messageChannelStateDir(test.layout, CLAUDE_COORDINATOR), "decisions")),
    ).toBe(false);
  });

  it("blocks an old spool when a newer attempt replaces it between summary and record reads", async () => {
    const test = fixture();
    writeJsonDurable(test.layout.routeFile, {
      schema: 2,
      state: "active",
      host: GAME,
      targets: [ROLE],
    });
    marker(join(gameLayout(test.layout, GAME).busDir, "unblock"), CLAUDE_COORDINATOR);
    const executable = join(test.base, "idle-listing.mjs");
    const listing = JSON.stringify([{ sessionId: CLAUDE_COORDINATOR, status: "idle" }]);
    writeFileSync(
      executable,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(listing)});\n`,
    );
    chmodSync(executable, 0o700);
    const env = { CLAUDE_BIN: executable };
    const service = new MessageService({ layout: test.layout, env });
    const queued = await service.send(input("game-coordinator"));
    const firstLease = await service.store.beginAttempt(messageExpectation(queued));
    const first = firstLease.complete({
      source: firstLease.source,
      state: "blocked",
      reason: "refused",
    });
    const secondLease = await service.store.beginAttempt(messageExpectation(first));
    const second = secondLease.complete({
      source: secondLease.source,
      state: "ambiguous",
      reason: "transport-pending",
    });
    expect(firstLease.source.owner).toEqual(secondLease.source.owner);
    expect(first.envelope).toEqual(second.envelope);
    expect(firstLease.source.requestId).not.toBe(secondLease.source.requestId);
    const directory = join(test.layout.reviewDir, "messages");
    const file = readdirSync(directory).find((name) => name.endsWith(".json"))!;
    const path = join(directory, file);
    // The summary observes the refused attempt; a concurrent sender then persists its successor.
    writeJsonDurable(path, first);
    const summary = MessageStore.prototype.summary;
    vi.spyOn(MessageStore.prototype, "summary").mockImplementationOnce(function (
      this: MessageStore,
    ) {
      const snapshot = summary.call(this);
      writeJsonDurable(path, second);
      return snapshot;
    });
    const outcome = await messageConsumeGuard(
      test.layout,
      env,
    )({
      requestId: firstLease.source.requestId,
      recipient: CLAUDE_COORDINATOR,
      text: BODY,
    });
    expect(outcome.status).toBe("blocked");
    expect(service.store.read(ID)).toEqual(second);
    expect(service.store.read(ID)?.attempts.at(-1)?.source.requestId).toBe(
      secondLease.source.requestId,
    );
  });
});
