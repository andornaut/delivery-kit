// Project checks run on the launcher's disposable /work snapshot, using image dependencies.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface CheckContext {
  readonly CHECK_REVISION: string;
  readonly CHECK_SOURCE_SHA256: string;
  readonly CHECK_SOURCE_DIRTY: boolean;
}

export function checkContext(env: Readonly<Record<string, string | undefined>>): CheckContext {
  const { CHECK_REVISION, CHECK_SOURCE_DIRTY, CHECK_SOURCE_SHA256 } = env;
  if (
    CHECK_REVISION === undefined ||
    !/^[0-9a-f]{40}$/.test(CHECK_REVISION) ||
    CHECK_SOURCE_SHA256 === undefined ||
    !/^[0-9a-f]{64}$/.test(CHECK_SOURCE_SHA256) ||
    (CHECK_SOURCE_DIRTY !== "true" && CHECK_SOURCE_DIRTY !== "false")
  ) {
    throw new Error("container snapshot provenance is missing or invalid");
  }
  return { CHECK_REVISION, CHECK_SOURCE_DIRTY: CHECK_SOURCE_DIRTY === "true", CHECK_SOURCE_SHA256 };
}

export interface TestTargets {
  readonly unit: readonly string[] | null;
  readonly contract: readonly string[] | null;
}

