// Image-owned dependencies are linked into scratch before native tools run.
import { existsSync, lstatSync, mkdirSync, readlinkSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { build, lint, run, test, verify } from "./check.ts";

function prepareDependencies(root: string): void {
  for (const [path, target] of [
    [join(root, "node_modules"), "/opt/check/root/node_modules"],
    [join(root, "tests/contract/node_modules"), "/opt/check/contract/node_modules"],
  ] as const) {
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) {
      throw new Error("snapshot dependency directory must be local writable scratch");
    }
    mkdirSync(path, { recursive: true });
    for (const name of readdirSync(target)) {
      const dependency = join(path, name),
        imagePath = join(target, name);
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

try {
  const [action, ...args] = process.argv.slice(2),
    root = process.cwd();
  if (process.env.CHECK_WRITABLE !== "1") prepareDependencies(root);
  if (action === "lint" && args.length === 0) lint(root);
  else if (action === "test") test(root, args);
  else if (action === "build" && args.length === 0) build(root);
  else if (action === "check") verify(root, args);
  else if (action === "exec" && args.length > 0) run(root, args[0]!, args.slice(1));
  else if (action === "exec" && process.env.COMMAND)
    run(root, "/bin/sh", ["-ec", process.env.COMMAND, "command"]);
  else throw new Error("specify a check category or an exec command");
} catch (error) {
  console.error("container-check: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
