// The isolated gate for one integrated tree.
//
// One container per departure, named deterministically and labelled with its game, runs as uid
// 19001 in the checkout's group. The scratch worktree, checked out at the local main HEAD SHA
// the departure gates, is bound read-only; the container copies it into its own /tmp/work and
// verifies that the copy's tree is the commit's tree, so the gate never writes the checkout and
// runs on the exact commit.
// The install step runs with network access, the container is then disconnected from every
// network, and the gate steps run. The host copies the gate logs out with docker cp, and, from a
// passing and verified gate only, dist/ and node_modules/, so the deployment runs the Wrangler
// locked in the gated commit. The container is removed, also after a failure or timeout. The npm
// cache lives in the game's named volume.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import type { BusContext } from "./bus/context.ts";
import { assertNotInterrupted, type ExecResult, git, Interrupted } from "./bus/exec.ts";
import type { GateStep } from "./config.ts";
import { checkoutMount, npmCacheArgs, npmVolume, userArgs } from "./container.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The step log name: a two-digit index and the step name with unsafe characters replaced. */
export function stepLogName(index: number, name: string): string {
  return `${String(index).padStart(2, "0")}-${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`;
}

/** The container paths: the read-only checkout, its copy and the step logs. */
export const GATE_WORK = "/tmp/work";
export const GATE_LOGS = "/tmp/gate-logs";
export const GATE_SOURCE = "/src";
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

/** The deterministic container name of one departure's gate, keyed by its short HEAD SHA. */
export function gateContainerName(game: string, departure: string): string {
  return `delivery-kit-gate-${game}-${departure}`;
}

export function createArgs(context: BusContext, name: string, input: GateInput): string[] {
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
    ...checkoutMount(input.work, GATE_SOURCE),
    "-e",
    `WORKERS_CI_COMMIT_SHA=${input.sha}`,
    ...npmCacheArgs(npmVolume(game.id)),
    config.gate.image,
    "sleep",
    "infinity",
  ];
}

