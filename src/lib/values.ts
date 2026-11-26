// Value checks and formatting shared across modules.

/** A plain object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the schema-1 app identity, rejecting an invalid or contradictory alias. */
export function wireAppId(value: Record<string, unknown>): string | undefined {
  const { appId, game } = value;
  if (appId === undefined) {
    return typeof game === "string" ? game : undefined;
  }
  return typeof appId === "string" && (game === undefined || game === appId) ? appId : undefined;
}

/** An error's message, or the value as text when it is not an Error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ISO 8601 UTC to the second. */
export function isoSeconds(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/u, "Z");
}
