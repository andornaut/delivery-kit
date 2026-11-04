// Python json.dumps output with its default separators: the one encoder for briefs, receipts,
// events, bus and monitor state records, status output and monitor digests, so persisted records
// and the digests that key existing acknowledgements and retentions stay byte-identical. It
// follows Python where a JavaScript serializer differs: keys sort by code point, ensure_ascii
// escapes U+007F, ensure_ascii=False leaves lone surrogates unescaped, and floats use repr().
//
// JSON.parse cannot tell 1 from 1.0, so an integral float read back from a persisted record is
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

function encodeString(value: string, ensureAscii: boolean): string {
  let text = '"';
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    const code = value.charCodeAt(index);
    const short = SHORT_ESCAPES[char];
    if (short !== undefined) {
      text += short;
    } else if (code < 0x20 || (ensureAscii && code > 0x7e)) {
      // UTF-16 code units, as Python's ensure_ascii writes surrogate pairs.
      text += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      text += char;
    }
  }
  return `${text}"`;
}

/**
 * float.__repr__: the shortest round-trip digits, positional for a decimal exponent from -4 to
 * 15 and otherwise scientific with a signed exponent of at least two digits.
 */
export function pyFloat(value: number): string {
  const [mantissa = "", power = "0"] = value.toExponential().split("e");
  const exponent = Number(power);
  if (exponent < -4 || exponent >= 16) {
    const sign = exponent < 0 ? "-" : "+";
    return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return String(value);
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

/** A value dumpsJson can write: JSON plus bigint for nanosecond integers. */
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
  /** Escape every code unit outside printable ASCII (Python's default); false writes them as is. */
  readonly ensureAscii?: boolean;
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
    if (Number.isInteger(value)) {
      return String(value);
    }
    if (options.floats === true && Number.isFinite(value)) {
      return pyFloat(value);
    }
    throw new Error("only integer numbers are supported");
  }
  const ensureAscii = options.ensureAscii !== false;
  if (typeof value === "string") {
    return encodeString(value, ensureAscii);
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
      .map((key) => `${encodeString(key, ensureAscii)}: ${dump(object[key], options)}`)
      .join(", ")}}`;
  }
  throw new Error(`unsupported JSON value: ${typeof value}`);
}

/** json.dumps(value, sort_keys=sortKeys) for JSON-safe values; floats only when allowed. */
export function pyJsonDumps(value: unknown, sortKeys = false, floats = false): string {
  return dump(value, { floats, sortKeys });
}

/** json.dumps(value, ensure_ascii=False), insertion order: brief text and its byte bounds. */
export function unicodeDumps(value: unknown): string {
  return dump(value, { ensureAscii: false, floats: true });
}

/** json.dumps(value, sort_keys=True) as persist() writes it: state files and receipts. */
export function dumpsJson(value: unknown): string {
  return dump(value, { floats: true, omitUndefined: true, sortKeys: true });
}

/** sha256 of json.dumps(value, sort_keys=True): the key for acks and retentions. */
export function digest(value: unknown): string {
  return createHash("sha256").update(pyJsonDumps(value, true), "utf8").digest("hex");
}

/** digest() over the persisted form, accepting floats and bigint. */
export function dumpsDigest(value: PyJson): string {
  return createHash("sha256").update(dumpsJson(value), "utf8").digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality of two parsed JSON values, as Python compares dicts and lists. */
export function sameJson(left: unknown, right: unknown): boolean {
  return dumpsJson(left as PyJson) === dumpsJson(right as PyJson);
}
