// Combine queued branches in a private scratch worktree, then gate and push once.
import { join } from "node:path";

import { readPending } from "../deploy.ts";
import { holdLockAsync } from "../lock.ts";
import type { BusContext } from "./context.ts";
import { git, gitOk } from "./exec.ts";
import { mergeBatch } from "./merge.ts";
import { ciNotRed, repairApproved } from "./repair.ts";
import { pinnedTip, type RequestRecord } from "./requests.ts";
import { readText, readTrimmed } from "./state.ts";

export interface BatchInput {
  readonly branches: readonly string[];
  readonly attempt: string;
  /** The validated request whose pinned tips are integrated, for a one-off request. */
  readonly request?: RequestRecord;
}

async function integrate(
  context: BusContext,
  input: BatchInput,
  work: string,
  name: string,
): Promise<string[]> {
  const picked: string[] = [];
  for (const branch of input.branches) {
    const subject = input.request === undefined ? branch : pinnedTip(input.request, branch);
    // Branches are integrated in queue order.
    // eslint-disable-next-line no-await-in-loop
    const resolution = await context.exec({
      args: ["-C", context.game.repo, "merge-base", subject, context.base],
      command: "git",
    });
    if (resolution.status !== 0) {
      const failure =
        `${resolution.stdout}${resolution.stderr}`.trim() ||
        "Git returned no diagnostic (no common ancestor)";
      const status = String(resolution.status);
      context.log(
        `SKIPPED ${branch} (merge-base against ${context.base} failed, exit ${status}: ${failure})`,
      );
      context.events.emit(
        `resolution-${branch}`,
        input.attempt || name,
        [
          `History resolution failed for ${branch}: merge-base against ${context.base},`,
          `exit ${status}: ${failure}; branch skipped; no push yet;`,
          "inspect history and requeue skipped branch.",
        ].join(" "),
      );
      continue;
    }
    const base = resolution.stdout.trim();
    // eslint-disable-next-line no-await-in-loop
    if (await gitOk(context.exec, work, ["cherry-pick", `${base}..${subject}`])) {
      picked.push(branch);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const conflicted = await context.exec({
      args: ["-C", work, "diff", "--name-only", "--diff-filter=U"],
      command: "git",
    });
    // eslint-disable-next-line no-await-in-loop
    await gitOk(context.exec, work, ["cherry-pick", "--abort"]);
    const files = conflicted.stdout
      .split("\n")
      .filter((file) => file !== "")
      .map((file) => `${file} `)
      .join("");
    context.log(`SKIPPED ${branch} (conflict: ${files})`);
    context.events.emit(
      `conflict-${branch}`,
      input.attempt || name,
      `Integration conflict in ${branch}; branch skipped; no push yet; fix and requeue skipped branch.`,
    );
  }
  return picked;
}

async function landed(
  context: BusContext,
  input: BatchInput,
  picked: readonly string[],
): Promise<void> {
  for (const branch of picked) {
    context.log(`landed ${branch}`);
    if (!branch.startsWith("bus/")) {
      continue;
    }
    if (input.request !== undefined) {
      const tip = pinnedTip(input.request, branch);
      // eslint-disable-next-line no-await-in-loop
      const current = await context.exec({
        args: ["-C", context.game.repo, "rev-parse", `refs/heads/${branch}`],
        command: "git",
      });
      // Retain a branch advanced after queue capture, even after its pinned work lands.
      if (current.status !== 0 || current.stdout.trim() !== tip) {
        continue;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await gitOk(context.exec, context.game.repo, ["branch", "-D", branch]);
  }
}

/** True when the batch was gated and pushed. */
export async function runBatch(context: BusContext, input: BatchInput): Promise<boolean> {
  const mergeLock = await holdLockAsync(context.paths.mergeLock);
  try {
    // Serialize approval validation, gate and consumption for all scratch batches.
    const approvalLock = await holdLockAsync(context.paths.approvalLock);
    try {
      return await batch(context, input);
    } finally {
      approvalLock.release();
    }
  } finally {
    mergeLock.release();
  }
}

async function batch(context: BusContext, input: BatchInput): Promise<boolean> {
  const { game, paths } = context;
  if (!(await gitOk(context.exec, game.repo, ["fetch", "-q", context.config.git.remote]))) {
    return false;
  }
  if (!(await ciNotRed(context, input.branches))) {
    return false;
  }
  const last = readTrimmed(paths.lastPushSha);
  const repair =
    last !== undefined && last !== "" && (await repairApproved(context, last, input.branches))
      ? readText(paths.approval)
      : undefined;
  const name = `batch-${context.clock.now()}`;
  const work = join(paths.dir, name);
  await git(context.exec, game.repo, ["worktree", "add", "-q", "-b", name, work, context.base]);
  const picked = await integrate(context, input, work, name);
  context.log(`picked: ${picked.join(" ") || "none"}`);
  if (picked.length === 0) {
    await gitOk(context.exec, game.repo, ["worktree", "remove", "--force", work]);
    await gitOk(context.exec, game.repo, ["branch", "-D", name]);
    return false;
  }
  // A batch is always gated at departure. No branch-side full gate is required.
  const pushed = await mergeBatch(context, {
    attempt: input.attempt || name,
    branch: name,
    branches: input.branches,
    candidates: picked,
    ...(repair === undefined ? {} : { repair }),
    work,
  });
  const keep = readPending(context)?.work === work;
  if (!keep) {
    await gitOk(context.exec, game.repo, ["worktree", "remove", "--force", work]);
  }
  if (pushed) {
    if (!keep) {
      await gitOk(context.exec, game.repo, ["branch", "-D", name]);
    }
    await landed(context, input, picked);
    if (keep) {
      context.log(`kept deployment worktree ${work}`);
    }
  } else {
    context.log(`kept branch ${name}; inspect and requeue after fixing the failure`);
  }
  return pushed;
}
