// Deployment of already-gated assets after the exact pushed SHA passes CI. The gated worktree
// is kept with its pending pointer until the deployment succeeds; a failed deployment is
// retried at a later departure, and a newer push supersedes it.
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { fsyncDirectory, holdLock, SHA_PATTERN } from "@andornaut/coordination-kit/build/shared";

import type { BusContext } from "./bus/context.ts";
import {
  beginDeliveryActivity,
  claimDeliveryRunner,
  endDeliveryActivity,
  readDeliveryControl,
  resumeDeliveryActivity,
  setObservedDelivery,
  updateDeliveryActivity,
} from "./bus/control.ts";
import { gitOk, WRANGLER_ENTRY } from "./bus/exec.ts";
import { ciStatusFile, ensureDir, readText, readTrimmed, writeLines } from "./bus/state.ts";
import { remoteMain } from "./bus/trunk.ts";

interface DeliverySession {
  readonly token: string;
  claimed: boolean;
}

const sessions = new WeakMap<BusContext, DeliverySession>();

/** Bind only after acquiring the runner singleton locks. */
export function bindDeliveryRunner(context: BusContext, token: string = randomUUID()): void {
  sessions.set(context, { claimed: false, token });
  deliveryRunnerReady(context);
}

export function unbindDeliveryRunner(context: BusContext): void {
  sessions.delete(context);
}

export function hasDeliveryRunner(context: BusContext): boolean {
  return sessions.has(context);
}

/** Internal direct calls use the same singleton exclusion as the resident runner. */
export async function withDeliveryRunner<T>(
  context: BusContext,
  run: () => Promise<T>,
): Promise<T> {
  if (hasDeliveryRunner(context)) {
    return run();
  }
  const runner = holdLock(context.paths.runnerLock, { nonBlocking: true });
  let loop;
  try {
    loop = holdLock(context.paths.loopLock, { nonBlocking: true });
    bindDeliveryRunner(context);
    return await run();
  } finally {
    unbindDeliveryRunner(context);
    loop?.release();
    runner.release();
  }
}

function controlStore(context: BusContext) {
  return { dir: context.paths.dir, now: () => new Date(context.clock.now() * 1000).toISOString() };
}

/** Missing control blocks admission while the existing runner continues observing. */
export function deliveryRunnerReady(context: BusContext): boolean {
  const session = sessions.get(context);
  if (session === undefined) {
    return false;
  }
  if (!session.claimed) {
    try {
      claimDeliveryRunner(controlStore(context), session.token);
      session.claimed = true;
    } catch (error) {
      context.log(`bus: delivery control unavailable; admission blocked (${String(error)})`);
    }
  }
  return session.claimed;
}

export function beginDeliveryWork(
  context: BusContext,
  state: "checking" | "deploying",
  sha: string | null,
  resume = false,
): string | undefined {
  if (!deliveryRunnerReady(context)) {
    return undefined;
  }
  const session = sessions.get(context)!;
  const id = randomUUID();
  try {
    const begin = resume ? resumeDeliveryActivity : beginDeliveryActivity;
    return begin(controlStore(context), session.token, { id, sha, state }) ? id : undefined;
  } catch (error) {
    context.log(`bus: delivery control unavailable; admission blocked (${String(error)})`);
    return undefined;
  }
}

export function updateDeliveryWork(
  context: BusContext,
  id: string,
  state: "checking" | "deploying" | "failed",
  sha: string | null,
): void {
  const session = sessions.get(context);
  if (session !== undefined) {
    try {
      updateDeliveryActivity(controlStore(context), session.token, { id, sha, state });
    } catch (error) {
      context.log(`bus: delivery observation unavailable (${String(error)})`);
    }
  }
}

export function endDeliveryWork(context: BusContext, id: string): void {
  const session = sessions.get(context);
  if (session !== undefined) {
    try {
      endDeliveryActivity(controlStore(context), session.token, id);
    } catch (error) {
      context.log(`bus: delivery observation unavailable (${String(error)})`);
    }
  }
}

export function settleDeliveryRunner(
  context: BusContext,
  state: "idle" | "stopped" | "failed",
): void {
  const session = sessions.get(context);
  if (session?.claimed === true) {
    try {
      const sha =
        state === "failed"
          ? (readDeliveryControl(controlStore(context)).observed?.sha ?? null)
          : null;
      setObservedDelivery(controlStore(context), session.token, { sha, state });
    } catch (error) {
      context.log(`bus: delivery observation unavailable (${String(error)})`);
    }
  }
}

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
 * The pushed range changes a file outside the configured skip pattern. An unknown range (a first
 * push, or a previous remote SHA this checkout does not have) always needs a deployment.
 */
export function deployNeeded(context: BusContext, changed: readonly string[] | undefined): boolean {
  const pattern = context.config.deploy.skipPattern;
  if (pattern === undefined || pattern === "" || changed === undefined) {
    return true;
  }
  const skip = new RegExp(pattern);
  return changed.some((name) => !skip.test(name));
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
  // A matching durable pending pointer proves this batch was already pushed.
  const activity = beginDeliveryWork(context, "deploying", pending.sha, true);
  try {
    if (await finishPending(context, pending)) {
      return true;
    }
    if (activity !== undefined) {
      updateDeliveryWork(context, activity, "failed", pending.sha);
    }
    failureEvent(context, pending.sha);
    return false;
  } catch (error) {
    if (activity !== undefined) {
      updateDeliveryWork(context, activity, "failed", pending.sha);
    }
    throw error;
  } finally {
    if (activity !== undefined) {
      endDeliveryWork(context, activity);
    }
  }
}

/** After CI passes for `sha`: deploy it when it is the pending deployment. */
export async function deployAfterCi(context: BusContext, sha: string): Promise<boolean> {
  const pending = readPending(context);
  if (pending?.sha !== sha) {
    return false;
  }
  return withDeliveryRunner(context, () => attempt(context, pending));
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

/** Record that the pushed `sha` is never deployed, with the reason. */
export function skipDeploy(context: BusContext, sha: string, reason: string): void {
  writeLines(context.paths.lastDeploySkippedSha, sha);
  context.events.emit(
    "deploy_skipped",
    sha,
    `Deployment skipped for pushed ${sha}: ${reason}; CI pending until verified.`,
  );
  context.log(`deploy skipped for ${sha}: ${reason}`);
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
    skipDeploy(context, sha, "every changed path matches deploy.skipPattern");
    await removeWorktree(context, pending.work);
    return;
  }
  if (context.config.deploy.mode === "none") {
    context.events.emit(
      "deploy_disabled",
      sha,
      `Deployment disabled for pushed ${sha}: deploy.mode is none; CI pending until verified.`,
    );
    context.log(`deployment disabled for ${sha}`);
    await removeWorktree(context, pending.work);
    return;
  }
  await supersede(context, sha);
  writeLines(context.paths.deployPending, pending.sha, pending.work);
  context.log(`deployment of ${sha} staged; it runs when CI passes`);
}
