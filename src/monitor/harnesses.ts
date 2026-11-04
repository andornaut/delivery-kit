// Adapter selection by the registry's active harness.
import { claudeAdapter } from "../adapters/claude/index.ts";
import type { HarnessAdapter } from "../adapters/types.ts";
import type { GameLayout, Layout } from "../layout.ts";
import type { Harness } from "../registry/schema.ts";

/**
 * The Codex adapter is owned by the events-codex port. Until src/adapters/codex/index.ts lands,
 * this seam rejects; it then becomes `export { codexAdapter } from "../adapters/codex/index.ts"`.
 */
export function codexAdapter(layout: Layout): HarnessAdapter {
  void layout;
  throw new Error("codex adapter is not available in this build");
}

export function adapterFor(
  env: NodeJS.ProcessEnv,
  layout: Layout,
  game: GameLayout,
  harness: Harness,
): HarnessAdapter {
  return harness === "claude" ? claudeAdapter(env, game) : codexAdapter(layout);
}
