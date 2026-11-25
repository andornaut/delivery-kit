import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  cursorRefersTo,
  EVENT_TYPES,
  eventId,
  formatLine,
  LINE_LIMIT,
  makeEvent,
  parseCursor,
  parseLine,
  startedDetail,
  TRUNCATED,
  workStatus,
} from "./events.ts";

const GAME = "archies-dog-walks";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.includes(".test") ? [path] : [];
  });
}

/** Every event type the source emits: literal emit() types, blocked stages and runner.started. */
function emittedTypes(): string[] {
  const types = new Set<string>(["runner.started"]);
  for (const path of sources(SRC)) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/events\.emit\(\s*"([^"]+)"/gu)) {
      types.add(match[1] as string);
    }
    for (const match of text.matchAll(/blocked\(\s*context,\s*attempt,\s*"([^"]+)"/gu)) {
      types.add(`blocked-${match[1] as string}`);
    }
  }
  const gate = readFileSync(join(SRC, "gate", "gate.ts"), "utf8");
  const stages = /readonly stage: ("[^;]+");/u.exec(gate)?.[1] ?? "";
  for (const match of stages.matchAll(/"([^"]+)"/gu)) {
    types.add(`blocked-${match[1] as string}`);
  }
  return [...types].sort();
}

describe("the event type table", () => {
  it("maps exactly the types the runner emits", () => {
    const emitted = emittedTypes();
    expect(emitted).toContain("blocked-full-gate");
    expect(emitted).toContain("ci_success");
    expect(emitted).toContain("gate_passed");
    expect(emitted).not.toContain("resident-identity-changed");
    expect(Object.keys(EVENT_TYPES).sort()).toEqual(emitted);
  });

  it("assigns the current event families and statuses", () => {
    expect(EVENT_TYPES.ci_success).toEqual({ kind: "ci", status: "ok" });
    expect(EVENT_TYPES["blocked-full-gate"]).toEqual({ kind: "gate", status: "failed" });
    expect(EVENT_TYPES.gate_passed).toEqual({ kind: "gate", status: "ok" });
    expect(EVENT_TYPES.gate_skipped).toEqual({ kind: "gate", status: "skipped" });
    expect(EVENT_TYPES.ci_timeout).toEqual({ kind: "ci", status: "timeout" });
    expect(EVENT_TYPES.deploy_disabled).toEqual({ kind: "deploy", status: "skipped" });
    expect(EVENT_TYPES["scheduled-status"]).toEqual({ kind: "runner", status: null });
  });
});

describe("event lines", () => {
  it("derives the ID from game, type and key", () => {
    expect(eventId(GAME, "push", SHA)).toBe(
      createHash("sha256").update(`${GAME}\npush\n${SHA}`).digest("hex"),
    );
    expect(eventId(GAME, "push", SHA)).not.toBe(eventId(GAME, "ci_success", SHA));
  });

  it("writes every field and sets sha only for a commit key", () => {
    const event = makeEvent(
      { at: "2026-11-18T21:30:00Z", detail: "pushed", game: GAME },
      "push",
      SHA,
    );
    expect(parseLine(formatLine(event).trimEnd())).toEqual({
      at: "2026-11-18T21:30:00Z",
      detail: "pushed",
      game: GAME,
      id: eventId(GAME, "push", SHA),
      key: SHA,
      kind: "push",
      schema: 1,
      sha: SHA,
      status: "ok",
      type: "push",
      work: null,
    });
    const slot = makeEvent({ at: "x", detail: "", game: GAME }, "scheduled-status", "1800000000");
    expect(slot.sha).toBeNull();
    expect(Object.keys(event)).toEqual([
      "schema",
      "id",
      "game",
      "kind",
      "type",
      "key",
      "at",
      "sha",
      "status",
      "detail",
      "work",
    ]);
  });

  it.each([
    { kind: "runner", status: "ok", type: "complete" },
    { kind: "runner", status: null, type: "resident-identity-changed" },
    { kind: "attempt", status: "blocked", type: "blocked-retired-stage" },
    { kind: "runner", status: null, type: "retired-kind" },
  ])("reads a historical schema-1 $type record", ({ kind, status, type }) => {
    const event = {
      at: "1970-01-01T00:00:00Z",
      detail: "Archie bus: imported event",
      game: GAME,
      id: eventId(GAME, type, SHA),
      key: SHA,
      kind,
      schema: 1,
      sha: SHA,
      status,
      type,
      work: null,
    };
    expect(parseLine(JSON.stringify(event))).toEqual(event);
  });

  it("keeps a short line whole and newline-terminated", () => {
    const event = makeEvent({ at: "x", detail: "short", game: GAME }, "attempt", "k");
    const line = formatLine(event);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(parseLine(line.slice(0, -1))?.detail).toBe("short");
  });

  it("cuts a long detail at a character boundary below the line limit", () => {
    const detail = `${"é".repeat(3000)}${"\u{1F600}".repeat(500)}`;
    const line = formatLine(makeEvent({ at: "x", detail, game: GAME }, "attempt", "k"));
    expect(Buffer.byteLength(line, "utf8")).toBeLessThan(LINE_LIMIT);
    expect(Buffer.byteLength(line, "utf8")).toBeGreaterThan(LINE_LIMIT - 16);
    const parsed = parseLine(line.slice(0, -1));
    expect(parsed?.detail.endsWith(TRUNCATED)).toBe(true);
    expect(detail.startsWith(parsed?.detail.slice(0, -TRUNCATED.length) ?? "-")).toBe(true);
  });

  it("refuses a line that cannot fit even without its detail", () => {
    const event = makeEvent(
      { at: "x", detail: "d", game: GAME },
      "attempt",
      "k".repeat(LINE_LIMIT),
    );
    expect(() => formatLine(event)).toThrow(/exceeds 4096 bytes/u);
  });

  it("rejects lines that are not events", () => {
    expect(parseLine("{")).toBeUndefined();
    expect(parseLine('{"schema":2}')).toBeUndefined();
    expect(parseLine("[]")).toBeUndefined();
  });
});

