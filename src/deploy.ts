// Deployment of already-gated assets after the exact pushed SHA passes CI. The gated worktree
// is kept with its pending pointer until the deployment succeeds; a failed deployment is
// retried at a later departure, and a newer push supersedes it.
import { existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { SHA_PATTERN } from "./adapters/shared/ids.ts";
import type { BusContext } from "./bus/context.ts";
import { gitOk, WRANGLER_ENTRY } from "./bus/exec.ts";
import { ciStatusFile, ensureDir, readText, readTrimmed, writeLines } from "./bus/state.ts";
import { remoteMain } from "./bus/trunk.ts";
import { fsyncDirectory } from "./durable.ts";

export interface PendingDeploy {
  readonly sha: string;
  /** The detached gate worktree holding the gated dist/ and node_modules/. */
  readonly work: string;
}

export function readPending(context: BusContext): PendingDeploy | undefined {
  const text = readText(context.paths.deployPending);
  if (text === undefined || text === "") {
    return undefined;
  }
  const [sha = "", work = ""] = text.split("\n");
  return { sha, work };
}

export function deployPendingExists(context: BusContext): boolean {
  return existsSync(context.paths.deployPending) && readPending(context) !== undefined;
}

/**
 * The pushed range changes a file outside the configured skip pattern. A first push, or a
 * previous remote SHA this checkout does not have, always needs a deployment.
 */
export async function deployNeeded(
  context: BusContext,
  from: string | undefined,
  to: string,
): Promise<boolean> {
  const pattern = context.config.deploy.skipPattern;
  if (pattern === undefined || pattern === "" || from === undefined) {
    return true;
  }
  const diff = await context.exec({
    args: ["-C", context.game.repo, "diff", "--name-only", from, to],
    command: "git",
  });
  if (diff.status !== 0) {
    return true;
  }
  const skip = new RegExp(pattern);
  return diff.stdout.split("\n").some((name) => name !== "" && !skip.test(name));
}

export async function removeWorktree(context: BusContext, work: string): Promise<void> {
  await gitOk(context.exec, context.game.repo, ["worktree", "remove", "--force", work]);
}

function failureEvent(context: BusContext, sha: string): void {
  if (SHA_PATTERN.test(sha)) {
    context.events.emit(
      "deploy_failure",
      sha,
      [
        `Deployment blocked/failed for pushed ${sha}; retained pending assets; inspect configuration,`,
        "the remote main and artifacts before the next retry. Fix forward with a new merge on main.",
      ].join(" "),
    );
  }
}

async function finishPending(context: BusContext, pending: PendingDeploy): Promise<boolean> {
  const { config, paths } = context;
  const { sha, work } = pending;
  if (config.deploy.mode !== "wrangler") {
    context.log(`deployment pending for ${sha}; deploy.mode must be wrangler before retrying`);
    return false;
  }
  const current = await remoteMain(
    context.exec,
    context.game.repo,
    config.git.remote,
    config.git.main,
  );
  if (current !== sha) {
    context.log(
      `deployment pending ${sha} differs from the remote main (${current ?? "absent"}); retained`,
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
  let wrangler: boolean;
  try {
    wrangler = statSync(join(work, WRANGLER_ENTRY)).isFile();
  } catch {
    wrangler = false;
  }
  if (!wrangler) {
    context.log(
      `deployment of ${sha} refused: ${WRANGLER_ENTRY} is missing from the gated worktree ` +
        `${work}; the gate's install must provide Wrangler`,
    );
    return false;
  }
  ensureDir(paths.deployDir);
  const log = join(paths.deployDir, `${sha}.log`);
  context.events.emit(
    "deploy_retry",
    sha,
    `Deployment pending/retrying exact pushed ${sha} using retained gated assets; CI passed.`,
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
  if (result.status !== 0) {
    context.events.emit(
      "deploy_failure",
      sha,
      [
        `Deployment FAILED for pushed ${sha}; gated assets retained;`,
        "retry at the next departure, or fix forward with a new merge on main.",
      ].join(" "),
    );
    context.log(`DEPLOY FAILED ${sha}; retained assets for the next departure; see ${log}`);
    return false;
  }
  writeLines(paths.lastDeploySha, sha);
  writeLines(paths.lastDeploy, String(context.clock.now()));
  renameSync(paths.deployPending, join(paths.deployDir, `${sha}.completed`));
  fsyncDirectory(paths.dir);
  fsyncDirectory(paths.deployDir);
  context.events.emit(
    "deploy_success",
    sha,
    `Deployment success for exact pushed ${sha}; CI passed.`,
  );
  context.log(`deployed ${sha}`);
  await removeWorktree(context, work);
  return true;
}

/** Deploy `pending`, reporting a failure; true once deployed. */
async function attempt(context: BusContext, pending: PendingDeploy): Promise<boolean> {
  if (await finishPending(context, pending)) {
    return true;
  }
  failureEvent(context, pending.sha);
  return false;
}

/** After CI passes for `sha`: deploy it when it is the pending deployment. */
export async function deployAfterCi(context: BusContext, sha: string): Promise<boolean> {
  const pending = readPending(context);
  if (pending?.sha !== sha) {
    return false;
  }
  return attempt(context, pending);
}

/**
 * At a departure: retry a pending deployment whose CI has passed. True when nothing is pending,
 * CI has not passed yet, or the retry deployed. A red CI waits for a fix merged on main.
 */
export async function retryDeploy(context: BusContext): Promise<boolean> {
  const pending = readPending(context);
  if (pending === undefined) {
    return true;
  }
  const ci = readTrimmed(ciStatusFile(context.paths, pending.sha));
  if (ci !== "success") {
    if (ci === "failure") {
      context.log(
        `deployment pending ${pending.sha} has failing CI; it waits for a fix merged on main`,
      );
    }
    return true;
  }
  return attempt(context, pending);
}

/** Supersede an older pending deployment by a newer push: keep its record, drop its worktree. */
async function supersede(context: BusContext, sha: string): Promise<void> {
  const previous = readPending(context);
  if (previous === undefined || previous.sha === sha) {
    return;
  }
  ensureDir(context.paths.deployDir);
  renameSync(
    context.paths.deployPending,
    join(context.paths.deployDir, `${previous.sha}.superseded`),
  );
  fsyncDirectory(context.paths.dir);
  context.log(`deployment pending ${previous.sha} superseded by pushed ${sha}`);
  await removeWorktree(context, previous.work);
}

/**
 * After a successful push: record the pending deployment, which runs once CI passes, or skip it
 * and drop the worktree. Never deploys before CI.
 */
export async function stageDeploy(
  context: BusContext,
  pending: PendingDeploy,
  needed: boolean,
): Promise<void> {
  const { sha } = pending;
  if (!needed) {
    writeLines(context.paths.lastDeploySkippedSha, sha);
    context.events.emit(
      "deploy_skipped",
      sha,
      `Deployment skipped for pushed ${sha}: every changed path matches deploy.skipPattern; CI pending until verified.`,
    );
    context.log("deploy skipped: every path changed in the pushed range matches deploy.skipPattern");
    await removeWorktree(context, pending.work);
    return;
  }
  if (context.config.deploy.mode === "none") {
    context.log(`deployment disabled for ${sha}`);
    await removeWorktree(context, pending.work);
    return;
  }
  await supersede(context, sha);
  writeLines(context.paths.deployPending, pending.sha, pending.work);
  context.log(`deployment of ${sha} staged; it runs when CI passes`);
}
