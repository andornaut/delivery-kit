// Verification in isolated containers running as uid 19001, which owns nothing on the host.
// The checkout is bound read-only and read through its group (--group-add), then copied into
// container scratch; the npm cache lives in a named volume. A first container populates that
// volume with network access; every check, the contract cases on the built bundle included,
// then runs with no network. Nothing is written to the host.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const POPULATE = `
  mkdir -p /tmp/fetch/tests/contract
  cp /source/package.json /source/package-lock.json /tmp/fetch/
  cd /source/tests/contract
  cp package.json package-lock.json /tmp/fetch/tests/contract/
  cd /tmp/fetch
  npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
  cd tests/contract
  npm ci --prefer-offline --ignore-scripts --no-audit --no-fund
`;

const CHECK = `
  mkdir /tmp/check
  tar -C /source --null -T /source.list -cf - | tar -x -C /tmp/check
  cd /tmp/check
  npm ci --offline --ignore-scripts --no-audit --no-fund
  npm run check
  npm run lint
  npm run build
  npm test -- --maxWorkers=4
  for path in scripts/*.sh tests/contract/run.sh; do bash -n "$path"; done
  cd tests/contract
  npm ci --offline --ignore-scripts --no-audit --no-fund
  npx tsc
  npx vitest run --maxWorkers=4
`;

function main(): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const image = checkImage(root);
  const volume = process.env.DELIVERY_KIT_NPM_VOLUME ?? DEFAULT_VOLUME;
  // The list is outside the checkout and group-readable, and is bound read-only beside it.
  const scratch = mkdtempSync(join(tmpdir(), "delivery-kit-check-"));
  const list = join(scratch, "source.list");
  writeFileSync(
    list,
    sourceList(root)
      .map((name) => `${name}\0`)
      .join(""),
  );
  chmodSync(list, 0o640);
  const before = snapshot(root);
  let status: number;
  try {
    const container = [
      "run",
      "--rm",
      "--read-only",
      "--cpus",
      "4",
      "--user",
      `${CONTAINER_ID}:${CONTAINER_ID}`,
      "-e",
      "HOME=/tmp",
      ...groupAdds([root, list]),
      "-e",
      "npm_config_cache=/var/tmp/npm",
      "--mount",
      `type=bind,src=${root},dst=/source,readonly`,
      "--mount",
      `type=bind,src=${list},dst=/source.list,readonly`,
      "--mount",
      `type=volume,src=${volume},dst=/var/tmp`,
      "--tmpfs",
      "/tmp:exec,mode=1777",
      "-w",
      "/tmp",
    ];
    requireLoad();
    console.log("delivery-kit: populating the npm cache volume in a container");
    status = run("docker", [...container, image, "sh", "-ec", POPULATE]);
    if (status === 0) {
      requireLoad();
      console.log("delivery-kit: checking types, lint, build, tests and contract cases offline");
      status = run("docker", [...container, "--network", "none", image, "bash", "-ec", CHECK]);
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
    const reason = discardReason(root, before, { gids: [CONTAINER_ID], uids: [CONTAINER_ID] });
    if (reason !== undefined) {
      console.error(`delivery-kit: ${reason}`);
      status = 1;
    }
  }
  return status;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`delivery-kit: ${error instanceof GuardError ? error.message : String(error)}`);
  process.exitCode = 1;
}