describe("the cursor and work files", () => {
  const cursor = {
    at: "2026-11-18T21:30:00Z",
    file: "events.jsonl",
    dev: 2049,
    firstId: "b".repeat(64),
    inode: 1234,
    lastId: "a".repeat(64),
    lines: 2,
    offset: 512,
    schema: 1,
  };

  it("reads a valid cursor and rejects any other", () => {
    expect(parseCursor(JSON.stringify(cursor))).toEqual(cursor);
    expect(parseCursor(JSON.stringify({ ...cursor, lastId: null }))?.lastId).toBeNull();
    for (const invalid of [
      { ...cursor, schema: 2 },
      { ...cursor, file: "events.1.jsonl" },
      { ...cursor, offset: -1 },
      { ...cursor, offset: 1.5 },
      { ...cursor, lastId: "x" },
      { ...cursor, firstId: "x" },
      { ...cursor, firstId: undefined },
      { ...cursor, inode: -1 },
      { ...cursor, dev: "2049" },
    ]) {
      expect(parseCursor(JSON.stringify(invalid))).toBeUndefined();
    }
    expect(parseCursor("{")).toBeUndefined();
  });

  it("matches a file by its first line ID, or by inode and dev when it has none", () => {
    const parsed = parseCursor(JSON.stringify(cursor))!;
    expect(cursorRefersTo(parsed, { dev: 1, firstId: "b".repeat(64), inode: 1 })).toBe(true);
    expect(cursorRefersTo(parsed, { dev: 2049, firstId: "c".repeat(64), inode: 1234 })).toBe(false);
    const empty = parseCursor(JSON.stringify({ ...cursor, firstId: null }))!;
    expect(cursorRefersTo(empty, { dev: 2049, firstId: null, inode: 1234 })).toBe(true);
    expect(cursorRefersTo(empty, { dev: 2049, firstId: null, inode: 1235 })).toBe(false);
    expect(cursorRefersTo(empty, { dev: 2049, firstId: "b".repeat(64), inode: 1234 })).toBe(false);
  });

  it("reads the front matter status of a work file", () => {
    expect(workStatus("---\nid: dk-0001\nstatus: done\n---\n\nBody\n")).toBe("done");
    expect(workStatus('---\nstatus: "done"\n---\n')).toBe("done");
    expect(workStatus("---\nid: dk-0001\n---\nstatus: done\n")).toBeUndefined();
    expect(workStatus("status: done\n")).toBeUndefined();
  });

  it("serializes runner.started with the five identity fields", () => {
    expect(
      JSON.parse(
        startedDetail({
          cliSha256: "c".repeat(64),
          coordinationKitVersion: "2.0.0",
          deliveryKitVersion: "6.1.0",
          distSha256: null,
          token: "1:2:3",
        }),
      ),
    ).toEqual({
      cliSha256: "c".repeat(64),
      coordinationKitVersion: "2.0.0",
      deliveryKitVersion: "6.1.0",
      distSha256: null,
      token: "1:2:3",
    });
  });
});
