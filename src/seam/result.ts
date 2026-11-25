// The coordinator CLI seam's typed results: the reason tokens, the slot the seam passes and the
// validation of a review-deliver, events-ingest or version result line. Pure; the spawn is in
// coordinator.ts.
import { zonedParts } from "../lib/time.ts";
import { isRecord } from "../lib/values.ts";
import { type CliIdentity, cliIdentity } from "../state/seam.ts";

/** The runner log prefix of a deferred review, on its own line and on stderr. */
export const DEFERRED_PREFIX = "bus: review deferred: ";
export const COMPACTION_RESERVED = "compaction-reserved";
/** Reason tokens the seam defines; any other token is treated as a deferral. */
const KNOWN_REASONS: ReadonlySet<string> = new Set([
  "route-unavailable",
  "recipient-unavailable",
  "recipient-busy",
  "question-pending",
  "held",
  "receipt-ambiguous",
  "already-delivered",
  "nothing-due",
  "no-events",
  "cli-error",
  COMPACTION_RESERVED,
]);
/** Reasons the runner itself reports without a CLI result. */
export const CLI_UNAVAILABLE = "cli-unavailable";
export const CLI_VERSION = "cli-version";

const TOKEN = /^[a-z][a-z0-9-]*$/u;

type SeamStatus = "delivered" | "deferred" | "skipped";

/** A typed result, or a runner-side deferral (`cli` absent) for a missing or out-of-range CLI. */
export interface SeamResult {
  readonly claimed: true;
  readonly status: SeamStatus;
  readonly reason: string | null;
  readonly detail: string;
  readonly cli?: CliIdentity;
  /** An ingest result's counts, each present only when the CLI reported it. */
  readonly counts?: Readonly<Partial<Record<IngestCount, number>>>;
}

/**
 * The counts an events-ingest result may carry: lines ingested, quarantined, COMPLETE reports
 * formed, lines committed (`delivered`) and `held` (1 while a torn tail is pending).
 */
const INGEST_COUNTS = ["completed", "delivered", "held", "ingested", "quarantined"] as const;
type IngestCount = (typeof INGEST_COUNTS)[number];

/** No delivery claimed: the spawn, its exit or its result was unusable. */
interface SeamUnclaimed {
  readonly claimed: false;
  readonly why: string;
}

export type SeamOutcome = SeamResult | SeamUnclaimed;

/**
 * The slot start the seam passes as `--slot` and expects echoed: ISO 8601 minute start in
 * `timezone`, with its offset, such as `2026-11-18T16:30:00-05:00`.
 */
export function slotIso(timezone: string, slot: number): string {
  const p = zonedParts(timezone, slot);
  const minute = String(p.minute).padStart(2, "0");
  const second = String(p.second).padStart(2, "0");
  const local = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    p.minute,
    p.second,
  );
  const offset = Math.round((local - slot * 1000) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${minute}:${second}${sign}${hours}:${minutes}`;
}

/** One log line: control characters, including newlines, become spaces. */
export function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
}

/** The single JSON object stdout holds, or why it is not one. */
function resultLine(stdout: string): Record<string, unknown> | string {
  const text = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (text.trim() === "") {
    return "no result on stdout";
  }
  if (text.includes("\n")) {
    return "stdout holds more than one line";
  }
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : "the result is not a JSON object";
  } catch {
    return "the result is not JSON";
  }
}

/** The expected fields of a review-deliver or events-ingest result. */
export type Expected =
  | { readonly kind: "review-deliver"; readonly game: string; readonly slot: string }
  | { readonly kind: "events-ingest"; readonly game: string };

/** Validate one result; an unknown reason token turns any status into a deferral. */
export function parseResult(expected: Expected, stdout: string): SeamOutcome {
  const value = resultLine(stdout);
  if (typeof value === "string") {
    return { claimed: false, why: value };
  }
  const mismatch = (field: string): SeamUnclaimed => ({
    claimed: false,
    why: `malformed result: ${field}`,
  });
  if (value.schema !== 1) {
    return mismatch("schema is not 1");
  }
  if (value.kind !== expected.kind) {
    return mismatch(`kind is not ${expected.kind}`);
  }
  if (value.game !== expected.game) {
    return mismatch("game differs");
  }
  if (expected.kind === "review-deliver" && value.slot !== expected.slot) {
    return mismatch("slot differs");
  }
  const { detail, reason, status } = value;
  if (status !== "delivered" && status !== "deferred" && status !== "skipped") {
    return mismatch("status");
  }
  if (reason !== null && (typeof reason !== "string" || !TOKEN.test(reason))) {
    return mismatch("reason");
  }
  if (status !== "delivered" && reason === null) {
    return mismatch("reason is null for a result that is not delivered");
  }
  if (typeof detail !== "string") {
    return mismatch("detail");
  }
  const cli = cliIdentity(value.cli);
  if (cli === undefined) {
    return mismatch("cli");
  }
  const counts: Partial<Record<IngestCount, number>> = {};
  if (expected.kind === "events-ingest") {
    for (const name of INGEST_COUNTS) {
      const field = value[name];
      if (field === undefined) {
        continue;
      }
      if (!Number.isSafeInteger(field) || (field as number) < 0) {
        return mismatch(name);
      }
      counts[name] = field as number;
    }
  }
  const known = reason === null || KNOWN_REASONS.has(reason);
  return {
    claimed: true,
    cli,
    detail: oneLine(detail),
    reason,
    status: known ? status : "deferred",
    ...(Object.keys(counts).length === 0 ? {} : { counts }),
  };
}

/** The `--version --json` identity, or why it is unusable. */
export function parseVersion(stdout: string): CliIdentity | string {
  const value = resultLine(stdout);
  if (typeof value === "string") {
    return value;
  }
  if (value.schema !== 1) {
    return "malformed result: schema is not 1";
  }
  return cliIdentity(value) ?? "malformed result: version or distSha256";
}

/** The log line for an ingest outcome that needs attention: a failure or a deferral. */
export function ingestLine(outcome: SeamOutcome): string | undefined {
  if (!outcome.claimed) {
    return `bus: event ingest failed: ${outcome.why}; no delivery claimed`;
  }
  if (outcome.status === "deferred") {
    return `bus: event ingest deferred: ${outcome.reason ?? "unknown"}: ${outcome.detail}`;
  }
  return undefined;
}
