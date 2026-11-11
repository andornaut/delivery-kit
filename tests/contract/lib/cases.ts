// Shared helpers for every contract file. Each case drives the built 1.0 CLI (dist/cli.js).
import { afterEach, describe, it } from "vitest";

import { impl } from "./adapter.ts";
import { type GameOptions, Workspace } from "./workspace.ts";

const skipped = impl.available !== true;

/** A contract group; skipped with its reason when the bundle is not built. */
export function suite(name: string, body: () => void): void {
  describe.skipIf(skipped)(name, body);
}

export const contract = it;

/**
 * The per-case real-time ceiling for cases that set one explicitly; the configured default is the
 * same. Condition waits are bounded separately (WAIT_CEILING_MS), so this only ends a hung case.
 */
export const CASE_TIMEOUT_MS = 600_000;

/** The deferral for an unusable review route. */
export const ROUTE_INVALID_MESSAGE =
  "review route is unavailable or invalid; its owner must verify identities and ownership";

/** The deferral for worker parents outside the active review route. */
export const WORKER_PARENTS_ROUTE_MESSAGE =
  "workerParents requires parents in the active review route";

/** check-config's exit status for invalid configuration. */
export const EXIT_INVALID = 1;

/** A fresh workspace per case, removed afterwards. */
export function workspaces(): (options?: GameOptions) => Workspace {
  const created: Workspace[] = [];
  afterEach(() => {
    for (const ws of created.splice(0)) ws.cleanup();
  });
  return (options) => {
    const ws = new Workspace(options);
    created.push(ws);
    return ws;
  };
}
