// The isolated gate for one integrated tree.
//
// One container per batch, named deterministically and labelled with its game, runs as uid
// 19001 with no host mount. The host copies the exact commit in (git archive, docker cp),
// the install step runs with network access, the container is then disconnected from every
// network, and the gate steps run. The host copies the gate logs and dist/ out with docker cp
// and removes the container, also after a failure or timeout. The npm cache lives in the
// game's named volume. Host worktree files are not readable by uid 19001 (umask 007), so the
// checkout is copied in rather than bind-mounted.
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { BusContext } from "./bus/context.ts";
import { type ExecResult, git } from "./bus/exec.ts";
import type { GateStep } from "./config.ts";
import { npmCacheArgs, npmVolume, userArgs } from "./container.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The step log name: a two-digit index and the step name with unsafe characters replaced. */
export function stepLogName(index: number, name: string): string {
  return `${String(index).padStart(2, "0")}-${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`;
}

/** The container paths: the copied checkout, the step logs and the incoming archive. */
export const GATE_WORK = "/tmp/work";
export const GATE_LOGS = "/tmp/gate-logs";
const SOURCE_TAR = "/tmp/source.tar";
export const GATE_LABEL = "delivery-kit-gate";
/** An upper bound for install and for the gate steps; the container is removed after it. */
export const GATE_TIMEOUT_SECONDS = 4 * 3600;

/** One `sh -c` script running every step in order, logging each to GATE_LOGS. */
export function gateScript(steps: readonly GateStep[]): string {
  const lines = ["set -e", `cd ${GATE_WORK}`];
  steps.forEach((step, index) => {
    const log = shellQuote(`${GATE_LOGS}/${stepLogName(index + 1, step.name)}`);
    lines.push(
      `printf "%s " ${shellQuote(step.name)}; { ${step.run}; } >${log} 2>&1 || ` +
        `{ echo FAIL; tail -30 ${log}; exit 1; }; echo ok`,
    );
  });
  return `${lines.join("\n")}\n`;
}

/**
 * Digest of Git status plus the content of every file it reports, tracked and untracked, never
 * ignored stores. Compared before and after the gate.
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

/** The deterministic container name of one batch's gate. */
export function gateContainerName(game: string, batch: string): string {
  return `delivery-kit-gate-${game}-${batch}`;
}

export function createArgs(context: BusContext, name: string, sha: string): string[] {
  const { config, game } = context;
  return [
    "create",
    "--name",
    name,
    "--label",
    `${GATE_LABEL}=${game.id}`,
    "--label",
    `game-bus=${config.git.github}`,
    "--cpus",
    String(config.resources.cpus),
    ...userArgs(),
    "-e",
    `WORKERS_CI_COMMIT_SHA=${sha}`,
    ...npmCacheArgs(npmVolume(game.id)),
    config.gate.image,
    "sleep",
    "infinity",
  ];
}

