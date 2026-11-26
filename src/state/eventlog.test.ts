import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  commitFile,
  GAME,
  gitSync,
  loggedEvents,
  makeGame,
  type TestGame,
} from "../testing/game.ts";
import { EventLog, eventLogReport, logIdentity, workDone } from "./eventlog.ts";
import { eventId, makeEvent, type RunnerEvent } from "./events.ts";
import { busPaths } from "./paths.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const NOW = 1_800_000_000;

interface Harness {
  readonly test: TestGame;
  readonly lines: string[];
  readonly log: (appMode?: boolean) => EventLog;
  readonly paths: ReturnType<typeof busPaths>;
}

function harness(test: TestGame = makeGame()): Harness {
  const lines: string[] = [];
  const paths = busPaths(test.game.busDir);
  return {
    lines,
    log: (appMode) =>
      new EventLog({
        appMode: appMode ?? false,
        game: GAME,
        log: (line) => lines.push(line),
        now: () => NOW,
        paths,
        repo: test.repo,
      }),
    paths,
    test,
  };
}

function rawLines(h: Harness): string[] {
  return readFileSync(h.paths.eventsLog, "utf8").split("\n").slice(0, -1);
}

/** A cursor at `offset` naming the file at `path` (the live log by default). */
function writeCursor(h: Harness, offset: number, path = h.paths.eventsLog): void {
  const identity = logIdentity(path)!;
  writeFileSync(
    h.paths.eventsCursor,
    JSON.stringify({
      at: "2026-11-18T21:30:00Z",
      dev: identity.dev,
      file: "events.jsonl",
      firstId: identity.firstId,
      inode: identity.inode,
      lastId: null,
      lines: 0,
      offset,
      schema: 1,
    }),
  );
}

function workFile(test: TestGame, id: string, status: string): string {
  mkdirSync(join(test.repo, "docs", "work"), { recursive: true });
  return commitFile(
    test.repo,
    `docs/work/${id}.md`,
    `---\nid: ${id}\nstatus: ${status}\n---\n\nBody\n`,
  );
}

describe("EventLog appends", () => {
  it("writes one newline-terminated line per event with the contract fields", () => {
    const h = harness();
    const log = h.log();
    log.open();
    expect(log.append("push", SHA, "Archie bus: pushed")).toBe(true);
    expect(log.append("attempt", "1800000000", "Archie bus: attempt")).toBe(true);
    expect(log.append("attempt-captured", "1800000000", "Archie bus: captured", SHA)).toBe(true);
    expect(loggedEvents(h.test)).toEqual([
      {
        at: "2027-01-15T08:00:00Z",
        detail: "Archie bus: pushed",
        game: GAME,
        id: eventId(GAME, "push", SHA),
        key: SHA,
        kind: "push",
        schema: 1,
        sha: SHA,
        status: "ok",
        type: "push",
        work: null,
      },
      expect.objectContaining({ kind: "attempt", sha: null, status: null, type: "attempt" }),
      {
        at: "2027-01-15T08:00:00Z",
        detail: "Archie bus: captured",
        game: GAME,
        id: eventId(GAME, "attempt-captured", "1800000000"),
        key: "1800000000",
        kind: "attempt",
        schema: 1,
        sha: SHA,
        status: null,
        type: "attempt-captured",
        work: null,
      },
    ]);
  });

  it("appends at most once per type and key, also across a restart", () => {
    const h = harness();
    const first = h.log();
    first.open();
    expect(first.append("ci_pending", SHA, "pending")).toBe(true);
    expect(first.append("ci_pending", SHA, "pending again")).toBe(false);
    expect(first.append("ci_success", SHA, "green")).toBe(true);
    const second = h.log();
    second.open();
    expect(second.append("ci_pending", SHA, "after restart")).toBe(false);
    expect(second.append("ci_success", SHA, "after restart")).toBe(false);
    expect(second.append("ci_failure", SHA, "red")).toBe(true);
    expect(loggedEvents(h.test).map((event) => event.type)).toEqual([
      "ci_pending",
      "ci_success",
      "ci_failure",
    ]);
  });

  it("keeps the cursor and commit progress across mixed game and app rows", () => {
    const h = harness();
    expect(h.log().append("push", SHA, "pushed")).toBe(true);
    const legacyBytes = readFileSync(h.paths.eventsLog, "utf8");
    writeCursor(h, Buffer.byteLength(legacyBytes));
    const cursor = readFileSync(h.paths.eventsCursor, "utf8");

    const app = h.log(true);
    expect(app.append("push", SHA, "already pushed")).toBe(false);
    expect(app.append("ci_success", SHA, "green")).toBe(true);
    const mixed = readFileSync(h.paths.eventsLog, "utf8");
    expect(mixed.startsWith(legacyBytes)).toBe(true);
    expect(rawLines(h)[1]).toContain(`"appId":"${GAME}"`);
    expect(rawLines(h)[1]).not.toContain('"game"');
    expect(eventLogReport(h.paths)).toMatchObject({
      blockers: [`events_uningested:${Buffer.byteLength(mixed) - Buffer.byteLength(legacyBytes)}`],
    });
    expect(readFileSync(h.paths.eventsCursor, "utf8")).toBe(cursor);

    const restarted = h.log(true);
    expect(restarted.append("ci_success", SHA, "already green")).toBe(false);
    expect(restarted.append("deploy_success", SHA, "deployed")).toBe(true);
    expect(readFileSync(h.paths.lastCompleteSha, "utf8")).toBe(`${SHA}\n`);
    expect(loggedEvents(h.test).map((event) => event.id)).toEqual([
      eventId(GAME, "push", SHA),
      eventId(GAME, "ci_success", SHA),
      eventId(GAME, "deploy_success", SHA),
    ]);
  });

  it("replaces control characters in the detail", () => {
    const h = harness();
    h.log().append("attempt", "k", "line one\nline two\ttab");
    expect(rawLines(h)).toHaveLength(1);
    expect(loggedEvents(h.test)[0]?.detail).toBe("line one line two tab");
  });

  it("logs a failed append to the runner log and stderr and never throws", () => {
    const h = harness();
    mkdirSync(h.paths.eventsLog);
    const log = h.log();
    expect(log.append("push", SHA, "pushed")).toBe(false);
    expect(h.lines.at(-1)).toMatch(
      new RegExp(
        `^bus: event push ${SHA} not appended to events.jsonl .*; operator review required$`,
      ),
    );
  });
});

