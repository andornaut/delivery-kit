// Contract harness in isolated containers, following check.ts: uid 19001 in the checkout's
// group, no host mount, the source streamed in as a tar, and the npm cache and the verified
// v0.9.1 parity release (tests/contract/lib/parity.ts) in a named volume. A first container
// fills the volume with network access; the build and both implementations' cases then run
// with no network, and both gate. Nothing is written back to the host.
// Usage: contract.ts [--lock] [vitest args]
//   --lock  regenerate tests/contract/package-lock.json; the file leaves through stdout.
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkImage,
  CONTAINER_ID,
  DEFAULT_VOLUME,
  discardReason,
  groupAdds,
  GuardError,
  requireLoad,
  run,
  snapshot,
  sourceList,
} from "./guards.ts";

const LOCK = `
  mkdir /tmp/h && tar -x -C /tmp/h && cd /tmp/h
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund >&2
  cat package-lock.json
`;

// CLEANUP (added 2026-11-04): remove once both games run delivery-kit 1.x and have completed one clean departure cycle.
// The bash parity release install in POPULATE and POPULATE_FILES, and the DK_IMPL=bash run in
// CASES.
const POPULATE = `
  mkdir /tmp/fetch && tar -x -C /tmp/fetch
  cd /tmp/fetch && npm ci --prefer-offline --ignore-scripts --no-audit --no-fund >/dev/null
  cd tests/contract && npm ci --prefer-offline --ignore-scripts --no-audit --no-fund >/dev/null
  node lib/parity-install.ts
`;

const CASES = `
  mkdir /tmp/check && tar -x -C /tmp/check
  cd /tmp/check
  npm ci --offline --ignore-scripts --no-audit --no-fund >/dev/null
  npm run build >/dev/null
  cd tests/contract
  npm ci --offline --ignore-scripts --no-audit --no-fund >/dev/null
  npx tsc
  status=0
  echo "contract: DK_IMPL=bash"
  DK_IMPL=bash npx vitest run --maxWorkers=4 $DK_VITEST_ARGS || status=1
  echo "contract: DK_IMPL=node"
  DK_IMPL=node npx vitest run --maxWorkers=4 $DK_VITEST_ARGS || status=1
  exit "$status"
`;

const POPULATE_FILES = [
  "package.json",
  "package-lock.json",
  "tests/contract/package.json",
  "tests/contract/package-lock.json",
  "tests/contract/lib/parity.ts",
  "tests/contract/lib/parity-install.ts",
];

/** Write a tar of `names` under `cwd` to `path`, for a container's stdin. */
function tarFile(cwd: string, names: readonly string[], path: string): void {
  const fd = openSync(path, "w", 0o600);
  try {
    const result = spawnSync("tar", ["--null", "--ignore-failed-read", "-T", "-", "-cf", "-"], {
      cwd,
      input: names.map((name) => `${name}\0`).join(""),
      stdio: ["pipe", fd, "ignore"],
    });
    if (result.status !== 0) {
      throw new GuardError(`tar failed in ${cwd}`);
    }
  } finally {
    closeSync(fd);
  }
}

function withStdin(path: string, body: (fd: number) => number): number {
  const fd = openSync(path, "r");
  try {
    return body(fd);
  } finally {
    closeSync(fd);
  }
}

function main(args: string[]): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const image = checkImage(root);
  const volume = process.env.DELIVERY_KIT_NPM_VOLUME ?? DEFAULT_VOLUME;
  const container = [
    "run",
    "-i",
    "--rm",
    "--read-only",
    "--cpus",
    "4",
    "--user",
    `${CONTAINER_ID}:${CONTAINER_ID}`,
    ...groupAdds([root]),
    "-e",
    "HOME=/tmp",
    "-e",
    "npm_config_cache=/var/tmp/npm",
    "-e",
    "DK_PARITY_DIR=/var/tmp/parity",
    "--mount",
    `type=volume,src=${volume},dst=/var/tmp`,
    "--tmpfs",
    "/tmp:exec,mode=1777",
    "-w",
    "/tmp",
  ];
  const scratch = mkdtempSync(join(tmpdir(), "delivery-kit-contract-"));
  try {
    if (args[0] === "--lock") {
      requireLoad();
      const input = join(scratch, "lock.tar");
      tarFile(join(root, "tests/contract"), ["package.json"], input);
      return withStdin(input, (fd) => {
        const result = spawnSync("docker", [...container, image, "sh", "-ec", LOCK], {
          maxBuffer: 1 << 30,
          stdio: [fd, "pipe", "inherit"],
        });
        if (result.status !== 0) {
          return result.status ?? 1;
        }
        writeFileSync(
          join(root, "tests/contract/package-lock.json"),
          `${result.stdout.toString("utf8").trimEnd()}\n`,
        );
        return 0;
      });
    }
    const before = snapshot(root);
    let status = 1;
    try {
      requireLoad();
      console.log("contract: populating the npm cache and parity release volume (network)");
      const populate = join(scratch, "populate.tar");
      tarFile(root, POPULATE_FILES, populate);
      status = withStdin(populate, (fd) =>
        run("docker", [...container, image, "sh", "-ec", POPULATE], {
          stdio: [fd, "inherit", "inherit"],
        }),
      );
      if (status === 0) {
        requireLoad();
        console.log("contract: build, type check and cases offline");
        const source = join(scratch, "source.tar");
        tarFile(root, sourceList(root), source);
        const offline = [
          ...container,
          "--network",
          "none",
          "-e",
          `DK_VITEST_ARGS=${args.join(" ")}`,
        ];
        status = withStdin(source, (fd) =>
          run("docker", [...offline, image, "bash", "-ec", CASES], {
            stdio: [fd, "inherit", "inherit"],
          }),
        );
      }
    } finally {
      const reason = discardReason(root, before, {
        gids: [CONTAINER_ID],
        uids: [CONTAINER_ID, 0],
      });
      if (reason !== undefined) {
        console.error(`contract: ${reason}`);
        status = 1;
      }
    }
    return status;
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`contract: ${error instanceof GuardError ? error.message : String(error)}`);
  process.exitCode = 1;
}
