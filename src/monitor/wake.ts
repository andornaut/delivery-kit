// Scheduled monitor wake for a due slot. Placeholder until the monitor port lands.
import type { GameLayout, Layout } from "../layout.ts";

export function deliverScheduledWake(
  layout: Layout,
  game: GameLayout,
  slot: number,
): Promise<string> {
  void layout;
  void game;
  void slot;
  return Promise.reject(new Error("monitor port pending"));
}
