// Gate one scratch batch, push it, then deploy the same build (merge.sh).
import { mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

import { deployNeeded, stageDeploy } from "../deploy.ts";
import { fsyncDirectory } from "../durable.ts";
import { runGate, treeFingerprint } from "../gate.ts";
import { type BusContext, loadOk } from "./context.ts";
import { git, gitOk } from "./exec.ts";
import { ciGreenOrUnknown, ciNotRed, repairApproved, repairTreeMatches } from "./repair.ts";
import { readText, readTrimmed, writeLines } from "./state.ts";
import { stamp } from "./time.ts";

export interface MergeInput {
  /** The scratch worktree and its batch branch. */
  readonly work: string;
  readonly branch: string;
  /** Queued branches, passed for repair validation only. */
  readonly branches: readonly string[];
  /** The approval text when this batch is a one-shot repair. */
  readonly repair?: string;
  /** Picked branch names for the push report. */
  readonly candidates: readonly string[];
  /** Attempt identity for event keys. */
  readonly attempt: string;
}

class Blocked extends Error {}

/** merge.sh. Returns true once the exact gated SHA is pushed; deployment is tracked separately. */
export async function mergeBatch(context: BusContext, input: MergeInput): Promise<boolean> {
  let stage = "preparation";
  try {
    return await merge(context, input, (next) => {
      stage = next;
    });
  } catch (error) {
    if (!(error instanceof Blocked)) {
      context.log(`bus: ${error instanceof Error ? error.message : String(error)}`);
    }
    context.events.emit(
      `blocked-${stage}`,
      input.attempt,
      [
        `Batch blocked at ${stage}; command failed; inspect local bus log and retained batch,`,
        "then fix/requeue. Push/deployment state is recorded by separate events.",
      ].join(" "),
    );
    return false;
  }
}

function fail(context: BusContext, message: string): never {
  context.log(message);
  throw new Blocked(message);
}

async function repairCheck(context: BusContext, input: MergeInput): Promise<boolean> {
  if (input.repair === undefined) {
    return true;
  }
  if (readText(context.paths.approval) !== input.repair) {
    return false;
  }
  const last = readTrimmed(context.paths.lastPushSha);
  if (last === undefined || last === "") {
    return false;
  }
  return (
    (await repairApproved(context, last, input.branches)) && repairTreeMatches(context, input.work)
  );
}

async function guard(context: BusContext, input: MergeInput, changed: string): Promise<void> {
  if (!(await ciNotRed(context, input.branches))) {
    throw new Blocked("red CI");
  }
  if (input.repair === undefined && !(await ciGreenOrUnknown(context))) {
    fail(context, "repair must be validated by the batch entry point");
  }
  if (!(await repairCheck(context, input))) {
    fail(context, changed);
  }
}

async function merge(
  context: BusContext,
  input: MergeInput,
  at: (stage: string) => void,
): Promise<boolean> {
  const { config, game, paths } = context;
  const { work } = input;
  const fetch = (): Promise<string> =>
    git(context.exec, game.repo, ["fetch", "-q", config.git.remote]);
  at("fetch");
  await fetch();
  at("rebase");
  if (!(await gitOk(context.exec, work, ["rebase", "-q", context.base]))) {
    context.log("REBASE CONFLICT");
    const status = await context.exec({
      args: ["-C", work, "status", "--porcelain"],
      command: "git",
    });
    for (const line of status.stdout.split("\n").filter((row) => /^(UU|AA|DU|UD)/.test(row))) {
      context.log(line);
    }
    throw new Blocked("rebase conflict");
  }
  const base = await git(context.exec, work, ["merge-base", "HEAD", context.base]);
  const sha = await git(context.exec, work, ["rev-parse", "HEAD"]);
  const needed = await deployNeeded(context, base, sha);
  if (!loadOk(context)) {
    fail(
      context,
      `host load is at or above ${config.resources.loadLimit}; batch retained for a later departure`,
    );
  }
  await guard(context, input, "repair approval does not match the batch");
  const before = await treeFingerprint(context, work);
  const gateDir = join(paths.gateLogsDir, basename(input.branch));
  mkdirSync(gateDir, { recursive: true });
  const logs = mkdtempSync(join(gateDir, "attempt."));
  writeLines(join(logs, "commit.sha"), sha);
  context.log(`gate logs: ${logs}`);
  at("full-gate");
  const outcome = await runGate(
    context,
    { batch: basename(input.branch), logs, sha, work },
    async () =>
      (await treeFingerprint(context, work)) === before
        ? undefined
        : "gate discarded: Git status or reported-file fingerprints changed during checks",
  );
  if (!outcome.ok) {
    at(outcome.stage);
    fail(context, outcome.reason);
  }
  for (const line of outcome.output.split("\n").filter((row) => row !== "")) {
    context.log(line);
  }
  writeLines(join(work, ".bus-built.sha"), sha);
  at("prepush-validation");
  await fetch();
  if ((await git(context.exec, game.repo, ["rev-parse", context.base])) !== base) {
    fail(context, "main changed during the gate; retained batch for a later scheduled departure");
  }
  await guard(context, input, "repair approval changed during the gate");
  if ((await git(context.exec, work, ["rev-parse", "HEAD"])) !== sha) {
    fail(context, "scratch HEAD changed during the gate");
  }
  at("push");
  await git(context.exec, work, ["push", "-q", config.git.remote, `HEAD:${config.git.main}`]);
  if (input.repair !== undefined) {
    renameSync(paths.approval, paths.approvalConsumed);
    fsyncDirectory(paths.dir);
  }
  const now = context.clock.now();
  writeLines(paths.lastPush, String(now));
  writeLines(paths.lastPushSha, sha);
  context.events.emit(
    "push",
    sha,
    `${stamp(config.schedule.timezone, now)} departed exact pushed SHA ${sha}: ${
      input.candidates.join(" ") || "scheduled batch"
    }; full gate passed; CI pending; deployment pending.`,
  );
  context.startCi(sha);
  context.log(await git(context.exec, work, ["log", "--oneline", "-1"]));
  context.log("merged");
  // A failed deployment still leaves a successfully pushed commit. Its pending pointer keeps
  // the build worktree until a later scheduled retry succeeds.
  try {
    await stageDeploy(context, { branch: input.branch, sha, work }, needed);
  } catch (error) {
    context.log(
      `bus: deployment staging failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return true;
}
