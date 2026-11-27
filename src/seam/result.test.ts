import { describe, expect, it } from "vitest";

import { ingestLine, parseResult, parseVersion, slotIso } from "./result.ts";

const GAME = "fixture-game";
// 2026-11-04 03:20 UTC, the :20 wake slot of 22:20 EST in America/Toronto.
const SLOT = Date.UTC(2026, 10, 4, 3, 20, 0) / 1000;
const TIMEZONE = "America/Toronto";
const ISO = "2026-11-03T22:20:00-05:00";
const SHA = "c".repeat(64);

describe("parsing", () => {
  const cli = { distSha256: SHA, version: "3.0.0" };
  const ingest = {
    cli,
    detail: "ingested 2",
    game: GAME,
    kind: "events-ingest",
    reason: null,
    schema: 1,
    status: "delivered",
  };

  it("requires the exact app and slot even when the reply uses a neutral identity", () => {
    const expected = { game: GAME, kind: "review-deliver", slot: ISO } as const;
    const { game, ...fields } = ingest;
    const neutral = { ...fields, appId: game, kind: expected.kind, slot: ISO };
    expect(parseResult(expected, "appId", JSON.stringify(neutral))).toMatchObject({
      claimed: true,
    });
    expect(parseResult(expected, "game", JSON.stringify(neutral))).toEqual({
      claimed: false,
      why: "malformed result: game differs",
    });
    expect(
      parseResult(
        expected,
        "appId",
        JSON.stringify({ ...fields, game, kind: expected.kind, slot: ISO }),
      ),
    ).toEqual({ claimed: false, why: "malformed result: app ID differs" });
    expect(parseResult(expected, "appId", JSON.stringify({ ...neutral, game }))).toMatchObject({
      claimed: true,
    });
    expect(
      parseResult(expected, "appId", JSON.stringify({ ...neutral, game: "other-app" })),
    ).toEqual({
      claimed: false,
      why: "malformed result: app ID differs",
    });
    expect(parseResult(expected, "appId", JSON.stringify({ ...neutral, slot: "later" }))).toEqual({
      claimed: false,
      why: "malformed result: slot differs",
    });
  });

  it("reads an events-ingest result with its counts and ignores fields it does not define", () => {
    const line = `${JSON.stringify(ingest)}\n`;
    expect(parseResult({ game: GAME, kind: "events-ingest" }, "game", line)).toEqual({
      claimed: true,
      cli,
      detail: "ingested 2",
      reason: null,
      status: "delivered",
    });
    const counted = {
      ...ingest,
      completed: 1,
      delivered: 3,
      held: 1,
      ingested: 2,
      quarantined: 1,
      unknownField: "ignored",
    };
    expect(
      parseResult({ game: GAME, kind: "events-ingest" }, "game", JSON.stringify(counted)),
    ).toEqual({
      claimed: true,
      cli,
      counts: { completed: 1, delivered: 3, held: 1, ingested: 2, quarantined: 1 },
      detail: "ingested 2",
      reason: null,
      status: "delivered",
    });
    for (const bad of [{ held: -1 }, { delivered: 1.5 }, { completed: "1" }]) {
      expect(
        parseResult(
          { game: GAME, kind: "events-ingest" },
          "game",
          JSON.stringify({ ...ingest, ...bad }),
        ),
      ).toEqual({ claimed: false, why: `malformed result: ${Object.keys(bad)[0]}` });
    }
    const skipped = JSON.stringify({ ...ingest, reason: "no-events", status: "skipped" });
    expect(parseResult({ game: GAME, kind: "events-ingest" }, "game", skipped)).toMatchObject({
      reason: "no-events",
      status: "skipped",
    });
  });

  it("reads a version identity and rejects an unusable one", () => {
    expect(parseVersion(`${JSON.stringify({ schema: 1, ...cli })}\n`)).toEqual(cli);
    expect(parseVersion(JSON.stringify({ schema: 1, version: "3.0.0" }))).toBe(
      "malformed result: version or distSha256",
    );
    expect(parseVersion(JSON.stringify({ schema: 2, ...cli }))).toBe(
      "malformed result: schema is not 1",
    );
  });

  it("formats a slot start as an ISO minute start with the timezone's offset", () => {
    expect(slotIso(TIMEZONE, SLOT)).toBe(ISO);
    // The daylight-saving fold: the same wall minute at two offsets.
    expect(slotIso(TIMEZONE, Date.UTC(2026, 10, 1, 5, 20) / 1000)).toBe(
      "2026-11-01T01:20:00-04:00",
    );
    expect(slotIso(TIMEZONE, Date.UTC(2026, 10, 1, 6, 20) / 1000)).toBe(
      "2026-11-01T01:20:00-05:00",
    );
    expect(slotIso("Asia/Kolkata", SLOT)).toBe("2026-11-04T08:50:00+05:30");
    expect(slotIso("UTC", SLOT)).toBe("2026-11-04T03:20:00+00:00");
  });
});

describe("ingestLine", () => {
  const cli = { distSha256: SHA, version: "3.0.0" };

  it("logs a failed or deferred ingest and nothing for a delivered or skipped one", () => {
    expect(ingestLine({ claimed: false, why: "exit 1" })).toBe(
      "bus: event ingest failed: exit 1; no delivery claimed",
    );
    expect(
      ingestLine({ claimed: true, cli, detail: "lock held", reason: "held", status: "deferred" }),
    ).toBe("bus: event ingest deferred: held: lock held");
    expect(
      ingestLine({ claimed: true, cli, detail: "", reason: null, status: "delivered" }),
    ).toBeUndefined();
    expect(
      ingestLine({ claimed: true, cli, detail: "", reason: "no-events", status: "skipped" }),
    ).toBeUndefined();
  });
});
