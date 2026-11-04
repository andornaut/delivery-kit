// Session-reported Claude state from `claude agents --json` (claude_adapter.py:agents_listing).
// Interactive sessions report `status` (idle or busy); background sessions report `state`.
// This is session-reported state only: it never proves question or queue state.
import { spawnSync } from "node:child_process";

export type AgentEntry = Readonly<Record<string, unknown>>;

const TIMEOUT_MS = 15_000;
const REPORTED = /^[a-z_]{1,32}$/;

export type Availability =
  | { readonly status: "busy" | "idle"; readonly reason?: undefined }
  | { readonly status: null; readonly reason: string };

/** `CLAUDE_BIN` overrides the executable for fixtures; the arguments are fixed. */
export function claudeExecutable(env: NodeJS.ProcessEnv): string {
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

export function monitorAvailability(
  entries: readonly AgentEntry[],
  sessionId: string,
): Availability {
  const matches = entries.filter((entry) => entry.sessionId === sessionId);
  if (matches.length === 0) {
    return { reason: "monitor session missing from claude agents listing", status: null };
  }
  if (matches.some((entry) => entry.state === "blocked")) {
    return { reason: "monitor session blocked", status: null };
  }
  const ready = matches.find(
    (entry) => (entry.status === "idle" || entry.status === "busy") && entry.state == null,
  );
  if (ready !== undefined) {
    return { status: ready.status as "busy" | "idle" };
  }
  return { reason: "monitor session state unknown", status: null };
}

export function monitorReady(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  entries: readonly AgentEntry[] | null = listingOrNull(env),
): Availability {
  if (entries === null) {
    return { reason: "claude agents listing unavailable", status: null };
  }
  return monitorAvailability(entries, sessionId);
}

/** The reported status or state token, else missing, unknown or unavailable. */
export function sessionStatus(entries: readonly AgentEntry[] | null, sessionId: string): string {
  if (entries === null) {
    return "unavailable";
  }
  const reported = entries
    .filter((entry) => entry.sessionId === sessionId)
    .map((entry) => entry.state || entry.status);
  if (reported.length === 0) {
    return "missing";
  }
  if (reported.includes("blocked")) {
    return "blocked";
  }
  const first = reported[0];
  return typeof first === "string" && REPORTED.test(first) ? first : "unknown";
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
