// Stage the built package, pack it and write SOURCE_COMMIT and SHA256SUMS beside the archive.
// Usage: node scripts/release-package.mjs STAGING_DIRECTORY OUTPUT_DIRECTORY (after scripts/build.mjs).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const [staging, output] = process.argv.slice(2).map((path) => resolve(path));
if (staging === undefined || output === undefined) {
  throw new Error("usage: release-package.mjs STAGING_DIRECTORY OUTPUT_DIRECTORY");
}
const version = readFileSync("VERSION", "utf8").trim();
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.version !== version) {
  throw new Error(`package.json version ${manifest.version} differs from VERSION ${version}`);
}
const commit = readFileSync("SOURCE_COMMIT", "utf8");
if (!/^[0-9a-f]{40}\n$/.test(commit)) {
  throw new Error("SOURCE_COMMIT must hold one exact commit");
}

mkdirSync(staging);
cpSync("dist", join(staging, "dist"), { recursive: true });
for (const file of ["README.md", "LICENSE", "SOURCE_COMMIT"]) {
  copyFileSync(file, join(staging, file));
}
delete manifest.devDependencies;
delete manifest.overrides;
delete manifest.scripts;
writeFileSync(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const archive = `delivery-kit-${version}.tgz`;
if (existsSync(join(output, archive))) {
  throw new Error(`${archive} already exists`);
}
execFileSync("npm", ["pack", "--offline", "--ignore-scripts", "--pack-destination", output], {
  cwd: staging,
  stdio: ["ignore", "ignore", "inherit"],
});
renameSync(join(output, `andornaut-delivery-kit-${version}.tgz`), join(output, archive));
writeFileSync(join(output, "SOURCE_COMMIT"), commit);
const sums = [archive, "SOURCE_COMMIT"]
  .map(
    (name) =>
      `${createHash("sha256")
        .update(readFileSync(join(output, name)))
        .digest("hex")}  ${name}\n`,
  )
  .join("");
writeFileSync(join(output, "SHA256SUMS"), sums);
