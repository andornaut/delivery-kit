#!/usr/bin/env node
// Preserve flock's inherited open file description and record successful event flush admission.
import { spawnSync } from "node:child_process";
import { appendFileSync, readlinkSync } from "node:fs";

const result = spawnSync("/usr/bin/flock", process.argv.slice(2), {
  stdio: ["inherit", "inherit", "inherit", 3],
});
if (result.error) throw result.error;
if (result.status === 0 && readlinkSync("/proc/self/fd/3") === process.env.DK_EVENT_LOCK) {
  appendFileSync(process.env.DK_EVENT_PASSES, "pass\n");
}
process.exit(result.status ?? 1);