describe("EventLog rotation", () => {
  function fill(h: Harness, bytes: number): number {
    const event = makeEvent({ at: "x", detail: "d".repeat(900), game: GAME }, "attempt", "fill");
    const line = `${JSON.stringify(event)}\n`;
    writeFileSync(h.paths.eventsLog, line.repeat(Math.ceil(bytes / line.length)));
    return readFileSync(h.paths.eventsLog).length;
  }

  it("rotates an ingested log over 1 MiB before the next append", () => {
    const h = harness();
    const size = fill(h, 1024 * 1024 + 1);
    writeCursor(h, size);
    h.log().append("push", SHA, "pushed");
    expect(readFileSync(join(h.paths.dir, `events.${NOW}.jsonl`)).length).toBe(size);
    expect(loggedEvents(h.test).map((event) => event.type)).toEqual(["push"]);
    expect(h.lines).toContain(
      `bus: rotated events.jsonl (${size} bytes, ingested) to events.${NOW}.jsonl`,
    );
  });

  it("keeps a log whose cursor names another file, even at the same offset", () => {
    const h = harness();
    const size = fill(h, 1024 * 1024 + 1);
    const other = join(h.paths.dir, "events.1799999999.jsonl");
    writeFileSync(
      other,
      `${JSON.stringify(makeEvent({ at: "x", detail: "", game: GAME }, "attempt", "old"))}\n`,
    );
    writeCursor(h, size, other);
    h.log().append("push", SHA, "pushed");
    expect(existsSync(join(h.paths.dir, `events.${NOW}.jsonl`))).toBe(false);
    expect(readFileSync(h.paths.eventsLog).length).toBeGreaterThan(size);
  });

  it("keeps a log that is not fully ingested or not over 1 MiB", () => {
    for (const [bytes, behind] of [
      [1024 * 1024 + 1, 1],
      [1024, 0],
    ] as const) {
      const h = harness();
      const size = fill(h, bytes);
      writeCursor(h, size - behind);
      h.log().append("push", SHA, "pushed");
      expect(readdirSync(h.paths.dir).filter((name) => /^events\.\d+\.jsonl$/u.test(name))).toEqual(
        [],
      );
      expect(readFileSync(h.paths.eventsLog).length).toBeGreaterThan(size);
    }
  });
});

describe("EventLog torn last line", () => {
  it("completes a torn line that is a whole event and keeps its ID deduplicated", () => {
    const h = harness();
    const event = makeEvent({ at: "x", detail: "pushed", game: GAME }, "push", SHA);
    writeFileSync(h.paths.eventsLog, JSON.stringify(event));
    const log = h.log();
    log.open();
    expect(rawLines(h)).toEqual([JSON.stringify(event)]);
    expect(log.append("push", SHA, "again")).toBe(false);
    expect(h.lines).toContain(`bus: completed the torn last line of events.jsonl (push ${SHA})`);
  });

  it("terminates any other fragment so the next event starts its own line", () => {
    const h = harness();
    const whole = makeEvent({ at: "x", detail: "attempt", game: GAME }, "attempt", "k");
    writeFileSync(h.paths.eventsLog, `${JSON.stringify(whole)}\n{"schema":1,"id":"ab`);
    const log = h.log();
    log.open();
    expect(log.append("push", SHA, "pushed")).toBe(true);
    const lines = rawLines(h);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('{"schema":1,"id":"ab');
    expect(JSON.parse(lines[2] ?? "").type).toBe("push");
    expect(h.lines).toContain(
      "bus: terminated a torn last line in events.jsonl; ingest quarantines it",
    );
  });
});

