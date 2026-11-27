import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { coordinatorCliReport } from "../state/seam.ts";
import { coordinatorCalls, installCoordinator, scriptCoordinator } from "../testing/coordinator.ts";
import { COORDINATOR_CLI, CoordinatorCli } from "./coordinator.ts";

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

function fixture(control?: Record<string, unknown>, timeoutMs?: number, appMode = false) {
  const root = mkdtempSync(join(tmpdir(), "seam-"));
  roots.push(root);
  if (control !== undefined) {
    installCoordinator(root, { distSha256: SHA, ...control });
  }
  const lines: string[] = [];
  const seamFile = join(root, "seam.json");
  let now = SLOT;
  const cli = new CoordinatorCli({
    appMode,
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
      cli: { distSha256: SHA, version: "3.0.0" },
      detail: "brief r-1 sent to game-coordinator",
      reason: null,
      status: "delivered",
    });
    expect(coordinatorCalls(root)).toEqual([
      { args: ["--version", "--json"], cwd: root, execPath: process.execPath, root },
      {
        args: ["review", "deliver", "--game", GAME, "--slot", ISO],
        cwd: root,
        execPath: process.execPath,
        root,
      },
    ]);
    expect(lines).toEqual([
      `bus: coordinator CLI 3.0.0 (dist sha256 ${SHA}), inside >=3.0.0 <10.0.0`,
    ]);
    expect(JSON.parse(readFileSync(seamFile, "utf8"))).toEqual({
      distSha256: SHA,
      schema: 1,
      seenAt: SEEN,
      version: "3.0.0",
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
    [{ override: { kind: "events-ingest" } }, "malformed result: kind is not review-deliver"],
    [{ override: { game: "other-game" } }, "malformed result: game differs"],
    // The same instant in another form is not the slot that was sent.
    [{ override: { slot: "2026-11-04T03:20:00Z" } }, "malformed result: slot differs"],
    [{ override: { status: "blocked" } }, "malformed result: status"],
    [{ override: { reason: "Not A Token" } }, "malformed result: reason"],
    [{ override: { reason: null, status: "deferred" } }, "malformed result: reason is null"],
    [{ override: { detail: 1 } }, "malformed result: detail"],
    [{ override: { cli: { version: "3.0.0" } } }, "malformed result: cli"],
  ])("claims no delivery for %j", async (review, why) => {
    const { cli, lines, seamFile } = fixture({ review });
    const outcome = await cli.review(SLOT);
    expect(outcome.claimed).toBe(false);
    expect(outcome.claimed ? "" : outcome.why).toContain(why);
    expect(lines).toEqual([
      `bus: coordinator CLI 3.0.0 (dist sha256 ${SHA}), inside >=3.0.0 <10.0.0`,
    ]);
    expect(coordinatorCliReport(seamFile).distSha256).toBe(SHA);
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
      version: "2.0.1",
    });
    expect(await cli.review(SLOT)).toEqual({
      claimed: true,
      detail: "coordinator CLI 2.0.1 is outside >=3.0.0 <10.0.0",
      reason: "cli-version",
      status: "deferred",
    });
    expect(lines).toEqual([
      `bus: coordinator CLI 2.0.1 (dist sha256 ${SHA}) is outside >=3.0.0 <10.0.0; reviews and event delivery defer`,
    ]);
    expect(coordinatorCliReport(seamFile)).toEqual({
      distSha256: SHA,
      seenAt: SEEN,
      supported: false,
      version: "2.0.1",
    });
    // Still out of range: only the version probe runs.
    expect(await cli.review(SLOT + 1800)).toMatchObject({ reason: "cli-version" });
    expect(coordinatorCalls(root).map((call) => call.args.slice(0, 2))).toEqual([
      ["--version", "--json"],
      ["--version", "--json"],
    ]);
    // A supported install is probed, logged and then asked.
    scriptCoordinator(root, { distSha256: SHA, review: { status: "delivered" }, version: "3.0.0" });
    expect(await cli.review(SLOT + 3600)).toMatchObject({ status: "delivered" });
    expect(lines.at(-1)).toBe(
      `bus: coordinator CLI 3.0.0 (dist sha256 ${SHA}), inside >=3.0.0 <10.0.0`,
    );
    expect(coordinatorCalls(root).map((call) => call.args.slice(0, 2))).toEqual([
      ["--version", "--json"],
      ["--version", "--json"],
      ["--version", "--json"],
      ["review", "deliver"],
    ]);
  });

  it.each(["1.2.0", "2.0.0", "3.0.0-rc.1", "2.0.1"])(
    "treats CLI %s as out of range",
    async (version) => {
      const { cli } = fixture({ review: { status: "delivered" }, version });
      expect(await cli.review(SLOT)).toMatchObject({ reason: "cli-version", status: "deferred" });
    },
  );

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
      `bus: coordinator CLI 3.0.0 (dist sha256 ${SHA}), inside >=3.0.0 <10.0.0`,
      `bus: coordinator CLI 3.0.0 (dist sha256 ${other}), inside >=3.0.0 <10.0.0`,
    ]);
    expect(coordinatorCliReport(seamFile)).toEqual({
      distSha256: other,
      seenAt: "2026-11-04T03:21:00Z",
      supported: true,
      version: "3.0.0",
    });
  });

  it("re-negotiates the selector on replacement in a legacy workspace", async () => {
    const { cli, root } = fixture({ review: { status: "delivered" }, version: "3.0.0" });
    expect(await cli.review(SLOT)).toMatchObject({ claimed: true, status: "delivered" });
    installCoordinator(root, {
      distSha256: SHA,
      review: { status: "delivered" },
      version: "8.0.0",
    });
    expect(await cli.review(SLOT + 60)).toMatchObject({
      cli: { version: "8.0.0" },
      status: "delivered",
    });
    cli.ingest();
    await cli.drain();
    expect(coordinatorCalls(root).map((call) => call.args.slice(0, 4))).toEqual([
      ["--version", "--json"],
      ["review", "deliver", "--game", GAME],
      ["--version", "--json"],
      ["review", "deliver", "--app", GAME],
      ["events", "ingest", "--app", GAME],
    ]);
  });
});

