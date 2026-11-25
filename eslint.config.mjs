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

export default defineConfig(
  {
    ignores: [".claude/", "node_modules/", "dist/"],
  },
  js.configs.recommended,
  ts.configs.recommended,
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
      "no-restricted-syntax": ["error", "WithStatement", "ImportExpression"],
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
  // No import cycles in src/, scripts/ or tests/: a module in a cycle can run before what it
  // imports has loaded. scripts/imports.test.ts checks the same trees, type-only imports included.
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
