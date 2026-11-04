// Request IDs are RFC 4122 version 5 UUIDs in the URL namespace, byte-identical to Python's
// uuid.uuid5(uuid.NAMESPACE_URL, name), so 0.9.x receipts deduplicate against 1.x ones.
import { createHash } from "node:crypto";

export const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
export const NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function uuid5(namespace: string, name: string): string {
  const hash = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(name, "utf8")
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/** Slot request ID shared by the Claude spool and the Codex steer. */
export function slotRequestId(coordinator: string, slot: number): string {
  return uuid5(NAMESPACE_URL, `hourly-unblock:${coordinator}:${slot}`);
}

/** Event request ID shared by both harnesses. */
export function eventRequestId(eventId: string, recipient: string): string {
  return uuid5(NAMESPACE_URL, `bus-event:${eventId}:${recipient}`);
}

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

export function canonicalUuid(value: unknown): string {
  if (!isCanonicalUuid(value)) {
    throw new Error("canonical session UUID required");
  }
  return value;
}
