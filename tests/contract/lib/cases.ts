// Case tags shared by every contract file.
//
// - contract: runs on both implementations with identical assertions.
// - bashConfig: the input exists only in Bash bus.conf syntax (0.9 legacy keys or shell
//   quoting); the Node implementation takes delivery-kit.json and the registry instead.
// - bashOnly: a 0.9 surface with no 1.0 CLI equivalent (export/package scripts, Python
//   entry argv). The Node replacement is covered by P2 packaging cases, not here.
// - hardened: 1.0 durability ordering (decision 5). Node asserts the hardened behaviour;
//   Bash asserts the 0.9 legacy behaviour where it differs.
// - retired: commands removed in 1.0 (decision 6); kept as a skipped, named group.
// - ciDisabled, localRemote: 0.9 modes 1.0 removes (CI is required; a remote is required).
//   Bash parity only, retired for Node with the decision as the reason.
// - queueModel: the 0.9 bus queue, admission, batch and cherry-pick model. 1.0 is trunk-based
//   (local main HEAD departs), so these run on Bash only and are retired for Node.
import { afterEach, describe, it } from "vitest";

import { impl } from "./adapter.ts";
import { type GameOptions, Workspace } from "./workspace.ts";

const skipped = impl.available !== true;

/** A contract group; skipped with its reason when the selected implementation is not built. */
export function suite(name: string, body: () => void): void {
  describe.skipIf(skipped)(`${name} [${impl.name}]`, body);
}

export const contract = it;

/**
 * The per-case real-time ceiling for cases that set one explicitly; the configured default is the
 * same. Condition waits are bounded separately (WAIT_CEILING_MS), so this only ends a hung case.
 */
export const CASE_TIMEOUT_MS = 600_000;

/**
 * Whether a native reply that never arrives is classified as a timeout. The v0.9.1 release
 * reads the control socket through websocket-client, whose receive timeout raises
 * WebSocketTimeoutException rather than TimeoutError, so its collectors record a generic
 * failure and keep calling. 1.0 must classify and latch it as a timeout, as the 0.9 unit
 * tests specified with a mocked TimeoutError.
 */
export const RECEIVE_TIMEOUT_LATCHES = impl.name !== "bash";

/**
 * The deferral for an unusable monitor route. 0.9 names its MONITOR_ROUTE_FILE key; 1.0 retires
 * the key for the fixed var/route.json.
 */
export const ROUTE_INVALID_MESSAGE =
  impl.name === "bash"
    ? "MONITOR_ROUTE_FILE is unavailable or invalid"
    : "monitor route is unavailable or invalid; its owner must verify identities and ownership";

/**
 * The deferral for worker parents outside the active monitor route. 0.9 names its
 * WORKER_PARENT_THREADS key; 1.0 names the delivery-kit.json field.
 */
export const WORKER_PARENTS_ROUTE_MESSAGE =
  impl.name === "bash"
    ? "WORKER_PARENT_THREADS requires parents in the active monitor route"
    : "workerParents requires parents in the active monitor route";

/** Retirement reasons for documented 1.0 decisions, shared by every case that cites them. */
export const CODEX_QUEUE_REMOVED =
  "the codex queue sink is removed; events go only to the registry recipient through the active adapter";
export const ROUTES_CARRY_NO_HARNESS =
  "routes carry no harness; the registry's active harness selects the adapter";
export const NO_VERSION_2_ROUTE = "1.0 has no version 2 route schema";

/** The fastest CI poll: 0 in 0.9; 1.0 rejects 0, and 1 second runs fast under the test clock. */
export const CI_POLL_SECONDS = impl.name === "bash" ? 0 : 1;

/** check-config's exit status for invalid configuration: 2 in 0.9, EXIT_INVALID (1) in 1.0. */
export const EXIT_INVALID_CONFIG = impl.name === "bash" ? 2 : 1;

export function bashConfig(
  name: string,
  body: () => Promise<void> | void,
  timeoutMs?: number,
): void {
  it.skipIf(impl.name !== "bash")(`[bash-config] ${name}`, body, timeoutMs);
}

export function bashOnly(name: string, body: () => Promise<void> | void): void {
  it.skipIf(impl.name !== "bash")(`[bash-only] ${name}`, body);
}

/**
 * A 0.9 contract a documented 1.0 decision removes: Bash parity only, reported on Node as
 * `[retired: <reason>]`. `tag` names the case on Bash.
 */
export function retiredOnNode(
  reason: string,
  tag: string,
  name: string,
  body: () => Promise<void> | void,
  timeoutMs?: number,
): void {
  it.skipIf(impl.name !== "bash")(
    `${impl.name === "bash" ? `[${tag}]` : `[retired: ${reason}]`} ${name}`,
    body,
    timeoutMs,
  );
}

export function queueModel(name: string, body: () => Promise<void> | void): void {
  retiredOnNode("trunk-based delivery", "queue-model", name, body);
}

/** 0.9 disables the CI watch with an empty GitHub slug; 1.0 requires CI. */
export function ciDisabled(name: string, body: () => Promise<void> | void): void {
  retiredOnNode("1.0 requires CI", "ci-disabled", name, body);
}

/** 0.9 integrates into local main without a remote; trunk-based 1.0 always pushes to one. */
export function localRemote(name: string, body: () => Promise<void> | void): void {
  retiredOnNode("trunk-based delivery requires a remote", "local-remote", name, body);
}

/** Assertions on queue, batch or branch artefacts inside an otherwise shared case. */
export const QUEUE_MODEL = impl.name === "bash";

export function hardened(
  name: string,
  bodies: { node: () => Promise<void> | void; bash: () => Promise<void> | void },
): void {
  it(`[hardened] ${name}`, impl.name === "node" ? bodies.node : bodies.bash);
}

export function retired(name: string, reason: string, cases: string[]): void {
  describe.skip(`[retired] ${name}: ${reason}`, () => {
    for (const title of cases) it(title, () => undefined);
  });
}

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