/** Explicit source and contract paths select their suite; unscoped filters apply to both. */
export function testTargets(args: readonly string[]): TestTargets {
  const isUnit = (arg: string): boolean => /^(src|scripts)\//.test(arg);
  const isContract = (arg: string): boolean => /^(tests\/contract\/|cases\/)/.test(arg);
  const unit = args.some(isUnit);
  const contract = args.some(isContract);
  return {
    unit: contract && !unit ? null : args.filter((arg) => !isContract(arg)),
    contract:
      unit && !contract
        ? null
        : args.filter((arg) => !isUnit(arg)).map((arg) => arg.replace(/^tests\/contract\//, "")),
  };
}

/** Keep focused Vitest invocations within the same absolute four-worker ceiling. */
export function workerArguments(args: readonly string[]): string[] {
  for (const [index, arg] of args.entries()) {
    if (/^--(?:max|min)(?:Workers|Threads|Forks)(?:=|$)/.test(arg)) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
      if (value === undefined || !/^[1-4]$/.test(value)) {
        throw new Error("test workers must be an integer from one to four");
      }
    }
  }
  return args.some((arg) => /^--maxWorkers(?:=|$)/.test(arg))
    ? [...args]
    : ["--maxWorkers=4", ...args];
}

function run(cwd: string, command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited ${String(result.status ?? result.signal)}`);
  }
}

function node(cwd: string, script: string, args: readonly string[] = []): void {
  run(cwd, process.execPath, [script, ...args]);
}

function linkDependencies(root: string): void {
  for (const [path, target] of [
    [join(root, "node_modules"), "/opt/check/root/node_modules"],
    [join(root, "tests/contract/node_modules"), "/opt/check/contract/node_modules"],
  ] as const) {
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) {
      throw new Error("snapshot dependency directory must be local writable scratch");
    }
    mkdirSync(path, { recursive: true });
    for (const name of readdirSync(target)) {
      const dependency = join(path, name);
      const imagePath = join(target, name);
      if (existsSync(dependency)) {
        if (!lstatSync(dependency).isSymbolicLink() || readlinkSync(dependency) !== imagePath) {
          throw new Error("snapshot package does not match the image dependency link");
        }
      } else {
        symlinkSync(imagePath, dependency);
      }
    }
  }
}

function lint(root: string): void {
  node(root, "node_modules/typescript/bin/tsc");
  node(join(root, "tests/contract"), "node_modules/typescript/bin/tsc");
  node(root, "node_modules/prettier/bin/prettier.cjs", ["--check", "."]);
  node(root, "node_modules/eslint/bin/eslint.js", ["--max-warnings", "0", "."]);
  node(root, "node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs");
  for (const wrapper of [
    "scripts/check.sh",
    "scripts/pack.sh",
    "tests/contract/run.sh",
    "tests/container/run",
  ]) {
    run(root, "bash", ["-n", wrapper]);
    run(root, "shellcheck", ["-x", "-P", "SCRIPTDIR", wrapper]);
  }
  node(root, "--check", ["tests/container/check"]);
}

function test(root: string, args: readonly string[]): void {
  const targets = testTargets(args);
  node(root, "scripts/build.mjs");
  if (targets.unit !== null) {
    node(root, "node_modules/vitest/vitest.mjs", ["run", ...workerArguments(targets.unit)]);
  }
  if (targets.contract !== null) {
    const contracts = join(root, "tests/contract");
    node(contracts, "node_modules/typescript/bin/tsc");
    node(contracts, "node_modules/vitest/vitest.mjs", [
      "run",
      ...workerArguments(targets.contract),
    ]);
  }
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A snapshot inspection package, distinct from pack.ts's clean exact-revision release asset. */
function build(root: string, context: CheckContext): void {
  const scratch = process.env.TMPDIR ?? "/scratch";
  const proof = join(scratch, "package-proof");
  const output = join(root, ".claude/release-output");
  if (existsSync(proof) || existsSync(output)) {
    throw new Error("snapshot package proof output already exists; use a fresh container");
  }
  mkdirSync(proof);
  node(root, "scripts/build.mjs");
  const packed = spawnSync(
    "npm",
    ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", proof],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  if (packed.status !== 0) {
    throw new Error(`snapshot package creation failed: ${packed.stderr}`);
  }
  const [metadata] = JSON.parse(packed.stdout) as [{ filename: string }];
  const archive = join(proof, metadata.filename);
  const extracted = join(proof, "unpacked");
  mkdirSync(extracted);
  run(root, "tar", ["-xzf", archive, "-C", extracted]);
  const pkg = join(extracted, "package");
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as {
    version: string;
    exports: Record<string, { types: string; import: string }>;
  };
  if (manifest.version !== readFileSync(join(root, "VERSION"), "utf8").trim()) {
    throw new Error("snapshot package version differs from VERSION");
  }
  const version = spawnSync(process.execPath, [join(pkg, "dist/cli.js"), "--version"], {
    encoding: "utf8",
  });
  if (version.status !== 0 || version.stdout.trim() !== manifest.version) {
    throw new Error("snapshot package CLI version differs from package.json");
  }
  const registry = manifest.exports["./registry"];
  if (registry === undefined || !existsSync(join(pkg, registry.types))) {
    throw new Error("snapshot package registry declarations missing");
  }
  node(pkg, "--input-type=module", [
    "-e",
    "import { readRegistry, resolveConversation, updateRegistry } " +
      'from "@andornaut/delivery-kit/registry"; ' +
      'if (![readRegistry, resolveConversation, updateRegistry].every(value => typeof value === "function")) process.exit(1);',
  ]);
  mkdirSync(output, { recursive: true });
  copyFileSync(archive, join(output, metadata.filename));
  writeFileSync(
    join(output, "CHECK_CONTEXT.json"),
    JSON.stringify(
      {
        version: 1,
        ...context,
        kind: "snapshot-package-inspection",
        immutableCommitClaim: false,
        packageVersion: manifest.version,
        archive: metadata.filename,
        archiveSha256: digest(archive),
        cliVersion: version.stdout.trim(),
      },
      null,
      2,
    ) + "\n",
  );
}

export function runChecks(args: readonly string[]): number {
  try {
    const [action, ...rest] = args;
    if (action === "exec") {
      const command = process.env.COMMAND;
      if (command === undefined || command === "") {
        throw new Error("COMMAND must be nonempty");
      }
      if (process.env.CHECK_WRITABLE !== "1") {
        linkDependencies(process.cwd());
      }
      run(process.cwd(), "/bin/sh", ["-ec", command, "command", ...rest]);
      return 0;
    }
    if (process.getuid?.() !== 19001) {
      throw new Error("checks require container uid 19001");
    }
    const context = checkContext(process.env);
    const tasks =
      action === "check" ? (process.env.CHECK_TASKS ?? "").trim().split(/\s+/) : [action];
    if (
      tasks.length === 0 ||
      new Set(tasks).size !== tasks.length ||
      tasks.some((task) => !["lint", "test", "build"].includes(task ?? ""))
    ) {
      throw new Error("checks must select lint, test or build");
    }
    linkDependencies(process.cwd());
    for (const task of tasks) {
      if (task === "lint") lint(process.cwd());
      if (task === "test") test(process.cwd(), rest);
      if (task === "build") build(process.cwd(), context);
    }
    return 0;
  } catch (error) {
    console.error(`container-check: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
