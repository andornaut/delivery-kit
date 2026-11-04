// Install the verified 0.9.1 parity release into DK_PARITY_DIR. Run with network access in the
// first container step: `node lib/parity-install.ts`. Reuses an earlier verified install.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PARITY, PARITY_DIR } from "./parity.ts";

const marker = join(PARITY_DIR, "verified");
const identity = `${PARITY.archive.sha256} ${PARITY.websocketClient.sha256}\n`;

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`parity: ${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function verify(name: string, data: Buffer, expected: string): void {
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected)
    throw new Error(`parity: ${name} sha256 ${actual}, expected ${expected}`);
}

if (existsSync(marker) && readFileSync(marker, "utf8") === identity) {
  console.log("parity: verified v0.9.1 install present");
} else {
  rmSync(PARITY_DIR, { force: true, recursive: true });
  mkdirSync(PARITY_DIR, { recursive: true });
  const archive = await download(PARITY.archive.url);
  verify(PARITY.archive.name, archive, PARITY.archive.sha256);
  const sums = (await download(PARITY.archive.sums)).toString("utf8");
  if (!sums.split("\n").includes(`${PARITY.archive.sha256}  ${PARITY.archive.name}`)) {
    throw new Error("parity: SHA256SUMS does not list the pinned archive digest");
  }
  const tarball = join(PARITY_DIR, PARITY.archive.name);
  writeFileSync(tarball, archive);
  execFileSync("tar", ["-xzf", tarball, "-C", PARITY_DIR]);
  rmSync(tarball);
  const commit = readFileSync(join(PARITY_DIR, PARITY.root, "SOURCE_COMMIT"), "utf8").trim();
  if (commit !== PARITY.sourceCommit)
    throw new Error(`parity: SOURCE_COMMIT ${commit}, expected ${PARITY.sourceCommit}`);
  const wheel = await download(PARITY.websocketClient.url);
  verify(PARITY.websocketClient.name, wheel, PARITY.websocketClient.sha256);
  writeFileSync(join(PARITY_DIR, `${PARITY.websocketClient.name}.part`), wheel);
  renameSync(
    join(PARITY_DIR, `${PARITY.websocketClient.name}.part`),
    join(PARITY_DIR, PARITY.websocketClient.name),
  );
  writeFileSync(marker, identity);
  console.log(`parity: installed v0.9.1 (${commit}) into ${PARITY_DIR}`);
}
