// Opt-in Node preload for the real installed CLI. Leave its executable and stdout intact.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const cli = process.env.DK_TRACE_COORDINATOR_CLI;
if (cli !== undefined && process.argv[1] === cli) {
  const argv = process.argv.slice(2);
  const rootAt = argv.indexOf("--root");
  const root = argv[rootAt + 1];
  if (rootAt >= 0 && root !== undefined) {
    const args = argv.filter((_, index) => index !== rootAt && index !== rootAt + 1);
    const dir = join(root, "fake-coordination-kit");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "calls.jsonl"),
      `${JSON.stringify({ args, cwd: process.cwd(), execPath: process.execPath, root })}\n`,
    );
  }
}
