import { join } from "node:path";

import { canonicalUuid } from "../adapters/shared/ids.ts";
import type { Layout } from "../layout.ts";
import { resolveProtocolLayout } from "../protocol/layout.ts";

export function messageLayout(layout: Pick<Layout, "reviewDir"> & Partial<Layout>): Layout | null {
  return layout.root !== undefined && layout.config !== undefined && layout.varDir !== undefined
    ? (layout as Layout)
    : null;
}

export function messageDirectory(layout: Pick<Layout, "reviewDir"> & Partial<Layout>): string {
  const complete = messageLayout(layout);
  return (
    (complete === null ? null : resolveProtocolLayout(complete))?.messagesDir ??
    join(layout.reviewDir, "messages")
  );
}

/** Existing channel contract beneath the shared durable role inbox. Creates no state. */
export function messageChannelStateDir(
  layout: Pick<Layout, "reviewDir"> & Partial<Layout>,
  conversationId: string,
): string {
  return join(messageDirectory(layout), "recipients", canonicalUuid(conversationId), "unblock");
}
