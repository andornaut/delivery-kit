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

import { deliverPending } from "../adapters/claude/channel.ts";
import { spoolDir } from "../adapters/claude/spool.ts";
import { type RpcClient, RpcError } from "../adapters/codex/rpc.ts";
import { decisionClear } from "../adapters/shared/decisions.ts";
import { safeDeliveryDiagnostic } from "../adapters/types.ts";
import { writeJsonDurable } from "../durable.ts";
import { gameLayout, loadLayout } from "../layout.ts";
import { holdLock } from "../lock.ts";
import { createRegistry, readRegistry, type Registry } from "../registry/index.ts";
import { CLAUDE_COORDINATOR, CODEX_TECH, makeFixture, registryInput } from "../testFixtures.ts";
import { messageChannelStateDir } from "./paths.ts";
import { messageConsumeGuard, messageGuardDirectory, MessageService } from "./service.ts";
import { messageExpectation, MessageStore } from "./store.ts";
import { claudeMessageTransport, type MessageTransport, type NativeMessage } from "./transports.ts";

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

  it("records a deduplicated transport result as accepted with its diagnostic and sends once", async () => {
    const test = fixture();
    codex(test);
    marker(messageGuardDirectory(test.layout, ROLE)!, CODEX_TECH);
    let sends = 0;
    const service = new MessageService({
      layout: test.layout,
      env: {},
      transport: () => ({
        send: async (_path, message) => {
          sends++;
          return {
            diagnostic: { category: "deduplicated", classification: "guarded", stage: "receipt" },
            requestId: message.requestId,
            status: "accepted",
          };
        },
      }),
    });
    await service.send(input());
    const accepted = await service.dispatch(ID);
    const diagnostic = { category: "deduplicated", classification: "guarded", stage: "receipt" };
    expect(accepted).toMatchObject({ diagnostic, reason: null, state: "accepted" });
    expect(accepted.attempts.at(-1)).toMatchObject({ diagnostic, state: "accepted" });
    expect((await service.dispatch(ID)).state).toBe("accepted");
    expect(sends).toBe(1);
  });

  it("prepares receipt storage before transport and blocks directory failures without sending", async () => {
    const test = fixture();
    codex(test);
    marker(messageGuardDirectory(test.layout, ROLE)!, CODEX_TECH);
    const directory = messageChannelStateDir(test.layout, CODEX_TECH);
    mkdirSync(dirname(directory), { recursive: true });
    writeFileSync(directory, "not a directory");
    let sends = 0;
    const service = new MessageService({
      layout: test.layout,
      env: {},
      transport: () => ({
        send: async (path, message) => {
          sends++;
          expect(existsSync(dirname(path))).toBe(true);
          return { requestId: message.requestId, status: "accepted" };
        },
      }),
    });
    await service.send(input());
    expect(await service.dispatch(ID)).toMatchObject({
      state: "blocked",
      reason: "transport-unavailable",
    });
    expect(sends).toBe(0);
    rmSync(directory);
    expect((await service.dispatch(ID)).state).toBe("accepted");
    expect(sends).toBe(1);
    expect(service.store.read(ID)?.envelope.body).toBe(BODY);
  });

  it("reports connection failure before unblock admission as unavailable", async () => {
    const test = fixture();
    codex(test);
    marker(messageGuardDirectory(test.layout, ROLE)!, CODEX_TECH);
    const service = new MessageService({
      layout: test.layout,
      env: {},
      connect: async () => {
        throw new Error("connection unavailable");
      },
    });
    await service.send({ ...input(), intent: "unblock" });
    expect(await service.dispatch(ID)).toMatchObject({
      state: "blocked",
      reason: "transport-unavailable",
    });
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

  it("blocks an old spool when a newer attempt replaces it between index and record reads", async () => {
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
    // The index observes the refused attempt; a concurrent sender then persists its successor.
    writeJsonDurable(path, first);
    const attemptIndex = MessageStore.prototype.attemptIndex;
    vi.spyOn(MessageStore.prototype, "attemptIndex").mockImplementationOnce(function (
      this: MessageStore,
    ) {
      const snapshot = attemptIndex.call(this);
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

describe("channel consumer guard cost", () => {
  async function spooled(
    test: ReturnType<typeof fixture>,
    service: MessageService,
    id: string,
    body: string,
  ) {
    const record = await service.send({ ...input("game-coordinator", id), body });
    const lease = await service.store.beginAttempt(messageExpectation(record));
    const source = lease.source;
    const pending = lease.complete({ reason: "transport-pending", source, state: "ambiguous" });
    const stateDir = messageChannelStateDir(test.layout, CLAUDE_COORDINATOR);
    const path = join(stateDir, `${source.requestId}.json`);
    const transport = claudeMessageTransport({ messageChannelStateDir: stateDir });
    const message = { recipient: CLAUDE_COORDINATOR, requestId: source.requestId, text: body };
    mkdirSync(stateDir, { recursive: true });
    expect((await transport.send(path, message)).status).toBe("queued");
    return { message, path, pending, transport };
  }

  function deliverable(test: ReturnType<typeof fixture>) {
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
    return { CLAUDE_BIN: executable };
  }

  it("indexes the store once per drain and skips terminal parents without claiming or rescanning", async () => {
    const test = fixture();
    const env = deliverable(test);
    const service = new MessageService({ layout: test.layout, env });
    const terminal = [];
    for (const [index, id] of [ID, SECOND, REPLACEMENT].entries()) {
      // Sequential sends keep each message lock and spool write ordered.
      // eslint-disable-next-line no-await-in-loop
      const entry = await spooled(test, service, id, `terminal original ${index}\n`);
      // eslint-disable-next-line no-await-in-loop
      await service.reconcile({
        disposition: "superseded",
        evidence: "fixture-owner-reconciliation",
        expectedRevision: entry.pending.revision,
        id,
      });
      terminal.push(entry);
    }
    const busDir = dirname(messageChannelStateDir(test.layout, CLAUDE_COORDINATOR));
    const summary = vi.spyOn(MessageStore.prototype, "summary");
    const scans = vi.spyOn(MessageStore.prototype, "attemptIndex");
    const lines: string[] = [];
    const guard = messageConsumeGuard(test.layout, env);
    const drain = () =>
      deliverPending((line) => void lines.push(line), busDir, CLAUDE_COORDINATOR, {
        beforeMessage: guard,
      });
    expect(await drain()).toBe(true);
    expect(scans).toHaveBeenCalledTimes(1);
    expect(await drain()).toBe(true);
    expect(scans).toHaveBeenCalledTimes(1);
    expect(summary).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
    const spool = readdirSync(spoolDir(busDir)).sort();
    expect(spool).toEqual(terminal.map((entry) => `${entry.message.requestId}.json`).sort());
    for (const entry of terminal) {
      expect(JSON.parse(readFileSync(entry.path, "utf8")).status).toBe("sending");
    }
    // Between drains a sender's non-blocking unblock.lock attempt succeeds.
    const live = await spooled(test, service, WORKER, "deliverable original\n");
    expect(await drain()).toBe(true);
    expect(scans).toHaveBeenCalledTimes(2);
    expect(lines.map((line) => JSON.parse(line).params.content)).toEqual([
      "deliverable original\n",
    ]);
    expect((await live.transport.send(live.path, live.message)).status).toBe("accepted");
  });
});

describe("busy Claude spool", () => {
  it("records a busy spool as a retryable transport-busy refusal and re-dispatches it", async () => {
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
    const service = new MessageService({ layout: test.layout, env: { CLAUDE_BIN: executable } });
    await service.send(input("game-coordinator"));
    const stateDir = messageChannelStateDir(test.layout, CLAUDE_COORDINATOR);
    mkdirSync(stateDir, { recursive: true });
    const held = holdLock(join(stateDir, "unblock.lock"));
    let busy;
    try {
      busy = await service.dispatch(ID);
    } finally {
      held.release();
    }
    const diagnostic = { category: "busy", classification: "unavailable", stage: "receipt" };
    expect(busy).toMatchObject({ reason: "transport-busy", state: "blocked", diagnostic });
    expect(busy.attempts).toHaveLength(1);
    expect(busy.attempts[0]).toMatchObject({ reason: "transport-busy", state: "blocked" });
    expect(service.status({ id: ID })[0]).toMatchObject({
      diagnostic,
      outbox: [{ diagnostic, state: "blocked" }],
      reason: "transport-busy",
    });
    const first = busy.attempts[0]!.source.requestId;
    expect(existsSync(join(stateDir, `${first}.json`))).toBe(false);
    expect(existsSync(join(spoolDir(dirname(stateDir)), `${first}.json`))).toBe(false);
    const retried = await service.dispatch(ID);
    // The queued spool leaves its receipt at sending, so the attempt stays ambiguous until consumed.
    expect(retried.state).toBe("ambiguous");
    expect(retried.reason).not.toBe("transport-busy");
    expect(retried.attempts).toHaveLength(2);
    const second = retried.attempts[1]!.source.requestId;
    expect(second).not.toBe(first);
    expect(existsSync(join(spoolDir(dirname(stateDir)), `${second}.json`))).toBe(true);
  });
});

describe("safe refusal diagnostics", () => {
  it("separates local zero-attempt guards from durable native RPC refusals", async () => {
    const test = fixture();
    codex(test);
    let sends = 0;
    const client: RpcClient = {
      close() {},
      async call(method) {
        if (method === "thread/read") {
          return {
            thread: { id: CODEX_TECH, canAcceptDirectInput: true, status: { type: "idle" } },
          };
        }
        if (method === "thread/turns/list") {
          return { data: [{ id: "prior-turn", status: "completed" }] };
        }
        if (method === "thread/items/list") {
          return { data: [] };
        }
        if (method === "turn/start") {
          sends++;
          throw new RpcError(
            {
              code: -32000,
              message: "private-fixture-detail",
              data: { context: "private-fixture-context" },
            },
            method,
          );
        }
        throw new Error("unexpected method");
      },
    };
    const context = { layout: test.layout, env: {}, connect: async () => client };
    const service = new MessageService(context);
    await service.send({ ...input(), intent: "unblock" });
    const local = await service.dispatch(ID);
    expect(local.attempts).toHaveLength(0);
    expect(service.status({ id: ID })[0]).toMatchObject({
      state: "blocked",
      reason: "guarded",
      diagnostic: { stage: "local", category: "decision-clearance", classification: "guarded" },
    });
    marker(messageGuardDirectory(test.layout, ROLE)!, CODEX_TECH);
    const refused = await service.dispatch(ID);
    expect(sends).toBe(1);
    expect(refused.state).toBe("blocked");
    expect(refused.attempts).toHaveLength(1);
    const diagnostic = {
      stage: "native-send",
      category: "rpc-refusal",
      classification: "native-rejected",
      method: "turn/start",
      rpcCode: -32000,
    };
    const status = service.status({ id: ID })[0]!;
    expect(status.diagnostic).toEqual(diagnostic);
    expect(status.outbox[0]?.diagnostic).toEqual(diagnostic);
    const requestId = status.outbox[0]!.requestId;
    const restarted = new MessageService(context);
    expect(restarted.status({ id: ID })[0]?.outbox[0]).toMatchObject({ requestId, diagnostic });
    await restarted.reconcile({
      id: ID,
      expectedRevision: refused.revision,
      disposition: "superseded",
      evidence: "fixture-owner-reconciliation",
    });
    expect(restarted.status({ id: ID })[0]?.outbox[0]).toMatchObject({ requestId, diagnostic });
    expect(sends).toBe(1);
    expect(JSON.stringify(status)).not.toContain("private-fixture");
    expect(JSON.stringify(refused)).not.toContain("private-fixture");
  });

  it("projects finite diagnostics and omits unknown RPC codes, methods and native context", () => {
    const error = new RpcError(
      {
        code: 123456,
        message: "private-fixture-native-message",
        data: { detail: "private-fixture-native-data" },
      },
      "unknown/private-fixture-method",
    );
    expect(error.diagnostic).toEqual({
      stage: "native-send",
      category: "rpc-refusal",
      classification: "native-rejected",
    });
    expect(error.code).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("private-fixture");
    expect(
      safeDeliveryDiagnostic({
        ...error.diagnostic,
        text: "private-fixture-payload",
        context: "private-fixture-context",
        rpcCode: 123456,
        method: "unknown",
      }),
    ).toEqual(error.diagnostic);
    expect(
      safeDeliveryDiagnostic({ ...error.diagnostic, category: "private-fixture-category" }),
    ).toBeUndefined();
  });
});

it("preserves a typed question guard through the native receipt without claiming native input", async () => {
  const test = fixture();
  codex(test);
  let inputCalls = 0;
  marker(messageGuardDirectory(test.layout, ROLE)!, CODEX_TECH);
  const client: RpcClient = {
    close() {},
    async call(method) {
      if (method === "thread/read") {
        return { thread: { id: CODEX_TECH, canAcceptDirectInput: true, status: { type: "idle" } } };
      }
      if (method === "thread/turns/list") {
        return { data: [{ id: "prior-turn", status: "completed" }] };
      }
      if (method === "thread/items/list") {
        return {
          data: [
            {
              turnId: "prior-turn",
              item: { id: "pending-item", type: "dynamicToolCall", tool: "request_user_input" },
            },
          ],
        };
      }
      inputCalls++;
      throw new Error("must not admit native input");
    },
  };
  const service = new MessageService({ layout: test.layout, env: {}, connect: async () => client });
  await service.send({ ...input(), intent: "unblock" });
  const record = await service.dispatch(ID);
  expect(record.state).toBe("blocked");
  expect(record.reason).toBe("refused");
  expect(record.attempts).toHaveLength(1);
  expect(inputCalls).toBe(0);
  const diagnostic = {
    stage: "question-guard",
    category: "pending-question",
    classification: "guarded",
  };
  expect(service.status({ id: ID })[0]).toMatchObject({ diagnostic, outbox: [{ diagnostic }] });
  const source = record.attempts[0]!.source;
  const nativeReceipt = JSON.parse(
    readFileSync(
      join(messageChannelStateDir(test.layout, CODEX_TECH), `${source.requestId}.json`),
      "utf8",
    ),
  );
  expect(nativeReceipt).toMatchObject({ status: "deferred", diagnostic, attempts: [] });
});
