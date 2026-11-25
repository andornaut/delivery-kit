// The package pin: the identity of the loaded and the installed delivery-kit. At startup the
// runner records the loaded version, the bundled coordination-kit version, the game lockfile's
// integrity for the package and the sha256 of the loaded dist/cli.js in runner.json. At each
// departure it compares them with the installed copy; on a mismatch it logs, emits one
// deduplicated pin-mismatch event and finishes on the loaded code.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeJsonDurable } from "@andornaut/coordination-kit/build/shared";

import { COORDINATION_KIT_BUNDLED, PACKAGE } from "../compatibility.ts";
import { fileSha256, readTrimmed } from "../lib/files.ts";

export interface PinIdentity {
  readonly version: string | null;
  readonly integrity: string | null;
  readonly sourceCommit: string | null;
  readonly cliSha256: string | null;
}

function jsonField(path: string, pick: (value: Record<string, unknown>) => unknown): string | null {
  try {
    const value = pick(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
    return typeof value === "string" && value.trim() !== "" ? value : null;
  } catch {
    return null;
  }
}

/** Source metadata is a claim, not independent archive verification. */
function sourceCommit(toolRoot: string): string | null {
  const value = readTrimmed(join(toolRoot, "SOURCE_COMMIT"));
  return value !== undefined && /^[a-f0-9]{40}$/.test(value) ? value : null;
}

function lockIntegrity(repo: string): string | null {
  return jsonField(join(repo, "package-lock.json"), (lock) => {
    const packages = lock.packages as Record<string, Record<string, unknown>> | undefined;
    return packages?.[`node_modules/${PACKAGE}`]?.integrity;
  });
}

/** The package the game's node_modules and package-lock.json currently provide. */
export function installedIdentity(repo: string): PinIdentity {
  const installed = join(repo, "node_modules", PACKAGE);
  return {
    cliSha256: fileSha256(join(installed, "dist", "cli.js")),
    integrity: lockIntegrity(repo),
    sourceCommit: sourceCommit(installed),
    version: jsonField(join(installed, "package.json"), (manifest) =>
      manifest.name === undefined || manifest.name === PACKAGE ? manifest.version : null,
    ),
  };
}

/** The running code: its embedded version, startup bundle digest and metadata. */
export function loadedIdentity(version: string, cliPath: string, repo: string): PinIdentity {
  return {
    cliSha256: fileSha256(cliPath),
    integrity: lockIntegrity(repo),
    sourceCommit: sourceCommit(dirname(dirname(cliPath))),
    version,
  };
}

/** Write runner.json: the loaded identity, the bundled coordination-kit and this process. */
export function recordPin(
  file: string,
  run: { readonly cliPath: string; readonly pid: number; readonly startedAt: number },
  loaded: PinIdentity,
): void {
  writeJsonDurable(
    file,
    {
      cliPath: run.cliPath,
      cliSha256: loaded.cliSha256,
      coordinationKitVersion: COORDINATION_KIT_BUNDLED,
      integrity: loaded.integrity,
      pid: run.pid,
      schema: 1,
      startedAt: new Date(run.startedAt * 1000).toISOString(),
      version: loaded.version,
    },
    { mode: 0o644 },
  );
}

function describe(identity: PinIdentity): string {
  return `${identity.version ?? "missing"} (cli ${identity.cliSha256?.slice(0, 12) ?? "missing"}, integrity ${
    identity.integrity ?? "missing"
  })`;
}

export interface PinMismatch {
  /** The sha256 of the loaded and installed descriptions: the pin-mismatch event key. */
  readonly key: string;
  readonly logLine: string;
  readonly detail: string;
}

/**
 * The mismatch between the loaded and the installed package, or undefined when the version, the
 * bundle digest and the lockfile integrity all agree.
 */
export function pinMismatch(loaded: PinIdentity, installed: PinIdentity): PinMismatch | undefined {
  if (
    loaded.version === installed.version &&
    loaded.cliSha256 === installed.cliSha256 &&
    loaded.integrity === installed.integrity
  ) {
    return undefined;
  }
  const pair = `loaded ${describe(loaded)}, installed ${describe(installed)}`;
  return {
    detail: [
      `Runner pin mismatch: ${pair};`,
      "the runner finishes on the loaded code until a controlled idle replacement.",
    ].join(" "),
    key: createHash("sha256")
      .update(`${describe(loaded)} -> ${describe(installed)}`)
      .digest("hex"),
    logLine: `bus: pin mismatch: ${pair}; finishing on the loaded code`,
  };
}
