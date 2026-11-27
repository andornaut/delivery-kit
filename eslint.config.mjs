import { readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import { createNodeResolver } from "eslint-plugin-import-x/node-resolver";
import noCycle from "eslint-plugin-import-x/rules/no-cycle";
import globals from "globals";
import ts from "typescript-eslint";

import { plugins, sourceRules, toolingRules } from "./eslint.config.base.mjs";

const KIT_FILES = ["src/**/*.ts"];
const MODULE_FILES = [...KIT_FILES, "scripts/**/*.{ts,mts,mjs}", "tests/**/*.{ts,mts,mjs}"];
const TEST_FILES = ["src/**/*.test.ts", "scripts/**/*.test.ts"];

// The bundles load nothing from disk after startup: only node: builtins, the kit's own modules and
// coordination-kit's public build/ subpaths, which the build inlines.
// coordination-kit 3.0 keeps these subpaths unchanged.
const COORDINATION_KIT = "@andornaut/coordination-kit/build/";
const COORDINATION_KIT_APIS = "registry|review|shared|store";
const OUTSIDE_NODE = {
  message: `src/ imports only node: builtins, its own modules by relative path and ${COORDINATION_KIT} subpaths.`,
  regex: `^(?!node:|\\.{1,2}/|${COORDINATION_KIT}(?:${COORDINATION_KIT_APIS})$)`,
};
// coordination-kit 3.0 removes the work protocol; nothing here, tests and tooling included, reads it.
const NO_PROTOCOL = {
  message:
    "delivery-kit reads no work protocol state; coordination-kit 3.0 removes build/protocol.",
  regex: `^${COORDINATION_KIT}protocol(?:/|$)`,
};
// Review and event delivery go through the coordinator-installed CLI (src/seam/coordinator.ts).
const SEAM_MESSAGE =
  "Deliver reviews and events through the coordinator CLI seam in src/seam/coordinator.ts.";
const BUNDLED_SEAM = [
  {
    importNames: ["deliverScheduledReview", "DEFERRED_PREFIX"],
    message: SEAM_MESSAGE,
    name: `${COORDINATION_KIT}review`,
  },
  {
    importNames: ["flushEvents", "flushEventsWith"],
    message: SEAM_MESSAGE,
    name: `${COORDINATION_KIT}events`,
  },
  {
    importNames: ["enqueueEvent", "recordEvent"],
    message: "Append runner events to bus/events.jsonl through src/state/eventlog.ts.",
    name: `${COORDINATION_KIT}events`,
  },
];

// The layers of src/, lowest first. Each entry is a group: a folder of src/ or a module directly in
// it. A shipped module imports only its own group and the groups of lower layers, type-only imports
// and re-exports included; never another group in its own layer, a higher layer or support code.
// Support code (src/testing/, scripts/, tests/) and tests never ship and are exempt.
const LAYERS = [
  ["lib", "compatibility.ts", "source-identity.ts"],
  ["state"],
  ["status", "seam", "gate"],
  ["runner", "supervision"],
  ["commands"],
  ["cli.ts"],
  ["bin.ts"],
];
const SUPPORT_FOLDER = "testing";
const SOURCE_ROOT = fileURLToPath(new URL("src/", import.meta.url));
const GROUP_LAYERS = new Map(
  LAYERS.flatMap((groups, layer) => groups.map((group) => [group, layer])),
);

const SRC_GROUPS = readdirSync(SOURCE_ROOT, { withFileTypes: true })
  .filter((entry) =>
    entry.isDirectory() ? entry.name !== SUPPORT_FOLDER : !entry.name.endsWith(".test.ts"),
  )
  .map((entry) => entry.name);
const unplaced = SRC_GROUPS.filter((name) => !GROUP_LAYERS.has(name));
if (unplaced.length > 0) {
  throw new Error(`src/ entries in no layer: ${unplaced.join(", ")}`);
}

const SRC_SYNTAX = ["WithStatement", "ImportExpression"];
// `typeof import("...")` names a module that no-restricted-imports does not see.
const TYPE_QUERY = {
  message: "Import types with `import type`, which the layer rule checks.",
  selector: "TSImportType",
};

function sourceGroup(path) {
  return relative(SOURCE_ROOT, path).split(sep)[0];
}

const sourceLayers = {
  create(context) {
    const group = sourceGroup(context.filename);
    const layer = GROUP_LAYERS.get(group);
    const directory = dirname(context.filename);
    function check(node) {
      const specifier = node.source?.value;
      if (!specifier?.startsWith("./") && !specifier?.startsWith("../")) {
        return;
      }
      const target = sourceGroup(resolve(directory, specifier));
      if (target !== group && !(GROUP_LAYERS.get(target) < layer)) {
        context.report({
          node: node.source,
          message: `src/${group} may reference its own group and lower layers only.`,
        });
      }
    }
    return {
      ImportDeclaration: check,
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
    };
  },
};

export default defineConfig(
  {
    ignores: [".claude/", "node_modules/", "dist/"],
  },
  js.configs.recommended,
  ts.configs.recommended,
  // `import { type A }` still loads its module at runtime under verbatimModuleSyntax, while
  // import-x/no-cycle skips it as type-only. `import type` keeps every runtime import visible.
  {
    files: ["**/*.ts", "**/*.mts"],
    rules: { "@typescript-eslint/no-import-type-side-effects": "error" },
  },
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: KIT_FILES,
    plugins,
    rules: {
      ...sourceRules,
      "no-restricted-syntax": ["error", ...SRC_SYNTAX],
    },
  },
  {
    files: ["**/*.ts", "**/*.mts", "**/*.js", "**/*.mjs"],
    rules: { "no-restricted-imports": ["error", { patterns: [NO_PROTOCOL] }] },
  },
  {
    files: KIT_FILES,
    ignores: TEST_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: BUNDLED_SEAM, patterns: [NO_PROTOCOL, OUTSIDE_NODE] },
      ],
    },
  },
  {
    files: KIT_FILES,
    ignores: [...TEST_FILES, `src/${SUPPORT_FOLDER}/**/*.ts`],
    plugins: { "delivery-kit": { rules: { "source-layers": sourceLayers } } },
    rules: {
      "delivery-kit/source-layers": "error",
      "no-restricted-syntax": ["error", ...SRC_SYNTAX, TYPE_QUERY],
    },
  },
  // No runtime import cycles in src/, scripts/ or tests/: a module in a cycle can run before what
  // it imports has loaded. Type-only imports are erased at build time, so they may form a cycle;
  // in src/ the layer boundaries keep any such cycle within one group.
  {
    files: MODULE_FILES,
    plugins: { "import-x": { rules: { "no-cycle": noCycle } } },
    rules: { "import-x/no-cycle": "error" },
    settings: {
      "import-x/extensions": [".ts", ".mts", ".mjs"],
      "import-x/resolver-next": [
        createNodeResolver({ extensions: [".ts", ".mts", ".mjs", ".js"] }),
      ],
    },
  },
  // Tests and tooling: they verify or produce what ships rather than being it.
  {
    files: [...TEST_FILES, "*.ts", "*.js", "*.mjs", "scripts/**/*.mjs"],
    plugins,
    rules: toolingRules,
  },
);