describe("app-mode calls", () => {
  it.each(["7.7.9", "10.0.0"])("only probes an installed CLI at %s", async (version) => {
    const { cli, lines, root } = fixture({ version }, undefined, true);
    expect(await cli.review(SLOT)).toMatchObject({
      detail: `coordinator CLI ${version} is outside >=7.8.0 <10.0.0`,
      reason: "cli-version",
      status: "deferred",
    });
    cli.ingest();
    await cli.drain();
    expect(coordinatorCalls(root).map((call) => call.args)).toEqual([
      ["--version", "--json"],
      ["--version", "--json"],
    ]);
    expect(lines.at(-1)).toContain("event ingest deferred: cli-version");
  });

  it("does not submit a review after an unusable version probe", async () => {
    const { cli, root } = fixture({ probe: { stdout: "broken" } }, undefined, true);
    expect(await cli.probe()).toBeUndefined();
    expect(await cli.review(SLOT)).toEqual({
      claimed: false,
      why: "version probe: the result is not JSON",
    });
    expect(coordinatorCalls(root).map((call) => call.args)).toEqual([
      ["--version", "--json"],
      ["--version", "--json"],
    ]);
  });

  it.each(["7.8.0", "8.0.0"])(
    "uses the app flag with CLI %s until a downgrade",
    async (version) => {
      const { cli, lines, root } = fixture({}, undefined, true);
      const calls = join(root, "app-calls.jsonl");
      writeFileSync(
        join(root, COORDINATOR_CLI),
        `import { appendFileSync } from "node:fs";
const args = process.argv.slice(4);
const cli = { version: "${version}", distSha256: "${SHA}" };
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") {
  console.log(JSON.stringify({ schema: 1, ...cli }));
} else {
  const [command, action, flag, appId, , slot] = args;
  if (flag !== "--app") process.exit(2);
  console.log(JSON.stringify({
    schema: 1, kind: command + "-" + action, appId, slot, cli,
    detail: "", reason: null, status: "delivered",
  }));
}
`,
      );
      expect(await cli.review(SLOT)).toMatchObject({
        cli: { version },
        status: "delivered",
      });
      cli.ingest();
      await cli.drain();
      expect(lines.filter((line) => line.includes("event ingest"))).toEqual([]);
      expect(
        readFileSync(calls, "utf8")
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        ["--version", "--json"],
        ["review", "deliver", "--app", GAME, "--slot", ISO],
        ["--version", "--json"],
        ["events", "ingest", "--app", GAME],
      ]);

      installCoordinator(root, { version: "7.7.9" });
      expect(await cli.review(SLOT)).toMatchObject({ reason: "cli-version" });
      expect(coordinatorCalls(root).map((call) => call.args)).toEqual([["--version", "--json"]]);
    },
  );

  it("does not retry a failed app command with the game flag", async () => {
    const { cli, root } = fixture({ version: "7.8.0" }, undefined, true);
    expect(await cli.review(SLOT)).toMatchObject({
      claimed: false,
      why: expect.stringContaining("exit 2"),
    });
    expect(coordinatorCalls(root).map((call) => call.args)).toEqual([
      ["--version", "--json"],
      ["review", "deliver", "--app", GAME, "--slot", ISO],
    ]);
  });
});

