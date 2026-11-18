// Inspect a built package without claiming that its source snapshot is an immutable commit.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COORDINATION_KIT, COORDINATION_KIT_RANGE, satisfies } from "../src/bus/pin.ts";
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

// The package ships the topic docs and the design summaries; the work files stay in the repository.
export function packagedDocs(root: string): string[] {
  const topics = readdirSync(join(root, "docs"), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `docs/${entry.name}`);
  const design = readdirSync(join(root, "docs", "design")).map((name) => `docs/design/${name}`);
  return [...topics, ...design].sort();
}

/** The coordination-kit version the build inlines; it must be inside the supported range. */
export function bundledCoordinationKit(root: string): string {
  const { version } = JSON.parse(
    readFileSync(join(root, "node_modules", COORDINATION_KIT, "package.json"), "utf8"),
  ) as { version: string };
  if (!satisfies(COORDINATION_KIT_RANGE, version))
    throw new Error(
      `bundled ${COORDINATION_KIT} ${version} is outside the supported range ${COORDINATION_KIT_RANGE}`,
    );
  return version;
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
    exports: Record<string, string | { types: string; import: string }>;
    dependencies?: unknown;
  };
  if (manifest.version !== readFileSync(join(root, "VERSION"), "utf8").trim())
    throw new Error("package version differs from VERSION");
  for (const doc of packagedDocs(root))
    if (!existsSync(join(pkg, doc))) throw new Error(`package ${doc} is missing`);
  if (existsSync(join(pkg, "docs", "work"))) throw new Error("package must not contain docs/work");
  const version = spawnSync(process.execPath, [join(pkg, "dist/cli.js"), "--version"], {
    encoding: "utf8",
  });
  if (version.status !== 0 || version.stdout.trim() !== manifest.version)
    throw new Error("package CLI version differs from package.json");
  const modules = ["source-identity"];
  const expectedExports = [
    "./package.json",
    ...modules.flatMap((name) => [`./build/${name}`, `./${name}`]),
  ].sort();
  if (JSON.stringify(Object.keys(manifest.exports).sort()) !== JSON.stringify(expectedExports))
    throw new Error(
      "package must export only explicit build APIs, compatibility aliases and metadata",
    );
  if (manifest.exports["./package.json"] !== "./package.json")
    throw new Error("package metadata export differs");
  for (const name of modules) {
    for (const path of [`./build/${name}`, `./${name}`]) {
      const entry = manifest.exports[path];
      if (
        entry === undefined ||
        typeof entry === "string" ||
        entry.types !== `./dist/${name}.d.ts` ||
        entry.import !== `./dist/${name}.js` ||
        JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["import", "types"]) ||
        !existsSync(join(pkg, entry.types)) ||
        !existsSync(join(pkg, entry.import))
      ) {
        throw new Error("package build API or compatibility target differs: " + path);
      }
    }
  }
  // The bundles inline coordination-kit, so the package declares no runtime dependency on it.
  if (manifest.dependencies !== undefined)
    throw new Error("package must not declare runtime dependencies");
  const built = { version: bundledCoordinationKit(root) };
  node(pkg, "--input-type=module", [
    "-e",
    `for (const name of ${JSON.stringify(modules)}) {
      const canonical = await import('@andornaut/delivery-kit/build/' + name);
      const alias = await import('@andornaut/delivery-kit/' + name);
      if (canonical !== alias) throw new Error('compatibility alias has a separate module: ' + name);
    }`,
  ]);
  node(pkg, "--input-type=module", [
    "-e",
    "import { snapshotSourceIdentity, restoreSourceIdentity, SourceIdentityError } " +
      "from '@andornaut/delivery-kit/build/source-identity'; " +
      "if (![snapshotSourceIdentity, restoreSourceIdentity, SourceIdentityError]" +
      ".every(value => typeof value === 'function')) process.exit(1);",
  ]);
  const consumer = join(proof, "consumer");
  const scope = join(consumer, "node_modules", "@andornaut");
  mkdirSync(scope, { recursive: true });
  symlinkSync(pkg, join(scope, "delivery-kit"), "dir");
  const source = join(consumer, "consumer.mts");
  const consumerSource = `import {
  snapshotSourceIdentity, restoreSourceIdentity, SourceIdentityError,
  type SourceIdentityManifest, type SourceIdentityStatus,
} from "@andornaut/delivery-kit/build/source-identity";
const commit = (manifest: SourceIdentityManifest): string => manifest.commit;
const dirty = (status: SourceIdentityStatus): boolean => status.dirty;
// @ts-expect-error Source identity must preserve a string expected commit, not any.
snapshotSourceIdentity({ sourceRoot: "/source", artifactDir: "/artifact" }, { expectedCommit: 42, approvedPaths: [] });
// @ts-expect-error Restore requires an independently pinned digest.
restoreSourceIdentity({ workRoot: "/work", artifactDir: "/artifact" }, { expectedCommit: "", expectedTree: "" });
export { commit, dirty, snapshotSourceIdentity, restoreSourceIdentity, SourceIdentityError };
`;
  writeFileSync(source, consumerSource);
  const aliasSource = join(consumer, "compatibility.mts");
  writeFileSync(
    aliasSource,
    consumerSource.replaceAll("@andornaut/delivery-kit/build/", "@andornaut/delivery-kit/"),
  );
  node(consumer, join(root, "node_modules/typescript/bin/tsc"), [
    "--noEmit",
    "--strict",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2024",
    "--types",
    "node",
    "--typeRoots",
    join(root, "node_modules/@types"),
    source,
    aliasSource,
  ]);
  const result = {
    version: 1,
    ...context,
    packageVersion: manifest.version,
    archive: metadata.filename,
    archiveSha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
    cliVersion: version.stdout.trim(),
    coordinationKit: { bundled: built.version, supported: COORDINATION_KIT_RANGE },
    nodeNextExports: {
      source: "extracted-package",
      canonicalSpecifiers: modules.map((name) => `@andornaut/delivery-kit/build/${name}`),
      compatibilitySpecifiers: modules.map((name) => `@andornaut/delivery-kit/${name}`),
      compatibilityModuleIdentity: "equal",
      classification: "node-build-operations-only",
      status: "passed",
    },
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
