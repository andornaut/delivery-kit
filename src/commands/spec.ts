// Every command's options: the one source for argument parsing and for the help text, so a flag a
// command accepts always appears in `delivery-kit --help`.
import {
  type CommandSpec,
  formSynopsis,
  usageText,
} from "@andornaut/coordination-kit/build/shared";

export type { CommandSpec } from "@andornaut/coordination-kit/build/shared";

const BINARY = "delivery-kit";
/** The placeholder each string option shows in help. */
const VALUES: Readonly<Record<string, string>> = {
  game: "ID",
  id: "SAFE_ID",
  reason: "TEXT",
  requester: "ROLE",
  state: "enabled|paused",
  timeout: "SECONDS",
};
const GAME = { game: { type: "string" } } as const;
/** Every command is a game operation: a top-level verb, or the runner group and its verb. */
export const SPECS = {
  "check-config": {
    forms: [["game?"]],
    options: GAME,
    summary: "validate config.json, var/registry.json, var/route.json and each delivery-kit.json",
  },
  control: {
    forms: [["game", "state", "reason", "requester"]],
    options: {
      ...GAME,
      reason: { type: "string" },
      requester: { type: "string" },
      state: { type: "string" },
    },
    summary: "persist the requested delivery state without starting a runner",
  },
  request: {
    forms: [["game", "id"]],
    options: { ...GAME, id: { type: "string" } },
    summary: "record a user-authorized one-off departure request",
  },
  run: {
    forms: [["game"]],
    options: GAME,
    summary: "run one game's resident delivery runner",
  },
  "runner start": {
    forms: [["game"]],
    options: GAME,
    summary: "start one runner for the game through its systemd user unit, or detached without one",
  },
  "runner stop": {
    forms: [["game", "timeout?"]],
    options: { ...GAME, timeout: { type: "string" } },
    summary: "wait until the game's runner is idle and drained, then stop it",
  },
  "runner unit": {
    forms: [["game"]],
    options: GAME,
    summary:
      "print the optional systemd user unit for the game's resident runner; installs nothing",
  },
  status: {
    forms: [["game", "resources?"]],
    options: { ...GAME, resources: { type: "boolean" } },
    summary:
      "print the read-only runner and delivery status, or with --resources the resource report",
  },
} as const satisfies Readonly<Record<string, CommandSpec>>;
export type Command = keyof typeof SPECS;
/** One `COMMAND ...` line per accepted form. */
export function synopsis(command: Command): string[] {
  return formSynopsis(VALUES, command, SPECS[command]);
}
/** The usage line a command prints with a usage error. */
export function commandUsage(command: Command): string {
  return usageText(BINARY, synopsis(command));
}
