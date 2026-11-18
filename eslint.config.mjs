import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import { createNodeResolver } from "eslint-plugin-import-x/node-resolver";
import noCycle from "eslint-plugin-import-x/rules/no-cycle";
import globals from "globals";
import ts from "typescript-eslint";

import { plugins, sourceRules, toolingRules } from "./eslint.config.base.mjs";

const KIT_FILES = ["src/**/*.ts"];
const TEST_FILES = ["src/**/*.test.ts", "scripts/**/*.test.ts"];

// The bundles load nothing from disk after startup: only node: builtins, the kit's own modules and
// coordination-kit's public build/ subpaths, which the build inlines.
const COORDINATION_KIT = "@andornaut/coordination-kit/build/";
const COORDINATION_KIT_APIS = "accounting|events|protocol|registry|review|shared|transport";
const OUTSIDE_NODE = {
  message: `src/ imports only node: builtins, its own modules by relative path and ${COORDINATION_KIT} subpaths.`,
  regex: `^(?!node:|\\.{1,2}/|${COORDINATION_KIT}(?:${COORDINATION_KIT_APIS})$)`,
};
// Review and event delivery go through the coordinator-installed CLI (src/bus/seam.ts).
const SEAM_MESSAGE =
  "Deliver reviews and events through the coordinator CLI seam in src/bus/seam.ts.";
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
    files: KIT_FILES,
    ignores: TEST_FILES,
    rules: {
      "no-restricted-imports": ["error", { paths: BUNDLED_SEAM, patterns: [OUTSIDE_NODE] }],
    },
  },
  // No import cycles: a module in a cycle can run before what it imports has loaded. Type-only
  // imports are erased at build time, so they never form one.
  {
    files: KIT_FILES,
    plugins: { "import-x": { rules: { "no-cycle": noCycle } } },
    rules: { "import-x/no-cycle": "error" },
    settings: {
      "import-x/extensions": [".ts"],
      "import-x/resolver-next": [createNodeResolver({ extensions: [".ts", ".js"] })],
    },
  },
  // Tests and tooling: they verify or produce what ships rather than being it.
  {
    files: [...TEST_FILES, "*.ts", "*.js", "*.mjs", "scripts/**/*.mjs"],
    plugins,
    rules: toolingRules,
  },
);
