#!/usr/bin/env node
// A fake coordinator-installed coordination-kit CLI implementing the runner seam contract:
// `--root ROOT review deliver --game G --slot S`, `--root ROOT events flush --game G` and
// `--root ROOT --version --json`, each printing one JSON line. Installed as
// ROOT/node_modules/@andornaut/coordination-kit/dist/cli.js. ROOT/fake-coordination-kit/control.json
// scripts each command; every call is appended to ROOT/fake-coordination-kit/calls.jsonl.
//
// S is an ISO 8601 minute start with an offset and is echoed as given. A typed review result is
// recorded at ROOT/var/games/G/bus/unblock/review-deliver/<epoch seconds>.json and printed again
// for a repeat call; recipient-busy (lock contention) is not recorded. A nonzero exit prints no
// stdout and one `coordination-kit:` stderr line. An unreadable outbox event defers a flush with
// outbox-unreadable before any send.
//
// control.json: { version?, distSha256?, review?, reviews?: {S: behaviour}, flush?, probe? }
// A behaviour: { status?, reason?, detail?, override?, stdout?, stderr?, exit?, hang?, delayMs?,
// markSent? }. `stdout` replaces the result line, `override` is merged over it, `hang` starts a
// grandchild in the same process group, records both PIDs in hang.json and never exits, and
// `markSent` (flush) marks the game's unsent outbox events sent.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
  version: control.version ?? "1.2.0",
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
  const keys = [
    "schema",
    "kind",
    "game",
    "slot",
    "status",
    "reason",
    "detail",
    "delivered",
    "held",
  ];
  const result = {};
  for (const key of keys) if (fields[key] !== undefined) result[key] = fields[key];
  return { ...result, cli };
}

function reason(behaviour, status, otherwise) {
  if (behaviour.reason !== undefined) return behaviour.reason;
  return status === "delivered" ? null : otherwise;
}

/** The game's outbox events, or null when one is unreadable. */
function outbox(game) {
  const events = join(root, "var", "games", game, "bus", "events");
  if (!existsSync(events)) return [];
  const entries = [];
  for (const name of readdirSync(events)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const path = join(events, name);
    const event = readJson(path, null);
    if (event === null || typeof event !== "object") return null;
    entries.push({ event, path });
  }
  return entries;
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
} else if (rest[0] === "events" && rest[1] === "flush") {
  const game = option("--game");
  if (game === undefined) {
    process.stderr.write("usage: coordination-kit events flush --game G\n");
    process.exit(2);
  }
  const behaviour = control.flush ?? {};
  const entries = outbox(game);
  if (entries === null) {
    // An unreadable event file stops a flush before any send.
    await respond(
      behaviour,
      ordered({
        delivered: 0,
        detail: "an outbox event is unreadable",
        game,
        held: 0,
        kind: "events-flush",
        reason: "outbox-unreadable",
        schema: 1,
        status: "deferred",
      }),
    );
  }
  let delivered = 0;
  if (behaviour.markSent === true) {
    for (const { event, path } of entries) {
      if (event.sent === true || event.suppressed === true) continue;
      writeFileSync(path, `${JSON.stringify({ ...event, sent: true })}\n`);
      delivered += 1;
    }
  }
  const status = behaviour.status ?? (delivered > 0 ? "delivered" : "skipped");
  await respond(
    behaviour,
    ordered({
      delivered,
      detail: behaviour.detail ?? `${delivered} delivered`,
      game,
      held: 0,
      kind: "events-flush",
      reason: reason(behaviour, status, "no-events"),
      schema: 1,
      status,
    }),
  );
} else {
  process.stderr.write(`coordination-kit: unknown command ${rest.join(" ")}\n`);
  process.exit(2);
}
