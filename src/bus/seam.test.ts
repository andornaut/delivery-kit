import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  COORDINATOR_CLI,
  CoordinatorCli,
  coordinatorCliReport,
  parseResult,
  parseVersion,
  slotIso,
} from "./seam.ts";
import { coordinatorCalls, installCoordinator, scriptCoordinator } from "./testCoordinator.ts";

const GAME = "fixture-game";
// 2026-11-04 03:20 UTC, the :20 wake slot of 22:20 EST in America/Toronto.
const SLOT = Date.UTC(2026, 10, 4, 3, 20, 0) / 1000;
const TIMEZONE = "America/Toronto";
const ISO = "2026-11-03T22:20:00-05:00";
/** seam.json records when the runner saw the identity, in UTC. */
const SEEN = "2026-11-04T03:20:00Z";
const SHA = "c".repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixture(control?: Record<string, unknown>, timeoutMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "seam-"));
  roots.push(root);
  if (control !== undefined) {
    installCoordinator(root, { distSha256: SHA, ...control });
  }
  const lines: string[] = [];
  const seamFile = join(root, "seam.json");
  let now = SLOT;
  const cli = new CoordinatorCli({
    game: GAME,
    log: (line) => lines.push(line),
    now: () => now,
    root,
    seamFile,
    timezone: TIMEZONE,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return {
    advance: (seconds: number) => {
      now += seconds;
    },
    cli,
    lines,
    root,
    seamFile,
  };
}

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition not reached");
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

/** Exited, or a zombie awaiting a reaper that is not this process. */
function gone(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}

function hung(root: string): { pid: number; grandchild: number } | undefined {
  const path = join(root, "fake-coordination-kit", "hang.json");
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as { pid: number; grandchild: number })
    : undefined;
}

