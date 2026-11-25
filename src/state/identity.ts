// runner.identity.json: the runner's self-attested identity. Only the runner writes it, while it
// holds runner.lock, and binds its token into runner.lock so a reader can attest it.
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync, writeSync } from "node:fs";

import { writeDurable } from "@andornaut/coordination-kit/build/shared";

import { fileSha256, readText } from "../lib/files.ts";
import { isoSeconds } from "../lib/values.ts";
import type { BusPaths } from "./paths.ts";

export interface IdentityInput {
  readonly cliSha256?: string | null;
  /** The bundled coordination-kit version. */
  readonly coordinationKitVersion?: string | null;
  readonly pid: number;
  readonly version: string;
  readonly sourceCommit: string | null;
  readonly config: string;
  readonly toolRoot: string;
  /** Epoch nanoseconds; injectable for tests. */
  readonly startedNs?: bigint;
}

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

/** Write runner.identity.json, then bind its token into runner.lock. */
export function recordIdentity(paths: BusPaths, input: IdentityInput): Record<string, unknown> {
  const started = input.startedNs ?? nowNs();
  const token = `${input.pid}:${started}:${randomUUID()}`;
  const startedAt = isoSeconds(Number(started / 1_000_000n));
  const identity = {
    cli_sha256: input.cliSha256 ?? null,
    config: input.config,
    config_sha256: fileSha256(input.config),
    coordination_kit_version: input.coordinationKitVersion ?? null,
    pid: input.pid,
    source_commit: input.sourceCommit,
    started_at: startedAt,
    started_ns: "__STARTED_NS__",
    state_dir: paths.dir,
    token,
    tool_root: input.toolRoot,
    version: input.version,
  };
  // started_ns exceeds the exact integer range of a double, so it is spliced in as text.
  const text = JSON.stringify(sortKeys(identity), null, 2).replace(
    '"__STARTED_NS__"',
    String(started),
  );
  writeDurable(paths.identity, `${text}\n`, { mode: 0o644 });
  // O_TRUNC keeps the lock inode, so the holder's lock stays valid while the token changes.
  const fd = openSync(paths.runnerLock, constants.O_WRONLY | constants.O_TRUNC);
  try {
    writeSync(fd, `${token}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { ...identity, started_ns: started };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function parse(text: string | undefined): unknown {
  if (text === undefined) {
    throw new Error("unreadable");
  }
  return JSON.parse(text) as unknown;
}

/**
 * The identity file parsed with started_ns kept exact: null when it does not exist, "unreadable"
 * when it exists but cannot be read or is not a JSON object.
 */
export function readIdentity(paths: BusPaths): Record<string, unknown> | "unreadable" | null {
  if (!existsSync(paths.identity)) {
    return null;
  }
  try {
    const text = readText(paths.identity);
    const value = parse(text?.replace(/"started_ns":\s*(\d+)/, '"started_ns": "$1"'));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return "unreadable";
    }
    const identity = value as Record<string, unknown>;
    if (typeof identity.started_ns === "string") {
      identity.started_ns = BigInt(identity.started_ns);
    }
    return identity;
  } catch {
    return "unreadable";
  }
}
