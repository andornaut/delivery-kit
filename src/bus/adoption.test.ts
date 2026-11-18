import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { emitEvent } from "../events.ts";
import { holdLock } from "../lock.ts";
import { ProtocolStore } from "../protocol/core.ts";
import { activateProtocolFixture } from "../protocol/testFixtures.ts";
import { createRegistry, type Registry, updateRegistry } from "../registry/index.ts";
import { registryInput } from "../testFixtures.ts";
import { adoptedResident, observerAdoption, reportResidentIdentity } from "./adoption.ts";
import type { Events } from "./context.ts";
import { busPaths } from "./state.ts";
import { recordIdentity, statusReport } from "./status.ts";
import { GAME, makeGame, testContext, type TestGame } from "./testGame.ts";

const CLI_SHA256 = "c".repeat(64);
const ADOPTED = "1234:1794994070515000000:d23faae9-397f-4aaa-abbe-b78d21512112";

interface AdoptionFixture {
  readonly test: TestGame;
  readonly stateRoot: string;
}

function protocolGame(): AdoptionFixture {
  const test = makeGame();
  createRegistry(
    test.layout,
    registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">,
  );
  return { stateRoot: activateProtocolFixture(test.layout), test };
}

/** Record the audit shape `protocol observer-adoption` writes and point lastAdoption at it. */
async function adopt(
  fixture: AdoptionFixture,
  residentId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const resident = {
    cliSha256: CLI_SHA256,
    observedAt: "2026-11-18T11:43:58.933Z",
    operation: GAME,
    ownerRole: "game-coordinator",
    residentId,
    version: "4.6.1",
    ...overrides,
  };
  const audit = { kind: "observer-adoption", operation: GAME, resident, schema: 1 };
  const artifact = await new ProtocolStore({ directory: fixture.stateRoot }).putArtifact(
    Buffer.from(JSON.stringify(audit)),
  );
  updateRegistry(fixture.test.layout, 1, (draft) => {
    const operation = draft.operations[GAME] as { lastAdoption?: unknown };
    operation.lastAdoption = {
      at: "2026-11-18T11:43:58.933Z",
      cliSha256: CLI_SHA256,
      evidenceRef: `protocol-artifact:${artifact.hash}`,
      version: "4.6.1",
    };
  });
}

/** Events through the real durable enqueue, which deduplicates on kind and key. */
function durableEvents(test: TestGame): Events {
  return {
    emit: (kind, key, message) => emitEvent(test.game, { project: "Archie" }, kind, key, message),
    flush: () => undefined,
  };
}

function identityEvents(test: TestGame): Record<string, unknown>[] {
  const directory = join(test.game.busDir, "events");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as Record<string, unknown>,
    )
    .filter((event) => event.kind === "resident-identity-changed");
}

describe("adoptedResident", () => {
  it("is unknown without an active protocol, an adoption or a readable audit", async () => {
    const legacy = makeGame();
    expect(adoptedResident(legacy.layout, GAME)).toEqual({
      reason: "protocol_inactive",
      status: "unknown",
    });
    const fixture = protocolGame();
    expect(adoptedResident(fixture.test.layout, GAME)).toEqual({
      reason: "adoption_absent",
      status: "unknown",
    });
    await adopt(fixture, ADOPTED, { version: "4.6.0" });
    expect(adoptedResident(fixture.test.layout, GAME)).toEqual({
      reason: "adoption_unreadable",
      status: "unknown",
    });
  });

  it("reads the adopted resident token from the audit the registry names", async () => {
    const fixture = protocolGame();
    await adopt(fixture, ADOPTED);
    expect(adoptedResident(fixture.test.layout, GAME)).toEqual({
      at: "2026-11-18T11:43:58.933Z",
      busOwner: "game-coordinator",
      residentId: ADOPTED,
      status: "recorded",
    });
  });
});

