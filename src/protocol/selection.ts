import { isDeepStrictEqual } from "node:util";

import type { Layout } from "../layout.ts";
import {
  type ProtocolLayout,
  ProtocolLayoutError,
  type ProtocolManagement,
  resolveProtocolLayout,
  resolveProtocolManagement,
} from "./layout.ts";

export interface ProtocolSelection {
  readonly management: ProtocolManagement;
  readonly protocol: ProtocolLayout | null;
}

/** Pending migration retains primitive intake and transport without adopting a legacy journal. */
export function captureProtocolSelection(layout: Layout): ProtocolSelection {
  const management = resolveProtocolManagement(layout);
  const protocol = management.status === "pending" ? null : resolveProtocolLayout(layout);
  const selected = { management, protocol };
  checkProtocolSelection(layout, selected);
  return selected;
}

export function checkProtocolSelection(layout: Layout, expected: ProtocolSelection): void {
  const management = resolveProtocolManagement(layout);
  if (
    !isDeepStrictEqual(management, expected.management) ||
    (management.status !== "pending" &&
      !isDeepStrictEqual(resolveProtocolLayout(layout), expected.protocol))
  ) {
    throw new ProtocolLayoutError("protocol-generation-conflict");
  }
}
