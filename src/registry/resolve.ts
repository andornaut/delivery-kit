// Role names resolve to a role key, then to the active harness's conversation ID.
import type { Harness, Registry } from "./schema.ts";

export class UnknownRole extends Error {
  readonly role: string;

  constructor(role: string) {
    super(`no registered role or duty named ${role}`);
    this.name = "UnknownRole";
    this.role = role;
  }
}

export class AmbiguousRole extends Error {
  readonly role: string;
  readonly holders: readonly string[];

  constructor(role: string, holders: readonly string[]) {
    super(`duty ${role} is held by more than one role: ${holders.join(", ")}`);
    this.name = "AmbiguousRole";
    this.role = role;
    this.holders = holders;
  }
}

/** A role key resolves to itself; a duty name resolves to the one role holding it. */
export function resolveRole(registry: Registry, role: string): string {
  if (Object.hasOwn(registry.roles, role)) {
    return role;
  }
  const holders = Object.entries(registry.roles)
    .filter(([, record]) => record.duties?.includes(role) === true)
    .map(([key]) => key);
  if (holders.length === 0) {
    throw new UnknownRole(role);
  }
  if (holders.length > 1) {
    throw new AmbiguousRole(role, holders);
  }
  return holders[0] as string;
}

/** The role or duty holder's selected transport, falling back to the global default. */
export function resolveHarness(registry: Registry, role: string): Harness {
  return registry.roles[resolveRole(registry, role)]?.harness ?? registry.harness;
}

/** The selected conversation only, or null when that transport has no ID. */
export function resolveConversation(registry: Registry, role: string): string | null {
  const record = registry.roles[resolveRole(registry, role)];
  return record?.conversations[resolveHarness(registry, role)] ?? null;
}
