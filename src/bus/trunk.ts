// Trunk reads. The runner only reads the canonical checkout's refs/heads/<main> and asks the
// remote for its main with ls-remote, which writes no ref; it never fetches, checks out or
// moves a ref in the canonical checkout. Its only write there is the push of an exact SHA.
import { existsSync } from "node:fs";

import { type Exec, git } from "./exec.ts";
import { type BusPaths, gateFailedFile, readTrimmed } from "./state.ts";

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

export type Skip = "gate-failed" | "pushed";

/** Why `head` must not depart: it is the last pushed SHA, or its gate already failed. */
export function skipReason(paths: BusPaths, head: string): Skip | undefined {
  if (readTrimmed(paths.lastPushSha) === head) {
    return "pushed";
  }
  return existsSync(gateFailedFile(paths, head)) ? "gate-failed" : undefined;
}
