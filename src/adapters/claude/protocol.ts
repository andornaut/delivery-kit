// The only Claude Code channel contract dependency: the channel notification and the initialize
// result. It is taken from the installed Claude Code client, not from published
// reference documentation: method notifications/claude/channel with string `content` and
// string-valued `meta` keys matching [A-Za-z_][A-Za-z0-9_]*, the experimental claude/channel
// capability, and a protocol version the client treats as legacy (it skips channel
// registration on a "modern" revision). Re-verify after Claude Code upgrades.
import type { SpoolEntry } from "./spool.ts";

export const SERVER_NAME = "delivery-kit-monitor";
export const LEGACY_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const DEFAULT_PROTOCOL = "2025-06-18";

export interface ChannelNotification {
  readonly jsonrpc: "2.0";
  readonly method: "notifications/claude/channel";
  readonly params: { readonly content: string; readonly meta: Readonly<Record<string, string>> };
}

export function channelNotification(entry: SpoolEntry): ChannelNotification {
  const meta: Record<string, string> = { kind: entry.kind, request_id: entry.requestId };
  if (entry.slot !== undefined) {
    meta.slot = String(entry.slot);
  }
  if (entry.event_id !== undefined) {
    meta.event_id = entry.event_id;
  }
  return {
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content: entry.text, meta },
  };
}

export function initializeResult(params: unknown): Record<string, unknown> {
  const requested =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>).protocolVersion
      : undefined;
  const protocolVersion = (LEGACY_PROTOCOLS as readonly unknown[]).includes(requested)
    ? (requested as string)
    : DEFAULT_PROTOCOL;
  return {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions:
      "Scheduled delivery-kit monitor briefs arrive as channel events. " +
      "Delivery is not handling; record handling separately.",
    protocolVersion,
    serverInfo: { name: SERVER_NAME, version: "1" },
  };
}
