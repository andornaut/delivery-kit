// Reporting-only resource information (resource-report.sh). Worktrees, branches and containers
// are never removed here.
import { appendFileSync } from "node:fs";
import { loadavg, uptime } from "node:os";

import type { BusContext } from "./context.ts";
import { zonedParts } from "./time.ts";

function clockLine(timezone: string, epoch: number): string {
  const p = zonedParts(timezone, epoch);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${pad(p.minute)}:${pad(p.second)} ${p.zone}`;
}

/** uptime(1)'s up-time and load averages, read from node:os rather than a child process. */
export function uptimeLine(seconds: number, loads: readonly number[]): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const up = `${days > 0 ? `${days} day${days === 1 ? "" : "s"}, ` : ""}${hours}:${String(minutes).padStart(2, "0")}`;
  return `up ${up},  load average: ${loads.map((load) => load.toFixed(2)).join(", ")}`;
}

export async function resourceReport(context: BusContext): Promise<string> {
  const lines = [
    clockLine(context.config.schedule.timezone, context.clock.now()),
    uptimeLine(uptime(), loadavg()),
  ];
  const containers = await context
    .exec({
      args: [
        "ps",
        "--filter",
        `label=game-bus=${context.config.git.github}`,
        "--format",
        "{{.Names}} {{.Status}}",
      ],
      command: "docker",
    })
    .catch(() => undefined);
  if (containers?.status === 0) {
    lines.push(...containers.stdout.split("\n").filter((line) => line !== ""));
  }
  return `${lines.join("\n")}\n`;
}

/** The runner's 1800 s reporting-only sampler, appending to resources.log until stopped. */
export async function sampleResources(context: BusContext, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      // The sampler is sequential by design.
      // eslint-disable-next-line no-await-in-loop
      appendFileSync(context.paths.resourcesLog, await resourceReport(context), { mode: 0o600 });
    } catch (error) {
      context.log(`bus: resource sample failed: ${String(error)}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await context.clock.sleep(1800, signal);
  }
}
