import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { holdLock } from "../lock.ts";
import { MessageService } from "../messages/service.ts";
import { claudeFixture, RECIPIENT } from "../review/fixtures.ts";
import { CODEX_TECH } from "../testFixtures.ts";
import { accountingReview, accountingStatus, captureAccounting } from "./boundary.ts";
import { LedgerStore } from "./store.ts";

describe("accounting at existing ingress boundaries (isolated fixtures)", () => {
  it("retains an exact message reference across reload without treating its body as human authority", async () => {
    const fixture = claudeFixture();
    fixture.clear("pending");
    const marker = join(fixture.unblock, "decisions", `${RECIPIENT}.json`);
    const before = readFileSync(marker, "utf8");
    const service = new MessageService({ env: fixture.env, layout: fixture.layout });
    const input = {
      body: "Fixture transport body: question, suggestion and request need owner review",
      fromRole: "archies-dog-walks/tech",
      id: "00000000-0000-4000-8000-000000000017",
      recipient: "game-coordinator",
    };
    const first = await service.send(input);
    const directory = join(fixture.layout.varDir, "accounting");
    const projection = new LedgerStore({ directory }).read();
    expect(projection.requests).toHaveLength(1);
    expect(projection.requests[0]).toMatchObject({
      kind: "unknown",
      reviewed: false,
      source: { origin: "relay" },
      state: "open",
    });
    expect(JSON.stringify(projection)).not.toContain(input.body);
    expect(JSON.stringify(projection)).toContain(input.id);
    expect(await service.send(input)).toEqual(first);
    expect(new LedgerStore({ directory }).read().revision).toBe(projection.revision);
    expect(readFileSync(marker, "utf8")).toBe(before);
    expect(accountingStatus(fixture.layout).accounting_ready).toBe(false);
  });

  it("retains unknown history and reports corrupt accounting without changing a protected question", async () => {
    const fixture = claudeFixture();
    fixture.clear("pending");
    const marker = join(fixture.unblock, "decisions", `${RECIPIENT}.json`);
    const before = readFileSync(marker, "utf8");
    expect(accountingStatus(fixture.layout)).toMatchObject({
      accounting_ready: false,
      coverageState: "unknown",
      status: "available",
    });
    const source = {
      native: null,
      origin: "owner-attested" as const,
      reference: "fixture-owner-audit",
      wordingHash: null,
    };
    const store = new LedgerStore({ directory: join(fixture.layout.varDir, "accounting") });
    await store.apply({
      actor: "game-coordinator",
      at: new Date().toISOString(),
      command: {
        coverage: {
          gaps: [],
          id: "one-owner-window",
          nextBoundary: null,
          ownerRole: "game-coordinator",
          range: { from: "first", through: "last" },
          source,
          state: "covered",
        },
        type: "coverage",
      },
      commandId: "one-owner-audit",
      expectedRevision: 0,
      schema: 1,
      source,
    });
    expect(store.report({ at: new Date().toISOString() }).coverageState).toBe("declared-complete");
    expect(accountingStatus(fixture.layout)).toMatchObject({
      accounting_ready: false,
      coverageState: "incomplete",
      missingOwners: ["archies-dog-walks/tech"],
    });
    expect(accountingStatus(fixture.layout, ["game-coordinator"])).toMatchObject({
      accounting_ready: true,
      coverageState: "declared-complete",
      missingOwners: [],
    });
    const foreignSource = { ...source, origin: "unknown" as const, reference: "foreign-question" };
    await store.apply({
      actor: "archies-dog-walks/tech",
      at: new Date().toISOString(),
      command: {
        request: {
          assignment: null,
          dependencies: [],
          id: "foreign-question",
          kind: "unknown",
          parentId: null,
          question: {
            native: null,
            options: null,
            resolutionRef: null,
            status: "unknown",
            text: null,
          },
          reviewed: false,
          source: foreignSource,
          summary: "Another owner's unconfirmed question",
          targets: [],
        },
        type: "register",
      },
      commandId: "foreign-question-intake",
      expectedRevision: store.read().revision,
      schema: 1,
      source: foreignSource,
    });
    const scoped = await captureAccounting(fixture.layout, {}, "resume", "message", [
      "game-coordinator",
    ]);
    expect(JSON.stringify(scoped.gaps)).not.toContain("protected-question-unresolved");
    expect(accountingStatus(fixture.layout).protectedQuestions).toContain("foreign-question");
    const lock = holdLock(join(fixture.layout.varDir, "accounting", "ledger.lock"));
    try {
      const busy = await captureAccounting(fixture.layout, {
        harness: "claude",
        queues: { [RECIPIENT]: [{ clientUserMessageId: "busy-original", id: "busy-original" }] },
      });
      expect(busy).toMatchObject({
        accounting_ready: false,
        reason: "ledger-busy",
        status: "unavailable",
      });
      expect(busy.pendingIntake?.offers?.length).toBeGreaterThan(0);
      expect(
        JSON.stringify(
          new LedgerStore({ directory: join(fixture.layout.varDir, "accounting") }).read(),
        ),
      ).not.toContain("busy-original");
    } finally {
      lock.release();
    }
    const result = await captureAccounting(fixture.layout, {
      harness: "claude",
      history: {},
      queues: {},
    });
    expect(result.status).toBe("available");
    expect(result.accounting_ready).toBe(false);
    expect(JSON.stringify(result.gaps)).toContain("claude-native-history-unsupported");
    expect(result.pendingIntake?.offers).toEqual([]);
    expect(
      JSON.stringify(
        new LedgerStore({ directory: join(fixture.layout.varDir, "accounting") }).read(),
      ),
    ).toContain("busy-original");
    const events = join(fixture.layout.varDir, "accounting", "events");
    const event = readdirSync(events).find((name) => name.endsWith(".json"));
    expect(event).toBeDefined();
    writeFileSync(join(events, event!), "{}\n");
    const unavailable = await captureAccounting(fixture.layout, {});
    expect(unavailable).toMatchObject({ accounting_ready: false, status: "unavailable" });
    expect(accountingReview(unavailable)).toContain('"accounting_ready":false');
    expect(readFileSync(marker, "utf8")).toBe(before);
  });

  it("retains a verified worker snapshot under its registered parent without assigning work", async () => {
    const fixture = claudeFixture();
    const registry = JSON.parse(readFileSync(fixture.layout.registryFile, "utf8"));
    registry.roles["archies-dog-walks/tech"].harness = "codex";
    writeFileSync(fixture.layout.registryFile, JSON.stringify(registry));
    const worker = "00000000-0000-4000-8000-000000000018";
    const result = await captureAccounting(fixture.layout, {
      harness: "codex",
      history: {
        [worker]: {
          complete: false,
          cursor: null,
          nextCursor: "older",
          question_refs: [],
          status: "partial",
          user_reply_refs: [{ item_id: "worker-input", turn_id: "worker-turn" }],
        },
      },
      queues: { [worker]: [] },
      worker_binding: { harness: "codex", parent: CODEX_TECH, worker },
    });
    expect(result.status).toBe("available");
    const projection = new LedgerStore({
      directory: join(fixture.layout.varDir, "accounting"),
    }).read();
    expect(projection.requests).toContainEqual(
      expect.objectContaining({
        assignment: null,
        createdBy: "archies-dog-walks/tech",
        kind: "unknown",
        source: expect.objectContaining({ native: expect.objectContaining({ threadId: worker }) }),
      }),
    );
    expect(result.accounting_ready).toBe(false);
  });
});
