// Python json.dumps output (default separators, ensure_ascii), so briefs, receipts, events and
// digests stay byte-identical with 0.9.x: monitor.py:608 digest, claude_adapter.py:brief and
// every persist() in unblock.py and event.py.
//
// JSON.parse cannot tell 1 from 1.0, so an integral float read back from a 0.9.x file is
// written as an integer. Python reads both as equal numbers, so digests of parsed values and
// every comparison still agree; only a byte-level rewrite of such a value differs.
import { createHash } from "node:crypto";

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};

function encodeString(value: string): string {
  let text = '"';
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    const code = value.charCodeAt(index);
    const short = SHORT_ESCAPES[char];
    if (short !== undefined) {
      text += short;
    } else if (code < 0x20 || code > 0x7e) {
      // UTF-16 code units, as Python's ensure_ascii writes surrogate pairs.
      text += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      text += char;
    }
  }
  return `${text}"`;
}

function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return a.length - b.length;
}

/** A value pythonJson can write: JSON plus bigint for nanosecond integers. */
export type PyJson =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly PyJson[]
  | { readonly [key: string]: PyJson | undefined };

export interface DumpOptions {
  readonly sortKeys?: boolean;
  /** Write non-integer numbers with String(); otherwise they are refused. */
  readonly floats?: boolean;
  /** Leave out object keys whose value is undefined; otherwise they are written as null. */
  readonly omitUndefined?: boolean;
}

function dump(value: unknown, options: DumpOptions): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) || (options.floats === true && Number.isFinite(value))) {
      return String(value);
    }
    throw new Error("only integer numbers are supported");
  }
  if (typeof value === "string") {
    return encodeString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => dump(item, options)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    let keys = Object.keys(object);
    if (options.omitUndefined === true) {
      keys = keys.filter((key) => object[key] !== undefined);
    }
    if (options.sortKeys === true) {
      keys.sort(compareCodePoints);
    }
    return `{${keys
      .map((key) => `${encodeString(key)}: ${dump(object[key], options)}`)
      .join(", ")}}`;
  }
  throw new Error(`unsupported JSON value: ${typeof value}`);
}

/** json.dumps(value, sort_keys=sortKeys) for JSON-safe values. */
export function pyJsonDumps(value: unknown, sortKeys = false): string {
  return dump(value, { sortKeys });
}

/** json.dumps(value, sort_keys=True) as persist() writes it: state files and receipts. */
export function pythonJson(value: PyJson): string {
  return dump(value, { floats: true, omitUndefined: true, sortKeys: true });
}

/** sha256 of json.dumps(value, sort_keys=True): the key for acks and retentions. */
export function digest(value: unknown): string {
  return createHash("sha256").update(pyJsonDumps(value, true), "utf8").digest("hex");
}

/** digest() over the persisted form, accepting floats and bigint. */
export function pythonDigest(value: PyJson): string {
  return createHash("sha256").update(pythonJson(value), "utf8").digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality of two parsed JSON values, as Python compares dicts and lists. */
export function sameJson(left: unknown, right: unknown): boolean {
  return pythonJson(left as PyJson) === pythonJson(right as PyJson);
}
