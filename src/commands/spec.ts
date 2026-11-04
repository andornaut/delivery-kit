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
  harness: "claude|codex",
  "history-cursor": "CURSOR",
  monitor: "UUID",
  parent: "ROLE|UUID",
  "poll-seconds": "SECONDS",
  "queue-id": "ID",
  reason: "TEXT",
  recipient: "ROLE|UUID",
  "request-id": "SAFE_ID",
  snapshot: "UUID",
  "state-dir": "STATE/unblock",
};

const GAME = { game: { type: "string" } } as const;
const MONITOR = {
  ...GAME,
  parent: { multiple: true, type: "string" },
  recipient: { type: "string" },
} as const;

export const SPECS = {
  channel: {
    forms: [["game?", "monitor?", "state-dir?", "poll-seconds?"]],
    options: {
      game: { multiple: true, type: "string" },
      monitor: { type: "string" },
      "poll-seconds": { type: "string" },
      "state-dir": { multiple: true, type: "string" },
    },
    summary: "run the Claude channel consumer",
  },
  "check-config": {
    forms: [["game?"]],
    options: GAME,
    summary: "validate config.json, var/registry.json and each delivery-kit.json",
  },
  migrate: {
    forms: [
      ["game?", "dry-run?", "harness?"],
      ["remove-legacy", "dry-run?"],
    ],
    options: {
      "dry-run": { type: "boolean" },
      game: { type: "string" },
      harness: { type: "string" },
      "remove-legacy": { type: "boolean" },
    },
    summary: "move 0.x state into var/ (run from game-dev)",
  },
  "monitor-ack": {
    forms: [["game", "snapshot", "queue-id", "disposition", "reason?", "recipient?", "parent?"]],
    options: {
      ...MONITOR,
      disposition: { type: "string" },
      "queue-id": { multiple: true, type: "string" },
      reason: { type: "string" },
      snapshot: { type: "string" },
    },
    summary: "acknowledge monitor queue items",
  },
  "monitor-snapshot": {
    forms: [["game", "recipient?", "parent?", "history-cursor?"]],
    options: { ...MONITOR, "history-cursor": { type: "string" } },
    summary: "capture the monitor review snapshot",
  },
  request: {
    forms: [["game", "request-id"]],
    options: { ...GAME, "request-id": { type: "string" } },
    summary: "record a user-authorized one-off departure request",
  },
  "resource-report": {
    forms: [["game"]],
    options: GAME,
    summary: "print reporting-only resource information",
  },
  run: {
    forms: [["game"]],
    options: GAME,
    summary: "run one game's resident delivery runner",
  },
  status: {
    forms: [["game"], ["harness"]],
    options: { ...GAME, harness: { type: "string" } },
    summary:
      "print read-only runner and delivery status, or probe whether a harness can deliver " +
      "(exit 0 when ready)",
  },
} as const satisfies Readonly<Record<string, CommandSpec>>;

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
  const spec: CommandSpec = SPECS[command];
  return spec.forms.map((form) => [command, ...form.map((token) => flag(spec, token))].join(" "));
}

/** The usage line a command prints with a usage error. */
export function commandUsage(command: Command): string {
  return synopsis(command)
    .map((line, index) => `${index === 0 ? "usage:" : "      "} delivery-kit ${line}`)
    .join("\n");
}
