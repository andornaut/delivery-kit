// Wall-clock review cadence, independent of release ticks. The seam is the fake coordination-kit CLI
// at the coordinator root: the runner spawns `review deliver` once per due slot and prints the
// line for its typed result. Route resolution, briefs and native delivery are coordination-kit's
// contract.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect } from "vitest";

import { cli, execute, impl, startRunnerAt } from "../lib/adapter.ts";
import { CASE_TIMEOUT_MS, contract, suite, workspaces } from "../lib/cases.ts";
import { iso, occurrences, reviewCalls, tick, virtualNow } from "../lib/review.ts";
import { at } from "../lib/time.ts";
import { COORDINATOR_CLI, type Workspace } from "../lib/workspace.ts";

const RECIPIENT = "00000000-0000-4000-8000-000000000002";
const RANGE = ">=2.0.0 <3.0.0";

/** A game with the observer at minutes 20 and 50 and departures at 00 and 10. */
function cadenceGame(
  ws: Workspace,
  review: Record<string, unknown> = { status: "delivered" },
): void {
  ws.writeRegistry({
    schema: 1,
    revision: 1,
    harness: "claude",
    roles: { "game-coordinator": { conversations: { claude: RECIPIENT } } },
  });
  ws.config.git = { main: "main", remote: "origin", github: "" };
  ws.config.schedule = { departures: ["00", "10"], timezone: "America/Toronto" };
  ws.config.deploy = { mode: "none", skipPattern: "" };
  ws.config.reports = { project: "Fixture", recipient: "game-coordinator", scheduledTicks: true };
  ws.scriptCoordinator({ review });
}

function pushes(ws: Workspace): number {
  return ws.calls("git").filter((call) => call.args.includes("push")).length;
}

