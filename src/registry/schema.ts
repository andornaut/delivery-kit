// var/registry.json schema version 1, shared by delivery-kit and the game-sessions skills.
// The skills own every field except operations.*.lastAdoption, which delivery-kit writes.
// Registry state records ownership; it never proves activation on its own.
import { type GameDevConfig, roleKeys } from "../layout.ts";
import {
  checkArray,
  checkEnum,
  checkInteger,
  checkMap,
  checkName,
  checkObject,
  checkRelativePath,
  checkString,
  ID_PATTERN,
  Issues,
  UUID_PATTERN,
} from "../validate.ts";

export const HARNESSES = ["claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export const TRANSFER_PHASES = ["source-held", "accepted", "active-confirmed"] as const;
export type TransferPhase = (typeof TRANSFER_PHASES)[number];

export interface Activation {
  readonly marker: string;
  /** Path relative to game-dev, for example var/handoffs/<file>. */
  readonly checkpoint?: string;
}

export interface RoleRecord {
  readonly ownership: string;
  /** Worktree relative to game-dev. */
  readonly worktree: string;
  readonly branch?: string;
  /** Conversation ID per harness. A harness flip keeps the other harness's IDs. */
  readonly conversations: Readonly<Partial<Record<Harness, string | null>>>;
  readonly phase?: string;
  readonly activation?: Activation;
  readonly duties?: readonly string[];
}

export interface Adoption {
  readonly at: string;
  readonly version: string;
  /** sha256 of the loaded dist/cli.js. */
  readonly cliSha256: string;
  /** Lockfile integrity of the installed package. */
  readonly integrity?: string;
}

export interface Operation {
  /** Role key or duty name of the bus operator. */
  readonly busOwner: string;
  readonly activation?: { readonly marker: string };
  readonly lastAdoption?: Adoption;
}

export interface Transfer {
  readonly marker: string;
  readonly from: Harness;
  readonly to: Harness;
  readonly phase: TransferPhase;
  readonly roles: readonly string[];
  readonly checkpoint: string;
}

export interface Registry {
  readonly schema: 1;
  readonly revision: number;
  readonly updatedAt: string;
  readonly harness: Harness;
  readonly host: { readonly nativeProjectId: string; readonly root: string };
  readonly roles: Readonly<Record<string, RoleRecord>>;
  readonly operations: Readonly<Record<string, Operation>>;
  readonly transfers: readonly Transfer[];
}

/** A registry as a mutate callback sees it: a private deep copy it may change in place. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
export type RegistryDraft = Mutable<Registry>;

const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ROLE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}(\/[a-z0-9][a-z0-9-]{0,63})?$/;

function checkTimestamp(issues: Issues, at: string, value: unknown): void {
  if (checkString(issues, at, ISO_UTC_PATTERN, value) && Number.isNaN(Date.parse(value))) {
    issues.add(at, "must be a valid UTC timestamp");
  }
}

function checkActivation(issues: Issues, at: string, value: unknown): void {
  if (checkObject(issues, at, { optional: ["checkpoint"], required: ["marker"] }, value)) {
    checkString(issues, `${at}/marker`, TOKEN_PATTERN, value.marker);
    if (value.checkpoint !== undefined) {
      checkRelativePath(issues, `${at}/checkpoint`, value.checkpoint);
    }
  }
}

function checkConversations(issues: Issues, at: string, value: unknown): void {
  if (!checkObject(issues, at, { optional: HARNESSES, required: [] }, value)) {
    return;
  }
  for (const harness of HARNESSES) {
    const id = value[harness];
    if (id !== undefined && id !== null) {
      checkString(issues, `${at}/${harness}`, UUID_PATTERN, id);
    }
  }
}

function checkRole(issues: Issues, at: string, value: unknown): void {
  const shape = {
    optional: ["branch", "phase", "activation", "duties"],
    required: ["ownership", "worktree", "conversations"],
  };
  if (!checkObject(issues, at, shape, value)) {
    return;
  }
  checkString(issues, `${at}/ownership`, TOKEN_PATTERN, value.ownership);
  checkRelativePath(issues, `${at}/worktree`, value.worktree);
  if (value.branch !== undefined) {
    checkName(issues, `${at}/branch`, /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,128}$/, value.branch);
  }
  checkConversations(issues, `${at}/conversations`, value.conversations);
  if (value.phase !== undefined) {
    checkString(issues, `${at}/phase`, TOKEN_PATTERN, value.phase);
  }
  if (value.activation !== undefined) {
    checkActivation(issues, `${at}/activation`, value.activation);
  }
  if (
    value.duties !== undefined &&
    checkArray(issues, `${at}/duties`, { unique: true }, value.duties)
  ) {
    value.duties.forEach((duty, index) =>
      checkString(issues, `${at}/duties/${index}`, ID_PATTERN, duty),
    );
  }
}

function checkOperation(issues: Issues, at: string, value: unknown): void {
  if (
    !checkObject(
      issues,
      at,
      { optional: ["activation", "lastAdoption"], required: ["busOwner"] },
      value,
    )
  ) {
    return;
  }
  checkString(issues, `${at}/busOwner`, ROLE_KEY_PATTERN, value.busOwner);
  if (
    value.activation !== undefined &&
    checkObject(issues, `${at}/activation`, { required: ["marker"] }, value.activation)
  ) {
    checkString(issues, `${at}/activation/marker`, TOKEN_PATTERN, value.activation.marker);
  }
  const adoption = value.lastAdoption;
  const shape = { optional: ["integrity"], required: ["at", "version", "cliSha256"] };
  if (adoption !== undefined && checkObject(issues, `${at}/lastAdoption`, shape, adoption)) {
    checkTimestamp(issues, `${at}/lastAdoption/at`, adoption.at);
    checkString(issues, `${at}/lastAdoption/version`, TOKEN_PATTERN, adoption.version);
    checkString(issues, `${at}/lastAdoption/cliSha256`, SHA256_PATTERN, adoption.cliSha256);
    if (adoption.integrity !== undefined) {
      checkString(
        issues,
        `${at}/lastAdoption/integrity`,
        /^sha512-[A-Za-z0-9+/]+={0,2}$/,
        adoption.integrity,
      );
    }
  }
}

function checkTransfer(issues: Issues, at: string, value: unknown): void {
  const shape = { required: ["marker", "from", "to", "phase", "roles", "checkpoint"] };
  if (!checkObject(issues, at, shape, value)) {
    return;
  }
  checkString(issues, `${at}/marker`, TOKEN_PATTERN, value.marker);
  checkEnum(issues, `${at}/from`, HARNESSES, value.from);
  checkEnum(issues, `${at}/to`, HARNESSES, value.to);
  checkEnum(issues, `${at}/phase`, TRANSFER_PHASES, value.phase);
  if (checkArray(issues, `${at}/roles`, { nonEmpty: true, unique: true }, value.roles)) {
    value.roles.forEach((role, index) =>
      checkString(issues, `${at}/roles/${index}`, ROLE_KEY_PATTERN, role),
    );
  }
  checkRelativePath(issues, `${at}/checkpoint`, value.checkpoint);
}

function checkStructure(issues: Issues, value: unknown): value is Registry {
  const shape = {
    required: [
      "schema",
      "revision",
      "updatedAt",
      "harness",
      "host",
      "roles",
      "operations",
      "transfers",
    ],
  };
  if (!checkObject(issues, "", shape, value)) {
    return false;
  }
  if (value.schema !== 1) {
    issues.add("/schema", "must be 1");
  }
  checkInteger(issues, "/revision", { min: 0 }, value.revision);
  checkTimestamp(issues, "/updatedAt", value.updatedAt);
  checkEnum(issues, "/harness", HARNESSES, value.harness);
  if (checkObject(issues, "/host", { required: ["nativeProjectId", "root"] }, value.host)) {
    checkString(issues, "/host/nativeProjectId", TOKEN_PATTERN, value.host.nativeProjectId);
    checkRelativePath(issues, "/host/root", value.host.root);
  }
  if (checkMap(issues, "/roles", value.roles)) {
    for (const [key, role] of Object.entries(value.roles)) {
      if (!ROLE_KEY_PATTERN.test(key)) {
        issues.add(`/roles/${key}`, "role key must be <game>/<role> or a shared role name");
      }
      checkRole(issues, `/roles/${key}`, role);
    }
  }
  if (checkMap(issues, "/operations", value.operations)) {
    for (const [game, operation] of Object.entries(value.operations)) {
      checkOperation(issues, `/operations/${game}`, operation);
    }
  }
  if (checkArray(issues, "/transfers", {}, value.transfers)) {
    value.transfers.forEach((transfer, index) =>
      checkTransfer(issues, `/transfers/${index}`, transfer),
    );
  }
  return issues.list.length === 0;
}

/** Keys and names must agree with config.json: role keys, games, duties and role references. */
function checkAgainstConfig(issues: Issues, config: GameDevConfig, registry: Registry): void {
  const keys = new Set(roleKeys(config));
  const duties = new Set<string>();
  for (const [key, role] of Object.entries(registry.roles)) {
    if (!keys.has(key)) {
      issues.add(`/roles/${key}`, "is not a role in config.json");
    }
    for (const duty of role.duties ?? []) {
      if (keys.has(duty)) {
        issues.add(`/roles/${key}/duties`, `duty ${duty} must not be a role key`);
      }
      duties.add(duty);
    }
  }
  const known = (name: string): boolean => Object.hasOwn(registry.roles, name) || duties.has(name);
  for (const [game, operation] of Object.entries(registry.operations)) {
    if (!Object.hasOwn(config.games, game)) {
      issues.add(`/operations/${game}`, "is not a game in config.json");
    }
    if (!known(operation.busOwner)) {
      issues.add(`/operations/${game}/busOwner`, "is not a registered role or duty");
    }
  }
  registry.transfers.forEach((transfer, index) =>
    transfer.roles.forEach((role, roleIndex) => {
      if (!keys.has(role)) {
        issues.add(`/transfers/${index}/roles/${roleIndex}`, "is not a role in config.json");
      }
    }),
  );
}

/** Validate a version 1 registry; with `config`, also check its keys against config.json. */
export function validateRegistry(config: GameDevConfig | undefined, value: unknown): Registry {
  const issues = new Issues();
  if (checkStructure(issues, value) && config !== undefined) {
    checkAgainstConfig(issues, config, value);
  }
  issues.throwIfAny("registry.json");
  return value as Registry;
}

export const RegistrySchema = { validate: validateRegistry, version: 1 } as const;
