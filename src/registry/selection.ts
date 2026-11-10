// Scoped transport selection changes no activation or ownership evidence.
import type { Layout } from "../layout.ts";
import { checkArray, checkEnum, checkObject, checkString, Issues } from "../validate.ts";
import { resolveRole } from "./resolve.ts";
import { type Harness, HARNESSES, type Registry } from "./schema.ts";
import { type UpdateOptions, updateRegistry } from "./store.ts";

export interface RoleSelection {
  readonly games?: readonly string[];
  /** Registered role keys or unambiguous duties. */
  readonly roles?: readonly string[];
}

export interface HarnessSelection extends RoleSelection {
  readonly harness: Harness | "default";
}

/** Resolve an explicit nonempty selection without changing registry state. */
export function resolveSelectedRoles(
  layout: Layout,
  registry: Registry,
  selection: RoleSelection,
): readonly string[] {
  const issues = new Issues();
  if (checkObject(issues, "", { optional: ["games", "roles"], required: [] }, selection)) {
    for (const key of ["games", "roles"] as const) {
      const names = selection[key];
      if (
        names !== undefined &&
        checkArray(issues, `/${key}`, { nonEmpty: true, unique: true }, names)
      ) {
        names.forEach((name, index) => checkString(issues, `/${key}/${index}`, null, name));
      }
    }
    if (selection.games === undefined && selection.roles === undefined) {
      issues.add("/", "select at least one game or role");
    }
  }
  issues.throwIfAny("role selection");
  const names = [...(selection.roles ?? [])];
  for (const game of selection.games ?? []) {
    const entry = Object.hasOwn(layout.config.games, game) ? layout.config.games[game] : undefined;
    if (entry === undefined) {
      issues.add("/games", `unknown game: ${game}`);
    } else {
      names.push(...entry.roles.map((role) => `${game}/${role}`));
    }
  }
  issues.throwIfAny("role selection");
  return [...new Set(names.map((name) => resolveRole(registry, name)))].sort();
}

/** Atomically select only named roles under the registry's revision-checked write lock. */
export function selectHarness(
  layout: Layout,
  expectedRevision: number,
  selection: HarnessSelection,
  options: UpdateOptions = {},
): Registry {
  return updateRegistry(
    layout,
    expectedRevision,
    (draft) => {
      const issues = new Issues();
      if (
        checkObject(issues, "", { optional: ["games", "roles"], required: ["harness"] }, selection)
      ) {
        checkEnum(issues, "/harness", [...HARNESSES, "default"], selection.harness);
      }
      issues.throwIfAny("harness selection");
      const { games, roles } = selection;
      const keys = resolveSelectedRoles(layout, draft, {
        ...(games === undefined ? {} : { games }),
        ...(roles === undefined ? {} : { roles }),
      });
      // Verify every selected endpoint before changing any role.
      for (const key of keys) {
        const harness = selection.harness === "default" ? draft.harness : selection.harness;
        if (draft.roles[key]?.conversations[harness] == null) {
          issues.add(
            `/roles/${key}/conversations/${harness}`,
            "selected conversation is unavailable",
          );
        }
      }
      issues.throwIfAny("harness selection");
      for (const key of keys) {
        const role = draft.roles[key]!;
        if (selection.harness === "default") {
          delete role.harness;
        } else {
          role.harness = selection.harness;
        }
      }
    },
    options,
  );
}
