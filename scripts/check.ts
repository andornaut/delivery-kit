// Compatibility entry point for the Make container interface.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync("make", ["check"], { cwd: root, stdio: "inherit" });
process.exitCode = result.status ?? 1;
