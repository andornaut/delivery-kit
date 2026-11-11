// check-config's worker-parent rule: each reports.workerParents role must resolve, through its
// selected harness, to a canonical lowercase conversation UUID, and no two parents may
// share one. Problems name the delivery-kit.json field, read from the raw registry so a registry
// that fails its own validation still points at the parent that caused it.
import { CANONICAL_UUID } from "../adapters/shared/ids.ts";
import type { ProjectConfig } from "../config.ts";

type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/** The selected ID of a registered role, without accepting an invalid override. */
function conversation(registry: Json, role: string): unknown {
  const roles = object(registry.roles) ?? {};
  const record = Object.hasOwn(roles, role) ? object(roles[role]) : undefined;
  if (record === undefined) {
    return undefined;
  }
  const harness = Object.hasOwn(record, "harness") ? record.harness : registry.harness;
  return harness === "claude" || harness === "codex"
    ? object(record.conversations)?.[harness]
    : undefined;
}

export function workerParentProblems(
  configFile: string,
  config: ProjectConfig,
  rawRegistry: unknown,
): string[] {
  const registry = object(rawRegistry);
  if (registry === undefined) {
    return [];
  }
  const problems: string[] = [];
  const seen = new Map<string, number>();
  config.reports.workerParents.forEach((role, index) => {
    const at = `${configFile}: /reports/workerParents/${index}`;
    const id = conversation(registry, role);
    if (typeof id !== "string" || !CANONICAL_UUID.test(id)) {
      problems.push(`${at}: ${role} has no canonical lowercase conversation UUID in registry.json`);
      return;
    }
    const first = seen.get(id);
    if (first !== undefined) {
      problems.push(`${at}: ${role} resolves to the same conversation as workerParents/${first}`);
    }
    seen.set(id, index);
  });
  return problems;
}
