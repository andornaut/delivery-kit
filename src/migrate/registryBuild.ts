// CLEANUP (added 2026-11-03): remove with src/migrate/ at convergence (see tree.ts).
//
// Builds the first var/registry.json from the 0.x registry files. Sources are only read. The
// global libraries.json is authoritative; shared-host.json and each game's session files are
// fallbacks and cross-checks, and every disagreement is recorded rather than resolved silently.
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { readJsonIfExists } from "../durable.ts";
import type { Layout } from "../layout.ts";
import {
  type Harness,
  HARNESSES,
  type Operation,
  type Registry,
  type RoleRecord,
  type Transfer,
  type TransferPhase,
} from "../registry/schema.ts";

export interface Source {
  readonly path: string;
  readonly value: unknown;
}

export interface GameSources {
  /** <game>/.claude/session-state/game-sessions.json: Claude conversations per role. */
  readonly sessions?: Source;
  /** <game>/.claude/session-state/game-sessions-project.json: Codex conversations per role. */
  readonly project?: Source;
}

export interface RegistrySources {
  /** ~/.local/state/game-sessions/libraries.json */
  readonly libraries: Source;
  /** game-dev/.claude/session-state/shared-host.json */
  readonly sharedHost?: Source;
  readonly games: Readonly<Record<string, GameSources>>;
}

export interface FieldSource {
  readonly source: string;
  /** Dotted key path inside the source, or a note for derived values. */
  readonly key: string;
}

export interface CheckpointCopy {
  /** Absolute source path. */
  readonly from: string;
  /** Path relative to game-dev, under var/handoffs/. */
  readonly to: string;
}

export interface BuiltRegistry {
  readonly registry: Omit<Registry, "revision" | "updatedAt">;
  /** JSON pointer of each registry field to where its value came from. */
  readonly provenance: Readonly<Record<string, FieldSource>>;
  readonly checkpoints: readonly CheckpointCopy[];
  /** Sources that disagree; the recorded value is the one named in provenance. */
  readonly conflicts: readonly string[];
  /** Source records that have no place in the version 1 registry. */
  readonly skipped: readonly string[];
}

export class RegistryBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryBuildError";
  }
}

const SOURCE_PHASES: Readonly<Record<string, TransferPhase>> = {
  accepted: "accepted",
  "active-confirmed": "active-confirmed",
  "source-held": "source-held",
};

const GAME_DEV_DUTIES = ["monitor", "coordinator"] as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isObject(current) || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function harnessOf(value: unknown): Harness | undefined {
  return (HARNESSES as readonly unknown[]).includes(value) ? (value as Harness) : undefined;
}