function reviewRecords(root: string): string[] {
  const dir = join(root, "var", "games", GAME, "bus", "unblock", "review-deliver");
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("review deliver", () => {
  it("spawns the coordinator CLI with the running Node binary, the root and the ISO slot", async () => {
    const { cli, lines, root, seamFile } = fixture({
      review: { detail: "brief r-1 sent to game-coordinator", status: "delivered" },
    });
    expect(await cli.review(SLOT)).toEqual({
      claimed: true,
      cli: { distSha256: SHA, version: "1.2.0" },
      detail: "brief r-1 sent to game-coordinator",
      reason: null,
      status: "delivered",
    });
    expect(coordinatorCalls(root)).toEqual([
      {
        args: ["review", "deliver", "--game", GAME, "--slot", ISO],
        cwd: root,
        execPath: process.execPath,
        root,
      },
    ]);
    expect(lines).toEqual([
      `bus: coordinator CLI 1.2.0 (dist sha256 ${SHA}), inside >=1.2.0 <2.0.0`,
    ]);
    expect(JSON.parse(readFileSync(seamFile, "utf8"))).toEqual({
      distSha256: SHA,
      schema: 1,
      seenAt: SEEN,
      version: "1.2.0",
    });
    // A repeat call is the CLI's no-op: it returns the recorded outcome.
    expect(await cli.review(SLOT)).toMatchObject({ status: "delivered" });
  });

  it.each([
    [{ reason: "recipient-busy", status: "deferred" }, "deferred", "recipient-busy"],
    [{ reason: "question-pending", status: "deferred" }, "deferred", "question-pending"],
    [{ reason: "already-delivered", status: "skipped" }, "skipped", "already-delivered"],
    [{ reason: "nothing-due", status: "skipped" }, "skipped", "nothing-due"],
    [{ reason: "brand-new-token", status: "skipped" }, "deferred", "brand-new-token"],
    [{ reason: "brand-new-token", status: "delivered" }, "deferred", "brand-new-token"],
  ])("reads %j as %s", async (review, status, reason) => {
    const { cli } = fixture({ review: { detail: "detail\ntext", ...review } });
    expect(await cli.review(SLOT)).toMatchObject({
      claimed: true,
      detail: "detail text",
      reason,
      status,
    });
  });

  it.each([
    [{ exit: 1 }, "exit 1: coordination-kit: internal failure"],
    [
      { exit: 1, stderr: "coordination-kit: store locked\n" },
      "exit 1: coordination-kit: store locked",
    ],
    [{ exit: 2, stdout: "" }, "exit 2"],
    [{ stdout: "not json" }, "the result is not JSON"],
    [{ stdout: "" }, "no result on stdout"],
    [{ stdout: '{"schema":1}\n{"schema":1}' }, "stdout holds more than one line"],
    [{ override: { schema: 2 } }, "malformed result: schema is not 1"],
    [{ override: { kind: "events-flush" } }, "malformed result: kind is not review-deliver"],
    [{ override: { game: "other-game" } }, "malformed result: game differs"],
    // The same instant in another form is not the slot that was sent.
    [{ override: { slot: "2026-11-04T03:20:00Z" } }, "malformed result: slot differs"],
    [{ override: { status: "blocked" } }, "malformed result: status"],
    [{ override: { reason: "Not A Token" } }, "malformed result: reason"],
    [{ override: { reason: null, status: "deferred" } }, "malformed result: reason is null"],
    [{ override: { detail: 1 } }, "malformed result: detail"],
    [{ override: { cli: { version: "1.2.0" } } }, "malformed result: cli"],
  ])("claims no delivery for %j", async (review, why) => {
    const { cli, lines, seamFile } = fixture({ review });
    const outcome = await cli.review(SLOT);
    expect(outcome.claimed).toBe(false);
    expect(outcome.claimed ? "" : outcome.why).toContain(why);
    expect(lines).toEqual([]);
    expect(existsSync(seamFile)).toBe(false);
  });

  it("asks again after lock contention, which the CLI does not record", async () => {
    const { cli, root } = fixture({ review: { reason: "recipient-busy", status: "deferred" } });
    expect(await cli.review(SLOT)).toMatchObject({ reason: "recipient-busy", status: "deferred" });
    scriptCoordinator(root, { distSha256: SHA, review: { detail: "sent", status: "delivered" } });
    expect(await cli.review(SLOT)).toMatchObject({ detail: "sent", status: "delivered" });
    scriptCoordinator(root, { distSha256: SHA, review: { detail: "again", status: "delivered" } });
    expect(await cli.review(SLOT)).toMatchObject({ detail: "sent", status: "delivered" });
    expect(reviewRecords(root)).toEqual([`${SLOT}.json`]);
  });

  it("defers with cli-unavailable while the CLI file is missing", async () => {
    const { cli, root } = fixture();
    expect(await cli.review(SLOT)).toEqual({
      claimed: true,
      detail: `${join(root, COORDINATOR_CLI)} is missing`,
      reason: "cli-unavailable",
      status: "deferred",
    });
  });

  it("kills the whole process group on a timeout", async () => {
    const { cli, root } = fixture({ review: { hang: true } }, 2_000);
    const started = Date.now();
    const outcome = await cli.review(SLOT);
    expect(outcome).toEqual({ claimed: false, why: "timed out after 2000 ms" });
    expect(Date.now() - started).toBeLessThan(10_000);
    const pids = hung(root);
    expect(pids).toBeDefined();
    await until(() => gone(pids!.pid) && gone(pids!.grandchild));
  });

  it("kills the whole process group on an abort", async () => {
    const { cli, root } = fixture({ review: { hang: true } });
    const controller = new AbortController();
    const running = cli.review(SLOT, controller.signal);
    await until(() => hung(root) !== undefined);
    controller.abort();
    expect(await running).toEqual({ claimed: false, why: "aborted" });
    const pids = hung(root)!;
    await until(() => gone(pids.pid) && gone(pids.grandchild));
  });

  it("stop() kills running children and refuses new spawns", async () => {
    const { cli, root } = fixture({ review: { hang: true } });
    const running = cli.review(SLOT);
    await until(() => hung(root) !== undefined);
    cli.stop();
    expect(await running).toEqual({ claimed: false, why: "aborted" });
    expect(await cli.review(SLOT)).toEqual({ claimed: false, why: "aborted" });
    await cli.drain();
  });

  it("defers an out-of-range CLI and probes it before asking it again", async () => {
    const { cli, lines, root, seamFile } = fixture({
      review: { status: "delivered" },
      version: "2.0.0",
    });
    expect(await cli.review(SLOT)).toEqual({
      claimed: true,
      detail: "coordinator CLI 2.0.0 is outside >=1.2.0 <2.0.0",
      reason: "cli-version",
      status: "deferred",
    });
    expect(lines).toEqual([
      `bus: coordinator CLI 2.0.0 (dist sha256 ${SHA}) is outside >=1.2.0 <2.0.0; reviews and event delivery defer`,
    ]);
    expect(coordinatorCliReport(seamFile)).toEqual({
      distSha256: SHA,
      seenAt: SEEN,
      supported: false,
      version: "2.0.0",
    });
    // Still out of range: only the version probe runs.
    expect(await cli.review(SLOT + 1800)).toMatchObject({ reason: "cli-version" });
    expect(coordinatorCalls(root).map((call) => call.args.slice(0, 2))).toEqual([
      ["review", "deliver"],
      ["--version", "--json"],
    ]);
    // A supported install is probed, logged and then asked.
    scriptCoordinator(root, { distSha256: SHA, review: { status: "delivered" }, version: "1.2.1" });
    expect(await cli.review(SLOT + 3600)).toMatchObject({ status: "delivered" });
    expect(lines.at(-1)).toBe(
      `bus: coordinator CLI 1.2.1 (dist sha256 ${SHA}), inside >=1.2.0 <2.0.0`,
    );
    expect(coordinatorCalls(root).map((call) => call.args.slice(0, 2))).toEqual([
      ["review", "deliver"],
      ["--version", "--json"],
      ["--version", "--json"],
      ["review", "deliver"],
    ]);
  });

  it.each(["1.1.0", "1.2.0-rc.1", "0.9.0"])("treats CLI %s as out of range", async (version) => {
    const { cli } = fixture({ review: { status: "delivered" }, version });
    expect(await cli.review(SLOT)).toMatchObject({ reason: "cli-version", status: "deferred" });
  });

  it("logs an identity once per change and refreshes seenAt at most once a minute", async () => {
    const { advance, cli, lines, root, seamFile } = fixture({ review: { status: "delivered" } });
    await cli.review(SLOT);
    advance(30);
    await cli.review(SLOT + 60);
    expect(lines).toHaveLength(1);
    expect(coordinatorCliReport(seamFile).seenAt).toBe(SEEN);
    advance(30);
    await cli.review(SLOT + 120);
    expect(coordinatorCliReport(seamFile).seenAt).toBe("2026-11-04T03:21:00Z");
    const other = "d".repeat(64);
    scriptCoordinator(root, { distSha256: other, review: { status: "delivered" } });
    await cli.review(SLOT + 180);
    expect(lines).toEqual([
      `bus: coordinator CLI 1.2.0 (dist sha256 ${SHA}), inside >=1.2.0 <2.0.0`,
      `bus: coordinator CLI 1.2.0 (dist sha256 ${other}), inside >=1.2.0 <2.0.0`,
    ]);
    expect(coordinatorCliReport(seamFile)).toEqual({
      distSha256: other,
      seenAt: "2026-11-04T03:21:00Z",
      supported: true,
      version: "1.2.0",
    });
  });
});

describe("probe", () => {
  it("logs the identity early, a missing CLI and an unusable probe", async () => {
    const present = fixture({});
    await present.cli.probe();
    expect(present.lines).toEqual([
      `bus: coordinator CLI 1.2.0 (dist sha256 ${SHA}), inside >=1.2.0 <2.0.0`,
    ]);
    const missing = fixture();
    await missing.cli.probe();
    expect(missing.lines).toEqual([
      `bus: coordinator CLI: ${join(missing.root, COORDINATOR_CLI)} is missing; reviews and event delivery defer`,
    ]);
    const broken = fixture({ probe: { stdout: "1.2" } });
    await broken.cli.probe();
    expect(broken.lines).toEqual([
      "bus: coordinator CLI unavailable (version probe: the result is not a JSON object)",
    ]);
  });
});

describe("events flush", () => {
  it("runs one flush at a time and one more for requests made meanwhile", async () => {
    const { cli, lines, root } = fixture({ flush: { delayMs: 300 } });
    cli.flush();
    cli.flush();
    cli.flush();
    await cli.drain();
    expect(coordinatorCalls(root).map((call) => call.args)).toEqual([
      ["events", "flush", "--game", GAME],
      ["events", "flush", "--game", GAME],
    ]);
    expect(lines.filter((line) => line.includes("flush"))).toEqual([]);
  });

  it("logs a deferral, a hold and a failure once until the outcome changes", async () => {
    const { cli, lines, root } = fixture({
      flush: { detail: "no route", reason: "route-unavailable", status: "deferred" },
    });
    for (let pass = 0; pass < 2; pass += 1) {
      cli.flush();
      // eslint-disable-next-line no-await-in-loop
      await cli.drain();
    }
    scriptCoordinator(root, { distSha256: SHA, flush: { exit: 1, stderr: "boom" } });
    cli.flush();
    await cli.drain();
    scriptCoordinator(root, {
      distSha256: SHA,
      flush: { detail: "receipt ambiguous", override: { held: 2 }, status: "skipped" },
    });
    cli.flush();
    await cli.drain();
    scriptCoordinator(root, { distSha256: SHA, flush: { status: "skipped" } });
    cli.flush();
    await cli.drain();
    expect(lines.filter((line) => line.includes("flush"))).toEqual([
      "bus: event flush deferred: route-unavailable: no route",
      "bus: event flush failed: exit 1: boom; no delivery claimed",
      "bus: event flush held 2: receipt ambiguous",
    ]);
  });

  it("logs the CLI's outbox-unreadable deferral", async () => {
    const { cli, lines, root } = fixture({ flush: { markSent: true } });
    const events = join(root, "var", "games", GAME, "bus", "events");
    mkdirSync(events, { recursive: true });
    writeFileSync(join(events, "broken.json"), "{");
    cli.flush();
    await cli.drain();
    expect(lines.filter((line) => line.includes("flush"))).toEqual([
      "bus: event flush deferred: outbox-unreadable: an outbox event is unreadable",
    ]);
  });

  it("defers while the CLI is missing and claims nothing for a malformed result", async () => {
    const missing = fixture();
    missing.cli.flush();
    await missing.cli.drain();
    expect(missing.lines).toEqual([
      `bus: event flush deferred: cli-unavailable: ${join(missing.root, COORDINATOR_CLI)} is missing`,
    ]);
    const malformed = fixture({ flush: { override: { delivered: -1 } } });
    malformed.cli.flush();
    await malformed.cli.drain();
    expect(malformed.lines).toEqual([
      "bus: event flush failed: malformed result: delivered or held; no delivery claimed",
    ]);
  });
});

describe("parsing", () => {
  const cli = { distSha256: SHA, version: "1.2.0" };
  const flush = {
    cli,
    delivered: 2,
    detail: "2 delivered",
    game: GAME,
    held: 1,
    kind: "events-flush",
    reason: null,
    schema: 1,
    status: "delivered",
  };

  it("reads an events-flush result with its counts", () => {
    expect(parseResult({ game: GAME, kind: "events-flush" }, `${JSON.stringify(flush)}\n`)).toEqual(
      {
        claimed: true,
        cli,
        delivered: 2,
        detail: "2 delivered",
        held: 1,
        reason: null,
        status: "delivered",
      },
    );
  });

  it("reads a version identity and rejects an unusable one", () => {
    expect(parseVersion(`${JSON.stringify({ schema: 1, ...cli })}\n`)).toEqual(cli);
    expect(parseVersion(JSON.stringify({ schema: 1, version: "1.2.0" }))).toBe(
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

  it("reports nothing seen without a readable seam record", () => {
    const empty = { distSha256: null, seenAt: null, supported: null, version: null };
    const root = mkdtempSync(join(tmpdir(), "seam-"));
    roots.push(root);
    expect(coordinatorCliReport(join(root, "seam.json"))).toEqual(empty);
  });
});
