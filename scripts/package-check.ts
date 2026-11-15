// Inspect a built package without claiming that its source snapshot is an immutable commit.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  const transport = manifest.exports["./transport"];
  if (transport === undefined || !existsSync(join(pkg, transport.types)))
    throw new Error("package transport declarations missing");
  node(pkg, "--input-type=module", [
    "-e",
    "import { resolveCodexControlSocket, messageChannelStateDir } from '@andornaut/delivery-kit/transport'; " +
      "const endpoint = resolveCodexControlSocket({ env: {}, home: '/fixture' }); " +
      "const channel = messageChannelStateDir({ reviewDir: '/review' }, '00000000-0000-4000-8000-000000000001'); " +
      "if (channel !== '/review/messages/recipients/00000000-0000-4000-8000-000000000001/unblock') process.exit(1); " +
      "if (endpoint.source !== 'managed' || endpoint.path !== '/fixture/.codex/app-server-control/app-server-control.sock') process.exit(1);",
  ]);
  const sourceIdentity = manifest.exports["./source-identity"];
  if (sourceIdentity === undefined || !existsSync(join(pkg, sourceIdentity.types)))
    throw new Error("package source identity declarations missing");
  node(pkg, "--input-type=module", [
    "-e",
    "import { snapshotSourceIdentity, restoreSourceIdentity, SourceIdentityError } " +
      "from '@andornaut/delivery-kit/source-identity'; " +
      "if (![snapshotSourceIdentity, restoreSourceIdentity, SourceIdentityError]" +
      ".every(value => typeof value === 'function')) process.exit(1);",
  ]);
  const consumer = join(proof, "consumer");
  const scope = join(consumer, "node_modules", "@andornaut");
  mkdirSync(scope, { recursive: true });
  symlinkSync(pkg, join(scope, "delivery-kit"), "dir");
  const source = join(consumer, "consumer.mts");
  writeFileSync(
    source,
    `import {
  readRegistry, updateRegistry, RevisionConflict, type Registry,
} from "@andornaut/delivery-kit/registry";
import {
  resolveCodexControlSocket, messageChannelStateDir, type CodexControlSocketEndpoint,
} from "@andornaut/delivery-kit/transport";
import {
  snapshotSourceIdentity, restoreSourceIdentity, SourceIdentityError,
  type SourceIdentityManifest, type SourceIdentityStatus,
} from "@andornaut/delivery-kit/source-identity";
const endpoint: CodexControlSocketEndpoint = resolveCodexControlSocket({ env: {}, home: "/fixture" });
const channel: string = messageChannelStateDir(
  { reviewDir: "/review" }, "00000000-0000-4000-8000-000000000001",
);
const revision: (registry: Registry) => number = registry => registry.revision;
// @ts-expect-error Registry declarations must preserve the numeric revision type.
const wrongRevision: (registry: Registry) => string = registry => registry.revision;
// @ts-expect-error Endpoint sources must remain a finite union rather than any.
const wrongSource: "other" = endpoint.source;
// @ts-expect-error The named transport export requires a string conversation ID.
messageChannelStateDir({ reviewDir: "/review" }, 42);
const commit = (manifest: SourceIdentityManifest): string => manifest.commit;
const dirty = (status: SourceIdentityStatus): boolean => status.dirty;
// @ts-expect-error Source identity must preserve a string expected commit, not any.
snapshotSourceIdentity({ sourceRoot: "/source", artifactDir: "/artifact" }, { expectedCommit: 42, approvedPaths: [] });
// @ts-expect-error Restore requires an independently pinned digest.
restoreSourceIdentity({ workRoot: "/work", artifactDir: "/artifact" }, { expectedCommit: "", expectedTree: "" });
export { channel, endpoint, revision, wrongRevision, wrongSource, readRegistry, updateRegistry, RevisionConflict,
  commit, dirty, snapshotSourceIdentity, restoreSourceIdentity, SourceIdentityError };
`,
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
  ]);
  const result = {
    version: 1,
    ...context,
    packageVersion: manifest.version,
    archive: metadata.filename,
    archiveSha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
    cliVersion: version.stdout.trim(),
    nodeNextExports: {
      source: "extracted-package",
      specifiers: [
        "@andornaut/delivery-kit/registry",
        "@andornaut/delivery-kit/source-identity",
        "@andornaut/delivery-kit/transport",
      ],
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
