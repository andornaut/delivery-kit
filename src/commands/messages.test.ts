import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { DeliveryDiagnostic } from "../adapters/types.ts";
import type { Handler } from "../io.ts";
import { loadLayout } from "../layout.ts";
import { MessageService } from "../messages/service.ts";
import { messageExpectation } from "../messages/store.ts";
import { createRegistry, type Registry } from "../registry/index.ts";
import { makeFixture, registryInput } from "../testFixtures.ts";
import { messageDispatch, messageReconcile, messageSend, messageStatus } from "./messages.ts";

const ID = "00000000-0000-4000-8000-000000000099";
const ROLE = "archies-dog-walks/tech";
const BODY = "  exact original é\nSecond line.\n\n";

function setup() {
  const fixture = makeFixture();
  const layout = loadLayout(fixture.root);
  createRegistry(layout, {
    ...(registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">),
    harness: "codex",
  });
  const bodyFile = join(fixture.base, "body.txt");
  writeFileSync(bodyFile, BODY);
  return { ...fixture, bodyFile, layout };
}

async function run(test: ReturnType<typeof setup>, handler: Handler, ...args: string[]) {
  let out = "";
  let err = "";
  const code = await handler(
    {
      cwd: test.base,
      env: { CLAUDE_BIN: "/never/run", CODEX_CONTROL_SOCKET: "/never/connect" },
      err: (value) => {
        err += value;
      },
      out: (value) => {
        out += value;
      },
    },
    test.root,
    args,
  );
  return { code, err, out };
}

function sendArgs(): string[] {
  return ["--from", "game-coordinator", "--recipient", ROLE, "--id", ID, "--body-file", "body.txt"];
}

describe("common message command handlers", () => {
  it("stores local text relative to caller CWD and pulls the exact body only on explicit request", async () => {
    const test = setup();
    const registry = readFileSync(test.layout.registryFile, "utf8");
    const sent = await run(test, messageSend, ...sendArgs());
    expect(sent).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse(sent.out)).toMatchObject({
      state: "queued",
      attempts: 0,
      id: ID,
      intent: "queue",
    });
    expect(JSON.parse(sent.out)).not.toHaveProperty("body");
    const status = await run(test, messageStatus, "--id", ID);
    expect(JSON.parse(status.out)).toEqual([JSON.parse(sent.out)]);
    for (const selection of [
      ["--id", ID],
      ["--recipient", ROLE],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const pulled = await run(test, messageStatus, ...selection, "--include-body");
      expect(pulled).toMatchObject({ code: 0, err: "" });
      expect(JSON.parse(pulled.out)[0]).toMatchObject({ body: BODY, state: "queued", attempts: 0 });
    }
    expect(readFileSync(test.layout.registryFile, "utf8")).toBe(registry);
  });

  it("preserves immutable IDs and reports file errors without exposing paths or payloads", async () => {
    const test = setup();
    await run(test, messageSend, ...sendArgs());
    writeFileSync(test.bodyFile, "PRIVATE_BODY");
    const conflicting = await run(test, messageSend, ...sendArgs());
    expect(conflicting).toEqual({ code: 1, out: "", err: "delivery-kit: id-conflict\n" });
    const args = sendArgs();
    args[args.length - 1] = "PRIVATE_MISSING_FILE";
    expect(await run(test, messageSend, ...args)).toEqual({
      code: 1,
      out: "",
      err: "delivery-kit: message_operation_failed\n",
    });
    const pulled = await run(test, messageStatus, "--id", ID, "--include-body");
    expect(JSON.parse(pulled.out)[0].body).toBe(BODY);
  });

  it("rejects malformed UTF-8 and preserves valid BOM, U+FFFD and trailing newlines", async () => {
    const test = setup();
    writeFileSync(
      test.bodyFile,
      Buffer.concat([Buffer.from("PRIVATE_PREFIX"), Buffer.from([0xc3, 0x28])]),
    );
    expect(await run(test, messageSend, ...sendArgs())).toEqual({
      code: 1,
      out: "",
      err: "delivery-kit: invalid-body-encoding\n",
    });
    expect(existsSync(join(test.layout.reviewDir, "messages"))).toBe(false);
    const empty = await run(test, messageStatus, "--recipient", ROLE, "--include-body");
    expect(empty).toEqual({ code: 0, out: "[]\n", err: "" });
    const valid = Buffer.from("\ufeff  Valid replacement \ufffd.\n\n", "utf8");
    writeFileSync(test.bodyFile, valid);
    const sent = await run(test, messageSend, ...sendArgs());
    expect(sent).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse(sent.out)).not.toHaveProperty("body");
    const pulled = await run(test, messageStatus, "--id", ID, "--include-body");
    expect(pulled).toMatchObject({ code: 0, err: "" });
    const body = JSON.parse(pulled.out)[0].body as string;
    expect(body).toBe(valid.toString("utf8"));
    expect(Buffer.from(body, "utf8")).toEqual(valid);
  });

  it("stores explicit worker and intent options locally without treating the parent as the child", async () => {
    const test = setup();
    const worker = "00000000-0000-4000-8000-000000000098";
    const sent = await run(
      test,
      messageSend,
      "--from",
      "game-coordinator",
      "--recipient",
      worker,
      "--parent",
      ROLE,
      "--id",
      ID,
      "--body-file",
      "body.txt",
      "--intent",
      "unblock",
    );
    expect(sent).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse(sent.out)).toMatchObject({
      state: "queued",
      attempts: 0,
      toRole: ROLE,
      workerId: worker,
      parentRole: ROLE,
      intent: "unblock",
    });
    const pulled = await run(test, messageStatus, "--recipient", ROLE, "--include-body");
    expect(JSON.parse(pulled.out)[0]).toMatchObject({ body: BODY, workerId: worker, attempts: 0 });
  });

  it("dispatches only through its separate handler and preserves unknown clearance", async () => {
    const test = setup();
    await run(test, messageSend, ...sendArgs());
    const invalid = await run(test, messageSend, ...sendArgs(), "--dispatch");
    expect(invalid.code).toBe(2);
    const dispatched = await run(test, messageDispatch, "--id", ID);
    expect(dispatched).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse(dispatched.out)).toMatchObject({
      state: "blocked",
      attempts: 0,
      reason: "guarded",
    });
  });

  it("keeps receipt reconciliation separate and refuses user-attested acceptance", async () => {
    const test = setup();
    const sent = await run(test, messageSend, ...sendArgs());
    const revision = String(JSON.parse(sent.out).revision);
    const receipt = await run(test, messageReconcile, "--id", ID, "--receipt");
    expect(receipt).toEqual(sent);
    const claimed = await run(
      test,
      messageReconcile,
      "--id",
      ID,
      "--expected-revision",
      revision,
      "--disposition",
      "accepted",
      "--evidence",
      "claim:1",
    );
    expect(claimed).toEqual({ code: 1, out: "", err: "delivery-kit: acceptance-unproven\n" });
    const current = await run(test, messageStatus, "--id", ID);
    expect(JSON.parse(current.out)[0]).toEqual(JSON.parse(sent.out));
  });

  it("requires retained evidence and a next boundary, defaulting the owner to the recipient", async () => {
    const test = setup();
    const sent = await run(test, messageSend, ...sendArgs());
    const revision = String(JSON.parse(sent.out).revision);
    const args = [
      "--id",
      ID,
      "--expected-revision",
      revision,
      "--disposition",
      "retained",
      "--evidence",
      "review:1",
    ];
    expect((await run(test, messageReconcile, ...args, "--reason", "waiting")).code).toBe(2);
    const retained = await run(
      test,
      messageReconcile,
      ...args,
      "--reason",
      "waiting",
      "--next-boundary",
      ":50 review",
    );
    expect(retained).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse(retained.out)).toMatchObject({
      state: "retained",
      ownerRole: ROLE,
      nextBoundary: ":50 review",
    });
    const privateStatus = await run(test, messageStatus, "--id", ID, "--include-retention");
    expect(JSON.parse(privateStatus.out)[0]).toMatchObject({
      retention: { reason: "waiting", ownerRole: ROLE, nextBoundary: ":50 review" },
    });
    expect(JSON.parse(privateStatus.out)[0]).not.toHaveProperty("body");
    const metadata = await run(test, messageStatus, "--id", ID);
    expect(JSON.parse(metadata.out)[0]).not.toHaveProperty("retention");
    const stale = await run(
      test,
      messageReconcile,
      "--id",
      ID,
      "--expected-revision",
      revision,
      "--disposition",
      "handled",
      "--evidence",
      "reply:1",
    );
    expect(stale).toEqual({ code: 1, out: "", err: "delivery-kit: binding-conflict\n" });
  });

  it("rejects conflicting forms, repeated options, invalid revisions and unauthorized dispositions", async () => {
    const test = setup();
    const cases: [Handler, string[]][] = [
      [messageSend, [...sendArgs(), "--id", ID]],
      [messageSend, [...sendArgs(), "--intent", "PRIVATE_VALUE"]],
      [messageStatus, []],
      [messageStatus, ["--id", ID, "--recipient", ROLE]],
      [messageStatus, ["--recipient", " "]],
      [messageDispatch, ["--id", ID, "--receipt"]],
      [messageReconcile, ["--id", ID, "--receipt", "--evidence", "PRIVATE_VALUE"]],
      [
        messageReconcile,
        [
          "--id",
          ID,
          "--expected-revision",
          "1.5",
          "--disposition",
          "handled",
          "--evidence",
          "reply:1",
        ],
      ],
      [
        messageReconcile,
        [
          "--id",
          ID,
          "--expected-revision",
          "9007199254740992",
          "--disposition",
          "handled",
          "--evidence",
          "reply:1",
        ],
      ],
      [
        messageReconcile,
        [
          "--id",
          ID,
          "--expected-revision",
          "1",
          "--disposition",
          "not-delivered",
          "--evidence",
          "claim:1",
        ],
      ],
      [
        messageReconcile,
        [
          "--id",
          ID,
          "--expected-revision",
          "1",
          "--disposition",
          "handled",
          "--evidence",
          "reply:1",
          "--reason",
          "PRIVATE_VALUE",
        ],
      ],
    ];
    for (const [handler, args] of cases) {
      // eslint-disable-next-line no-await-in-loop
      const result = await run(test, handler, ...args);
      expect(result).toMatchObject({ code: 2, out: "" });
      expect(result.err).not.toContain("PRIVATE_VALUE");
    }
  });
});

