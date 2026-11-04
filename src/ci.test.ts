import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { makeGame, manualClock, recordingEvents, testContext } from "./bus/testGame.ts";
import { type CheckRun, latestRuns, unfinishedCi, watchCi } from "./ci.ts";
import { holdLock } from "./lock.ts";

const SHA = "c".repeat(40);

function run(id: number, name: string, status: string, conclusion: string | null): CheckRun {
  return { conclusion, id, name, status };
}

function setup() {
  const clock = manualClock(1_800_000_000);
  const events = recordingEvents();
  const context = testContext(makeGame(), { clock, events });
  return {
    clock,
    context,
    events,
    status: () => readFileSync(join(context.paths.ciDir, `${SHA}.status`), "utf8"),
  };
}

describe("watchCi", () => {
  it("succeeds once every required check completes, and records the summary", async () => {
    const { context, events, status } = setup();
    const polls = [
      [run(1, "Lint", "in_progress", null)],
      [run(1, "Lint", "completed", "success"), run(2, "Test", "completed", "skipped")],
    ];
    const result = await watchCi(context, SHA, {
      checks: () => Promise.resolve(polls.shift() ?? []),
    });
    expect(result).toBe("success");
    expect(status()).toBe("success\n");
    expect(readFileSync(join(context.paths.ciDir, `${SHA}.json`), "utf8")).toBe(
      [
        '[{"conclusion": "success", "name": "Lint", "status": "completed"},',
        '{"conclusion": "skipped", "name": "Test", "status": "completed"}]\n',
      ].join(" "),
    );
    expect(events.list.map(([kind]) => kind)).toEqual(["ci_pending", "ci_success"]);
  });

  it("stops on the first failed check and on timeout", async () => {
    const failed = setup();
    const failing = () => Promise.resolve([run(1, "Lint", "completed", "failure")]);
    expect(await watchCi(failed.context, SHA, { checks: failing })).toBe("failure");
    expect(failed.status()).toBe("failure\n");
    const slow = setup();
    const pending = () => Promise.resolve([run(1, "Lint", "completed", "success")]);
    expect(await watchCi(slow.context, SHA, { checks: pending })).toBe("timeout");
    expect(slow.events.list.at(-1)?.[0]).toBe("ci_timeout");
  });

  it("lets a later rerun supersede an older check of the same name", () => {
    expect(
      latestRuns([run(2, "Lint", "completed", "success"), run(1, "Lint", "completed", "failure")]),
    ).toEqual([{ conclusion: "success", name: "Lint", status: "completed" }]);
  });

  it("resumes a running watch with its original deadline", async () => {
    const { clock, context } = setup();
    mkdirSync(context.paths.ciDir, { recursive: true });
    const status = join(context.paths.ciDir, `${SHA}.status`);
    writeFileSync(status, "running\n");
    const started = clock.time - context.config.ci.timeoutSeconds + 120;
    utimesSync(status, started, started);
    expect(unfinishedCi(context)).toEqual([SHA]);
    let polls = 0;
    const result = await watchCi(context, SHA, {
      checks: () => {
        polls += 1;
        return Promise.resolve([]);
      },
    });
    expect(result).toBe("timeout");
    expect(polls).toBe(2);
  });

  it("returns busy while another watcher holds ci/<sha>.lock", async () => {
    const { context } = setup();
    mkdirSync(context.paths.ciDir, { recursive: true });
    const lock = holdLock(join(context.paths.ciDir, `${SHA}.lock`));
    expect(await watchCi(context, SHA, { checks: () => Promise.resolve([]) })).toBe("busy");
    lock.release();
  });
});