function docker(
  context: BusContext,
  args: readonly string[],
  logFile?: string,
  timeoutMs?: number,
): Promise<ExecResult> {
  return context.exec({
    args,
    command: "docker",
    ...(logFile === undefined ? {} : { logFile }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/**
 * Remove every gate container left for this game, for example by a stopped runner. Called
 * under merge.lock, so no gate of this game is running.
 */
export async function removeLeftoverGates(context: BusContext): Promise<string[]> {
  const listed = await docker(context, [
    "ps",
    "--all",
    "--filter",
    `label=${GATE_LABEL}=${context.game.id}`,
    "--format",
    "{{.Names}}",
  ]);
  const names = listed.status === 0 ? listed.stdout.split("\n").filter((name) => name !== "") : [];
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    await docker(context, ["rm", "--force", name]);
  }
  return names;
}

export interface GateInput {
  /** The scratch worktree; dist/ is copied back into it. */
  readonly work: string;
  readonly sha: string;
  /** This attempt's gate-logs directory on the host. */
  readonly logs: string;
  readonly batch: string;
}

export type GateOutcome =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly stage: "full-gate" | "install"; readonly reason: string };

function failed(stage: "full-gate" | "install", reason: string): GateOutcome {
  return { ok: false, reason, stage };
}

function timedOut(result: ExecResult): boolean {
  return result.status === null;
}

async function copyIn(context: BusContext, name: string, input: GateInput): Promise<boolean> {
  const archive = join(input.logs, "source.tar");
  await git(context.exec, input.work, ["archive", "--format=tar", "-o", archive, "HEAD"]);
  try {
    // docker cp keeps the mode; the copy is root-owned in the container, so it must be world-readable.
    chmodSync(archive, 0o644);
    if ((await docker(context, ["cp", archive, `${name}:${SOURCE_TAR}`])).status !== 0) {
      return false;
    }
  } finally {
    unlinkSync(archive);
  }
  const unpack = `mkdir -p ${GATE_WORK} ${GATE_LOGS} && tar -xf ${SOURCE_TAR} -C ${GATE_WORK} && rm ${SOURCE_TAR}`;
  return (await docker(context, ["exec", name, "sh", "-c", unpack])).status === 0;
}

async function copyOut(
  context: BusContext,
  name: string,
  input: GateInput,
  built: boolean,
): Promise<void> {
  await docker(context, ["cp", "--quiet", `${name}:${GATE_LOGS}/.`, input.logs]);
  if (
    built &&
    (await docker(context, ["exec", name, "test", "-d", `${GATE_WORK}/dist`])).status === 0
  ) {
    mkdirSync(join(input.work, "dist"), { recursive: true });
    const copied = await docker(context, [
      "cp",
      "--quiet",
      `${name}:${GATE_WORK}/dist/.`,
      join(input.work, "dist"),
    ]);
    if (copied.status !== 0) {
      throw new Error(`docker cp of dist/ failed: ${copied.stderr.trim()}`);
    }
  }
}

async function gate(context: BusContext, name: string, input: GateInput): Promise<GateOutcome> {
  const { gate: settings } = context.config;
  const timeoutMs = GATE_TIMEOUT_SECONDS * 1000;
  if ((await docker(context, createArgs(context, name, input.sha))).status !== 0) {
    return failed("install", "gate container could not be created");
  }
  if (
    (await docker(context, ["start", name])).status !== 0 ||
    !(await copyIn(context, name, input))
  ) {
    return failed("install", "gate container could not receive the checkout");
  }
  if (settings.install !== "") {
    const log = join(input.logs, "install.log");
    const install = await docker(
      context,
      ["exec", name, "sh", "-c", `cd ${GATE_WORK} && ${settings.install}`],
      log,
      timeoutMs,
    );
    if (install.status !== 0) {
      return failed("install", `install ${timedOut(install) ? "TIMED OUT" : "FAIL"}; see ${log}`);
    }
  }
  // Every gate step runs without network: disconnect, then confirm only loopback remains.
  await docker(context, ["network", "disconnect", "bridge", name]);
  const offline = await docker(context, [
    "exec",
    name,
    "sh",
    "-c",
    'test "$(ls /sys/class/net)" = lo',
  ]);
  if (offline.status !== 0) {
    return failed("full-gate", "gate container still has a network interface; gate not run");
  }
  const result = await docker(
    context,
    ["exec", name, "sh", "-c", gateScript(settings.steps)],
    undefined,
    timeoutMs,
  );
  if (result.status !== 0) {
    const detail = timedOut(result) ? "gate TIMED OUT" : `${result.stdout}${result.stderr}`.trim();
    return failed("full-gate", detail);
  }
  return { ok: true, output: result.stdout };
}

/**
 * Run install then the offline gate in one batch container, copy results out and remove it.
 * `verify` runs after a passing gate and returns a reason to discard it.
 */
export async function runGate(
  context: BusContext,
  input: GateInput,
  verify: () => Promise<string | undefined> = () => Promise.resolve(undefined),
): Promise<GateOutcome> {
  await removeLeftoverGates(context);
  const name = gateContainerName(context.game.id, input.batch);
  let outcome: GateOutcome = failed("install", "gate did not start");
  try {
    outcome = await gate(context, name, input);
    if (outcome.ok) {
      // Checked before dist/ is copied into the worktree, so the copy is not a change.
      const problem = await verify();
      if (problem !== undefined) {
        outcome = failed("full-gate", problem);
      }
    }
    // Logs are copied out whatever the outcome; dist/ only from a passing, verified gate.
    await copyOut(context, name, input, outcome.ok);
  } catch (error) {
    outcome = failed(
      outcome.ok ? "full-gate" : outcome.stage,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await docker(context, ["rm", "--force", name]);
  }
  return outcome;
}
