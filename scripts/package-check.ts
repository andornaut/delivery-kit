// Inspect a built package without claiming that its source snapshot is an immutable commit.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain, node, run } from "./check.ts";

export interface CheckContext {
  readonly CHECK_REVISION: string;
  readonly CHECK_SOURCE_SHA256: string;
  readonly CHECK_SOURCE_DIRTY: boolean;
}

export function checkContext(env: Readonly<Record<string, string | undefined>>): CheckContext {
  const { CHECK_REVISION, CHECK_SOURCE_SHA256, CHECK_SOURCE_DIRTY } = env;
  if (
    CHECK_REVISION === undefined ||
    !/^[0-9a-f]{40}$/.test(CHECK_REVISION) ||
    CHECK_SOURCE_SHA256 === undefined ||
    !/^[0-9a-f]{64}$/.test(CHECK_SOURCE_SHA256) ||
    (CHECK_SOURCE_DIRTY !== "true" && CHECK_SOURCE_DIRTY !== "false")
  ) {
    throw new Error("container snapshot provenance is missing or invalid");
  }
  return { CHECK_REVISION, CHECK_SOURCE_SHA256, CHECK_SOURCE_DIRTY: CHECK_SOURCE_DIRTY === "true" };
}

export function inspectionContext(env: Readonly<Record<string, string | undefined>>) {
  const supplied = ["CHECK_REVISION", "CHECK_SOURCE_SHA256", "CHECK_SOURCE_DIRTY"].some(
    (key) => env[key] !== undefined,
  );
  return {
    kind: "snapshot-package-inspection" as const,
    immutableCommitClaim: false as const,
    ...(supplied ? checkContext(env) : {}),
  };
}

export function inspectPackage(
  env: Readonly<Record<string, string | undefined>>,
  root: string,
): void {
  const context = inspectionContext(env);
  const proof = mkdtempSync(join(tmpdir(), "delivery-kit-package-check-"));
  const packed = spawnSync(
    "npm",
    ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", proof],
    { cwd: root, encoding: "utf8" },
  );
  if (packed.status !== 0) throw new Error("package inspection failed: " + packed.stderr);
  const [metadata] = JSON.parse(packed.stdout) as [{ filename: string }];
  const archive = join(proof, metadata.filename),
    extracted = join(proof, "unpacked");
  mkdirSync(extracted);
  run(root, "tar", ["-xzf", archive, "-C", extracted]);
  const pkg = join(extracted, "package");
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as {
    version: string;
    exports: Record<string, { types: string; import: string }>;
  };
  if (manifest.version !== readFileSync(join(root, "VERSION"), "utf8").trim())
    throw new Error("package version differs from VERSION");
  const version = spawnSync(process.execPath, [join(pkg, "dist/cli.js"), "--version"], {
    encoding: "utf8",
  });
  if (version.status !== 0 || version.stdout.trim() !== manifest.version)
    throw new Error("package CLI version differs from package.json");
  const registry = manifest.exports["./registry"];
  if (registry === undefined || !existsSync(join(pkg, registry.types)))
    throw new Error("package registry declarations missing");
  node(pkg, "--input-type=module", [
    "-e",
    "import { readRegistry, resolveConversation, updateRegistry } from '@andornaut/delivery-kit/registry'; " +
      "if (![readRegistry, resolveConversation, updateRegistry].every(value => typeof value === 'function')) process.exit(1);",
  ]);
  const result = {
    version: 1,
    ...context,
    packageVersion: manifest.version,
    archive: metadata.filename,
    archiveSha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
    cliVersion: version.stdout.trim(),
    SOURCE_DATE_EPOCH: env.SOURCE_DATE_EPOCH ?? null,
  };
  writeFileSync(join(proof, "CHECK_CONTEXT.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ ...result, inspectionDirectory: proof }));
}

if (isMain(import.meta.url)) {
  try {
    inspectPackage(process.env, resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  } catch (error) {
    console.error("package-check: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
