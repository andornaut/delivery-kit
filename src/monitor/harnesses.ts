// Adapter selection by the registry's active harness.
import { claudeAdapter } from "../adapters/claude/index.ts";
import { codexAdapter } from "../adapters/codex/index.ts";
import type { HarnessAdapter } from "../adapters/types.ts";
import type { GameLayout, Layout } from "../layout.ts";
import type { Harness } from "../registry/schema.ts";

export { codexAdapter } from "../adapters/codex/index.ts";

export function adapterFor(
  env: NodeJS.ProcessEnv,
  layout: Layout,
  game: GameLayout,
  harness: Harness,
): HarnessAdapter {
  return harness === "claude" ? claudeAdapter(env, game) : codexAdapter(layout);
}
