// Host-side helpers for the npm release packaging controller in pack.ts.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** The uid and gid every container runs as; nothing on the host is owned by them. */
export const CONTAINER_ID = 19001;
export const DEFAULT_VOLUME = "delivery-kit-npm-check";

export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

/** The verification image is the Node version pinned in .nvmrc. */
export function checkImage(root: string): string {
  return `node:${readFileSync(join(root, ".nvmrc"), "utf8").trim().replace(/^v/, "")}`;
}

/** `--group-add` arguments for the distinct groups of `paths`, so uid 19001 can read them. */
export function groupAdds(paths: readonly string[]): string[] {
  const gids = [...new Set(paths.map((path) => lstatSync(path).gid))].sort((a, b) => a - b);
  return gids.flatMap((gid) => ["--group-add", String(gid)]);
}

/** Run a command with inherited output; returns its exit status (1 when it could not start). */
export function run(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): number {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error !== undefined) {
    process.stderr.write(`delivery-kit: ${command}: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

/** Whether pack's two arguments are an exact 40-hex SHA and a new absolute directory. */
export function validPackArgs(args: readonly string[]): boolean {
  const [sha, output] = args;
  return (
    args.length === 2 &&
    sha !== undefined &&
    /^[0-9a-f]{40}$/.test(sha) &&
    output !== undefined &&
    isAbsolute(output) &&
    !existsSync(output)
  );
}
