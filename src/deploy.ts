// Deployment of already-gated assets. A failed deployment keeps its pending
// pointer and worktree, and is retried only at a later departure.
import { existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import type { BusContext } from "./bus/context.ts";
import { git, gitOk, WRANGLER_ENTRY } from "./bus/exec.ts";
import { ensureDir, readText, readTrimmed, writeLines } from "./bus/state.ts";
import { fsyncDirectory } from "./durable.ts";

const SHA = /^[0-9a-f]{40}$/;

export interface PendingDeploy {
  readonly sha: string;
  readonly work: string;
  readonly branch: string;
}

export function readPending(context: BusContext): PendingDeploy | undefined {
  const text = readText(context.paths.deployPending);
  if (text === undefined || text === "") {
    return undefined;
  }
  const [sha = "", work = "", branch = ""] = text.split("\n");
  return { branch, sha, work };
}

/** The batch diff from `from` to `to` changes a file outside the configured skip pattern. */
export async function deployNeeded(
  context: BusContext,
  from: string,
  to: string,
): Promise<boolean> {
  const pattern = context.config.deploy.skipPattern;
  if (pattern === undefined || pattern === "") {
    return true;
  }
  const names = await git(context.exec, context.game.repo, ["diff", "--name-only", from, to]);
  const skip = new RegExp(pattern);
  return names.split("\n").some((name) => name !== "" && !skip.test(name));
}

function failureEvent(context: BusContext, sha: string): void {
  if (SHA.test(sha)) {
    context.events.emit(
      "deploy_failure",
      sha,
      [
        `Deployment blocked/failed for pushed ${sha}; retained pending assets; inspect configuration,`,
        "base and artifacts before next scheduled retry. CI tracked separately.",
      ].join(" "),
    );
  }
}

async function finishPending(context: BusContext, pending: PendingDeploy): Promise<boolean> {
  const { paths } = context;
  const { sha, work } = pending;
  if (context.config.deploy.mode !== "wrangler") {
    context.log(`deployment pending for ${sha}; deploy.mode must be wrangler before retrying`);
    return false;
  }
  if (!(await gitOk(context.exec, context.game.repo, ["fetch", "-q", context.config.git.remote]))) {
    return false;
  }
  const current = await git(context.exec, context.game.repo, ["rev-parse", context.base]);
  if (current !== sha) {
    context.log(
      `deployment pending ${sha} differs from ${context.base} (${current}); queue retained for operator review`,
    );
    return false;
  }
  let assets: boolean;
  try {
    assets =
      readTrimmed(join(work, ".bus-built.sha")) === sha &&
      statSync(join(work, "dist")).isDirectory();
  } catch {
    assets = false;
  }
  if (!assets) {
    context.log(`deployment assets missing or built for another commit: ${sha}`);
    return false;
  }
  ensureDir(paths.deployDir);
  const log = join(paths.deployDir, `${sha}.log`);
  context.events.emit(
    "deploy_retry",
    sha,
    `Deployment pending/retrying exact pushed ${sha} using retained gated assets; CI tracked separately.`,
  );
  context.log(`deploying gated assets for ${sha}; log ${log}`);
  const result = await context.exec({
    args: [
      WRANGLER_ENTRY,
      "deploy",
      "--config",
      "wrangler.jsonc",
      "--no-bundle",
      "--tag",
      sha.slice(0, 8),
      "--message",
      `Scheduled bus ${sha}`,
    ],
    command: process.execPath,
    cwd: work,
    logFile: log,
  });
  if (result.status === 0) {
    writeLines(paths.lastDeploySha, sha);
    writeLines(paths.lastDeploy, String(context.clock.now()));
    renameSync(paths.deployPending, join(paths.deployDir, `${sha}.completed`));
    fsyncDirectory(paths.dir);
    fsyncDirectory(paths.deployDir);
    context.events.emit(
      "deploy_success",
      sha,
      `Deployment success for exact pushed ${sha}; CI completion tracked separately.`,
    );
    context.log(`deployed ${sha}`);
    return true;
  }
  context.events.emit(
    "deploy_failure",
    sha,
    [
      `Deployment FAILED for pushed ${sha}; gated assets retained;`,
      "retry at next scheduled departure; CI tracked separately.",
    ].join(" "),
  );
  context.log(`DEPLOY FAILED ${sha}; retained assets for the next scheduled departure; see ${log}`);
  return false;
}

/** Retry a pending deployment. True when nothing is pending or the retry deployed and cleaned up. */
export async function retryDeploy(context: BusContext): Promise<boolean> {
  const pending = readPending(context);
  if (pending === undefined) {
    return true;
  }
  if (!(await finishPending(context, pending))) {
    failureEvent(context, pending.sha);
    return false;
  }
  // The retained worktree and batch branch belong only to this bus.
  await gitOk(context.exec, context.game.repo, ["worktree", "remove", "--force", pending.work]);
  await gitOk(context.exec, context.game.repo, ["branch", "-D", pending.branch]);
  return true;
}

/** Stage and deploy after a successful push. */
export async function stageDeploy(
  context: BusContext,
  pending: PendingDeploy,
  needed: boolean,
): Promise<boolean> {
  const { sha } = pending;
  if (!needed) {
    writeLines(context.paths.lastDeploySkippedSha, sha);
    context.events.emit(
      "deploy_skipped",
      sha,
      `Deployment skipped for pushed ${sha}: documentation/art-source exclusions; CI pending until verified.`,
    );
    context.log("deploy skipped: entire batch matches documentation/art-source exclusions");
    return true;
  }
  if (context.config.deploy.mode === "none") {
    context.log(`deployment disabled for ${sha}`);
    return true;
  }
  writeLines(context.paths.deployPending, pending.sha, pending.work, pending.branch);
  if (await finishPending(context, pending)) {
    return true;
  }
  failureEvent(context, sha);
  return false;
}

export function deployPendingExists(context: BusContext): boolean {
  return existsSync(context.paths.deployPending) && readPending(context) !== undefined;
}