describe("observerAdoption", () => {
  const recorded = {
    at: "2026-11-18T11:43:58.933Z",
    busOwner: "game-coordinator",
    residentId: ADOPTED,
    status: "recorded",
  } as const;

  it("compares an attested running token with the adopted one", () => {
    expect(observerAdoption(recorded, ADOPTED)).toEqual({ reason: null, status: "current" });
    expect(observerAdoption(recorded, "other")).toEqual({ reason: null, status: "stale" });
    expect(observerAdoption(recorded, null)).toEqual({
      reason: "runner_not_current",
      status: "unknown",
    });
    expect(observerAdoption({ reason: "adoption_absent", status: "unknown" }, "other")).toEqual({
      reason: "adoption_absent",
      status: "unknown",
    });
  });

  it("reports current, stale and unknown in status for the running identity", async () => {
    const fixture = protocolGame();
    const bus = busPaths(fixture.test.game.busDir);
    const runner = holdLock(bus.runnerLock);
    try {
      const token = recordIdentity(bus, {
        config: "/c",
        pid: 42,
        sourceCommit: null,
        toolRoot: "/t",
        version: "4.7.0",
      }).token as string;
      const report = () => statusReport(bus, undefined, adoptedResident(fixture.test.layout, GAME));
      expect(report()).toMatchObject({
        observer_adoption: "unknown",
        observer_adoption_reason: "adoption_absent",
      });
      await adopt(fixture, token);
      expect(report()).toMatchObject({
        observer_adoption: "current",
        observer_adoption_reason: null,
      });
      recordIdentity(bus, {
        config: "/c",
        pid: 43,
        sourceCommit: null,
        toolRoot: "/t",
        version: "4.7.0",
      });
      expect(report()).toMatchObject({
        observer_adoption: "stale",
        observer_adoption_reason: null,
      });
    } finally {
      runner.release();
    }
    expect(statusReport(bus, undefined, adoptedResident(fixture.test.layout, GAME))).toMatchObject({
      observer_adoption: "unknown",
      observer_adoption_reason: "runner_not_current",
    });
  });
});

describe("reportResidentIdentity", () => {
  it("emits one event per new token that differs from the adopted one", async () => {
    const fixture = protocolGame();
    await adopt(fixture, ADOPTED);
    const context = testContext(fixture.test, { events: durableEvents(fixture.test) });
    reportResidentIdentity(context, "first-token");
    reportResidentIdentity(context, "first-token");
    expect(identityEvents(fixture.test)).toMatchObject([
      {
        key: "first-token",
        message: expect.stringContaining(
          `runner first-token differs from the observer adoption of ${ADOPTED}`,
        ),
        sent: false,
      },
    ]);
    expect(identityEvents(fixture.test)[0]?.message).toContain(
      "Bus owner game-coordinator must refresh observer adoption.",
    );
    reportResidentIdentity(context, "second-token");
    expect(
      identityEvents(fixture.test)
        .map((event) => event.key)
        .sort(),
    ).toEqual(["first-token", "second-token"]);
  });

  it("stays silent for the adopted token and without an active protocol", async () => {
    const fixture = protocolGame();
    await adopt(fixture, ADOPTED);
    const context = testContext(fixture.test, { events: durableEvents(fixture.test) });
    reportResidentIdentity(context, ADOPTED);
    const legacy = makeGame();
    const legacyContext = testContext(legacy, { events: durableEvents(legacy) });
    reportResidentIdentity(legacyContext, "first-token");
    for (const test of [fixture.test, legacy]) {
      expect(() => identityEvents(test)).toThrow(/ENOENT/u);
    }
    expect(legacyContext.lines).toEqual([]);
  });

  it("logs an unknown adoption without reporting it", () => {
    const fixture = protocolGame();
    const context = testContext(fixture.test, { events: durableEvents(fixture.test) });
    reportResidentIdentity(context, "first-token");
    expect(context.lines).toEqual([
      "bus: observer adoption unknown (adoption_absent); no identity report",
    ]);
    expect(() => identityEvents(fixture.test)).toThrow(/ENOENT/u);
  });
});
