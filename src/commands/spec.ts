// Every command's options: the one source for argument parsing and for the help text, so a flag a
// command accepts always appears in `delivery-kit --help`.
import type { ParseArgsConfig } from "node:util";

import {
  LEDGER_BOUNDARY_OPTIONS,
  LEDGER_COVERAGE_OPTIONS,
  LEDGER_ID_OPTIONS,
  LEDGER_INPUT_OPTIONS,
  LEDGER_REPORT_OPTIONS,
} from "./accounting.ts";
import { DOCTOR_OPTIONS } from "./doctor.ts";
import {
  MESSAGE_DISPATCH_OPTIONS,
  MESSAGE_RECONCILE_OPTIONS,
  MESSAGE_RETIRE_SPOOL_OPTIONS,
  MESSAGE_SEND_OPTIONS,
  MESSAGE_STATUS_OPTIONS,
} from "./messages.ts";
import {
  PROTOCOL_ARTIFACT_OPTIONS,
  PROTOCOL_BOUNDARY_OPTIONS,
  PROTOCOL_INBOX_OPTIONS,
  PROTOCOL_INPUT_OPTIONS,
  PROTOCOL_INTAKE_OPTIONS,
  PROTOCOL_PHASES,
  PROTOCOL_ROLE_OPTIONS,
  PROTOCOL_ROOT_OPTIONS,
} from "./protocol.ts";
export type Options = NonNullable<ParseArgsConfig["options"]>;
export interface CommandSpec {
  readonly summary: string;
  readonly values?: Readonly<Record<string, string>>;
  readonly options: Options;
  /**
   * The accepted forms. Each lists the options it takes in help order; a trailing `?` marks one
   * as optional. Every option appears in at least one form.
   */
  readonly forms: readonly (readonly string[])[];
}
/** The placeholder each string option shows in help. */
const VALUES: Readonly<Record<string, string>> = {
  at: "ISO_TIMESTAMP",
  "body-file": "FILE",
  conversation: "UUID",
  disposition: "handled|superseded|retained",
  evidence: "REF",
  "expected-revision": "N",
  from: "ROLE",
  game: "ID",
  harness: "claude|codex|default",
  "history-cursor": "CURSOR",
  id: "SAFE_ID",
  "input-file": "FILE",
  intent: "queue|unblock",
  "next-boundary": "TEXT",
  owner: "ROLE",
  "owner-role": "ROLE",
  parent: "ROLE|UUID",
  phase: "startup|resume|handoff|review",
  "poll-seconds": "SECONDS",
  "queue-id": "ID",
  reason: "TEXT",
  recipient: "ROLE|UUID",
  requester: "ROLE",
  role: "ROLE",
  snapshot: "UUID",
  state: "enabled|paused",
  "state-dir": "STATE/unblock",
};
/** Help groups, in help order. */
export const GROUPS = {
  game: "game operations",
  harness: "harness (claude, codex)",
  inbox: "inbox (recipient)",
  ledger: "request accounting",
  message: "durable role messages",
  protocol: "explicit filesystem work protocol",
} as const;
export interface GroupedSpec extends CommandSpec {
  readonly group: keyof typeof GROUPS;
}
const GAME = { game: { type: "string" } } as const;
const SCOPE = {
  game: { multiple: true, type: "string" },
  role: { multiple: true, type: "string" },
} as const;
const INBOX = {
  ...GAME,
  parent: { multiple: true, type: "string" },
  recipient: { type: "string" },
} as const;
const READY = {
  forms: [["game?", "role?"]],
  group: "harness",
  options: SCOPE,
  summary:
    "probe whether this harness can deliver now; prints one JSON line, exits 0 when ready, 1 when not",
} as const satisfies GroupedSpec;
/** Commands by their words: a top-level game verb, or a noun group and its verb. */
export const SPECS = {
  "check-config": {
    forms: [["game?"]],
    group: "game",
    options: GAME,
    summary: "validate config.json, var/registry.json, var/route.json and each delivery-kit.json",
  },
  "claude channel": {
    forms: [["game?", "conversation?", "state-dir?", "poll-seconds?"]],
    group: "harness",
    options: {
      conversation: { type: "string" },
      game: { multiple: true, type: "string" },
      "poll-seconds": { type: "string" },
      "state-dir": { multiple: true, type: "string" },
    },
    summary: "the stdio server the Claude recipient session starts; delivers the channel spool",
  },
  "claude ready": READY,
  "codex ready": READY,
  control: {
    forms: [["game", "state", "reason", "requester"]],
    group: "game",
    options: {
      ...GAME,
      reason: { type: "string" },
      requester: { type: "string" },
      state: { type: "string" },
    },
    summary: "persist the requested delivery state without starting a runner",
  },
  "harness doctor": {
    forms: [["game", "role?"], ["role"]],
    group: "harness",
    options: DOCTOR_OPTIONS,
    summary: "diagnose explicitly selected roles without sending or activating",
  },
  "harness ready": {
    forms: [["game?", "role?"]],
    group: "harness",
    options: SCOPE,
    summary: "probe each selected role's effective harness without sending or activating",
  },
  "harness select": {
    forms: [
      ["harness", "expected-revision", "game", "role?"],
      ["harness", "expected-revision", "role"],
    ],
    group: "harness",
    options: {
      ...SCOPE,
      "expected-revision": { type: "string" },
      harness: { type: "string" },
    },
    summary: "atomically select harness overrides for an explicit scope without activating roles",
  },
  "inbox ack": {
    forms: [["game", "snapshot", "queue-id", "disposition", "reason?", "recipient?", "parent?"]],
    group: "inbox",
    options: {
      ...INBOX,
      disposition: { type: "string" },
      "queue-id": { multiple: true, type: "string" },
      reason: { type: "string" },
      snapshot: { type: "string" },
    },
    summary: "acknowledge inbox queue items from a snapshot",
  },
  "inbox snapshot": {
    forms: [["game", "recipient?", "parent?", "history-cursor?"]],
    group: "inbox",
    options: { ...INBOX, "history-cursor": { type: "string" } },
    summary: "capture the recipient's inbox snapshot",
  },
  "ledger apply": {
    forms: [["input-file"]],
    group: "ledger",
    options: LEDGER_INPUT_OPTIONS,
    summary: "apply one explicit revision-checked request accounting transaction",
  },
  "ledger boundary": {
    forms: [["role", "phase"]],
    group: "ledger",
    options: LEDGER_BOUNDARY_OPTIONS,
    summary: "capture a scoped accounting boundary and report independent readiness",
  },
  "ledger coverage": {
    forms: [["owner?"]],
    group: "ledger",
    options: LEDGER_COVERAGE_OPTIONS,
    summary: "show declared accounting coverage and gaps",
  },
  "ledger history": {
    forms: [["id"]],
    group: "ledger",
    options: LEDGER_ID_OPTIONS,
    summary: "show immutable request accounting transitions",
  },
  "ledger intake": {
    forms: [["input-file"]],
    group: "ledger",
    options: LEDGER_INPUT_OPTIONS,
    summary: "register a request with explicit provenance and revision",
  },
  "ledger reconcile": {
    forms: [["input-file"]],
    group: "ledger",
    options: LEDGER_INPUT_OPTIONS,
    summary: "record an explicit accounting reconciliation transaction",
  },
  "ledger report": {
    forms: [["at", "owner?"]],
    group: "ledger",
    options: LEDGER_REPORT_OPTIONS,
    summary: "report accounting state at an explicit cutoff",
  },
  "ledger show": {
    forms: [["id"]],
    group: "ledger",
    options: LEDGER_ID_OPTIONS,
    summary: "show one current request accounting record",
  },
  "message dispatch": {
    forms: [["id"]],
    group: "message",
    options: MESSAGE_DISPATCH_OPTIONS,
    summary: "explicitly attempt guarded delivery of a stored message",
    values: { id: "UUID" },
  },
  "message reconcile": {
    forms: [
      ["id", "receipt"],
      [
        "id",
        "expected-revision",
        "disposition",
        "evidence",
        "reason?",
        "owner-role?",
        "next-boundary?",
      ],
    ],
    group: "message",
    options: MESSAGE_RECONCILE_OPTIONS,
    summary: "reconcile exact receipt or explicit handling and retention evidence",
    values: { disposition: "accepted|handled|superseded|retained", id: "UUID" },
  },
  "message retire-spool": {
    forms: [["recipient", "dry-run?"]],
    group: "message",
    options: MESSAGE_RETIRE_SPOOL_OPTIONS,
    summary: "move Claude spool entries of handled or superseded messages to claude-retired",
  },
  "message send": {
    forms: [["from", "recipient", "id", "body-file", "intent?", "parent?"]],
    group: "message",
    options: MESSAGE_SEND_OPTIONS,
    summary: "store an exact message locally without waking a recipient",
    values: { id: "UUID", parent: "ROLE" },
  },
  "message status": {
    forms: [
      ["id", "include-body?", "include-retention?"],
      ["recipient", "include-body?", "include-retention?"],
    ],
    group: "message",
    options: MESSAGE_STATUS_OPTIONS,
    summary: "read local message metadata or the exact original body",
    values: { id: "UUID", recipient: "ROLE" },
  },
  "protocol activate": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol activate operation; no native delivery or owner activation",
  },
  "protocol artifact-put": {
    forms: [["file", "hash?", "output-file?", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_ARTIFACT_OPTIONS,
    summary: "Explicit protocol artifact-put operation; no native delivery or owner activation",
  },
  "protocol artifact-read": {
    forms: [["hash", "output-file", "file?", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_ARTIFACT_OPTIONS,
    summary: "Explicit protocol artifact-read operation; no native delivery or owner activation",
  },
  "protocol backup": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol backup operation; no native delivery or owner activation",
  },
  "protocol boundary": {
    forms: [["role", "phase", "at", "work-id?", "work-role?", "worker?", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_BOUNDARY_OPTIONS,
    summary: "Explicit protocol boundary operation; no native delivery or owner activation",
    values: { phase: PROTOCOL_PHASES.join("|") },
  },
  "protocol claim": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol claim operation; no native delivery or owner activation",
  },
  "protocol declare": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "declare supported canonical protocol evidence; no provider activation",
  },
  "protocol dry-run": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol dry-run operation; no native delivery or owner activation",
  },
  "protocol enroll": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "enroll supported canonical protocol evidence; no provider activation",
  },
  "protocol enrollment-report": {
    forms: [["state-root?"]],
    group: "protocol",
    options: PROTOCOL_ROOT_OPTIONS,
    summary: "enrollment-report supported canonical protocol evidence; no provider activation",
  },
  "protocol import": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol import operation; no native delivery or owner activation",
  },
  "protocol import-originals": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol import-originals operation; no native delivery or owner activation",
  },
  "protocol inbox": {
    forms: [["role", "sender", "include-body?", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INBOX_OPTIONS,
    summary: "Explicit protocol inbox operation; no native delivery or owner activation",
  },
  "protocol intake": {
    forms: [["owner", "id?"]],
    group: "protocol",
    options: PROTOCOL_INTAKE_OPTIONS,
    summary: "Explicit protocol intake operation; no native delivery or owner activation",
  },
  "protocol inventory": {
    forms: [[]],
    group: "protocol",
    options: {},
    summary: "Explicit protocol inventory operation; no native delivery or owner activation",
  },
  "protocol message-observe": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol message-observe operation; no native delivery or owner activation",
  },
  "protocol message-original": {
    forms: [["input-file", "include-body?", "state-root?"]],
    group: "protocol",
    options: { ...PROTOCOL_INPUT_OPTIONS, "include-body": { type: "boolean" } },
    summary: "Explicit protocol message-original operation; no native delivery or owner activation",
  },
  "protocol message-publish": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol message-publish operation; no native delivery or owner activation",
  },
  "protocol message-receipt": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol message-receipt operation; no native delivery or owner activation",
  },
  "protocol message-withdraw": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol message-withdraw operation; no native delivery or owner activation",
  },
  "protocol observer-adoption": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "observer-adoption supported canonical protocol evidence; no provider activation",
  },
  "protocol restore": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol restore operation; no native delivery or owner activation",
  },
  "protocol role": {
    forms: [["role", "id?", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_ROLE_OPTIONS,
    summary: "Explicit protocol role operation; no native delivery or owner activation",
  },
  "protocol status": {
    forms: [["state-root?"]],
    group: "protocol",
    options: PROTOCOL_ROOT_OPTIONS,
    summary: "Explicit protocol status operation; no native delivery or owner activation",
  },
  "protocol work-accept": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol work-accept operation; no native delivery or owner activation",
  },
  "protocol work-publish": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol work-publish operation; no native delivery or owner activation",
  },
  "protocol work-read": {
    forms: [["role", "id?", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_ROLE_OPTIONS,
    summary: "Explicit protocol work-read operation; no native delivery or owner activation",
  },
  "protocol work-receipt": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol work-receipt operation; no native delivery or owner activation",
  },
  "protocol work-submit": {
    forms: [["input-file", "state-root?"]],
    group: "protocol",
    options: PROTOCOL_INPUT_OPTIONS,
    summary: "Explicit protocol work-submit operation; no native delivery or owner activation",
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
  const value =
    option.type === "string" ? ` ${spec.values?.[name] ?? VALUES[name] ?? "VALUE"}` : "";
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
