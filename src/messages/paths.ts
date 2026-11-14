import { join } from "node:path";

import { canonicalUuid } from "../adapters/shared/ids.ts";
import type { Layout } from "../layout.ts";

/** Existing channel contract beneath the shared durable role inbox. Creates no state. */
export function messageChannelStateDir(
  layout: Pick<Layout, "reviewDir">,
  conversationId: string,
): string {
  return join(layout.reviewDir, "messages", "recipients", canonicalUuid(conversationId), "unblock");
}
