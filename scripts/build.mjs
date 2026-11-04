// Build dist/cli.js and dist/registry.js as separate self-contained bundles, then the registry
// declarations. Each bundle is one file that imports only node: builtins, so a running process
// never reads its package again after startup.
import { execFileSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { build } from "vite";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const ENTRIES = [
  { entry: "src/bin.ts", name: "cli" },
  { entry: "src/registry/index.ts", name: "registry" },
];

for (const [index, { entry, name }] of ENTRIES.entries()) {
  // Sequential: the first build empties dist/ and the second adds to it.
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
    define: { __DK_VERSION__: JSON.stringify(version) },
    logLevel: "warn",
    ssr: { noExternal: true, target: "node" },
  });
}
chmodSync("dist/cli.js", 0o755);

execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.types.json"], {
  stdio: "inherit",
});
// Declarations keep the source's relative .ts specifiers; consumers resolve the emitted .js names.
for (const name of readdirSync("dist/types", { recursive: true })) {
  if (name.endsWith(".d.ts")) {
    const path = join("dist/types", name);
    writeFileSync(path, readFileSync(path, "utf8").replace(/"(\.{1,2}\/[^"]+)\.ts"/g, '"$1.js"'));
  }
}
writeFileSync("dist/registry.d.ts", 'export * from "./types/registry/index.js";\n');