function pointer(...parts: string[]): string {
  return `/${parts.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

/** Expand `~/` and resolve relative paths against the home directory, as the 0.x skills wrote them. */
function absolute(home: string, path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    return join(home, path.slice(1));
  }
  return isAbsolute(path) ? path : resolve(home, path);
}

class Builder {
  readonly provenance: Record<string, FieldSource> = {};
  readonly conflicts: string[] = [];
  readonly skipped: string[] = [];
  readonly checkpoints = new Map<string, CheckpointCopy>();
  private readonly layout: Layout;
  private readonly home: string;

  constructor(layout: Layout, home: string) {
    this.layout = layout;
    this.home = home;
  }

  record(field: string, source: Source, key: string): void {
    this.provenance[field] = { key, source: source.path };
  }

  derived(field: string, note: string): void {
    this.provenance[field] = { key: note, source: "migrate" };
  }

  relativePath(path: string): string {
    return relative(this.layout.root, absolute(this.home, path)) || ".";
  }

  /** Map a checkpoint to var/handoffs/<basename>. Two different files with one name stop the build. */
  checkpoint(path: string): string {
    const from = absolute(this.home, path);
    const to = relative(this.layout.root, join(this.layout.handoffsDir, basename(from)));
    for (const copy of this.checkpoints.values()) {
      if (copy.to === to && copy.from !== from) {
        throw new RegistryBuildError(`checkpoints ${copy.from} and ${from} share the name ${to}`);
      }
    }
    this.checkpoints.set(from, { from, to });
    return to;
  }

  /** Keep `primary` and record a conflict when `secondary` names a different value. */
  crossCheck(
    field: string,
    primary: string | undefined,
    secondary: { source: Source; key: string; value: unknown },
  ): void {
    const other = text(secondary.value);
    if (primary !== undefined && other !== undefined && other !== primary) {
      this.conflicts.push(
        `${field}: ${secondary.source.path} ${secondary.key} differs from the recorded value`,
      );
    }
  }
}

function sourceConversations(
  builder: Builder,
  field: string,
  claude: { source: Source; key: string; value: unknown },
  codex: { source: Source; key: string; value: unknown },
): RoleRecord["conversations"] {
  const conversations: Partial<Record<Harness, string>> = {};
  for (const [harness, candidate] of [
    ["claude", claude],
    ["codex", codex],
  ] as const) {
    const id = text(candidate.value);
    if (id !== undefined) {
      conversations[harness] = id;
      builder.record(`${field}/conversations/${harness}`, candidate.source, candidate.key);
    }
  }
  return conversations;
}

function gameRoles(
  builder: Builder,
  claims: Map<string, Harness>,
  layout: Layout,
  sources: RegistrySources,
  roles: Record<string, RoleRecord>,
): void {
  const { libraries } = sources;
  const projects = at(libraries.value, "game-dev", "projects");
  const activeProjects = at(libraries.value, "active_projects");
  for (const [game, entry] of Object.entries(layout.config.games)) {
    const { project, sessions } = sources.games[game] ?? {};
    const projectIndex = Array.isArray(projects)
      ? projects.findIndex((candidate) => at(candidate, "game") === game)
      : -1;
    const repo = resolve(layout.root, entry.path);
    const activeKey = isObject(activeProjects)
      ? Object.keys(activeProjects).find((key) => at(activeProjects, key, "game") === game)
      : undefined;
    for (const role of entry.roles) {
      const key = `${game}/${role}`;
      const field = pointer("roles", key);
      const session = sessions === undefined ? undefined : at(sessions.value, "claude", role);
      const worktree = text(at(session, "worktree"));
      if (sessions === undefined || worktree === undefined) {
        builder.skipped.push(`${key}: no Claude session record with a worktree`);
        continue;
      }
      const libraryCodex =
        Array.isArray(projects) && projectIndex >= 0
          ? at(projects[projectIndex], "providers", "codex", role)
          : undefined;
      const projectCodex = project === undefined ? undefined : at(project.value, "codex", role);
      const codex =
        text(libraryCodex) === undefined && project !== undefined
          ? { key: `codex.${role}`, source: project, value: projectCodex }
          : {
              key: `game-dev.projects[${projectIndex}].providers.codex.${role}`,
              source: libraries,
              value: libraryCodex,
            };
      if (project !== undefined && codex.source === libraries) {
        builder.crossCheck(`${field}/conversations/codex`, text(libraryCodex), {
          key: `codex.${role}`,
          source: project,
          value: projectCodex,
        });
      }
      const record: Mutable<RoleRecord> = {
        conversations: sourceConversations(
          builder,
          field,
          { key: `claude.${role}.session_id`, source: sessions, value: at(session, "session_id") },
          codex,
        ),
        ownership: "inactive",
        worktree: builder.relativePath(worktree),
      };
      builder.record(`${field}/worktree`, sessions, `claude.${role}.worktree`);
      if (activeKey !== undefined && at(activeProjects, activeKey, "active") === true) {
        record.ownership = "active";
        builder.record(`${field}/ownership`, libraries, `active_projects.${activeKey}.active`);
      } else {
        builder.derived(`${field}/ownership`, `no active_projects entry is active for ${repo}`);
      }
      const phase = text(at(session, "phase"));
      if (phase !== undefined) {
        record.phase = phase;
        builder.record(`${field}/phase`, sessions, `claude.${role}.phase`);
        if (phase === "active") {
          claims.set(`${sessions.path} claude.${role}.phase`, "claude");
        }
      }
      const marker = text(at(session, "activation_marker"));
      if (marker !== undefined) {
        record.activation = { marker };
        builder.record(`${field}/activation/marker`, sessions, `claude.${role}.activation_marker`);
      }
      roles[key] = record;
    }
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function libraryRole(
  builder: Builder,
  claims: Map<string, Harness>,
  sources: RegistrySources,
  name: string,
  base: string[],
): RoleRecord | undefined {
  const { libraries, sharedHost } = sources;
  const entry = at(libraries.value, ...base);
  const field = pointer("roles", name);
  const prefix = base.join(".");
  if (!isObject(entry)) {
    builder.skipped.push(`${name}: no ${prefix} entry in ${libraries.path}`);
    return undefined;
  }
  const harness = harnessOf(at(entry, "active_owner", "harness"));
  if (harness !== undefined) {
    claims.set(`${libraries.path} ${prefix}.active_owner.harness`, harness);
  }
  const ownerWorktree =
    text(at(entry, "active_owner", "worktree")) ??
    (harness === undefined ? undefined : text(at(entry, "providers", harness, "worktree")));
  if (ownerWorktree === undefined) {
    builder.skipped.push(`${name}: ${prefix} has no active owner worktree`);
    return undefined;
  }
  const record: Mutable<RoleRecord> = {
    conversations: sourceConversations(
      builder,
      field,
      {
        key: `${prefix}.providers.claude.session_id`,
        source: libraries,
        value: at(entry, "providers", "claude", "session_id"),
      },
      {
        key: `${prefix}.providers.codex.thread_id`,
        source: libraries,
        value: at(entry, "providers", "codex", "thread_id"),
      },
    ),
    ownership: text(at(entry, "ownership")) ?? "inactive",
    worktree: builder.relativePath(ownerWorktree),
  };
  builder.record(`${field}/ownership`, libraries, `${prefix}.ownership`);
  builder.record(
    `${field}/worktree`,
    libraries,
    text(at(entry, "active_owner", "worktree")) === undefined
      ? `${prefix}.providers.${String(harness)}.worktree`
      : `${prefix}.active_owner.worktree`,
  );
  if (sharedHost !== undefined) {
    const sharedKey = name === "game-dev" ? "monitor" : name;
    builder.crossCheck(`${field}/conversations/codex`, record.conversations.codex ?? undefined, {
      key: `roles.${sharedKey}`,
      source: sharedHost,
      value: at(sharedHost.value, "roles", sharedKey),
    });
    builder.crossCheck(`${field}/conversations/claude`, record.conversations.claude ?? undefined, {
      key: `claude_roles.${sharedKey}`,
      source: sharedHost,
      value: at(sharedHost.value, "claude_roles", sharedKey),
    });
  }
  const phase = harness === undefined ? undefined : text(at(entry, "providers", harness, "phase"));
  if (phase !== undefined) {
    record.phase = phase;
    builder.record(`${field}/phase`, libraries, `${prefix}.providers.${String(harness)}.phase`);
  }
  const markerKey =
    text(at(entry, "active_owner", "activation_marker")) === undefined
      ? "confirmation_marker"
      : "activation_marker";
  const marker = text(at(entry, "active_owner", markerKey));
  if (marker !== undefined) {
    const checkpointPath = text(at(entry, "activation_checkpoint"));
    record.activation =
      checkpointPath === undefined
        ? { marker }
        : { checkpoint: builder.checkpoint(checkpointPath), marker };
    builder.record(`${field}/activation/marker`, libraries, `${prefix}.active_owner.${markerKey}`);
    if (checkpointPath !== undefined) {
      builder.record(
        `${field}/activation/checkpoint`,
        libraries,
        `${prefix}.activation_checkpoint`,
      );
    }
  }
  if (name === "game-dev") {
    record.duties = [...GAME_DEV_DUTIES];
    builder.derived(
      `${field}/duties`,
      "the game-dev role carries the monitor and coordinator duties",
    );
  }
  return record;
}

function transfer(
  builder: Builder,
  libraries: Source,
  name: string,
  base: string[],
): Transfer | undefined {
  const entry = at(libraries.value, ...base, "provider_transfer");
  const prefix = `${base.join(".")}.provider_transfer`;
  if (!isObject(entry)) {
    return undefined;
  }
  const marker = text(entry.marker);
  const sourcePhase = text(entry.phase);
  const phase = sourcePhase === undefined ? undefined : SOURCE_PHASES[sourcePhase];
  const from = harnessOf(at(entry, "source", "harness") ?? at(entry, "from", "harness"));
  const to = harnessOf(
    at(entry, "to", "harness") ?? at(libraries.value, ...base, "active_owner", "harness"),
  );
  const checkpointPath = text(entry.checkpoint);
  if (
    marker === undefined ||
    phase === undefined ||
    from === undefined ||
    to === undefined ||
    checkpointPath === undefined
  ) {
    builder.skipped.push(
      `${prefix}: not recorded (needs marker, a known phase, from, to and checkpoint; phase is ${
        sourcePhase ?? "absent"
      })`,
    );
    return undefined;
  }
  return { checkpoint: builder.checkpoint(checkpointPath), from, marker, phase, roles: [name], to };
}

function collectCheckpoints(builder: Builder, libraries: Source): void {
  const owners = [
    ["game-dev"],
    ...Object.keys(at(libraries.value, "libraries") ?? {}).map((kit) => ["libraries", kit]),
  ];
  for (const owner of owners) {
    for (const keys of [
      ["activation_checkpoint"],
      ["source_hold_checkpoint"],
      ["host_transfer", "checkpoint"],
      ["provider_transfer", "checkpoint"],
    ]) {
      const path = text(at(libraries.value, ...owner, ...keys));
      if (path !== undefined) {
        builder.checkpoint(path);
      }
    }
  }
  const operations = at(libraries.value, "game-dev", "bus_operations");
  for (const operation of isObject(operations) ? Object.values(operations) : []) {
    const path = text(at(operation, "checkpoint"));
    if (path !== undefined) {
      builder.checkpoint(path);
    }
  }
}

function chooseHarness(
  builder: Builder,
  claims: Map<string, Harness>,
  override: Harness | undefined,
): Harness {
  const distinct = new Set(claims.values());
  if (override !== undefined) {
    builder.derived("/harness", `operator --harness ${override}`);
    if (distinct.size > 1 || (distinct.size === 1 && !distinct.has(override))) {
      builder.conflicts.push(`/harness: sources claim ${[...distinct].sort().join(" and ")}`);
    }
    return override;
  }
  if (distinct.size !== 1) {
    const listing = [...claims.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([claim, harness]) => `  ${claim}: ${harness}`)
      .join("\n");
    throw new RegistryBuildError(
      `the sources do not agree on one active harness; pass --harness claude|codex\n${listing}`,
    );
  }
  const [harness] = distinct as Set<Harness>;
  builder.derived("/harness", `every active owner record names ${String(harness)}`);
  return harness as Harness;
}

/** Build the registry draft. Throws RegistryBuildError when the sources cannot be reconciled. */
export function buildRegistry(
  layout: Layout,
  home: string,
  harnessOverride: Harness | undefined,
  sources: RegistrySources,
): BuiltRegistry {
  const builder = new Builder(layout, home);
  const { libraries, sharedHost } = sources;
  const claims = new Map<string, Harness>();

  const nativeProjectId = text(at(libraries.value, "host", "native_project_id"));
  if (nativeProjectId === undefined) {
    throw new RegistryBuildError(`${libraries.path}: host.native_project_id is missing`);
  }
  builder.record("/host/nativeProjectId", libraries, "host.native_project_id");
  const sharedId =
    sharedHost === undefined ? undefined : text(at(sharedHost.value, "native_project_id"));
  if (sharedId !== undefined && sharedId !== nativeProjectId) {
    throw new RegistryBuildError(
      `${sharedHost?.path ?? ""}: native_project_id differs from ${libraries.path} host.native_project_id`,
    );
  }
  const hostRoot = text(at(libraries.value, "host", "root"));
  if (hostRoot !== undefined && resolve(absolute(home, hostRoot)) !== layout.root) {
    throw new RegistryBuildError(`${libraries.path}: host.root is not this game-dev root`);
  }
  builder.derived("/host/root", "game-dev is the registry root");

  const roles: Record<string, RoleRecord> = {};
  gameRoles(builder, claims, layout, sources, roles);
  const transfers: Transfer[] = [];
  for (const name of layout.config.sharedRoles) {
    const base = name === "game-dev" ? ["game-dev"] : ["libraries", name];
    const record = libraryRole(builder, claims, sources, name, base);
    if (record !== undefined) {
      roles[name] = record;
      const recorded = transfer(builder, libraries, name, base);
      if (recorded !== undefined) {
        builder.record(
          pointer("transfers", String(transfers.length)),
          libraries,
          `${base.join(".")}.provider_transfer`,
        );
        transfers.push(recorded);
      }
    }
  }

  const operations: Record<string, Operation> = {};
  const busOperations = at(libraries.value, "game-dev", "bus_operations");
  for (const game of Object.keys(layout.config.games)) {
    const field = pointer("operations", game);
    const entry = at(busOperations, game);
    const marker = text(at(entry, "activation_marker"));
    if (at(entry, "ownership") === "active" && Object.hasOwn(roles, "game-dev")) {
      operations[game] =
        marker === undefined
          ? { busOwner: "game-dev" }
          : { activation: { marker }, busOwner: "game-dev" };
      builder.record(`${field}/busOwner`, libraries, `game-dev.bus_operations.${game}.ownership`);
      if (marker !== undefined) {
        builder.record(
          `${field}/activation/marker`,
          libraries,
          `game-dev.bus_operations.${game}.activation_marker`,
        );
      }
    } else if (Object.hasOwn(roles, `${game}/tech`)) {
      operations[game] = { busOwner: `${game}/tech` };
      builder.derived(
        `${field}/busOwner`,
        "no active bus operations transfer: Tech operates the bus",
      );
    }
  }

  collectCheckpoints(builder, libraries);
  const harness = chooseHarness(builder, claims, harnessOverride);
  return {
    checkpoints: [...builder.checkpoints.values()],
    conflicts: builder.conflicts,
    provenance: builder.provenance,
    registry: {
      harness,
      host: { nativeProjectId, root: "." },
      operations,
      roles,
      schema: 1,
      transfers,
    },
    skipped: builder.skipped,
  };
}

/** The 0.x registry files for `layout`, read without modification. Missing optional files are omitted. */
export function readRegistrySources(layout: Layout, env: NodeJS.ProcessEnv): RegistrySources {
  const home = env.HOME ?? homedir();
  const stateHome = env.XDG_STATE_HOME ?? join(home, ".local", "state");
  const librariesPath = join(stateHome, "game-sessions", "libraries.json");
  const libraries = readJsonIfExists(librariesPath);
  if (libraries === undefined) {
    throw new RegistryBuildError(`${librariesPath}: not found`);
  }
  const optional = (path: string): Source | undefined => {
    const value = readJsonIfExists(path);
    return value === undefined ? undefined : { path, value };
  };
  const games: Record<string, GameSources> = {};
  for (const [game, entry] of Object.entries(layout.config.games)) {
    const stateDir = join(resolve(layout.root, entry.path), ".claude", "session-state");
    const sessions = optional(join(stateDir, "game-sessions.json"));
    const project = optional(join(stateDir, "game-sessions-project.json"));
    games[game] = {
      ...(sessions === undefined ? {} : { sessions }),
      ...(project === undefined ? {} : { project }),
    };
  }
  const sharedHost = optional(join(layout.root, ".claude", "session-state", "shared-host.json"));
  return {
    games,
    libraries: { path: librariesPath, value: libraries },
    ...(sharedHost === undefined ? {} : { sharedHost }),
  };
}
