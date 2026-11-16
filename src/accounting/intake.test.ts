import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { holdLockAsync } from "../lock.ts";
import { snapshotIntake } from "./ingress.ts";
import { IntakeError, type IntakeInput, IntakeStore } from "./intake.ts";
import { LedgerStore } from "./store.ts";
import type { LedgerCommand } from "./types.ts";

const sync = vi.hoisted(() => ({ fail: false, published: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync(fd: number) {
      if (sync.fail && sync.published) {
        throw new Error("synthetic directory sync failure");
      }
      actual.fsyncSync(fd);
    },
    renameSync(
      from: Parameters<typeof actual.renameSync>[0],
      to: Parameters<typeof actual.renameSync>[1],
    ) {
      actual.renameSync(from, to);
      if (/[a-f0-9]{64}\.json$/u.test(String(to))) {
        sync.published = true;
      }
    },
  };
});

beforeEach(() => {
  sync.fail = false;
  sync.published = false;
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "intake-"));
  const accounting = join(root, "var/accounting");
  const directory = join(accounting, "intake");
  const observed = snapshotIntake(
    {
      harness: "codex",
      nativeId: "thread-observed",
      nextBoundary: "next owner boundary",
      ownerRole: "game-coordinator",
      phase: "startup",
    },
    {
      harness: "codex",
      history: {
        "thread-observed": {
          complete: true,
          cursor: null,
          nextCursor: null,
          question_refs: [],
          status: "complete",
          user_reply_refs: [{ item_id: "original-item", turn_id: "original-turn" }],
        },
      },
    },
  );
  const command: Extract<LedgerCommand, { type: "capture" }> = {
    coverage: observed.coverage,
    requests: observed.commands.flatMap((c) => (c.type === "register" ? [c.request] : [])),
    type: "capture",
  };
  const input: IntakeInput = {
    actor: "game-coordinator",
    command,
    source: command.coverage[0]!.source,
  };
  return { accounting, directory, input, store: new IntakeStore({ directory }) };
}

describe("durable immutable accounting intake", () => {
  it("retains busy-ledger observations across reload and admits only exact matching journal events", async () => {
    const test = setup();
    const offer = test.store.offer(test.input);
    expect(existsSync(join(test.accounting, "events"))).toBe(false);
    const lock = await holdLockAsync(join(test.accounting, "ledger.lock"));
    const ledger = new LedgerStore({ directory: test.accounting, nonBlocking: true });
    const transaction = {
      ...test.input,
      at: "2026-11-16T03:00:00.000Z",
      commandId: `intake-${offer.id}`,
      expectedRevision: 0,
      schema: 1 as const,
    };
    try {
      await expect(ledger.apply(transaction)).rejects.toMatchObject({ code: "ledger-busy" });
    } finally {
      lock.release();
    }
    // Reload needs only the durable offer, even when native history no longer contains the item.
    const reloaded = new IntakeStore({ directory: test.directory });
    expect(reloaded.pending([])).toEqual([offer]);
    expect(reloaded.pending([], ["delivery-kit"])).toEqual([]);
    const event = await ledger.apply(transaction);
    expect(reloaded.pending(ledger.history())).toEqual([]);
    const changed = { ...event, actor: "delivery-kit" };
    expect(reloaded.pending([changed])).toEqual([offer]);
    expect(reloaded.pending([event, changed])).toEqual([offer]);
    expect(ledger.read(test.input.command.requests[0]!.id)).toMatchObject({
      kind: "unknown",
      reviewed: false,
    });
    expect(readFileSync(join(test.directory, `${offer.id}.json`), "utf8")).not.toContain('"at":');
    expect(readdirSync(test.directory)).toEqual([`${offer.id}.json`]);
  });

  it("deduplicates simultaneous process offers to identical content-addressed bytes", async () => {
    const test = setup();
    const program = `import { IntakeStore } from ${JSON.stringify(new URL("./intake.ts", import.meta.url).href)};
      const offer = new IntakeStore({ directory: process.argv[1] }).offer(JSON.parse(process.argv[2]));
      process.stdout.write(offer.id);`;
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        promisify(execFile)(
          process.execPath,
          ["--input-type=module", "-e", program, test.directory, JSON.stringify(test.input)],
          { timeout: 15_000 },
        ),
      ),
    );
    expect(new Set(results.map((r) => r.stdout)).size).toBe(1);
    const offers = test.store.pending([]);
    expect(offers).toHaveLength(1);
    expect(readdirSync(test.directory)).toEqual([`${offers[0]!.id}.json`]);
    const before = readFileSync(join(test.directory, `${offers[0]!.id}.json`));
    expect(test.store.offer(test.input)).toEqual(offers[0]);
    expect(readFileSync(join(test.directory, `${offers[0]!.id}.json`))).toEqual(before);
  });

  it("rejects bodies, unknown schemas and content conflicts without overwriting retained evidence", () => {
    const test = setup();
    const body = structuredClone(test.input);
    const bad = {
      ...body,
      command: {
        ...body.command,
        requests: [
          {
            ...body.command.requests[0]!,
            summary: "PRIVATE_SYNTHETIC_BODY",
          },
        ],
      },
    };
    expect(() => test.store.offer(bad)).toThrowError(IntakeError);
    expect(existsSync(test.directory)).toBe(false);
    const offer = test.store.offer(test.input);
    const path = join(test.directory, `${offer.id}.json`);
    const unknown = JSON.stringify({ ...offer, schema: 2 });
    writeFileSync(path, unknown);
    expect(() => test.store.pending([])).toThrowError("corrupt-intake");
    expect(() => test.store.offer(test.input)).toThrowError("corrupt-intake");
    expect(readFileSync(path, "utf8")).toBe(unknown);
    writeFileSync(
      path,
      JSON.stringify({ ...offer, source: { ...offer.source, reference: "changed-reference" } }),
    );
    expect(() => test.store.pending([])).toThrowError("intake-hash-conflict");
    expect(() => test.store.offer(test.input)).toThrowError("intake-hash-conflict");
  });

  it("does not acknowledge a failed post-rename directory sync and safely deduplicates recovery", () => {
    const test = setup();
    sync.fail = true;
    expect(() => test.store.offer(test.input)).toThrowError("intake-unavailable");
    expect(sync.published).toBe(true);
    sync.fail = false;
    const reloaded = new IntakeStore({ directory: test.directory });
    const pending = reloaded.pending([]);
    expect(pending).toHaveLength(1);
    expect(reloaded.offer(test.input)).toEqual(pending[0]);
    expect(readdirSync(test.directory)).toEqual([`${pending[0]!.id}.json`]);
  });
});
