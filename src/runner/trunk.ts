// Trunk reads. The runner only reads the canonical checkout's refs/heads/<main> and asks the
// remote for its main with ls-remote, which writes no ref; it never fetches, checks out or
// moves a ref in the canonical checkout. Its only write there is the push of an exact SHA.
import { existsSync } from "node:fs";

import { assertNotInterrupted, type Exec, git } from "../lib/exec.ts";
import { type BusPaths, gateFailedFile, readTrimmed } from "../state/paths.ts";

/** The exact commit local main points at. */
export function mainHead(exec: Exec, repo: string, main: string): Promise<string> {
  return git(exec, repo, ["rev-parse", "--verify", `refs/heads/${main}^{commit}`]);
}

/** The remote's main SHA, or undefined when the remote has no such branch. */
export async function remoteMain(
  exec: Exec,
  repo: string,
  remote: string,
  main: string,
): Promise<string | undefined> {
  const line = await git(exec, repo, ["ls-remote", remote, `refs/heads/${main}`]);
  const sha = line.split(/\s+/)[0];
  return sha === undefined || sha === "" ? undefined : sha;
}

/**
 * The documentation path prefix. A departure whose every changed path starts with it pushes
 * without a gate and never deploys.
 */
export const DOCS_PREFIX = "docs/";

/**
 * The paths changed from `from` to `to`, each side of a rename listed separately, or undefined
 * when the range is unknown: no previous remote main, or a commit this checkout does not have.
 */
export async function changedPaths(
  exec: Exec,
  repo: string,
  from: string | undefined,
  to: string,
): Promise<string[] | undefined> {
  if (from === undefined) {
    return undefined;
  }
  const diff = assertNotInterrupted(
    "git diff",
    await exec({
      args: ["-C", repo, "diff", "--name-only", "--no-renames", from, to],
      command: "git",
    }),
  );
  if (diff.status !== 0) {
    return undefined;
  }
  return diff.stdout.split("\n").filter((name) => name !== "");
}

/** A known, non-empty range whose every changed path is under DOCS_PREFIX. */
export function docsOnly(paths: readonly string[] | undefined): boolean {
  return (
    paths !== undefined && paths.length > 0 && paths.every((path) => path.startsWith(DOCS_PREFIX))
  );
}

export type Skip = "gate-failed" | "pushed";

/** Why `head` must not depart: it is the last pushed SHA, or its gate already failed. */
export function skipReason(paths: BusPaths, head: string): Skip | undefined {
  if (readTrimmed(paths.lastPushSha) === head) {
    return "pushed";
  }
  return existsSync(gateFailedFile(paths, head)) ? "gate-failed" : undefined;
}
