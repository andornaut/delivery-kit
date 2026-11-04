// Build the npm release asset from an exact committed revision, offline, in a container running
// as uid 19001. The host writes the committed tree with git archive to a group-readable file
// outside the checkout, bound read-only (--group-add its group); the npm cache comes read-only
// from the volume check.ts populates, and the host user copies the artifacts out with docker cp.
// Output: delivery-kit-VERSION.tgz, SOURCE_COMMIT and SHA256SUMS.
// Usage: pack.ts EXACT_COMMIT_SHA NEW_ABSOLUTE_DIRECTORY
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkImage,
  CONTAINER_ID,
  DEFAULT_VOLUME,
  groupAdds,
  GuardError,
  requireLoad,
  run,
  validPackArgs,
} from "./guards.ts";

const USAGE = "usage: pack.sh EXACT_COMMIT_SHA NEW_ABSOLUTE_DIRECTORY";

const PACK = `
  umask 022
  mkdir /tmp/package /tmp/out
  tar -x -f /source.tar -C /tmp/package
  cd /tmp/package
  printf "%s\\n" "$SOURCE_REVISION" >SOURCE_COMMIT
  cp -R /var/tmp/npm /tmp/npm-cache
  npm ci --offline --ignore-scripts --no-audit --no-fund
  npm run build
  node scripts/release-package.mjs /tmp/release /tmp/out
`;

function capture(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new GuardError(`${command} ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function quiet(command: string, args: readonly string[]): number {
  return spawnSync(command, args, { stdio: "ignore" }).status ?? 1;
}

function main(args: string[]): number {
  process.umask(0o022);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (!validPackArgs(args)) {
    console.error(USAGE);
    return 2;
  }
  const [sha, outputArg] = args as [string, string];
  const revision = spawnSync("git", ["-C", root, "rev-parse", "--verify", `${sha}^{commit}`], {
    encoding: "utf8",
  });
  if (revision.status !== 0 || revision.stdout.trim() !== sha) {
    return 2;
  }
  const volume = process.env.DELIVERY_KIT_NPM_VOLUME ?? DEFAULT_VOLUME;
  if (quiet("docker", ["volume", "inspect", volume]) !== 0) {
    console.error(`delivery-kit: run scripts/check.sh first to populate the ${volume} volume`);
    return 2;
  }
  const image = checkImage(root);
  requireLoad();
  // Deterministic per revision, so a leftover container from an interrupted pack is replaced.
  const name = `delivery-kit-pack-${sha.slice(0, 12)}`;
  quiet("docker", ["rm", "--force", name]);
  const scratch = mkdtempSync(join(tmpdir(), "delivery-kit-pack-"));
  const archive = join(scratch, "source.tar");
  try {
    capture("git", ["-C", root, "archive", "-o", archive, sha]);
    chmodSync(archive, 0o640);
    const epoch = capture("git", ["-C", root, "show", "-s", "--format=%ct", sha]);
    const created = spawnSync(
      "docker",
      [
        "create",
        "--name",
        name,
        "--network",
        "none",
        "--cpus",
        "4",
        "--user",
        `${CONTAINER_ID}:${CONTAINER_ID}`,
        "-e",
        "HOME=/tmp",
        ...groupAdds([archive]),
        "--mount",
        `type=bind,src=${archive},dst=/source.tar,readonly`,
        "--mount",
        `type=volume,src=${volume},dst=/var/tmp,readonly`,
        "-e",
        `SOURCE_DATE_EPOCH=${epoch}`,
        "-e",
        `SOURCE_REVISION=${sha}`,
        "-e",
        "npm_config_cache=/tmp/npm-cache",
        "-w",
        "/tmp",
        image,
        "sh",
        "-ec",
        PACK,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    if (created.status !== 0) {
      return created.status ?? 1;
    }
    const started = run("docker", ["start", "-a", name]);
    if (started !== 0) {
      return started;
    }
    mkdirSync(outputArg, { recursive: true });
    const output = realpathSync(outputArg);
    const copied = run("docker", ["cp", "--quiet", `${name}:/tmp/out/.`, `${output}/`]);
    if (copied !== 0) {
      return copied;
    }
    console.log(`delivery-kit: release artifacts in ${output}`);
    return 0;
  } finally {
    quiet("docker", ["rm", "--force", name]);
    rmSync(scratch, { force: true, recursive: true });
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`delivery-kit: ${error instanceof GuardError ? error.message : String(error)}`);
  process.exitCode = 1;
}
