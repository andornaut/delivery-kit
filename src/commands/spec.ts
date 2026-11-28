// Command options and forms shared by the argument parser and help text.
import {
  type CommandSpec,
  formSynopsis,
  usageText,
} from "@andornaut/coordination-kit/build/shared";

const BINARY = "delivery-kit";
/** The placeholder each string option shows in help. */
const VALUES: Readonly<Record<string, string>> = {
  app: "ID",
  id: "SAFE_ID",
  reason: "TEXT",
  requester: "ROLE",
  scope: "app:ID",
  state: "enabled|paused",
  timeout: "SECONDS",
};
export const APP_OPTIONS = { app: { type: "string" }, game: { type: "string" } } as const;
/** Commands are top-level verbs or verbs in the runner group. */
export const SPECS = {
  "check-config": {
    forms: [["app?"]],
    options: APP_OPTIONS,
    summary:
      "validate the workspace configuration, optional registry and route, and each delivery-kit.json",
  },
  control: {
    forms: [["app", "state", "reason", "requester"]],
    options: {
      ...APP_OPTIONS,
      reason: { type: "string" },
      requester: { type: "string" },
      state: { type: "string" },
    },
    summary: "persist the requested delivery state without starting a runner",
  },
  request: {
    forms: [["app", "id"]],
    options: { ...APP_OPTIONS, id: { type: "string" } },
    summary: "record a user-authorized one-off departure request",
  },
  run: {
    forms: [["app"]],
    options: APP_OPTIONS,
    summary: "run one app's resident delivery runner",
  },
  "runner start": {
    forms: [["app"]],
    options: APP_OPTIONS,
    summary: "start one runner for the app through its systemd user unit, or detached without one",
  },
  "runner stop": {
    forms: [["app", "timeout?"]],
    options: { ...APP_OPTIONS, timeout: { type: "string" } },
    summary: "wait until the app's runner is idle and drained, then stop it",
  },
  "runner unit": {
    forms: [["app"]],
    options: APP_OPTIONS,
    summary: "print the optional systemd user unit for the app's resident runner; installs nothing",
  },
  status: {
    forms: [
      ["app", "resources?"],
      ["scope", "resources?"],
    ],
    options: { ...APP_OPTIONS, resources: { type: "boolean" }, scope: { type: "string" } },
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
