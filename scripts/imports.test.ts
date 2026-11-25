// The relative import graph of src/ and scripts/ has no cycles, type-only imports included: a
// module in a cycle can run before what it imports has loaded, and a type cycle still ties two
// modules' interfaces together. Each source module imports only its own directory and the layers
// below it, so dependencies point from the CLI down to the domain-free helpers.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Graph = ReadonlyMap<string, readonly string[]>;

/**
 * The source layers, lowest first. A module may import its own group and any group in a lower
 * layer, never one in its own layer or above. testing/ holds test fixtures, which no source module
 * imports.
 */
const LAYERS: readonly (readonly string[])[] = [
  ["src/lib", "src/compatibility.ts", "src/source-identity.ts"],
  ["src/state"],
  ["src/status", "src/seam", "src/gate"],
  ["src/runner", "src/supervision"],
  ["src/commands"],
  ["src/cli.ts"],
  ["src/bin.ts"],
];

/** A module's group: its directory under src/, or the file itself at the top of src/. */
function group(path: string): string {
  const [top, second = ""] = path.split("/");
  return `${top}/${second}`;
}

function layer(path: string): number {
  return LAYERS.findIndex((groups) => groups.includes(group(path)));
}

function isTest(path: string): boolean {
  return /\.test\.ts$/u.test(path) || group(path) === "src/testing";
}

/** Each import of a source module that leaves its group for one at the same layer or above. */
function upwardImports(graph: Graph): string[] {
  return [...graph].flatMap(([from, targets]) => {
    if (!from.startsWith("src/") || isTest(from)) {
      return [];
    }
    return targets
      .filter((to) => group(to) !== group(from) && !(layer(to) >= 0 && layer(to) < layer(from)))
      .map((to) => `${from} -> ${to}`);
  });
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return /\.(?:ts|mjs)$/u.test(entry.name) ? [path] : [];
  });
}

/** The relative specifiers a module imports or re-exports statically. */
function relativeImports(text: string): string[] {
  return [
    ...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']/gmu),
    ...text.matchAll(/^\s*import\s*["'](\.{1,2}\/[^"']+)["']/gmu),
  ].map((match) => match[1] ?? "");
}

/** Each module of src/ and scripts/, relative to the root, with the modules it imports. */
function importGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const path of [...sources(join(root, "src")), ...sources(join(root, "scripts"))]) {
    const targets = relativeImports(readFileSync(path, "utf8")).map((specifier) =>
      relative(root, resolve(dirname(path), specifier)),
    );
    graph.set(relative(root, path), targets);
  }
  return graph;
}

/** Every strongly connected set of more than one module, or a module importing itself. */
function cycles(graph: Graph): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  const visit = (node: string): void => {
    index.set(node, index.size);
    low.set(node, index.get(node) ?? 0);
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) {
        continue;
      }
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member !== undefined) {
          onStack.delete(member);
          component.push(member);
        }
      } while (member !== undefined && member !== node);
      if (component.length > 1 || (graph.get(node) ?? []).includes(node)) {
        found.push(component.sort());
      }
    }
  };
  for (const node of [...graph.keys()].sort()) {
    if (!index.has(node)) {
      visit(node);
    }
  }
  return found.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}

describe("cycles", () => {
  it("finds a direct, a longer and a self cycle and passes a chain", () => {
    const graph = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", ["d"]],
      ["d", ["e"]],
      ["e", ["c", "f"]],
      ["f", []],
      ["g", ["g"]],
      ["h", ["f", "outside"]],
    ]);
    expect(cycles(graph)).toEqual([["a", "b"], ["c", "d", "e"], ["g"]]);
    expect(
      cycles(
        new Map([
          ["x", ["y"]],
          ["y", []],
        ]),
      ),
    ).toEqual([]);
  });
});

describe("the import graph", () => {
  const graph = importGraph();

  it("parses static, type-only, multi-line and re-export imports", () => {
    expect(
      relativeImports(
        [
          'import { a } from "./a.ts";',
          'import type { B } from "../b.ts";',
          "import {\n  c,\n  type D,\n} from './c.ts';",
          'export { e } from "./e.ts";',
          'import "./side.ts";',
          'import { join } from "node:path";',
        ].join("\n"),
      ),
    ).toEqual(["./a.ts", "../b.ts", "./c.ts", "./e.ts", "./side.ts"]);
  });

  it("resolves every relative import to a file", () => {
    const missing = [...graph].flatMap(([from, targets]) =>
      targets.filter((target) => !existsSync(join(root, target))).map((to) => `${from} -> ${to}`),
    );
    expect(missing).toEqual([]);
  });

  it("has no cycles in src/ or scripts/", () => {
    expect(cycles(graph)).toEqual([]);
  });

  it("places every source module in a layer", () => {
    const unplaced = [...graph.keys()].filter(
      (path) => path.startsWith("src/") && !isTest(path) && layer(path) < 0,
    );
    expect(unplaced).toEqual([]);
  });

  it("imports only the module's own group and lower layers", () => {
    expect(upwardImports(graph)).toEqual([]);
    expect(
      upwardImports(
        new Map([
          ["src/state/a.ts", ["src/runner/b.ts", "src/lib/c.ts", "src/state/d.ts"]],
          ["src/status/e.ts", ["src/seam/f.ts", "src/testing/g.ts"]],
          ["src/runner/h.test.ts", ["src/commands/i.ts"]],
        ]),
      ),
    ).toEqual([
      "src/state/a.ts -> src/runner/b.ts",
      "src/status/e.ts -> src/seam/f.ts",
      "src/status/e.ts -> src/testing/g.ts",
    ]);
  });
});
