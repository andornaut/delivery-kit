// bus/seam.json: the last coordinator CLI identity a seam result carried and when this runner saw
// it, and the read-only `coordinator_cli` status field derived from it.
import { readFileSync } from "node:fs";

import { writeJsonDurable } from "@andornaut/coordination-kit/build/shared";

import { COORDINATOR_CLI_RANGE, satisfies } from "../compatibility.ts";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface CliIdentity {
  readonly version: string;
  readonly distSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `{version, distSha256}` identity, or undefined when the value is not one. */
export function cliIdentity(value: unknown): CliIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { distSha256, version } = value;
  return typeof version === "string" &&
    version !== "" &&
    typeof distSha256 === "string" &&
    SHA256.test(distSha256)
    ? { distSha256, version }
    : undefined;
}

/** bus/seam.json: the last CLI identity a seam result carried and when this runner saw it. */
interface SeamRecord {
  readonly schema: 1;
  readonly version: string;
  readonly distSha256: string;
  readonly seenAt: string;
}

/** The read-only `coordinator_cli` status field. */
export interface CoordinatorCliReport {
  readonly version: string | null;
  readonly distSha256: string | null;
  readonly seenAt: string | null;
  readonly supported: boolean | null;
}

export function coordinatorCliReport(seamFile: string): CoordinatorCliReport {
  try {
    const value = JSON.parse(readFileSync(seamFile, "utf8")) as unknown;
    const cli = isRecord(value) && value.schema === 1 ? cliIdentity(value) : undefined;
    if (cli !== undefined && isRecord(value) && typeof value.seenAt === "string") {
      return {
        ...cli,
        seenAt: value.seenAt,
        supported: satisfies(COORDINATOR_CLI_RANGE, cli.version),
      };
    }
  } catch {
    // Absent or unreadable: nothing seen.
  }
  return { distSha256: null, seenAt: null, supported: null, version: null };
}

/** Write the identity and the time it was seen, to the second, in UTC. */
export function writeSeamRecord(file: string, cli: CliIdentity, now: number): void {
  const record: SeamRecord = {
    distSha256: cli.distSha256,
    schema: 1,
    seenAt: new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z"),
    version: cli.version,
  };
  writeJsonDurable(file, record, { mode: 0o644 });
}
