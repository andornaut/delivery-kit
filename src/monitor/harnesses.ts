// Adapter selection by the recipient's effective harness.
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
  if (harness === "claude") {
    return claudeAdapter(env, game);
  }
  if (harness === "codex") {
    return codexAdapter(layout);
  }
  throw new Error("monitor adapter harness invalid");
}
