// Small structural validation helpers shared by the config, layout and registry schemas.
// Each check records a JSON-pointer-style issue and returns whether the value passed.
import { CANONICAL_UUID } from "./adapters/shared/ids.ts";

export class ValidationError extends Error {
  readonly issues: readonly string[];

  constructor(subject: string, issues: readonly string[]) {
    super(`${subject} is invalid:\n${issues.map((issue) => `  ${issue}`).join("\n")}`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export type Json = Record<string, unknown>;

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Anything shaped like a UUID in either case: names must never look like one. */
export const UUID_PATTERN = new RegExp(CANONICAL_UUID.source, "i");
/** A conversation ID in the canonical lowercase form native receipts and routes compare. */
export const CONVERSATION_ID_PATTERN = CANONICAL_UUID;
export const SECRET_KEY_PATTERN = /secret|token|passw|api[-_]?key|credential|private[-_]?key|auth/i;

export class Issues {
  readonly list: string[] = [];

  add(at: string, message: string): false {
    this.list.push(`${at || "/"}: ${message}`);
    return false;
  }

  throwIfAny(subject: string): void {
    if (this.list.length > 0) {
      throw new ValidationError(subject, this.list);
    }
  }
}

export function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Require an object whose keys are exactly drawn from `required` and `optional`. */
export function checkObject(
  issues: Issues,
  at: string,
  shape: { readonly required: readonly string[]; readonly optional?: readonly string[] },
  value: unknown,
): value is Json {
  if (!isObject(value)) {
    return issues.add(at, "must be an object");
  }
  const allowed = new Set([...shape.required, ...(shape.optional ?? [])]);
  for (const key of Object.keys(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      issues.add(`${at}/${key}`, "secret-like keys are not allowed; use a credential reference");
    } else if (!allowed.has(key)) {
      issues.add(`${at}/${key}`, "unknown key");
    }
  }
  // Unknown keys are recorded but do not stop validation of the known ones.
  let complete = true;
  for (const key of shape.required) {
    if (!(key in value)) {
      complete = issues.add(`${at}/${key}`, "is required");
    }
  }
  return complete;
}

/** Require an object used as a map; its keys are validated by the caller. */
export function checkMap(issues: Issues, at: string, value: unknown): value is Json {
  return isObject(value) || issues.add(at, "must be an object");
}

export function checkString(
  issues: Issues,
  at: string,
  pattern: RegExp | null,
  value: unknown,
): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return issues.add(at, "must be a non-empty string");
  }
  if (/[\0\n\r]/.test(value)) {
    return issues.add(at, "must not contain NUL or line breaks");
  }
  if (pattern !== null && !pattern.test(value)) {
    return issues.add(at, `must match ${String(pattern)}`);
  }
  return true;
}

/** A plain value that is neither a conversation ID nor an absolute path. */
export function checkName(
  issues: Issues,
  at: string,
  pattern: RegExp | null,
  value: unknown,
): value is string {
  if (!checkString(issues, at, pattern, value)) {
    return false;
  }
  if (UUID_PATTERN.test(value)) {
    return issues.add(at, "must be a name, not a conversation ID");
  }
  if (value.startsWith("/")) {
    return issues.add(at, "must not be an absolute path");
  }
  return true;
}

/** A path relative to its root. `..` is allowed: sibling checkouts are addressed that way. */
export function checkRelativePath(issues: Issues, at: string, value: unknown): value is string {
  if (!checkString(issues, at, null, value)) {
    return false;
  }
  if (value.startsWith("/") || value.startsWith("~")) {
    return issues.add(at, "must be a relative path");
  }
  return true;
}

export function checkInteger(
  issues: Issues,
  at: string,
  range: { readonly min: number; readonly max?: number },
  value: unknown,
): value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return issues.add(at, "must be an integer");
  }
  if (value < range.min || (range.max !== undefined && value > range.max)) {
    return issues.add(
      at,
      `must be from ${range.min}${range.max === undefined ? "" : ` through ${range.max}`}`,
    );
  }
  return true;
}

export function checkBoolean(issues: Issues, at: string, value: unknown): value is boolean {
  return typeof value === "boolean" || issues.add(at, "must be a boolean");
}

export function checkArray(
  issues: Issues,
  at: string,
  options: { readonly nonEmpty?: boolean; readonly unique?: boolean },
  value: unknown,
): value is unknown[] {
  if (!Array.isArray(value)) {
    return issues.add(at, "must be an array");
  }
  if (options.nonEmpty === true && value.length === 0) {
    return issues.add(at, "must not be empty");
  }
  if (
    options.unique === true &&
    new Set(value.map((item) => JSON.stringify(item))).size !== value.length
  ) {
    return issues.add(at, "must not contain duplicates");
  }
  return true;
}

export function checkTimezone(issues: Issues, at: string, value: unknown): value is string {
  if (!checkString(issues, at, null, value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return issues.add(at, "must be an IANA time zone");
  }
}

export function checkEnum<T extends string>(
  issues: Issues,
  at: string,
  values: readonly T[],
  value: unknown,
): value is T {
  return values.includes(value as T) || issues.add(at, `must be one of ${values.join(", ")}`);
}
