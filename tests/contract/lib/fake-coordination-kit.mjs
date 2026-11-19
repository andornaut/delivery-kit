#!/usr/bin/env node
// A fake coordinator-installed coordination-kit CLI implementing the runner seam contract:
// `--root ROOT review deliver --game G --slot S`, `--root ROOT events ingest --game G` and
// `--root ROOT --version --json`, each printing one JSON line. Installed as
// ROOT/node_modules/@andornaut/coordination-kit/dist/cli.js. ROOT/fake-coordination-kit/control.json
// scripts each command; every call is appended to ROOT/fake-coordination-kit/calls.jsonl.
//
// S is an ISO 8601 minute start with an offset and is echoed as given. A typed review result is
// recorded at ROOT/var/games/G/bus/unblock/review-deliver/<epoch seconds>.json and printed again
// for a repeat call; recipient-busy (lock contention) is not recorded. A nonzero exit prints no
// stdout and one `coordination-kit:` stderr line.
//
// `events ingest` follows the event log contract: it finds the file the cursor names by its first
// line ID (inode and device for a file without one) among the rotated `events.<epoch>.jsonl` logs
// and bus/events.jsonl, finishes that file from the cursor's offset and newer files from 0 (every
// file from 0 when none matches), deletes each rotated log it read, stops before a last line
// without its newline, appends a malformed complete line to events.quarantine.jsonl and writes
// bus/events.cursor atomically with the live log's identity. Ingested events, deduplicated by
// ID, are appended to ROOT/fake-coordination-kit/ingested.jsonl.
//
// control.json: { version?, distSha256?, review?, reviews?: {S: behaviour}, ingest?, probe? }
// A behaviour: { status?, reason?, detail?, override?, stdout?, stderr?, exit?, hang?, delayMs?,
// consume? }. `stdout` replaces the result line, `override` is merged over it, `hang` starts a
// grandchild in the same process group, records both PIDs in hang.json and never exits, and
// `consume: false` (ingest) leaves the log and cursor untouched.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const rootAt = args.indexOf("--root");
if (rootAt === -1 || args[rootAt + 1] === undefined) {
  process.stderr.write("usage: coordination-kit --root ROOT COMMAND\n");
  process.exit(2);
}
const root = args[rootAt + 1];
const rest = args.filter((_, index) => index !== rootAt && index !== rootAt + 1);
const dir = join(root, "fake-coordination-kit");
mkdirSync(dir, { recursive: true });

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

const control = readJson(join(dir, "control.json"), {});
const cli = {
  distSha256:
    control.distSha256 ?? createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"),
  version: control.version ?? "3.0.0",
};

function option(name) {
  const at = rest.indexOf(name);
  return at === -1 ? undefined : rest[at + 1];
}

appendFileSync(
  join(dir, "calls.jsonl"),
  `${JSON.stringify({ args: rest, cwd: process.cwd(), execPath: process.execPath, root })}\n`,
);

function print(line) {
  process.stdout.write(`${line}\n`);
}

async function respond(behaviour, result) {
  if (behaviour.delayMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
  }
  if (behaviour.hang === true) {
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    writeFileSync(
      join(dir, "hang.json"),
      JSON.stringify({ grandchild: grandchild.pid, pid: process.pid }),
    );
    setInterval(() => {}, 1000);
    return undefined;
  }
  const exit = behaviour.exit ?? 0;
  if (behaviour.stderr !== undefined) process.stderr.write(behaviour.stderr);
  // An internal failure exits 1 with no stdout and one `coordination-kit:` line on stderr.
  if (exit !== 0 && behaviour.stdout === undefined) {
    if (behaviour.stderr === undefined)
      process.stderr.write("coordination-kit: internal failure\n");
    process.exit(exit);
  }
  const line =
    behaviour.stdout !== undefined
      ? behaviour.stdout
      : JSON.stringify({ ...result, ...(behaviour.override ?? {}) });
  if (line !== "") process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
  process.exit(exit);
}

/** The result's keys in the CLI's print order; the runner parses JSON and ignores the order. */
function ordered(fields) {
  const keys = ["schema", "kind", "game", "slot", "status", "reason", "detail"];
  const result = {};
  for (const key of keys) if (fields[key] !== undefined) result[key] = fields[key];
  return { ...result, cli };
}

function reason(behaviour, status, otherwise) {
  if (behaviour.reason !== undefined) return behaviour.reason;
  return status === "delivered" ? null : otherwise;
}

const ROTATED = /^events\.(\d+)\.jsonl$/;

/** Complete lines of `buffer` from byte `offset`: each line and the offset after it. */
function completeLines(buffer, offset) {
  const lines = [];
  let at = offset;
  for (;;) {
    const end = buffer.indexOf(0x0a, at);
    if (end === -1) return lines;
    lines.push({ end: end + 1, text: buffer.subarray(at, end).toString("utf8") });
    at = end + 1;
  }
}

function parseEvent(text) {
  try {
    const event = JSON.parse(text);
    return event !== null && typeof event === "object" && event.schema === 1 && event.id
      ? event
      : null;
  } catch {
    return null;
  }
}

/** A log's identity: its first complete line's ID (null without one), inode and device. */
function identity(path) {
  const stat = statSync(path);
  const first = completeLines(readFileSync(path), 0)[0];
  return { dev: stat.dev, firstId: (first && parseEvent(first.text)?.id) ?? null, inode: stat.ino };
}

function refersTo(cursor, id) {
  if (cursor.firstId !== null) return cursor.firstId === id.firstId;
  return id.firstId === null && cursor.inode === id.inode && cursor.dev === id.dev;
}

