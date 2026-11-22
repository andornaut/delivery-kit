// Build self-contained CLI and public API bundles with declarations. Each inlines the
// coordination-kit modules it uses and imports only node: builtins, so a running process never
// reads its package, or coordination-kit's, again after startup.
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

import { build } from "vite";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
// The coordination-kit the bundles inline; package-check refuses one outside the supported range.
const coordinationKit = JSON.parse(
  readFileSync("node_modules/@andornaut/coordination-kit/package.json", "utf8"),
).version;
const ENTRIES = [
  { entry: "src/bin.ts", name: "cli" },
  { entry: "src/source-identity.ts", name: "source-identity" },
];

for (const [index, { entry, name }] of ENTRIES.entries()) {
  // Sequential: the first build empties dist/ and later builds add to it.
  // eslint-disable-next-line no-await-in-loop
  await build({
    build: {
      copyPublicDir: false,
      emptyOutDir: index === 0,
      minify: false,
      outDir: "dist",
      reportCompressedSize: false,
      rolldownOptions: {
        output: { codeSplitting: false, entryFileNames: `${name}.js`, format: "es" },
      },
      sourcemap: false,
      ssr: entry,
      target: "node24",
    },
    configFile: false,
    define: {
      __DK_COORDINATION_KIT_VERSION__: JSON.stringify(coordinationKit),
      __DK_VERSION__: JSON.stringify(version),
    },
    logLevel: "warn",
    ssr: { noExternal: true, target: "node" },
  });
}
chmodSync("dist/cli.js", 0o755);

execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.types.json"], {
  stdio: "inherit",
});
writeFileSync("dist/source-identity.d.ts", 'export * from "./types/source-identity.js";\n');
