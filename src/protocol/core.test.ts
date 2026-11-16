import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as durable from "../durable.ts";
import { protocolRole, ProtocolStore, protocolWorkerRole } from "./core.ts";
import type { Binding, ProtocolClaim, ProtocolTransaction, ProtocolWriter } from "./types.ts";

const AT = "2026-11-16T04:00:00.000Z";
const LATER = "2026-11-16T04:01:00.000Z";
const ROLE = "kits/delivery-kit";
const FIRST: Binding = { harness: "codex", nativeId: "00000000-0000-4000-8000-000000000001" };
const SECOND: Binding = { harness: "claude", nativeId: "00000000-0000-4000-8000-000000000002" };
const CHILD: Binding = { harness: "codex", nativeId: "00000000-0000-4000-8000-000000000003" };

function fixture() {
  const directory = join(mkdtempSync(join(tmpdir(), "protocol-")), "state");
  const current = new Map<string, Binding>([[ROLE, FIRST]]);
  const options = {
    directory,
    resolveBinding: (role: string, binding: Binding) =>
      current.get(role)?.harness === binding.harness &&
      current.get(role)?.nativeId === binding.nativeId,
  };
  const store = new ProtocolStore(options);
  const claim = (expectedEpoch = 0, binding = FIRST, at = AT): ProtocolClaim => ({
    at,
    binding,
    evidence: "owner:explicit-claim",
    expectedEpoch,
    role: ROLE,
  });
  const writer = (epoch = 1, binding = FIRST): ProtocolWriter => ({ binding, epoch, role: ROLE });
  const transaction = (
    id: string,
    revision: number,
    epoch = 1,
    binding = FIRST,
  ): ProtocolTransaction => ({
    ...writer(epoch, binding),
    at: AT,
    expectedRevision: revision,
    id,
    mutations: [
      {
        collection: "work",
        expectedRevision: 0,
        id: "work-id",
        value: { source: "exact-source", state: "started" },
      },
    ],
  });
  return { claim, current, directory, options, store, transaction, writer };
}

afterEach(() => vi.restoreAllMocks());

