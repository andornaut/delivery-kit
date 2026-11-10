// Native verification shared by local development and the project check image.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isMain(url: string): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(url);
}

export function run(root: string, command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(command + " exited " + String(result.status ?? result.signal));
}

export function node(root: string, script: string, args: readonly string[] = []): void {
  run(root, process.execPath, [script, ...args]);
}

export interface TestTargets {
  readonly unit: readonly string[] | null;
  readonly contract: readonly string[] | null;
}

/** Explicit source and contract paths select their suite; unscoped filters apply to both. */
export function testTargets(args: readonly string[]): TestTargets {
  const isUnit = (arg: string): boolean => /^(src|scripts)\//.test(arg);
  const isContract = (arg: string): boolean => /^(tests\/contract\/|cases\/)/.test(arg);
  const unit = args.some(isUnit),
    contract = args.some(isContract);
  return {
    unit: contract && !unit ? null : args.filter((arg) => !isContract(arg)),
    contract:
      unit && !contract
        ? null
        : args.filter((arg) => !isUnit(arg)).map((arg) => arg.replace(/^tests\/contract\//, "")),
  };
}

/** Apply the same absolute four-worker ceiling to native and image verification. */
export function workerArguments(args: readonly string[]): string[] {
  for (const [index, arg] of args.entries()) {
    if (/^--(?:max|min)(?:Workers|Threads|Forks)(?:=|$)/.test(arg)) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
      if (value === undefined || !/^[1-4]$/.test(value))
        throw new Error("test workers must be an integer from one to four");
    }
  }
  return args.some((arg) => /^--maxWorkers(?:=|$)/.test(arg))
    ? [...args]
    : ["--maxWorkers=4", ...args];
}

export function lint(root: string): void {
  run(root, "npm", ["run", "check"]);
  run(root, "npm", ["run", "lint"]);
  for (const wrapper of [
    "scripts/check.sh",
    "scripts/pack.sh",
    "tests/contract/run.sh",
    "tests/container/run",
    "tests/container/check",
  ]) {
    run(root, "bash", ["-n", wrapper]);
  }
}

export function test(root: string, args: readonly string[]): void {
  const targets = testTargets(args);
  const unit = targets.unit === null ? null : workerArguments(targets.unit);
  const contract = targets.contract === null ? null : workerArguments(targets.contract);
  node(root, "scripts/build.mjs");
  if (unit !== null) node(root, "node_modules/vitest/vitest.mjs", ["run", ...unit]);
  if (contract !== null) {
    const contracts = join(root, "tests/contract");
    node(contracts, "node_modules/typescript/bin/tsc");
    node(contracts, "node_modules/vitest/vitest.mjs", ["run", ...contract]);
  }
}

export function build(root: string): void {
  node(root, "scripts/build.mjs");
  run(root, "npm", ["run", "package:check"]);
}

export function verify(root: string, args: readonly string[]): void {
  lint(root);
  test(root, args);
  run(root, "npm", ["run", "package:check"]);
}

if (isMain(import.meta.url)) {
  try {
    verify(resolve(dirname(fileURLToPath(import.meta.url)), ".."), process.argv.slice(2));
  } catch (error) {
    console.error("check: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
