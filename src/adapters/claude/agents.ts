// Session-reported Claude state from `claude agents --json`.
// Interactive sessions report `status` (idle, busy, shell or waiting) with no `state`; background
// sessions report `state`. A listed interactive session with one of those statuses is live, so a
// channel brief queues for it. This is session-reported state only: it never proves question or
// queue state.
import { spawnSync } from "node:child_process";

export type AgentEntry = Readonly<Record<string, unknown>>;

const TIMEOUT_MS = 15_000;
const REPORTED = /^[a-z_]{1,32}$/;

/** Interactive statuses of a live session: `shell` and `waiting` deliver like `busy`. */
export const LIVE_STATUSES = ["idle", "busy", "shell", "waiting"] as const;
export type LiveStatus = (typeof LIVE_STATUSES)[number];

export const MISSING_REASON = "recipient session missing from claude agents listing";
export const BLOCKED_REASON = "recipient session blocked";

export type Availability =
  | { readonly status: LiveStatus; readonly reason?: undefined }
  | { readonly status: null; readonly reason: string };

function isLive(value: unknown): value is LiveStatus {
  return (LIVE_STATUSES as readonly unknown[]).includes(value);
}

/** The entry's reported state or status when it is a plain token, else `unknown`. */
function reportedToken(entry: AgentEntry): string {
  const reported = entry.state || entry.status;
  return typeof reported === "string" && REPORTED.test(reported) ? reported : "unknown";
}

/** `CLAUDE_BIN` overrides the executable for fixtures; the arguments are fixed. */
function claudeExecutable(env: NodeJS.ProcessEnv): string {
  const override = env.CLAUDE_BIN;
  return override !== undefined && override !== "" ? override : "claude";
}

export function agentsListing(env: NodeJS.ProcessEnv): AgentEntry[] {
  const result = spawnSync(claudeExecutable(env), ["agents", "--json"], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: TIMEOUT_MS,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("claude agents listing unavailable");
  }
  const entries = JSON.parse(result.stdout) as unknown;
  if (
    !Array.isArray(entries) ||
    !entries.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry))
  ) {
    throw new Error("unexpected agents listing");
  }
  return entries as AgentEntry[];
}

export function listingOrNull(env: NodeJS.ProcessEnv): AgentEntry[] | null {
  try {
    return agentsListing(env);
  } catch {
    return null;
  }
}

export function recipientAvailability(
  entries: readonly AgentEntry[],
  sessionId: string,
): Availability {
  const matches = entries.filter((entry) => entry.sessionId === sessionId);
  if (matches.length === 0) {
    return { reason: MISSING_REASON, status: null };
  }
  if (matches.some((entry) => entry.state === "blocked")) {
    return { reason: BLOCKED_REASON, status: null };
  }
  const ready = matches.find((entry) => isLive(entry.status) && entry.state == null);
  if (ready !== undefined) {
    return { status: ready.status as LiveStatus };
  }
  return {
    reason: `recipient session state unknown (reported: ${reportedToken(matches[0]!)})`,
    status: null,
  };
}

export function recipientReady(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  entries: readonly AgentEntry[] | null = listingOrNull(env),
): Availability {
  if (entries === null) {
    return { reason: "claude agents listing unavailable", status: null };
  }
  return recipientAvailability(entries, sessionId);
}

/** The reported status or state token, else missing, unknown or unavailable. */
export function sessionStatus(entries: readonly AgentEntry[] | null, sessionId: string): string {
  if (entries === null) {
    return "unavailable";
  }
  const matches = entries.filter((entry) => entry.sessionId === sessionId);
  if (matches.length === 0) {
    return "missing";
  }
  if (matches.some((entry) => (entry.state || entry.status) === "blocked")) {
    return "blocked";
  }
  return reportedToken(matches[0]!);
}

export interface RoleDiagnostic {
  readonly kind: "question_state";
  readonly session_id: string;
  readonly status: "unavailable";
  readonly reason_code: "claude_session_reported_only";
  readonly session_status: string;
}

export function roleDiagnostics(
  entries: readonly AgentEntry[] | null,
  sessionIds: readonly string[],
): RoleDiagnostic[] {
  return sessionIds.map(
    (sessionId) =>
      Object.fromEntries([
        ["kind", "question_state"],
        ["session_id", sessionId],
        ["status", "unavailable"],
        ["reason_code", "claude_session_reported_only"],
        ["session_status", sessionStatus(entries, sessionId)],
      ]) as unknown as RoleDiagnostic,
  );
}
