// Bus events with per-commit tracking. emitEvent records an event once through coordination-kit's
// outbox and, for a 40-hex key, tracks that commit's CI and deployment state under the same
// events/state.lock, adding a `complete` event when a pushed commit has CI success and a finished
// deployment. Delivery is coordination-kit's flushEvents.
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  enqueueEvent,
  QUIET_KINDS,
  recordEvent,
  writeEventState,
} from "@andornaut/coordination-kit/build/events";
import {
  type GameLayout,
  type PyJson,
  readJson,
  SHA_PATTERN,
} from "@andornaut/coordination-kit/build/shared";

export interface CommitState {
  [key: string]: PyJson | undefined;
  ci: string;
  deploy: string;
  /** "skipped" for a docs-only departure, pushed without a gate. */
  gate?: string;
  pushed?: boolean;
}

export function deployFinished(state: CommitState): boolean {
  return state.deploy === "success" || state.deploy === "skipped";
}

/** Fold one event into `<key>.state`. The caller holds events/state.lock. */
export function trackCommit(directory: string, project: string, kind: string, key: string): void {
  const path = join(directory, `${key}.state`);
  const initial = { ci: "pending", deploy: "pending" };
  const state = (existsSync(path) ? readJson(path) : initial) as CommitState;
  const quiet = QUIET_KINDS.has(kind);
  if (kind.startsWith("ci_") && !(quiet && state.ci === "success")) {
    state.ci = kind.slice(3);
  }
  if (kind.startsWith("deploy_") && !(quiet && deployFinished(state))) {
    state.deploy = kind.slice(7);
  }
  if (kind === "push") {
    state.pushed = true;
  }
  if (kind === "gate_skipped") {
    state.gate = "skipped";
  }
  writeEventState(path, state);
  if (state.pushed === true && state.ci === "success" && deployFinished(state)) {
    const gate = state.gate === "skipped" ? "docs-only, gate skipped" : "full gate passed";
    enqueueEvent(
      directory,
      project,
      "complete",
      key,
      `COMPLETE ${key}: ${gate}; CI success; deployment ${state.deploy}.`,
    );
  }
}

/** Record one event, at most once per identity. A 40-hex key also updates that commit's state. */
export function emitEvent(
  game: GameLayout,
  options: { readonly project: string },
  kind: string,
  key: string,
  message: string,
): void {
  recordEvent(
    game,
    {
      project: options.project,
      underLock: SHA_PATTERN.test(key)
        ? (directory) => trackCommit(directory, options.project, kind, key)
        : undefined,
    },
    kind,
    key,
    message,
  );
}
