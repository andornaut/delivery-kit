import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { makeGame, manualClock, recordingEvents, testContext } from "./bus/testGame.ts";
import {
  type CheckRun,
  GitHubAuthError,
  latestRuns,
  requiredDecision,
  resumeStoppedCi,
  unfinishedCi,
  watchCi,
} from "./ci.ts";
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
        '[{"conclusion": "success", "name": "Lint", "required": true, "status": "completed"},',
        '{"conclusion": "skipped", "name": "Test", "required": true, "status": "completed"}]\n',
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

  it("ignores runs whose names are not required, but still records them", async () => {
    const { context, status } = setup();
    const runs = [
      run(1, "Lint", "completed", "success"),
      run(2, "Test", "completed", "success"),
      run(3, "Workers Builds: archies-dog-walks", "completed", "failure"),
      run(4, "Preview", "in_progress", null),
    ];
    expect(await watchCi(context, SHA, { checks: () => Promise.resolve(runs) })).toBe("success");
    expect(status()).toBe("success\n");
    const recorded = readFileSync(join(context.paths.ciDir, `${SHA}.json`), "utf8");
    expect(recorded).toContain(
      '"name": "Workers Builds: archies-dog-walks", "required": false, "status": "completed"',
    );
    expect(recorded).toContain('"name": "Preview"');
  });

  it("decides from the latest run of each required name alone", () => {
    const required = new Set(["Lint", "Test"]);
    const decide = (rows: CheckRun[]) => requiredDecision(latestRuns(rows), required);
    const lint = run(1, "Lint", "completed", "success");
    expect(decide([lint])).toBeUndefined();
    expect(decide([lint, run(2, "Test", "in_progress", null)])).toBeUndefined();
    expect(decide([lint, run(2, "Test", "completed", "cancelled")])).toBe("failure");
    expect(decide([lint, run(2, "Test", "completed", "neutral")])).toBe("success");
    expect(
      decide([lint, run(2, "Test", "completed", "failure"), run(3, "Test", "queued", null)]),
    ).toBe(undefined);
    expect(decide([run(9, "Other", "completed", "failure")])).toBeUndefined();
  });

  it("names a required check that never ran and one still running when the watch times out", async () => {
    const { context, events } = setup();
    const runs = [run(1, "Lint", "in_progress", null), run(2, "Other", "completed", "success")];
    expect(await watchCi(context, SHA, { checks: () => Promise.resolve(runs) })).toBe("timeout");
    const message = events.list.at(-1)?.[2] ?? "";
    expect(message).toContain("required checks with no run: Test");
    expect(message).toContain("still incomplete: Lint (in_progress)");
    const log = readFileSync(join(context.paths.ciDir, `${SHA}.log`), "utf8");
    expect(log).toContain("required checks with no run: Test; still incomplete: Lint (in_progress)");
  });

  it("names the failed required runs and not the passing or unrequired ones", async () => {
    const { context, events } = setup();
    const runs = [
      run(1, "Lint", "completed", "timed_out"),
      run(2, "Test", "completed", "success"),
      run(3, "Other", "completed", "failure"),
    ];
    expect(await watchCi(context, SHA, { checks: () => Promise.resolve(runs) })).toBe("failure");
    const message = events.list.at(-1)?.[2] ?? "";
    expect(message).toContain("required runs failed: Lint (timed_out);");
    expect(message).not.toContain("Other");
  });

  it("states the recovery of a timed-out watch", async () => {
    const { context, events } = setup();
    expect(await watchCi(context, SHA, { checks: () => Promise.resolve([]) })).toBe("timeout");
    expect(events.list.at(-1)?.[2]).toContain("The next departure resumes the watch");
  });

  it("reports lost GitHub authentication as its own cause, not as a timeout", async () => {
    const { context, events, status } = setup();
    let polls = 0;
    const result = await watchCi(context, SHA, {
      checks: () => {
        polls += 1;
        return Promise.reject(new GitHubAuthError("the GitHub CLI is not authenticated"));
      },
    });
    expect(result).toBe("unauthenticated");
    expect(polls).toBe(1);
    expect(status()).toBe("unauthenticated\n");
    expect(events.list.at(-1)?.[0]).toBe("ci_auth_failed");
  });

  it("restarts a timed-out or unauthenticated watch and leaves the others", () => {
    const started: string[] = [];
    const context = testContext(makeGame(), { startCi: (sha) => started.push(sha) });
    mkdirSync(context.paths.ciDir, { recursive: true });
    const shas = ["a", "b", "c", "d"].map((letter) => letter.repeat(40));
    ["timeout", "unauthenticated", "failure", "running"].forEach((value, index) =>
      writeFileSync(join(context.paths.ciDir, `${shas[index] ?? ""}.status`), `${value}\n`),
    );
    resumeStoppedCi(context, [...shas, shas[0], undefined]);
    expect(started).toEqual([shas[0], shas[1]]);
  });

  it("lets a later rerun supersede an older check of the same name", () => {
    expect(
      latestRuns([run(2, "Lint", "completed", "success"), run(1, "Lint", "completed", "failure")]),
    ).toEqual([{ conclusion: "success", name: "Lint", status: "completed" }]);
  });

  it("treats only a missing ci/ directory as nothing to resume", () => {
    const { context } = setup();
    expect(unfinishedCi(context)).toEqual([]);
    writeFileSync(context.paths.ciDir, "");
    expect(() => unfinishedCi(context)).toThrow(/ENOTDIR/);
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
