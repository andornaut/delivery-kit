// Every command's options: the one source for argument parsing and for the help text, so a flag a
// command accepts always appears in `delivery-kit --help`.
import type { ParseArgsConfig } from "node:util";

export type Options = NonNullable<ParseArgsConfig["options"]>;

export interface CommandSpec {
  readonly summary: string;
  readonly options: Options;
  /**
   * The accepted forms. Each lists the options it takes in help order; a trailing `?` marks one
   * as optional. Every option appears in at least one form.
   */
  readonly forms: readonly (readonly string[])[];
}

/** The placeholder each string option shows in help. */
const VALUES: Readonly<Record<string, string>> = {
  disposition: "handled|superseded|retained",
  game: "ID",
  "history-cursor": "CURSOR",
  id: "SAFE_ID",
  monitor: "UUID",
  parent: "ROLE|UUID",
  "poll-seconds": "SECONDS",
  "queue-id": "ID",
  reason: "TEXT",
  recipient: "ROLE|UUID",
  snapshot: "UUID",
  "state-dir": "STATE/unblock",
};

/** Help groups, in help order. */
export const GROUPS = {
  game: "game operations",
  harness: "harness (claude, codex)",
  monitor: "monitor (game-dev)",
} as const;

export interface GroupedSpec extends CommandSpec {
  readonly group: keyof typeof GROUPS;
}

const GAME = { game: { type: "string" } } as const;
const MONITOR = {
  ...GAME,
  parent: { multiple: true, type: "string" },
  recipient: { type: "string" },
} as const;
const READY: GroupedSpec = {
  forms: [[]],
  group: "harness",
  options: {},
  summary:
    "probe whether this harness can deliver now; prints one JSON line, exits 0 when ready, 1 when not",
};

/** Commands by their words: a top-level game verb, or a noun group and its verb. */
export const SPECS = {
  "check-config": {
    forms: [["game?"]],
    group: "game",
    options: GAME,
    summary: "validate config.json, var/registry.json and each delivery-kit.json",
  },
  "claude channel": {
    forms: [["game?", "monitor?", "state-dir?", "poll-seconds?"]],
    group: "harness",
    options: {
      game: { multiple: true, type: "string" },
      monitor: { type: "string" },
      "poll-seconds": { type: "string" },
      "state-dir": { multiple: true, type: "string" },
    },
    summary: "the stdio server the Claude monitor session starts; delivers the channel spool",
  },
  "claude ready": READY,
  "codex ready": READY,
  "monitor ack": {
    forms: [["game", "snapshot", "queue-id", "disposition", "reason?", "recipient?", "parent?"]],
    group: "monitor",
    options: {
      ...MONITOR,
      disposition: { type: "string" },
      "queue-id": { multiple: true, type: "string" },
      reason: { type: "string" },
      snapshot: { type: "string" },
    },
    summary: "acknowledge monitor queue items from a snapshot",
  },
  "monitor snapshot": {
    forms: [["game", "recipient?", "parent?", "history-cursor?"]],
    group: "monitor",
    options: { ...MONITOR, "history-cursor": { type: "string" } },
    summary: "capture the monitor review snapshot",
  },
  request: {
    forms: [["game", "id"]],
    group: "game",
    options: { ...GAME, id: { type: "string" } },
    summary: "record a user-authorized one-off departure request",
  },
  run: {
    forms: [["game"]],
    group: "game",
    options: GAME,
    summary: "run one game's resident delivery runner",
  },
  status: {
    forms: [["game", "resources?"]],
    group: "game",
    options: { ...GAME, resources: { type: "boolean" } },
    summary:
      "print the read-only runner and delivery status, or with --resources the resource report",
  },
} as const satisfies Readonly<Record<string, GroupedSpec>>;

export type Command = keyof typeof SPECS;

function flag(spec: CommandSpec, token: string): string {
  const optional = token.endsWith("?");
  const name = optional ? token.slice(0, -1) : token;
  const option = spec.options[name];
  if (option === undefined) {
    throw new Error(`help names an unknown option --${name}`);
  }
  const value = option.type === "string" ? ` ${VALUES[name] ?? "VALUE"}` : "";
  const text = `--${name}${value}${option.multiple === true ? " ..." : ""}`;
  return optional ? `[${text}]` : text;
}

/** One `delivery-kit COMMAND ...` line per accepted form. */
export function synopsis(command: Command): string[] {
  const spec: GroupedSpec = SPECS[command];
  return spec.forms.map((form) => [command, ...form.map((token) => flag(spec, token))].join(" "));
}

/** The usage line a command prints with a usage error. */
export function commandUsage(command: Command): string {
  return synopsis(command)
    .map((line, index) => `${index === 0 ? "usage:" : "      "} delivery-kit ${line}`)
    .join("\n");
}