describe("probe", () => {
  it("logs the identity early, a missing CLI and an unusable probe", async () => {
    const present = fixture({});
    expect(await present.cli.probe()).toEqual({ distSha256: SHA, version: "3.0.0" });
    expect(present.lines).toEqual([
      `bus: coordinator CLI 3.0.0 (dist sha256 ${SHA}), inside >=3.0.0 <10.0.0`,
    ]);
    const missing = fixture();
    expect(await missing.cli.probe()).toBeUndefined();
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

describe("events ingest", () => {
  it("runs one ingest at a time and one more for requests made meanwhile", async () => {
    const { cli, lines, root } = fixture({ ingest: { delayMs: 300 } });
    cli.ingest();
    cli.ingest();
    cli.ingest();
    await cli.drain();
    expect(coordinatorCalls(root).map((call) => call.args)).toEqual([
      ["--version", "--json"],
      ["events", "ingest", "--game", GAME],
      ["events", "ingest", "--game", GAME],
    ]);
    expect(lines.filter((line) => line.includes("ingest"))).toEqual([]);
  });

  it("logs a deferral and a failure once until the outcome changes", async () => {
    const { cli, lines, root } = fixture({
      ingest: { detail: "store busy", reason: "cli-error", status: "deferred" },
    });
    for (let pass = 0; pass < 2; pass += 1) {
      cli.ingest();
      // eslint-disable-next-line no-await-in-loop
      await cli.drain();
    }
    scriptCoordinator(root, { distSha256: SHA, ingest: { exit: 1, stderr: "boom" } });
    cli.ingest();
    await cli.drain();
    scriptCoordinator(root, { distSha256: SHA, ingest: { status: "skipped" } });
    cli.ingest();
    await cli.drain();
    scriptCoordinator(root, { distSha256: SHA, ingest: { exit: 1, stderr: "boom" } });
    cli.ingest();
    await cli.drain();
    expect(lines.filter((line) => line.includes("ingest"))).toEqual([
      "bus: event ingest deferred: cli-error: store busy",
      "bus: event ingest failed: exit 1: boom; no delivery claimed",
      "bus: event ingest failed: exit 1: boom; no delivery claimed",
    ]);
  });

  it("treats an in-flight result as a deferral and logs it once", async () => {
    const { cli, lines } = fixture({
      ingest: { detail: "spooled", reason: "in-flight", status: "skipped" },
    });
    for (let pass = 0; pass < 3; pass += 1) {
      cli.ingest();
      // eslint-disable-next-line no-await-in-loop
      await cli.drain();
    }
    expect(lines.filter((line) => line.includes("ingest"))).toEqual([
      "bus: event ingest deferred: in-flight: spooled",
    ]);
  });

  it("defers while the CLI is missing and claims nothing for a malformed result", async () => {
    const missing = fixture();
    missing.cli.ingest();
    await missing.cli.drain();
    expect(missing.lines).toEqual([
      `bus: event ingest deferred: cli-unavailable: ${join(missing.root, COORDINATOR_CLI)} is missing`,
    ]);
    const malformed = fixture({ ingest: { override: { kind: "events-flush" } } });
    malformed.cli.ingest();
    await malformed.cli.drain();
    expect(malformed.lines.at(-1)).toBe(
      "bus: event ingest failed: malformed result: kind is not events-ingest; no delivery claimed",
    );
  });
});
