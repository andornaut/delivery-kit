import {
  isPermitted,
  type Layout,
  readRegistry,
  resolveConversation,
  resolveHarness,
} from "@andornaut/coordination-kit/build/registry";

const NATIVE_ENV = { claude: "CLAUDE_CODE_SESSION_ID", codex: "CODEX_THREAD_ID" } as const;

/** Resolve the app's active operator, or preserve the legacy trusted-host contract. */
export function deliveryOperator(
  layout: Layout,
  env: NodeJS.ProcessEnv,
  appId: string,
  supervising = false,
): string | undefined {
  if (layout.mode !== "app") {
    return undefined;
  }
  const registry = readRegistry(layout);
  const operations = registry.operations;
  const owner = Object.hasOwn(operations, appId) ? operations[appId]?.busOwner : undefined;
  if (owner === undefined) {
    throw new Error(`app ${appId} has no registered delivery operator`);
  }
  const matches = Object.keys(registry.roles).filter((role) => {
    const claimed = env[NATIVE_ENV[resolveHarness(registry, role)]];
    return claimed !== undefined && resolveConversation(registry, role) === claimed;
  });
  const actor = { nativeId: env[NATIVE_ENV[resolveHarness(registry, owner)]] ?? null, role: owner };
  if (
    matches.length !== 1 ||
    matches[0] !== owner ||
    !isPermitted(layout, registry, actor, "delivery:operate", appId)
  ) {
    throw new Error(`app ${appId} requires its active registered operator with delivery:operate`);
  }
  if (
    supervising &&
    (!isPermitted(layout, registry, actor, "review:deliver", appId) ||
      !isPermitted(layout, registry, actor, "events:ingest", appId))
  ) {
    throw new Error(`app ${appId} runner requires review:deliver and events:ingest`);
  }
  return owner;
}
