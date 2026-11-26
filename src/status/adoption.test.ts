import { appendFileSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { holdLock } from "@andornaut/coordination-kit/build/shared";
import { describe, expect, it } from "vitest";

import { logIdentity } from "../state/eventlog.ts";
import { EVENTS_FILE, formatLine, makeEvent, startedDetail } from "../state/events.ts";
import { recordIdentity } from "../state/identity.ts";
import { type BusPaths, busPaths } from "../state/paths.ts";
import { adoption, latestStart, observerAdoption } from "./adoption.ts";
import { statusReport } from "./status.ts";

const GAME = "archies-dog-walks";
const TOKEN = "1234:1794994070515000000:d23faae9-397f-4aaa-abbe-b78d21512112";
const OTHER = "5678:1794994999000000000:0b7a33c1-5d0e-4f4e-9d55-3c2f3e0e8a10";
const DIST = "d".repeat(64);

function bus(): BusPaths {
  const dir = join(mkdtempSync(join(tmpdir(), "adoption-")), "bus");
  mkdirSync(dir);
  return busPaths(dir);
}

function startedLine(token: string | null, key = token ?? "1:2"): string {
  const detail = startedDetail({
    cliSha256: "c".repeat(64),
    coordinationKitVersion: "3.0.0",
    deliveryKitVersion: "7.0.0",
    distSha256: DIST,
    token,
  });
  return formatLine(
    makeEvent({ at: "2026-11-19T12:00:00Z", detail, game: GAME }, "runner.started", key),
  );
}

function otherLine(key: string): string {
  return formatLine(
    makeEvent(
      { at: "2026-11-19T12:01:00Z", detail: "Archie bus: tick", game: GAME },
      "scheduled-status",
      key,
    ),
  );
}

function append(path: string, text: string): void {
  appendFileSync(path, text);
}

/** A cursor that names `file` and has consumed `offset` bytes of it (default: all of it). */
function cursorAt(paths: BusPaths, file: string, offset = statSync(file).size): void {
  const identity = logIdentity(file);
  if (identity === undefined) {
    throw new Error(`${file} is missing`);
  }
  writeFileSync(
    paths.eventsCursor,
    JSON.stringify({
      at: "2026-11-19T12:02:00Z",
      dev: identity.dev,
      file: EVENTS_FILE,
      firstId: identity.firstId,
      inode: identity.inode,
      lastId: null,
      lines: 1,
      offset,
      schema: 1,
    }),
  );
}

function seen(paths: BusPaths, version: string): void {
  writeFileSync(
    paths.seam,
    JSON.stringify({ distSha256: DIST, schema: 1, seenAt: "2026-11-19T12:00:00Z", version }),
  );
}

describe("observerAdoption", () => {
  it("is unknown without a running runner with a current identity", () => {
    const paths = bus();
    append(paths.eventsLog, startedLine(TOKEN));
    for (const token of [null, ""]) {
      expect(observerAdoption(paths, token)).toEqual({
        reason: "runner_not_current",
        status: "unknown",
      });
    }
  });

  it("is unknown with no runner.started record", () => {
    const paths = bus();
    expect(observerAdoption(paths, TOKEN)).toEqual({
      reason: "no_runner_started",
      status: "unknown",
    });
    append(paths.eventsLog, otherLine("1"));
    // A torn runner.started line is not a record yet.
    append(paths.eventsLog, startedLine(TOKEN).slice(0, -1));
    expect(observerAdoption(paths, TOKEN)).toEqual({
      reason: "no_runner_started",
      status: "unknown",
    });
  });

  it("is unknown when the log cannot be read", () => {
    const paths = bus();
    mkdirSync(paths.eventsLog);
    expect(observerAdoption(paths, TOKEN)).toEqual({
      reason: "log_unreadable",
      status: "unknown",
    });
  });

  it("is stale when the latest runner.started carries another token", () => {
    const paths = bus();
    append(paths.eventsLog, startedLine(TOKEN) + otherLine("1") + startedLine(OTHER));
    seen(paths, "4.0.2");
    cursorAt(paths, paths.eventsLog);
    expect(observerAdoption(paths, TOKEN)).toEqual({ reason: "token_differs", status: "stale" });
    expect(observerAdoption(paths, OTHER)).toEqual({ reason: null, status: "current" });
    // A start without an identity records a null token, which is never the running token.
    append(paths.eventsLog, startedLine(null, "99:1800000000"));
    expect(observerAdoption(paths, OTHER)).toEqual({ reason: "token_differs", status: "stale" });
  });

  it("reads a Unicode-escaped start at its byte offset once the append is complete", () => {
    const paths = bus();
    const prior = startedLine(TOKEN) + otherLine("café");
    const escaped = startedLine(OTHER).replace('"runner.started"', '"runner\\u002estarted"');
    append(paths.eventsLog, prior + escaped.slice(0, -1));
    expect(latestStart(paths)).toEqual({
      end: Buffer.byteLength(startedLine(TOKEN)),
      file: paths.eventsLog,
      token: TOKEN,
    });
    append(paths.eventsLog, `\n${otherLine("later")}`);
    expect(latestStart(paths)).toEqual({
      end: Buffer.byteLength(prior + escaped),
      file: paths.eventsLog,
      token: OTHER,
    });
  });

  it("is current only once the line is ingested and the CLI last seen is in range", () => {
    const paths = bus();
    const line = startedLine(TOKEN);
    append(paths.eventsLog, otherLine("1") + line);
    expect(observerAdoption(paths, TOKEN)).toEqual({ reason: "cli_unseen", status: "unknown" });
    seen(paths, "2.0.1");
    expect(observerAdoption(paths, TOKEN)).toEqual({
      reason: "cli_out_of_range",
      status: "unknown",
    });
    seen(paths, "8.0.0");
    expect(observerAdoption(paths, TOKEN).reason).toBe("cli_out_of_range");
    seen(paths, "4.0.2");
    expect(observerAdoption(paths, TOKEN)).toEqual({ reason: "not_ingested", status: "unknown" });
    // A cursor short of the line's end has not ingested it.
    const size = statSync(paths.eventsLog).size;
    cursorAt(paths, paths.eventsLog, size - 1);
    expect(observerAdoption(paths, TOKEN).reason).toBe("not_ingested");
    cursorAt(paths, paths.eventsLog, size);
    expect(observerAdoption(paths, TOKEN)).toEqual({ reason: null, status: "current" });
    // Later lines do not change the record; the cursor still covers it.
    append(paths.eventsLog, otherLine("2"));
    expect(observerAdoption(paths, TOKEN)).toEqual({ reason: null, status: "current" });
    writeFileSync(paths.eventsCursor, "not json");
    expect(observerAdoption(paths, TOKEN).reason).toBe("not_ingested");
  });

  it("reads the newest rotated log when events.jsonl has no record", () => {
    const paths = bus();
    const older = join(paths.dir, "events.1800000000.jsonl");
    const newest = join(paths.dir, "events.1800000600.jsonl");
    writeFileSync(older, startedLine(OTHER));
    writeFileSync(newest, otherLine("1") + startedLine(TOKEN) + otherLine("2"));
    writeFileSync(paths.eventsLog, otherLine("3"));
    seen(paths, "4.0.2");
    expect(latestStart(paths)).toEqual({
      end: Buffer.byteLength(otherLine("1") + startedLine(TOKEN)),
      file: newest,
      token: TOKEN,
    });
    // The cursor names the live log: the rotated record is in another file, so not ingested.
    cursorAt(paths, paths.eventsLog);
    expect(observerAdoption(paths, TOKEN)).toEqual({ reason: "not_ingested", status: "unknown" });
    cursorAt(paths, newest, Buffer.byteLength(otherLine("1") + startedLine(TOKEN)));
    expect(observerAdoption(paths, TOKEN)).toEqual({ reason: null, status: "current" });
    // Only the newest rotated log counts.
    writeFileSync(newest, otherLine("1"));
    expect(observerAdoption(paths, TOKEN).reason).toBe("no_runner_started");
    // A record in events.jsonl wins over any rotated one.
    append(paths.eventsLog, startedLine(OTHER));
    writeFileSync(newest, startedLine(TOKEN));
    expect(observerAdoption(paths, TOKEN)).toEqual({ reason: "token_differs", status: "stale" });
  });

  it("is a status field read from bus/ for the running identity", () => {
    const paths = bus();
    writeFileSync(paths.runnerLock, "");
    const runner = holdLock(paths.runnerLock);
    try {
      const token = recordIdentity(paths, {
        config: "/c",
        pid: 42,
        sourceCommit: null,
        toolRoot: "/t",
        version: "7.0.0",
      }).token as string;
      expect(statusReport(paths)).toMatchObject({
        observer_adoption: "unknown",
        observer_adoption_reason: "no_runner_started",
      });
      append(paths.eventsLog, startedLine(token));
      seen(paths, "4.0.2");
      cursorAt(paths, paths.eventsLog);
      expect(statusReport(paths)).toMatchObject({
        observer_adoption: "current",
        observer_adoption_reason: null,
      });
      recordIdentity(paths, {
        config: "/c",
        pid: 43,
        sourceCommit: null,
        toolRoot: "/t",
        version: "7.0.0",
      });
      expect(statusReport(paths)).toMatchObject({
        observer_adoption: "stale",
        observer_adoption_reason: "token_differs",
      });
    } finally {
      runner.release();
    }
    expect(statusReport(paths)).toMatchObject({
      observer_adoption: "unknown",
      observer_adoption_reason: "runner_not_current",
    });
  });
});

describe("adoption", () => {
  const start = { end: 10, file: "events.jsonl", token: TOKEN };
  const facts = { ingested: true, runnerToken: TOKEN, start, supported: true } as const;

  it("is current only when every fact holds", () => {
    expect(adoption(facts)).toEqual({ reason: null, status: "current" });
  });

  it.each([
    [{ runnerToken: null }, "runner_not_current", "unknown"],
    [{ runnerToken: "" }, "runner_not_current", "unknown"],
    [{ start: "unreadable" }, "log_unreadable", "unknown"],
    [{ start: null }, "no_runner_started", "unknown"],
    [{ start: { ...start, token: OTHER } }, "token_differs", "stale"],
    [{ supported: null }, "cli_unseen", "unknown"],
    [{ supported: false }, "cli_out_of_range", "unknown"],
    [{ ingested: false }, "not_ingested", "unknown"],
  ] as const)("with %j reports %s", (change, reason, status) => {
    expect(adoption({ ...facts, ...change })).toEqual({ reason, status });
  });

  it("checks the token before the coordinator CLI and ingest", () => {
    expect(
      adoption({
        ingested: false,
        runnerToken: TOKEN,
        start: { ...start, token: OTHER },
        supported: null,
      }),
    ).toEqual({ reason: "token_differs", status: "stale" });
  });
});
