// A game's committed delivery-kit.json. It holds project values only: no conversation IDs,
// absolute paths or secret material. Reports address roles by name; the registry resolves them.
import { readJson } from "./durable.ts";
import {
  checkArray,
  checkBoolean,
  checkEnum,
  checkInteger,
  checkName,
  checkObject,
  checkString,
  checkTimezone,
  Issues,
  type Json,
} from "./validate.ts";

export interface GateStep {
  readonly name: string;
  readonly run: string;
}

export type DeployMode = "none" | "wrangler";

export interface ProjectConfig {
  readonly schema: 1;
  readonly git: { readonly main: string; readonly remote: string; readonly github: string };
  readonly schedule: {
    readonly departures: readonly string[];
    /** Defaults to the game-dev config.json timezone when omitted. */
    readonly timezone?: string;
  };
  /**
   * Any image and any install command: a Node-only image with `npm ci` is as valid as any other.
   * An empty install skips the install step; empty steps run a gate with no checks.
   */
  readonly gate: {
    readonly image: string;
    readonly install: string;
    readonly steps: readonly GateStep[];
  };
  readonly resources: {
    readonly cpus: number;
    /** Departures start only below this one-minute load; 0 holds every departure. */
    readonly loadLimit: number;
  };
  readonly ci: {
    readonly requiredNames: readonly string[];
    readonly pollSeconds: number;
    readonly timeoutSeconds: number;
  };
  readonly deploy: { readonly mode: DeployMode; readonly skipPattern?: string };
  readonly reports: {
    /** The game's display name, matching config.json. */
    readonly project: string;
    readonly scheduledTicks: boolean;
    /** A registry role key or duty name, for example "monitor". */
    readonly recipient: string;
    readonly workerParents: readonly string[];
  };
}

/** The resource ceiling every gate observes: at most four CPUs, start below load 24. */
export const RESOURCE_LIMITS = { cpus: 4, loadLimit: 24 } as const;

const BRANCH_PATTERN = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,128}$/;
const GITHUB_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const MINUTE_PATTERN = /^[0-5][0-9]$/;
const STEP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CHECK_NAME_PATTERN = /^[^|]{1,128}$/;
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/;
// A role key (`<game>/<role>`) or a shared role or duty name.
export const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63})?$/;
// An inline assignment of secret-like material in a command, such as `TOKEN=x npm ci`.
const INLINE_SECRET_PATTERN =
  /(^|\s)[A-Za-z_]*(SECRET|TOKEN|PASSW|API_?KEY|CREDENTIAL)[A-Za-z_]*=/i;

function checkCommand(issues: Issues, at: string, value: unknown, allowEmpty = false): void {
  if (allowEmpty && value === "") {
    return;
  }
  if (checkString(issues, at, null, value) && INLINE_SECRET_PATTERN.test(value)) {
    issues.add(
      at,
      "must not assign secret-like values; use the operator's existing authentication",
    );
  }
}

function checkGit(issues: Issues, value: unknown): void {
  if (checkObject(issues, "/git", { required: ["main", "remote", "github"] }, value)) {
    checkName(issues, "/git/main", BRANCH_PATTERN, value.main);
    checkName(issues, "/git/remote", BRANCH_PATTERN, value.remote);
    checkName(issues, "/git/github", GITHUB_PATTERN, value.github);
  }
}

function checkSchedule(issues: Issues, value: unknown): void {
  const shape = { optional: ["timezone"], required: ["departures"] };
  if (checkObject(issues, "/schedule", shape, value)) {
    if (
      checkArray(issues, "/schedule/departures", { nonEmpty: true, unique: true }, value.departures)
    ) {
      value.departures.forEach((minute, index) =>
        checkString(issues, `/schedule/departures/${index}`, MINUTE_PATTERN, minute),
      );
    }
    if (value.timezone !== undefined) {
      checkTimezone(issues, "/schedule/timezone", value.timezone);
    }
  }
}

