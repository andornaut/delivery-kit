// Role names resolve to a registered role key, then to its selected harness's conversation ID.
import type { Harness, Registry } from "./schema.ts";

export class UnknownRole extends Error {
  readonly role: string;

  constructor(role: string) {
    super(`no registered role named ${role}`);
    this.name = "UnknownRole";
    this.role = role;
  }
}

/** A registered role key resolves to itself; any other name throws UnknownRole. */
export function resolveRole(registry: Registry, role: string): string {
  if (!Object.hasOwn(registry.roles, role)) {
    throw new UnknownRole(role);
  }
  return role;
}

/** The role's selected transport, falling back to the global default. */
export function resolveHarness(registry: Registry, role: string): Harness {
  return registry.roles[resolveRole(registry, role)]?.harness ?? registry.harness;
}

/** The selected conversation only, or null when that transport has no ID. */
export function resolveConversation(registry: Registry, role: string): string | null {
  const record = registry.roles[resolveRole(registry, role)];
  return record?.conversations[resolveHarness(registry, role)] ?? null;
}
