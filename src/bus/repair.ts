// Red-CI push blocking and the one-shot repair approval.
// CLEANUP (added 2026-10-30): remove the repair protocol after its consumed approval is archived.
// Approval is data, never shell input. A consumed marker rejects later copies of the file.
import { existsSync, lstatSync } from "node:fs";

import type { BusContext } from "./context.ts";
import { git } from "./exec.ts";
import { ciStatusFile, readText, readTrimmed } from "./state.ts";

const SHA = /^[0-9a-f]{40}$/;

async function revParse(
  context: BusContext,
  cwd: string,
  ref: string,
): Promise<string | undefined> {
  try {
    return await git(context.exec, cwd, ["rev-parse", ref]);
  } catch {
    return undefined;
  }
}

/** The approval file's three lines: failed SHA, repair branch and its exact tip. */
export function approvalLines(context: BusContext): string[] | undefined {
  const text = readText(context.paths.approval);
  if (text === undefined) {
    return undefined;
  }
  // mapfile -t semantics: newline-terminated lines.
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

export async function repairApproved(
  context: BusContext,
  failed: string,
  branches: readonly string[],
): Promise<boolean> {
  const { paths } = context;
  if (
    readTrimmed(paths.lastPushSha) !== failed ||
    readTrimmed(ciStatusFile(paths, failed)) !== "failure"
  ) {
    return false;
  }
  if (branches.length !== 1 || existsSync(paths.approvalConsumed)) {
    return false;
  }
  try {
    const stat = lstatSync(paths.approval);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return false;
    }
  } catch {
    return false;
  }
  const approved = approvalLines(context);
  if (approved?.length !== 3) {
    return false;
  }
  const [approvedFailed = "", branch = "", tip = ""] = approved;
  if (!SHA.test(approvedFailed) || !SHA.test(tip)) {
    return false;
  }
  if (!branch.startsWith("bus/") || branches[0] !== branch || failed !== approvedFailed) {
    return false;
  }
  const repo = context.game.repo;
  if ((await revParse(context, repo, context.base)) !== failed) {
    return false;
  }
  if ((await revParse(context, repo, `refs/heads/${branch}`)) !== tip) {
    return false;
  }
  try {
    return (await git(context.exec, repo, ["merge-base", context.base, tip])) === failed;
  } catch {
    return false;
  }
}

/** False (with a log line) when the last push has failing CI and no valid repair approval. */
export async function ciNotRed(context: BusContext, branches: readonly string[]): Promise<boolean> {
  const sha = readTrimmed(context.paths.lastPushSha);
  if (sha === undefined || sha === "") {
    return true;
  }
  if (readTrimmed(ciStatusFile(context.paths, sha)) !== "failure") {
    return true;
  }
  if (await repairApproved(context, sha, branches)) {
    context.log(`bus: using one-shot repair approval for ${sha}`);
    return true;
  }
  context.log(`bus: previous push ${sha} has failing CI; queue retained`);
  return false;
}

/** Quiet ci_not_red with no branches (`ci_not_red >/dev/null`). */
export async function ciGreenOrUnknown(context: BusContext): Promise<boolean> {
  return ciNotRed({ ...context, log: () => undefined }, []);
}

/** An approved repair contains exactly the approved tree, with no additional batch work. */
export async function repairTreeMatches(context: BusContext, work: string): Promise<boolean> {
  const tip = approvalLines(context)?.[2];
  if (tip === undefined) {
    return false;
  }
  const head = await revParse(context, work, "HEAD^{tree}");
  const approved = await revParse(context, context.game.repo, `${tip}^{tree}`);
  return head !== undefined && head === approved;
}