function checkGate(issues: Issues, value: unknown): void {
  if (!checkObject(issues, "/gate", { required: ["image", "install", "steps"] }, value)) {
    return;
  }
  checkName(issues, "/gate/image", IMAGE_PATTERN, value.image);
  checkCommand(issues, "/gate/install", value.install, true);
  if (!checkArray(issues, "/gate/steps", {}, value.steps)) {
    return;
  }
  const names = new Set<string>();
  value.steps.forEach((step, index) => {
    const at = `/gate/steps/${index}`;
    if (checkObject(issues, at, { required: ["name", "run"] }, step)) {
      if (checkString(issues, `${at}/name`, STEP_NAME_PATTERN, step.name)) {
        if (names.has(step.name)) {
          issues.add(`${at}/name`, "duplicates an earlier step name");
        }
        names.add(step.name);
      }
      checkCommand(issues, `${at}/run`, step.run);
    }
  });
}

function checkResources(issues: Issues, value: unknown): void {
  if (!checkObject(issues, "/resources", { required: ["cpus", "loadLimit"] }, value)) {
    return;
  }
  checkInteger(issues, "/resources/cpus", { max: RESOURCE_LIMITS.cpus, min: 1 }, value.cpus);
  const load = value.loadLimit;
  if (
    typeof load !== "number" ||
    !Number.isFinite(load) ||
    load < 0 ||
    load > RESOURCE_LIMITS.loadLimit
  ) {
    issues.add(
      "/resources/loadLimit",
      `must be a number from 0 through ${RESOURCE_LIMITS.loadLimit}`,
    );
  }
}

function checkCi(issues: Issues, value: unknown): void {
  if (
    !checkObject(
      issues,
      "/ci",
      { required: ["requiredNames", "pollSeconds", "timeoutSeconds"] },
      value,
    )
  ) {
    return;
  }
  if (
    checkArray(issues, "/ci/requiredNames", { nonEmpty: true, unique: true }, value.requiredNames)
  ) {
    value.requiredNames.forEach((name, index) =>
      checkName(issues, `/ci/requiredNames/${index}`, CHECK_NAME_PATTERN, name),
    );
  }
  checkInteger(issues, "/ci/pollSeconds", { max: 3600, min: 1 }, value.pollSeconds);
  checkInteger(issues, "/ci/timeoutSeconds", { max: 86400, min: 1 }, value.timeoutSeconds);
}

function checkDeploy(issues: Issues, value: unknown): void {
  if (!checkObject(issues, "/deploy", { optional: ["skipPattern"], required: ["mode"] }, value)) {
    return;
  }
  checkEnum(issues, "/deploy/mode", ["wrangler", "none"], value.mode);
  if (
    value.skipPattern !== undefined &&
    checkString(issues, "/deploy/skipPattern", null, value.skipPattern)
  ) {
    try {
      new RegExp(value.skipPattern);
    } catch {
      issues.add("/deploy/skipPattern", "must be a valid regular expression");
    }
  }
}

function checkReports(issues: Issues, value: unknown): void {
  const shape = { required: ["project", "scheduledTicks", "recipient", "workerParents"] };
  if (!checkObject(issues, "/reports", shape, value)) {
    return;
  }
  checkName(issues, "/reports/project", PROJECT_PATTERN, value.project);
  checkBoolean(issues, "/reports/scheduledTicks", value.scheduledTicks);
  checkName(issues, "/reports/recipient", ROLE_NAME_PATTERN, value.recipient);
  if (checkArray(issues, "/reports/workerParents", { unique: true }, value.workerParents)) {
    value.workerParents.forEach((parent, index) =>
      checkName(issues, `/reports/workerParents/${index}`, ROLE_NAME_PATTERN, parent),
    );
  }
}

export function validateProjectConfig(
  value: unknown,
  subject = "delivery-kit.json",
): ProjectConfig {
  const issues = new Issues();
  const required = ["schema", "git", "schedule", "gate", "resources", "ci", "deploy", "reports"];
  if (checkObject(issues, "", { required }, value)) {
    const config: Json = value;
    if (config.schema !== 1) {
      issues.add("/schema", "must be 1");
    }
    checkGit(issues, config.git);
    checkSchedule(issues, config.schedule);
    checkGate(issues, config.gate);
    checkResources(issues, config.resources);
    checkCi(issues, config.ci);
    checkDeploy(issues, config.deploy);
    checkReports(issues, config.reports);
  }
  issues.throwIfAny(subject);
  return value as unknown as ProjectConfig;
}

export function loadProjectConfig(path: string): ProjectConfig {
  return validateProjectConfig(readJson(path), path);
}

/** Every role name the configuration addresses, for resolution against the registry. */
export function addressedRoles(config: ProjectConfig): string[] {
  return [...new Set([config.reports.recipient, ...config.reports.workerParents])];
}
