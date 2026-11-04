// Python json.dumps output (default separators, ensure_ascii), so briefs and digests stay
// byte-identical with 0.9.x: monitor.py:608 digest and claude_adapter.py:brief.
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

/** json.dumps(value, sort_keys=sortKeys) for JSON-safe values. */
export function pyJsonDumps(value: unknown, sortKeys = false): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error("only integer numbers are supported");
    }
    return String(value);
  }
  if (typeof value === "string") {
    return encodeString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => pyJsonDumps(item, sortKeys)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (sortKeys) {
      keys.sort(compareCodePoints);
    }
    const object = value as Record<string, unknown>;
    return `{${keys
      .map((key) => `${encodeString(key)}: ${pyJsonDumps(object[key], sortKeys)}`)
      .join(", ")}}`;
  }
  throw new Error(`unsupported JSON value: ${typeof value}`);
}

/** sha256 of json.dumps(value, sort_keys=True): the key for acks and retentions. */
export function digest(value: unknown): string {
  return createHash("sha256").update(pyJsonDumps(value, true), "utf8").digest("hex");
}
