// The loaded-code guard. At startup the runner records the loaded version, the game lockfile's
// integrity for the package and the sha256 of the loaded dist/cli.js in runner.json. At each
// departure it compares them with the installed copy; on a mismatch it logs, emits one
// deduplicated pin-mismatch event and finishes on the loaded code.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonDurable } from "../durable.ts";
import type { BusContext } from "./context.ts";

export const PACKAGE = "@andornaut/delivery-kit";

export interface PinIdentity {
  readonly version: string | null;
  readonly integrity: string | null;
  readonly cliSha256: string | null;
}

function sha256(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function jsonField(path: string, pick: (value: Record<string, unknown>) => unknown): string | null {
  try {
    const value = pick(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** The package the game's node_modules and package-lock.json currently provide. */
export function installedIdentity(repo: string): PinIdentity {
  const installed = join(repo, "node_modules", PACKAGE);
  return {
    cliSha256: sha256(join(installed, "dist", "cli.js")),
    integrity: jsonField(join(repo, "package-lock.json"), (lock) => {
      const packages = lock.packages as Record<string, Record<string, unknown>> | undefined;
      return packages?.[`node_modules/${PACKAGE}`]?.integrity;
    }),
    version: jsonField(join(installed, "package.json"), (manifest) => manifest.version),
  };
}

/** The running code: its embedded version, the loaded bundle digest and the startup lockfile. */
export function loadedIdentity(version: string, cliPath: string, repo: string): PinIdentity {
  return { cliSha256: sha256(cliPath), integrity: installedIdentity(repo).integrity, version };
}

export function recordPin(context: BusContext, loaded: PinIdentity, cliPath: string): void {
  writeJsonDurable(
    context.paths.runnerJson,
    {
      cliPath,
      cliSha256: loaded.cliSha256,
      integrity: loaded.integrity,
      pid: process.pid,
      schema: 1,
      startedAt: new Date(context.clock.now() * 1000).toISOString(),
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

function samePin(a: PinIdentity, b: PinIdentity): boolean {
  return a.version === b.version && a.cliSha256 === b.cliSha256 && a.integrity === b.integrity;
}

/** A guard bound to the loaded identity; check() returns false on a mismatch. */
export function pinGuard(context: BusContext, loaded: PinIdentity): { check(): boolean } {
  let reported: string | undefined;
  return {
    check(): boolean {
      const installed = installedIdentity(context.game.repo);
      if (samePin(loaded, installed)) {
        return true;
      }
      const key = `${describe(loaded)} -> ${describe(installed)}`;
      context.log(
        `bus: pin mismatch: loaded ${describe(loaded)}, installed ${describe(installed)}; finishing on the loaded code`,
      );
      if (reported !== key) {
        reported = key;
        context.events.emit(
          "pin-mismatch",
          createHash("sha256").update(key).digest("hex"),
          [
            `Runner pin mismatch: loaded ${describe(loaded)}, installed ${describe(installed)};`,
            "the runner finishes on the loaded code until a controlled idle replacement.",
          ].join(" "),
        );
      }
      return false;
    },
  };
}