it("prints only allowlisted per-attempt diagnostics and preserves old schema-one records", async () => {
  const test = setup();
  const service = new MessageService({ layout: test.layout, env: {} });
  const queued = await service.send({
    id: ID,
    fromRole: "game-coordinator",
    recipient: ROLE,
    body: BODY,
  });
  const legacy = await run(test, messageStatus, "--id", ID);
  expect(JSON.parse(legacy.out)[0]).not.toHaveProperty("diagnostic");
  const lease = await service.store.beginAttempt(messageExpectation(queued));
  const diagnostic = {
    stage: "native-send",
    category: "rpc-refusal",
    classification: "native-rejected",
    method: "turn/start",
    rpcCode: -32000,
  } as const;
  lease.complete({
    source: lease.source,
    state: "blocked",
    reason: "refused",
    diagnostic: {
      ...diagnostic,
      nativeMessage: "private-fixture-detail",
      context: { payload: "private-fixture-context" },
    } as DeliveryDiagnostic,
  });
  const result = await run(test, messageStatus, "--id", ID);
  expect(result).toMatchObject({ code: 0, err: "" });
  const status = JSON.parse(result.out)[0];
  expect(status.diagnostic).toEqual(diagnostic);
  expect(status.outbox[0].diagnostic).toEqual(diagnostic);
  expect(status).not.toHaveProperty("body");
  expect(result.out).not.toContain("private-fixture");
  expect(result.out).not.toContain(BODY);
});