describe("filesystem protocol core", () => {
  it("maps stable namespaces and reads absent or committed state without writer credentials", async () => {
    const f = fixture();
    const reader = new ProtocolStore({ directory: f.directory });
    expect(reader.read(ROLE)).toMatchObject({ binding: null, epoch: 0, objects: [], revision: 0 });
    expect(reader.listRoles()).toEqual([]);
    expect(existsSync(f.directory)).toBe(false);
    expect(protocolRole("game-coordinator")).toBe("coordinator");
    expect(protocolRole("delivery-kit")).toBe(ROLE);
    expect(protocolRole("archies-dog-walks/tech")).toBe("games/archies-dog-walks/tech");
    expect(() => reader.read("../outside")).toThrow("invalid-role");
    await expect(reader.claim(f.claim())).rejects.toMatchObject({ code: "binding-unavailable" });
    const claimed = await f.store.claim(f.claim());
    expect(claimed).toEqual({ epoch: 1, revision: 1 });
    expect(await f.store.claim(f.claim())).toEqual(claimed);
    expect(reader.read(ROLE)).toMatchObject({ binding: FIRST, epoch: 1, revision: 1 });
    expect(reader.listRoles()).toEqual([ROLE]);
    expect(reader.history(ROLE)).toHaveLength(1);
  });

  it("publishes atomic objects and serializes independent writers", async () => {
    const f = fixture();
    await f.store.claim(f.claim());
    const input = f.transaction("first", 1);
    const first = {
      ...input,
      mutations: [
        ...input.mutations,
        {
          collection: "receipts" as const,
          expectedRevision: 0,
          id: "receipt",
          value: "separate-receipt",
        },
      ],
    };
    const event = await f.store.transact(first);
    const before = f.store.read(ROLE);
    expect(before).toMatchObject({
      revision: 2,
      objects: [
        { collection: "receipts", id: "receipt", revision: 1, value: "separate-receipt" },
        { collection: "work", id: "work-id", revision: 1 },
      ],
    });
    expect(await new ProtocolStore(f.options).transact(first)).toEqual(event);
    await expect(
      f.store.transact({
        ...first,
        mutations: [{ ...first.mutations[0]!, value: "changed payload" }],
      }),
    ).rejects.toMatchObject({ code: "transaction-conflict" });
    await expect(
      f.store.transact({
        ...first,
        expectedRevision: 2,
        id: "bad-batch",
        mutations: [
          {
            collection: "messages",
            expectedRevision: 0,
            id: "must-not-publish",
            value: "original",
          },
          {
            collection: "work",
            expectedRevision: 99,
            id: "work-id",
            value: "invalid later mutation",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "object-conflict" });
    expect(f.store.read(ROLE)).toEqual(before);
    const code = [
      `import {ProtocolStore} from ${JSON.stringify(new URL("./core.ts", import.meta.url).href)};`,
      "const s=new ProtocolStore({directory:process.argv[1],resolveBinding:()=>true});",
      "try {const e=await s.transact(JSON.parse(process.argv[2]));",
      "console.log(JSON.stringify({revision:e.revision}));}",
      "catch(e){console.log(JSON.stringify({code:e.code}));}",
    ].join("\n");
    const run = promisify(execFile);
    const inputs = ["writer-one", "writer-two"].map((id) => ({
      ...first,
      expectedRevision: 2,
      id,
      mutations: [{ collection: "work", expectedRevision: 1, id: "work-id", value: id }],
    }));
    const results = await Promise.all(
      inputs.map((input) =>
        run(process.execPath, [
          "--input-type=module",
          "--eval",
          code,
          f.directory,
          JSON.stringify(input),
        ]),
      ),
    );
    expect(results.map((r) => JSON.parse(r.stdout)).filter((r) => r.revision === 3)).toHaveLength(
      1,
    );
    expect(
      results.map((r) => JSON.parse(r.stdout)).filter((r) => r.code === "stale-revision"),
    ).toHaveLength(1);
    expect(f.store.read(ROLE).revision).toBe(3);
    expect(f.store.read(ROLE).objects.find((o) => o.collection === "work")?.revision).toBe(2);
    expect(f.store.history(ROLE)).toHaveLength(3);
  });

  it("recovers a manifest across interrupted publication and a lost response", async () => {
    const f = fixture();
    await f.store.claim(f.claim());
    const events = join(f.directory, "roles", ROLE, "events");
    const originalClaim = readFileSync(join(events, "000000000001.json"));
    const input = f.transaction("recover", 1);
    const originalWrite = durable.writeJsonDurable;
    vi.spyOn(durable, "writeJsonDurable").mockImplementationOnce((path, data) =>
      originalWrite(path, data, {
        onStage: (stage) => {
          if (stage === "synced") {
            throw new Error("interrupted before publication");
          }
        },
      }),
    );
    await expect(f.store.transact(input)).rejects.toThrow("interrupted before publication");
    expect(new ProtocolStore({ directory: f.directory }).read(ROLE)).toMatchObject({
      objects: [],
      revision: 1,
    });
    writeFileSync(
      join(events, ".000000000002.json.999.abcdef012345.tmp"),
      "orphaned partial manifest",
    );
    expect(f.store.read(ROLE).revision).toBe(1);
    vi.restoreAllMocks();
    vi.spyOn(durable, "writeJsonDurable").mockImplementationOnce((path, data) =>
      originalWrite(path, data, {
        onStage: (stage) => {
          if (stage === "renamed") {
            throw new Error("lost commit response");
          }
        },
      }),
    );
    await expect(f.store.transact(input)).rejects.toThrow("lost commit response");
    expect(new ProtocolStore({ directory: f.directory }).read(ROLE).revision).toBe(2);
    vi.restoreAllMocks();
    expect((await new ProtocolStore(f.options).transact(input)).revision).toBe(2);
    expect(f.store.history(ROLE)).toHaveLength(2);
    expect(readFileSync(join(events, "000000000001.json"))).toEqual(originalClaim);
    expect(readdirSync(events).filter((name) => !name.startsWith("."))).toHaveLength(2);
  });

  it("fences old ownership epochs and rechecks live binding immediately before publication", async () => {
    const f = fixture();
    await f.store.claim(f.claim());
    const first = f.transaction("before-handoff", 1);
    await f.store.transact(first);
    f.current.set(ROLE, SECOND);
    await expect(
      f.store.transact({ ...first, expectedRevision: 2, id: "old-owner" }),
    ).rejects.toMatchObject({ code: "binding-changed" });
    await f.store.claim(f.claim(1, SECOND, LATER));
    expect(f.store.read(ROLE)).toMatchObject({ binding: SECOND, epoch: 2, revision: 3 });
    await expect(f.store.transact(first)).rejects.toMatchObject({ code: "writer-fenced" });
    await expect(f.store.claim(f.claim())).rejects.toMatchObject({ code: "binding-changed" });
    const second = {
      ...f.transaction("new-owner", 3, 2, SECOND),
      at: LATER,
      mutations: [
        {
          collection: "work" as const,
          expectedRevision: 1,
          id: "work-id",
          value: "new owner publication",
        },
      ],
    };
    await f.store.transact(second);
    let calls = 0;
    const changing = new ProtocolStore({
      directory: f.directory,
      resolveBinding: () => ++calls === 1,
    });
    await expect(
      changing.transact({
        ...second,
        expectedRevision: 4,
        id: "changed-mid-read",
        mutations: [{ ...second.mutations[0]!, expectedRevision: 2 }],
      }),
    ).rejects.toMatchObject({ code: "binding-changed" });
    expect(f.store.read(ROLE).revision).toBe(4);
    expect(new ProtocolStore({ directory: f.directory }).history(ROLE)).toHaveLength(4);
  });

  it("fences legacy actions and reports ambiguous post-action outcomes", async () => {
    const f = fixture();
    await f.store.claim(f.claim());
    let started!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const journal = join(f.directory, "existing-ledger-event.json");
    const action = f.store.withWriter(f.writer(), async () => {
      started();
      await released;
      durable.writeJsonDurable(journal, { id: "legacy-event", revision: 1 });
      return "committed";
    });
    await entered;
    const contender = new ProtocolStore({ ...f.options, nonBlocking: true });
    try {
      await expect(contender.claim(f.claim(1, SECOND, LATER))).rejects.toMatchObject({
        code: "protocol-busy",
      });
      await expect(contender.transact(f.transaction("concurrent", 1))).rejects.toMatchObject({
        code: "protocol-busy",
      });
    } finally {
      resume();
    }
    expect(await action).toBe("committed");
    expect(JSON.parse(readFileSync(journal, "utf8"))).toEqual({ id: "legacy-event", revision: 1 });
    expect(f.store.history(ROLE)).toHaveLength(1);
    await expect(
      f.store.withWriter(f.writer(), () => f.store.transact(f.transaction("nested", 1))),
    ).rejects.toMatchObject({ code: "writer-reentrant" });
    f.current.set(ROLE, SECOND);
    await f.store.claim(f.claim(1, SECOND, LATER));
    let staleAction = false;
    await expect(
      f.store.withWriter(f.writer(), () => {
        staleAction = true;
      }),
    ).rejects.toMatchObject({ code: "writer-fenced" });
    expect(staleAction).toBe(false);
    await expect(
      f.store.withWriter(f.writer(2, SECOND), () => {
        durable.writeJsonDurable(journal, { id: "legacy-event", revision: 2 });
        f.current.set(ROLE, FIRST);
      }),
    ).rejects.toMatchObject({ actionMayHaveCommitted: true, code: "writer-action-ambiguous" });
    expect(JSON.parse(readFileSync(journal, "utf8")).revision).toBe(2);
    expect(f.store.read(ROLE).revision).toBe(2);
  });

  it("isolates verified worker submissions and fences them when the parent epoch changes", async () => {
    const f = fixture();
    await f.store.claim(f.claim());
    const role = protocolWorkerRole(ROLE, CHILD.nativeId, 1);
    f.current.set(role, CHILD);
    const input: ProtocolClaim = {
      at: AT,
      binding: CHILD,
      evidence: "supported:worker-lineage",
      expectedEpoch: 0,
      parent: { epoch: 1, role: ROLE, workerId: CHILD.nativeId },
      role,
    };
    await expect(
      f.store.claim({ ...input, parent: { ...input.parent!, epoch: 2 } }),
    ).rejects.toMatchObject({ code: "invalid-parent" });
    await expect(f.store.claim({ ...f.claim(1), binding: CHILD })).rejects.toMatchObject({
      code: "binding-changed",
    });
    await f.store.claim(input);
    const submission: ProtocolTransaction = {
      at: AT,
      binding: CHILD,
      epoch: 1,
      expectedRevision: 1,
      id: "worker-ready",
      mutations: [
        {
          collection: "submissions",
          expectedRevision: 0,
          id: "submission",
          value: { parentEpoch: 1, state: "ready" },
        },
      ],
      role,
    };
    await f.store.transact(submission);
    expect(f.store.read(ROLE)).toMatchObject({ objects: [], revision: 1 });
    await f.store.claim(f.claim(1, FIRST, LATER));
    await expect(
      f.store.transact({ ...submission, expectedRevision: 2, id: "stale-child" }),
    ).rejects.toMatchObject({ code: "parent-fenced" });
    await expect(f.store.claim(input)).rejects.toMatchObject({ code: "parent-fenced" });
    const secondRole = protocolWorkerRole(ROLE, CHILD.nativeId, 2);
    f.current.set(secondRole, CHILD);
    await f.store.claim({
      ...input,
      at: LATER,
      parent: { ...input.parent!, epoch: 2 },
      role: secondRole,
    });
    expect(new ProtocolStore({ directory: f.directory }).read(role).objects).toHaveLength(1);
    expect(f.store.listRoles()).toEqual([ROLE]);
    expect(f.store.listRoles({ includeWorkers: true })).toEqual([ROLE, role, secondRole]);
    f.current.set(ROLE, SECOND);
    await expect(
      f.store.transact({
        ...submission,
        at: LATER,
        expectedRevision: 1,
        id: "rerouted-parent",
        role: secondRole,
      }),
    ).rejects.toMatchObject({ code: "binding-changed" });
  });

  it("promotes immutable exact artifact bytes beyond task cleanup and verifies every read", async () => {
    const f = fixture();
    const task = mkdtempSync(join(tmpdir(), "protocol-task-"));
    const bytes = Buffer.from([0, 255, 128, 10, 42]);
    writeFileSync(join(task, "evidence.bin"), bytes);
    const refs = await Promise.all([
      f.store.putArtifact(bytes),
      new ProtocolStore({ directory: f.directory }).putArtifact(bytes),
    ]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(refs).toEqual([
      { hash: digest, size: 5 },
      { hash: digest, size: 5 },
    ]);
    rmSync(task, { recursive: true });
    expect(Buffer.from(f.store.readArtifact(digest))).toEqual(bytes);
    const original = durable.writeDurable;
    const other = Buffer.from("uncommitted artifact");
    const otherHash = createHash("sha256").update(other).digest("hex");
    vi.spyOn(durable, "writeDurable").mockImplementationOnce((path, value) =>
      original(path, value, {
        onStage: (stage) => {
          if (stage === "synced") {
            throw new Error("artifact interrupted");
          }
        },
      }),
    );
    await expect(f.store.putArtifact(other)).rejects.toThrow("artifact interrupted");
    expect(() => f.store.readArtifact(otherHash)).toThrow("artifact-missing");
    vi.restoreAllMocks();
    expect(await f.store.putArtifact(other)).toEqual({ hash: otherHash, size: other.length });
    const path = join(f.directory, "artifacts", "sha256", digest.slice(0, 2), digest);
    writeFileSync(path, "corrupted bytes");
    expect(() => f.store.readArtifact(digest)).toThrow("artifact-corrupt");
    await expect(f.store.putArtifact(bytes)).rejects.toMatchObject({ code: "artifact-corrupt" });
    expect(() => f.store.readArtifact("../outside")).toThrow("invalid-artifact");
  });

  it("fails closed on truncated journals and unsafe artifact or namespace filesystem entries", async () => {
    const f = fixture();
    await f.store.claim(f.claim());
    const event = join(f.directory, "roles", ROLE, "events", "000000000001.json");
    writeFileSync(event, "{truncated");
    expect(() => new ProtocolStore({ directory: f.directory }).read(ROLE)).toThrow(
      "corrupt-history",
    );
    const unsafe = fixture();
    const outside = mkdtempSync(join(tmpdir(), "protocol-outside-"));
    const sentinel = Buffer.from("owned public fixture");
    const digest = createHash("sha256").update(sentinel).digest("hex");
    writeFileSync(join(outside, "fixture"), sentinel);
    const artifacts = join(unsafe.directory, "artifacts", "sha256", digest.slice(0, 2));
    mkdirSync(artifacts, { recursive: true });
    symlinkSync(join(outside, "fixture"), join(artifacts, digest));
    expect(() => unsafe.store.readArtifact(digest)).toThrow("unsafe-path");
    rmSync(join(artifacts, digest));
    linkSync(join(outside, "fixture"), join(artifacts, digest));
    expect(() => unsafe.store.readArtifact(digest)).toThrow("unsafe-path");
    const redirected = join(mkdtempSync(join(tmpdir(), "protocol-root-")), "state");
    symlinkSync(unsafe.directory, redirected);
    expect(() => new ProtocolStore({ directory: redirected }).read(ROLE)).toThrow("unsafe-path");
  });
});