async function docker(
  context: BusContext,
  args: readonly string[],
  logFile?: string,
  timeoutMs?: number,
): Promise<ExecResult> {
  const result = await context.exec({
    args,
    command: "docker",
    ...(logFile === undefined ? {} : { logFile }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  // A gate stopped by the runner's shutdown is not a gate failure; removal still runs.
  return args[0] === "rm" ? result : assertNotInterrupted(`docker ${args[0] ?? ""}`, result);
}

/**
 * Remove every gate container left for this game, for example by a stopped runner. Called
 * under departure.lock, so no gate of this game is running.
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
  /** The scratch worktree; dist/ and node_modules/ are copied back into it after a pass. */
  readonly work: string;
  readonly sha: string;
  /** This attempt's gate-logs directory on the host. */
  readonly logs: string;
  /** The short departure SHA that names the gate container. */
  readonly departure: string;
}

/**
 * A `step` failure is install or a gate step exiting non-zero inside the running container: the
 * departure records gate-failed for the SHA. An `infrastructure` failure (Docker, the image, the
 * container, its network, a copy or the fingerprint check) records nothing, so the next
 * departure gates the same SHA again.
 */
export type GateOutcome =
  | { readonly ok: true; readonly output: string }
  | {
      readonly ok: false;
      readonly failure: "step";
      readonly stage: "full-gate" | "install";
      readonly reason: string;
    }
  | { readonly ok: false; readonly failure: "infrastructure"; readonly reason: string };

/** `docker exec` exits 125 when Docker itself fails, before or around the command. */
const DOCKER_EXEC_ERROR = 125;

function failed(stage: "full-gate" | "install", reason: string): GateOutcome {
  return { failure: "step", ok: false, reason, stage };
}

function blockedGate(reason: string): GateOutcome {
  return { failure: "infrastructure", ok: false, reason };
}

/** The first line of a Docker diagnostic, or the exit status when it printed none. */
function diagnostic(result: ExecResult): string {
  const line = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row !== "");
  return line ?? (result.status === null ? "no exit status" : `exit ${String(result.status)}`);
}

function timedOut(result: ExecResult): boolean {
  return result.status === null;
}

/** Tools the gate image provides besides sh, for the copy, the loopback check and step logs. */
export const GATE_TOOLS = ["git", "tar", "ls", "tail"] as const;
/** COPY_SCRIPT exit statuses: a required tool is missing (named on stdout), or the tree differs. */
const MISSING_TOOL = 3;
const TREE_MISMATCH = 4;

// Probe the image's tools, copy the read-only checkout (without its .git link) and confirm the
// copy is the commit's tree.
const COPY_SCRIPT = [
  [
    `for tool in ${GATE_TOOLS.join(" ")}; do`,
    `command -v "$tool" >/dev/null 2>&1 || { echo "$tool"; exit ${MISSING_TOOL}; };`,
    "done",
  ].join(" "),
  `mkdir -p ${GATE_WORK} ${GATE_LOGS}`,
  `tar -C ${GATE_SOURCE} --exclude=./.git -cf - . | tar -x -C ${GATE_WORK}`,
  `cd ${GATE_WORK}`,
  "git init -q",
  "git add -A -f",
  "actual=$(git write-tree)",
  "rm -rf .git",
  `{ test "$actual" = "$EXPECTED_TREE" || exit ${TREE_MISMATCH}; }`,
].join(" && ");

/** Copy the checkout in; the reason it could not, or undefined. */
async function copyIn(
  context: BusContext,
  name: string,
  input: GateInput,
): Promise<string | undefined> {
  const tree = await git(context.exec, input.work, ["rev-parse", `${input.sha}^{tree}`]);
  const copy = await docker(context, [
    "exec",
    "-e",
    `EXPECTED_TREE=${tree}`,
    name,
    "sh",
    "-c",
    COPY_SCRIPT,
  ]);
  if (copy.status === 0) {
    return undefined;
  }
  if (copy.status === MISSING_TOOL) {
    const tool = copy.stdout.trim() || "required tool";
    return `the gate image ${context.config.gate.image} has no ${tool}; it needs sh, ${GATE_TOOLS.join(", ")}`;
  }
  if (copy.status === TREE_MISMATCH) {
    return "gate container copy of the checkout does not match the departure commit";
  }
  return `copying the checkout into the gate container failed: ${diagnostic(copy)}`;
}

/** The build outputs a passing, verified gate copies back into the scratch worktree. */
export const GATE_OUTPUTS = ["dist", "node_modules"] as const;

async function copyOut(
  context: BusContext,
  name: string,
  input: GateInput,
  built: boolean,
): Promise<void> {
  await docker(context, ["cp", "--quiet", `${name}:${GATE_LOGS}/.`, input.logs]);
  if (!built) {
    return;
  }
  for (const output of GATE_OUTPUTS) {
    const path = `${GATE_WORK}/${output}`;
    // eslint-disable-next-line no-await-in-loop
    if ((await docker(context, ["exec", name, "test", "-d", path])).status !== 0) {
      continue;
    }
    mkdirSync(join(input.work, output), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    const copied = await docker(context, [
      "cp",
      "--quiet",
      `${name}:${path}/.`,
      join(input.work, output),
    ]);
    if (copied.status !== 0) {
      throw new Error(`docker cp of ${output}/ failed: ${copied.stderr.trim()}`);
    }
  }
}

async function gate(context: BusContext, name: string, input: GateInput): Promise<GateOutcome> {
  const { gate: settings } = context.config;
  const timeoutMs = GATE_TIMEOUT_SECONDS * 1000;
  const created = await docker(context, createArgs(context, name, input));
  if (created.status !== 0) {
    return blockedGate(`docker create of the gate container failed: ${diagnostic(created)}`);
  }
  const started = await docker(context, ["start", name]);
  if (started.status !== 0) {
    return blockedGate(`docker start of the gate container failed: ${diagnostic(started)}`);
  }
  const copyProblem = await copyIn(context, name, input);
  if (copyProblem !== undefined) {
    return blockedGate(copyProblem);
  }
  if (settings.install !== "") {
    const log = join(input.logs, "install.log");
    const install = await docker(
      context,
      ["exec", name, "sh", "-c", `cd ${GATE_WORK} && ${settings.install}`],
      log,
      timeoutMs,
    );
    if (install.status === DOCKER_EXEC_ERROR) {
      return blockedGate(`docker exec of the install step failed; see ${log}`);
    }
    if (install.status !== 0) {
      return failed("install", `install ${timedOut(install) ? "TIMED OUT" : "FAIL"}; see ${log}`);
    }
  }
  // Every gate step runs without network: disconnect, then confirm only loopback remains.
  const detached = await docker(context, ["network", "disconnect", "bridge", name]);
  if (detached.status !== 0) {
    return blockedGate(`docker network disconnect failed: ${diagnostic(detached)}`);
  }
  const offline = await docker(context, [
    "exec",
    name,
    "sh",
    "-c",
    'test "$(ls /sys/class/net)" = lo',
  ]);
  if (offline.status !== 0) {
    return blockedGate("gate container still has a network interface; gate not run");
  }
  const result = await docker(
    context,
    ["exec", name, "sh", "-c", gateScript(settings.steps)],
    undefined,
    timeoutMs,
  );
  if (result.status === DOCKER_EXEC_ERROR) {
    return blockedGate(`docker exec of the gate steps failed: ${diagnostic(result)}`);
  }
  if (result.status !== 0) {
    const detail = timedOut(result) ? "gate TIMED OUT" : `${result.stdout}${result.stderr}`.trim();
    return failed("full-gate", detail);
  }
  return { ok: true, output: result.stdout };
}

/**
 * Run install then the offline gate in one departure container, copy results out and remove it.
 * `verify` runs after a passing gate and returns a reason to discard it.
 */
export async function runGate(
  context: BusContext,
  input: GateInput,
  verify: () => Promise<string | undefined> = () => Promise.resolve(undefined),
): Promise<GateOutcome> {
  await removeLeftoverGates(context);
  const name = gateContainerName(context.game.id, input.departure);
  let outcome: GateOutcome = blockedGate("gate did not start");
  try {
    outcome = await gate(context, name, input);
    if (outcome.ok) {
      // Checked before the outputs are copied into the worktree, so the copy is not a change.
      const problem = await verify();
      if (problem !== undefined) {
        outcome = blockedGate(problem);
      }
    }
    // Logs are copied out whatever the outcome; the outputs only from a passing, verified gate.
    await copyOut(context, name, input, outcome.ok);
  } catch (error) {
    if (error instanceof Interrupted) {
      throw error;
    }
    // A step failure stays one; anything thrown around it (a docker cp, a git read) is not.
    if (outcome.ok || outcome.failure === "infrastructure") {
      outcome = blockedGate(error instanceof Error ? error.message : String(error));
    }
  } finally {
    await docker(context, ["rm", "--force", name]);
  }
  return outcome;
}
