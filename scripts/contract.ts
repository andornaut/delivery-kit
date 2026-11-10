// Native standalone contracts. --lock explicitly regenerates the contract lockfile.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain, node, run, workerArguments } from "./check.ts";

if (isMain(import.meta.url)) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const args = process.argv.slice(2),
      contracts = join(root, "tests/contract");
    if (args[0] === "--lock") {
      if (args.length !== 1) throw new Error("--lock does not accept test arguments");
      run(contracts, "npm", [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ]);
    } else {
      const workers = workerArguments(args);
      node(root, "scripts/build.mjs");
      node(contracts, "node_modules/typescript/bin/tsc");
      node(contracts, "node_modules/vitest/vitest.mjs", ["run", ...workers]);
    }
  } catch (error) {
    console.error("contract: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
