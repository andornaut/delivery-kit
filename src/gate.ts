// The isolated gate for one integrated tree (merge.sh run and gate_script). The install step
// has network access; every gate step then runs in a fresh container with no network.
// Containers run as the invoking user, the npm cache is created before it is mounted, and
// every bind mount uses --mount so a missing source fails.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import type { BusContext } from "./bus/context.ts";
import type { ExecResult } from "./bus/exec.ts";
import type { GateStep } from "./config.ts";
import { bindMount, cacheMount, currentUser, userArgs } from "./container.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The step log name: a two-digit index and the step name with unsafe characters replaced. */
export function stepLogName(index: number, name: string): string {
  return `${String(index).padStart(2, "0")}-${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`;
}

/** One `sh -c` script running every step in order, logging each to /gate-logs. */
export function gateScript(steps: readonly GateStep[]): string {
  const lines = ["set -e"];
  steps.forEach((step, index) => {
    const log = shellQuote(`/gate-logs/${stepLogName(index + 1, step.name)}`);
    lines.push(
      `printf "%s " ${shellQuote(step.name)}; { ${step.run}; } >${log} 2>&1 || ` +
        `{ echo FAIL; tail -30 ${log}; exit 1; }; echo ok`,
    );
  });
  return `${lines.join("\n")}\n`;
}

/** docker run arguments shared by the install and gate containers. */
export function containerArgs(context: BusContext, work: string, sha: string): string[] {
  const { config } = context;
  return [
    "run",
    "--rm",
    "--label",
    `game-bus=${config.git.github}`,
    "--cpus",
    String(config.resources.cpus),
    ...userArgs(currentUser()),
    ...bindMount({}, work, "/app"),
    "-w",
    "/app",
    "--tmpfs",
    "/tmp:exec",
    "-e",
    `WORKERS_CI_COMMIT_SHA=${sha}`,
    ...cacheMount(context.paths.npmCache),
  ];
}

export function installArgs(context: BusContext, work: string, sha: string): string[] {
  return [
    ...containerArgs(context, work, sha),
    context.config.gate.image,
    "sh",
    "-c",
    context.config.gate.install,
  ];
}

export function gateArgs(context: BusContext, work: string, sha: string, logs: string): string[] {
  return [
    ...containerArgs(context, work, sha),
    ...bindMount({}, logs, "/gate-logs"),
    "--network",
    "none",
    context.config.gate.image,
    "sh",
    "-c",
    gateScript(context.config.gate.steps),
  ];
}

/**
 * Digest of Git status plus the content of every file it reports, tracked and untracked, never
 * ignored stores (bus-common.sh fingerprint). Compared before and after the gate.
 */
export async function treeFingerprint(context: BusContext, work: string): Promise<string> {
  // Untrimmed: a porcelain row may begin with a space.
  const status = await context.exec({
    args: ["-C", work, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    command: "git",
  });
  if (status.status !== 0) {
    throw new Error(`git status failed in ${work}: ${status.stderr.trim()}`);
  }
  const raw = status.stdout;
  const rows = raw.split("\0");
  const names: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? "";
    if (row === "") {
      continue;
    }
    names.push(row.slice(3));
    if (/[RC]/.test(row.slice(0, 2))) {
      index += 1;
      names.push(rows[index] ?? "");
    }
  }
  const digest = createHash("sha256").update(raw);
  for (const name of names) {
    const path = join(work, name);
    digest.update(`\0${name}\0`);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        digest.update(`link:${readlinkSync(path)}`);
      } else if (stat.isFile()) {
        digest.update(readFileSync(path));
      } else {
        digest.update("missing");
      }
    } catch {
      digest.update("missing");
    }
  }
  return digest.digest("hex");
}

export type GateOutcome =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly stage: "full-gate" | "install"; readonly reason: string };

/** Run install then the offline gate; `logs` is this attempt's gate-logs directory. */
export async function runGate(
  context: BusContext,
  work: string,
  sha: string,
  logs: string,
): Promise<GateOutcome> {
  if (context.config.gate.install !== "") {
    const install: ExecResult = await context.exec({
      args: installArgs(context, work, sha),
      command: "docker",
      logFile: join(logs, "install.log"),
    });
    if (install.status !== 0) {
      return {
        ok: false,
        reason: `install FAIL; see ${join(logs, "install.log")}`,
        stage: "install",
      };
    }
  }
  const gate = await context.exec({ args: gateArgs(context, work, sha, logs), command: "docker" });
  if (gate.status !== 0) {
    return { ok: false, reason: `${gate.stdout}${gate.stderr}`.trim(), stage: "full-gate" };
  }
  return { ok: true, output: gate.stdout };
}