/**
 * Ingest the game's event log per the cursor contract; the counts consumed. The cursor's offset
 * applies to the file it names: the live log, or a rotated log that is finished from there before
 * newer files are read from 0. A cursor that names no file present restarts every file at 0.
 */
function ingest(game) {
  const bus = join(root, "var", "games", game, "bus");
  const cursorPath = join(bus, "events.cursor");
  const seen = new Set(
    existsSync(join(dir, "ingested.jsonl"))
      ? readFileSync(join(dir, "ingested.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line).id)
      : [],
  );
  const counts = { held: 0, ingested: 0, quarantined: 0 };
  const cursor = readJson(cursorPath, null);
  const live = join(bus, "events.jsonl");
  const files = [
    ...(existsSync(bus)
      ? readdirSync(bus)
          .filter((name) => ROTATED.test(name))
          .sort((a, b) => Number(ROTATED.exec(a)[1]) - Number(ROTATED.exec(b)[1]))
          .map((name) => join(bus, name))
      : []),
    ...(existsSync(live) ? [live] : []),
  ];
  let start = 0;
  let offset = 0;
  if (cursor !== null) {
    const at = files.findIndex((path) => refersTo(cursor, identity(path)));
    if (at !== -1) {
      start = at;
      offset = cursor.offset;
    }
  }
  let lastId = cursor?.lastId ?? null;
  let liveOffset = 0;
  let liveLines = 0;
  for (const [index, path] of files.entries()) {
    const buffer = readFileSync(path);
    const from = index < start ? 0 : index === start ? Math.min(offset, buffer.length) : 0;
    const lines = completeLines(buffer, from);
    for (const line of lines) {
      const event = parseEvent(line.text);
      if (event === null) {
        appendFileSync(join(bus, "events.quarantine.jsonl"), `${line.text}\n`);
        counts.quarantined += 1;
      } else {
        if (!seen.has(event.id)) {
          seen.add(event.id);
          appendFileSync(join(dir, "ingested.jsonl"), `${JSON.stringify(event)}\n`);
          counts.ingested += 1;
        }
        lastId = event.id;
      }
    }
    if (path === live) {
      liveOffset = lines.at(-1)?.end ?? from;
      liveLines = completeLines(buffer.subarray(0, liveOffset), 0).length;
      counts.held = liveOffset < buffer.length ? 1 : 0;
    } else {
      rmSync(path);
    }
  }
  if (existsSync(live)) {
    const id = identity(live);
    const record = {
      schema: 1,
      file: "events.jsonl",
      offset: liveOffset,
      lines: liveLines,
      lastId,
      firstId: id.firstId,
      inode: id.inode,
      dev: id.dev,
      at: new Date().toISOString(),
    };
    writeFileSync(`${cursorPath}.tmp`, `${JSON.stringify(record)}\n`);
    renameSync(`${cursorPath}.tmp`, cursorPath);
  }
  return counts;
}

if (rest[0] === "--version" && rest[1] === "--json") {
  await respond(control.probe ?? {}, { schema: 1, ...cli });
} else if (rest[0] === "review" && rest[1] === "deliver") {
  const game = option("--game");
  const slot = option("--slot");
  const epoch = slot === undefined ? Number.NaN : Date.parse(slot) / 1000;
  if (game === undefined || !/[+-]\d\d:\d\d$/.test(slot ?? "") || !Number.isInteger(epoch)) {
    process.stderr.write(
      "usage: coordination-kit review deliver --game G --slot ISO-WITH-OFFSET\n",
    );
    process.exit(2);
  }
  // The CLI owns the per-slot record: a repeat call prints the recorded result.
  const records = join(root, "var", "games", game, "bus", "unblock", "review-deliver");
  const record = join(records, `${epoch}.json`);
  if (existsSync(record)) {
    print(readFileSync(record, "utf8").trim());
    process.exit(0);
  }
  const behaviour = control.reviews?.[slot] ?? control.review ?? {};
  const status = behaviour.status ?? "skipped";
  const result = ordered({
    detail: behaviour.detail ?? (status === "delivered" ? `review ${slot} delivered` : ""),
    game,
    kind: "review-deliver",
    reason: reason(behaviour, status, "nothing-due"),
    schema: 1,
    slot,
    status,
  });
  // Lock contention (recipient-busy) and failures are not recorded.
  const typed = (behaviour.exit ?? 0) === 0 && behaviour.stdout === undefined;
  if (typed && behaviour.hang !== true && result.reason !== "recipient-busy") {
    mkdirSync(records, { recursive: true });
    writeFileSync(record, `${JSON.stringify(result)}\n`);
  }
  await respond(behaviour, result);
} else if (rest[0] === "events" && rest[1] === "ingest") {
  const game = option("--game");
  if (game === undefined) {
    process.stderr.write("usage: coordination-kit events ingest --game G\n");
    process.exit(2);
  }
  const behaviour = control.ingest ?? {};
  const idle =
    behaviour.consume === false || behaviour.hang === true || (behaviour.exit ?? 0) !== 0;
  const counts = idle ? { held: 0, ingested: 0, quarantined: 0 } : ingest(game);
  const consumed = counts.ingested + counts.quarantined;
  const status = behaviour.status ?? (consumed > 0 ? "delivered" : "skipped");
  await respond(behaviour, {
    ...ordered({
      detail: behaviour.detail ?? `ingested ${counts.ingested}`,
      game,
      kind: "events-ingest",
      reason: reason(behaviour, status, "no-events"),
      schema: 1,
      status,
    }),
    completed: 0,
    delivered: consumed,
    held: counts.held,
    ingested: counts.ingested,
    quarantined: counts.quarantined,
  });
} else {
  process.stderr.write(`coordination-kit: unknown command ${rest.join(" ")}\n`);
  process.exit(2);
}