suite("review cadence", () => {
  const workspace = workspaces();

  contract(
    "only current wall minutes dispatch, missed startup slots are skipped and releases report separately",
    async () => {
      const ws = workspace();
      cadenceGame(ws);
      // Started after :20 has begun: that slot is not replayed.
      const late = await tick(ws, at(20), { lead: -30, settle: 120 });
      expect(late.review).toEqual([]);
      expect(reviewCalls(ws)).toEqual([]);
      const slots: number[] = [];
      for (const slot of [at(20), at(50)]) {
        const result = await tick(ws, slot);
        slots.push(...result.review.map((row) => row.slot));
      }
      expect(slots).toEqual([at(20), at(50)]);
      expect(reviewCalls(ws)).toEqual([iso(at(20)), iso(at(50))]);
      // Release ticks at the departure minutes report through the event log.
      const runner = await startRunnerAt(ws, at(-1, 50));
      try {
        // Wait for both release reports, not a fixed span of virtual time: a slow host may
        // still be writing the second one when the clock passes the window.
        await runner.until(
          () =>
            virtualNow(ws) > at(11, 30) &&
            ws.events().filter((event) => event.type === "scheduled-status").length >= 2,
        );
      } finally {
        await runner.stop();
      }
      const reports = ws.events().filter((event) => event.type === "scheduled-status");
      expect(reports.map((event) => event.key)).toEqual([String(at(0)), String(at(10))]);
      expect(runner.output().stdout).toContain("bus: scheduled 00 10 (America/Toronto)");
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "the runner spawns the coordinator root's CLI with its own Node binary and reports its identity",
    async () => {
      const ws = workspace();
      cadenceGame(ws, { detail: "brief r-1 sent", status: "delivered" });
      const result = await tick(ws, at(20));
      expect(result.review).toEqual([{ slot: at(20), text: "brief r-1 sent" }]);
      const calls = ws.coordinatorCalls();
      expect(calls[0]!.args).toEqual(["--version", "--json"]);
      const review = calls.find((call) => call.args[0] === "review")!;
      expect(review).toEqual({
        args: ["review", "deliver", "--game", ws.game, "--slot", iso(at(20))],
        cwd: ws.coordinator,
        execPath: process.execPath,
        root: ws.coordinator,
      });
      expect(calls.some((call) => call.args.join(" ") === `events ingest --game ${ws.game}`)).toBe(
        true,
      );
      const distSha256 = createHash("sha256")
        .update(readFileSync(join(ws.coordinator, COORDINATOR_CLI)))
        .digest("hex");
      expect(result.stdout).toContain(
        `bus: coordinator CLI 2.0.0 (dist sha256 ${distSha256}), inside ${RANGE}`,
      );
      const status = await cli(ws, ["status"]);
      expect(status.code, status.stderr).toBe(0);
      const report = JSON.parse(status.stdout) as Record<string, Record<string, unknown>>;
      expect(report.coordinator_cli).toEqual({
        distSha256,
        seenAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
        supported: true,
        version: "2.0.0",
      });
      // runner.json keeps recording the bundled coordination-kit.
      expect(ws.readJson("runner.json").coordinationKitVersion).toBe(
        report.coordination_kit!.bundled,
      );
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "the bundled coordination-kit release answers the version probe and is outside the 2.x range",
    async () => {
      const ws = workspace();
      cadenceGame(ws);
      ws.installReleasedCoordinatorCli();
      const cliPath = join(ws.coordinator, COORDINATOR_CLI);
      const { version } = JSON.parse(
        readFileSync(join(dirname(dirname(cliPath)), "package.json"), "utf8"),
      ) as { version: string };
      const distSha256 = createHash("sha256").update(readFileSync(cliPath)).digest("hex");
      // The devDependency predates the 2.x seam: its identity is read and it is deferred.
      expect(version).toMatch(/^1\./);
      const result = await tick(ws, at(20));
      const output = result.stdout + result.stderr;
      expect(output).toContain(
        `bus: coordinator CLI ${version} (dist sha256 ${distSha256}) is outside ${RANGE}`,
      );
      // A probe killed at shutdown claims nothing; a parsed probe is never malformed.
      expect(output).not.toMatch(/unavailable \(|malformed result/);
      expect(output).toContain(
        `bus: review deferred: cli-version: coordinator CLI ${version} is outside`,
      );
      const status = JSON.parse((await cli(ws, ["status"])).stdout) as Record<
        string,
        Record<string, unknown>
      >;
      expect(status.coordinator_cli).toMatchObject({ distSha256, supported: false, version });
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "each typed outcome prints its runner line and a deferral also goes to stderr",
    async () => {
      const ws = workspace();
      cadenceGame(ws);
      const cases: Array<{ review: Record<string, unknown>; line?: (slot: number) => string }> = [
        {
          review: { detail: "brief r-2 sent", status: "delivered" },
          line: (slot) => `bus: scheduled review ${slot}: brief r-2 sent`,
        },
        {
          review: { detail: "turn active", reason: "recipient-busy", status: "deferred" },
          line: () => "bus: review deferred: recipient-busy: turn active",
        },
        {
          review: { detail: "a new reason", reason: "brand-new-token", status: "skipped" },
          line: () => "bus: review deferred: brand-new-token: a new reason",
        },
        {
          review: { detail: "receipt r-2", reason: "already-delivered", status: "skipped" },
          line: (slot) => `bus: scheduled review ${slot}: skipped already-delivered: receipt r-2`,
        },
        {
          review: { exit: 1 },
          line: (slot) =>
            `bus: scheduled review ${slot} unavailable (exit 1: coordination-kit: internal failure); no delivery claimed`,
        },
        {
          review: { stdout: "not json" },
          line: (slot) =>
            `bus: scheduled review ${slot} unavailable (the result is not JSON); no delivery claimed`,
        },
        { review: { reason: "nothing-due", status: "skipped" } },
      ];
      for (const [index, { line, review }] of cases.entries()) {
        const slot = at(20, 0, index);
        ws.scriptCoordinator({ review });
        const result = await tick(ws, slot, {
          done: ({ stdout }) => (line ? stdout.includes(line(slot)) : false),
        });
        const label = JSON.stringify(review);
        expect(reviewCalls(ws).at(-1), label).toBe(iso(slot));
        if (line === undefined) {
          expect(result.stdout, label).not.toMatch(/review (deferred|\d+)/);
          continue;
        }
        expect(occurrences(result.stdout, line(slot)), label).toBe(1);
        // The log replays on both streams; a deferral is also written to stderr itself.
        const deferred = line(slot).startsWith("bus: review deferred: ");
        expect(occurrences(result.stderr, line(slot)), label).toBe(deferred ? 2 : 1);
      }
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "a slow review spans the next wake minute, which is observed once and never replayed",
    async () => {
      const ws = workspace();
      cadenceGame(ws);
      ws.updateCoordinatorConfig({ wakeMinutes: [20, 21] });
      // At speed 20 a virtual minute is three real seconds; the :20 call takes about 80 virtual
      // seconds, so its pass ends inside minute :21.
      ws.scriptCoordinator({
        review: { status: "delivered" },
        reviews: { [iso(at(20))]: { delayMs: 4_000, status: "delivered" } },
      });
      const runner = await startRunnerAt(ws, at(19), 20);
      try {
        await runner.until(() => virtualNow(ws) > at(23, 30));
      } finally {
        await runner.stop();
      }
      expect(reviewCalls(ws)).toEqual([iso(at(20)), iso(at(21))]);
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "a missing coordinator CLI defers reviews and event delivery, and the runner still departs",
    async () => {
      const ws = workspace();
      cadenceGame(ws);
      ws.config.schedule = { departures: ["20"], timezone: "America/Toronto" };
      ws.updateCoordinatorConfig({ wakeMinutes: [20, 25] });
      impl.offer(ws, ["bus/feature"]);
      ws.removeCoordinatorCli();
      const missing = join(ws.coordinator, COORDINATOR_CLI);
      const deferral = `bus: review deferred: cli-unavailable: ${missing} is missing`;
      const runner = await startRunnerAt(ws, at(19));
      try {
        await runner.until(() => runner.output().stderr.includes(deferral));
        // npm ci at the root has finished: the next slot reaches the CLI again.
        ws.installCoordinatorCli();
        await runner.until(
          () =>
            pushes(ws) === 1 &&
            runner.output().stdout.includes(`bus: scheduled review ${at(25)}: `),
        );
      } finally {
        await runner.stop();
      }
      const { stdout } = runner.output();
      expect(stdout).toContain(
        `bus: coordinator CLI: ${missing} is missing; reviews and event delivery defer`,
      );
      expect(stdout).toContain(
        `bus: event ingest deferred: cli-unavailable: ${missing} is missing`,
      );
      expect(reviewCalls(ws)).toEqual([iso(at(25))]);
      expect(pushes(ws)).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "an out-of-range coordinator CLI defers with cli-version, and the runner still departs",
    async () => {
      const ws = workspace();
      cadenceGame(ws);
      ws.config.schedule = { departures: ["20"], timezone: "America/Toronto" };
      ws.scriptCoordinator({ review: { status: "delivered" }, version: "3.0.0" });
      impl.offer(ws, ["bus/feature"]);
      const deferral = `bus: review deferred: cli-version: coordinator CLI 3.0.0 is outside ${RANGE}`;
      const result = await tick(ws, at(20), {
        done: ({ stderr }) => pushes(ws) === 1 && stderr.includes(deferral),
        // A departure under load can outlast the default settle; end on the condition.
        settle: 1_200,
      });
      expect(result.stdout).toContain(`is outside ${RANGE}; reviews and event delivery defer`);
      expect(result.stdout).toContain("bus: event ingest deferred: cli-version: ");
      // The startup probe found it out of range, so it is asked only for its version.
      expect(reviewCalls(ws)).toEqual([]);
      expect(ws.coordinatorCalls().every((call) => call.args[0] === "--version")).toBe(true);
      expect(pushes(ws)).toBe(1);
      const status = JSON.parse((await cli(ws, ["status"])).stdout) as Record<
        string,
        Record<string, unknown>
      >;
      expect(status.coordinator_cli).toMatchObject({ supported: false, version: "3.0.0" });
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "review minutes are validated at the observer without blocking or coupling to releases",
    async () => {
      const ws = workspace();
      cadenceGame(ws);
      // An empty list is valid and schedules no wake; other invalid values are rejected when the
      // configuration loads, naming /wakeMinutes.
      ws.updateCoordinatorConfig({ wakeMinutes: [] });
      const none = await tick(ws, at(20));
      expect(none.review).toEqual([]);
      expect(reviewCalls(ws)).toEqual([]);
      for (const value of [[60], ["20+1"]]) {
        ws.updateCoordinatorConfig({ wakeMinutes: value });
        ws.setClock(at(19, 30), 60);
        const result = await execute(impl.run(ws), { timeoutMs: 15_000 });
        expect(result.code, JSON.stringify(value)).not.toBe(0);
        expect(result.code, JSON.stringify(value)).not.toBeNull();
        const log = ws.exists("runner.log") ? ws.read("runner.log") : "";
        expect(result.stdout + result.stderr + log, JSON.stringify(value)).toContain(
          "/wakeMinutes",
        );
        expect(reviewCalls(ws)).toEqual([]);
      }
      ws.updateCoordinatorConfig({ wakeMinutes: [10] });
      const ten = await tick(ws, at(10));
      expect(ten.review.map((row) => row.slot)).toEqual([at(10)]);
      expect(reviewCalls(ws)).toEqual([iso(at(10))]);
    },
    CASE_TIMEOUT_MS,
  );

  contract(
    "daylight-saving fold slots keep distinct epoch identities at the same wall minute",
    async () => {
      const ws = workspace();
      cadenceGame(ws);
      const first = Date.UTC(2026, 10, 1, 5, 20) / 1000; // 01:20 EDT
      const second = Date.UTC(2026, 10, 1, 6, 20) / 1000; // 01:20 EST
      const slots: number[] = [];
      for (const slot of [first, second])
        slots.push(...(await tick(ws, slot)).review.map((row) => row.slot));
      expect(slots).toEqual([first, second]);
      expect(reviewCalls(ws)).toEqual(["2026-11-01T01:20:00-04:00", "2026-11-01T01:20:00-05:00"]);
    },
    CASE_TIMEOUT_MS,
  );
});
