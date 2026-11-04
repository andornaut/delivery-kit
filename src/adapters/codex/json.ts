// Byte-compatible JSON and identifiers shared with the 0.9.x Python state files.
//
// Python's json.dumps(value, sort_keys=True) separates with ", " and ": " and escapes every
// character outside printable ASCII. Receipts, events and payload signatures written in that form
// keep the same bytes and sha256 digests across a runner replacement.
import { createHash } from "node:crypto";

export type PyJson =
  | null
  | boolean
  | number
  | bigint
  | string
  | readonly PyJson[]
  | { readonly [key: string]: PyJson | undefined };

const NON_ASCII = /[\u007f-\uffff]/g;

function escapeUnit(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function pyString(value: string): string {
  return JSON.stringify(value).replace(NON_ASCII, escapeUnit);
}

/** json.dumps(value, sort_keys=True). Object keys with an undefined value are omitted. */
export function pythonJson(value: PyJson): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return value.toString();
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("JSON numbers must be finite");
      }
      return String(value);
    case "string":
      return pyString(value);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly PyJson[]).map((item) => pythonJson(item)).join(", ")}]`;
  }
  const entries = Object.entries(value as { readonly [key: string]: PyJson | undefined })
    .filter((entry): entry is [string, PyJson] => entry[1] !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : Number(left > right)));
  return `{${entries.map(([key, item]) => `${pyString(key)}: ${pythonJson(item)}`).join(", ")}}`;
}

/** digest() in monitor.py: sha256 of the sorted Python JSON form. */
export function pythonDigest(value: PyJson): string {
  return createHash("sha256").update(pythonJson(value), "utf8").digest("hex");
}

const NAMESPACE_URL = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** uuid.uuid5(uuid.NAMESPACE_URL, name), the request ID form of every native delivery. */
export function uuid5Url(name: string): string {
  const hash = createHash("sha1").update(NAMESPACE_URL).update(name, "utf8").digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** True when str(uuid.UUID(value)) == value: lowercase, hyphenated, 36 characters. */
export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality of two parsed JSON values, as Python compares dicts and lists. */
export function sameJson(left: unknown, right: unknown): boolean {
  return pythonJson(left as PyJson) === pythonJson(right as PyJson);
}