describe("EventLog work range", () => {
  it("lists work files that became done since the last complete commit on ok or skipped deploys", () => {
    const h = harness();
    workFile(h.test, "dk-0001", "approved");
    const base = workFile(h.test, "dk-0003", "done");
    const log = h.log();
    log.open();
    // The first complete commit has no known base.
    log.append("push", base, "pushed");
    log.append("ci_success", base, "green");
    log.append("deploy_success", base, "deployed");
    expect(readFileSync(h.paths.lastCompleteSha, "utf8")).toBe(`${base}\n`);
    workFile(h.test, "dk-0001", "done");
    workFile(h.test, "dk-0002", "done");
    workFile(h.test, "dk-0004", "approved");
    const head = gitSync(h.test.repo, "rev-parse", "HEAD");
    log.append("push", head, "pushed");
    log.append("deploy_failure", head, "failed");
    log.append("deploy_skipped", head, "skipped");
    const events = loggedEvents(h.test);
    const work = (type: string, sha: string): RunnerEvent["work"] | undefined =>
      events.find((event) => event.type === type && event.key === sha)?.work;
    expect(work("deploy_success", base)).toBeNull();
    expect(work("push", head)).toBeNull();
    expect(work("deploy_failure", head)).toBeNull();
    expect(work("deploy_skipped", head)).toEqual(["dk-0001", "dk-0002"]);
  });

  it("is null for an unknown base and [] when nothing became done", () => {
    const h = harness();
    const base = workFile(h.test, "dk-0001", "done");
    const head = commitFile(h.test.repo, "README.md", "changed\n");
    expect(workDone(h.test.repo, base, head)).toEqual([]);
    expect(workDone(h.test.repo, "f".repeat(40), head)).toBeNull();
  });
});

describe("eventLogReport", () => {
  it("is drained only when the cursor reaches the end with no rotated log and no torn line", () => {
    const h = harness();
    expect(eventLogReport(h.paths)).toEqual({
      blockers: [],
      report: {
        cursorOffset: null,
        drained: true,
        file: h.paths.eventsLog,
        rotated: [],
        size: 0,
        torn: false,
      },
    });
    h.log().append("push", SHA, "pushed");
    const size = readFileSync(h.paths.eventsLog).length;
    expect(eventLogReport(h.paths).blockers).toEqual([`events_uningested:${size}`]);
    writeCursor(h, size);
    expect(eventLogReport(h.paths).report).toMatchObject({
      cursorOffset: size,
      drained: true,
      size,
    });
    writeFileSync(join(h.paths.dir, "events.1799999999.jsonl"), "");
    appendFileSync(h.paths.eventsLog, '{"torn"');
    expect(eventLogReport(h.paths)).toMatchObject({
      blockers: ["events_uningested:7", "events_rotated:1", "events_torn"],
      report: { drained: false, rotated: ["events.1799999999.jsonl"], torn: true },
    });
  });

  it("reports an invalid cursor and a cursor past the end", () => {
    const h = harness();
    h.log().append("push", SHA, "pushed");
    writeFileSync(h.paths.eventsCursor, "{");
    expect(eventLogReport(h.paths)).toMatchObject({
      blockers: ["events_cursor_invalid"],
      report: { cursorOffset: null, drained: false },
    });
    writeCursor(h, 1_000_000);
    expect(eventLogReport(h.paths).blockers).toEqual(["events_cursor_ahead"]);
  });

  it("counts the offset only for the file the cursor names", () => {
    const h = harness();
    const log = h.log();
    log.append("push", SHA, "pushed");
    const size = readFileSync(h.paths.eventsLog).length;
    writeCursor(h, size);
    // The runner rotated the log the cursor names, then appended to a new one.
    renameSync(h.paths.eventsLog, join(h.paths.dir, "events.1800000000.jsonl"));
    log.append("attempt", "k", "attempt");
    const live = readFileSync(h.paths.eventsLog).length;
    expect(eventLogReport(h.paths)).toMatchObject({
      blockers: [`events_uningested:${live}`, "events_cursor_rotated", "events_rotated:1"],
      report: { cursorOffset: size, drained: false },
    });
    // Ingest deleted the rotated log without moving the cursor: it names no file present.
    rmSync(join(h.paths.dir, "events.1800000000.jsonl"));
    expect(eventLogReport(h.paths).blockers).toEqual([
      `events_uningested:${live}`,
      "events_cursor_unmatched",
    ]);
    writeCursor(h, live);
    expect(eventLogReport(h.paths).report.drained).toBe(true);
  });
});
