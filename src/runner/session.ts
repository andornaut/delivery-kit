// The runner's delivery-control session: the runner incarnation's token bound to
// delivery-control.json, admission of delivery work under it and the observed state it reports.
// A direct caller without a resident runner takes the same singleton locks for the duration.
import { randomUUID } from "node:crypto";

import { holdLock } from "@andornaut/coordination-kit/build/shared";

import {
  beginDeliveryActivity,
  claimDeliveryRunner,
  endDeliveryActivity,
  readDeliveryControl,
  resumeDeliveryActivity,
  setObservedDelivery,
  updateDeliveryActivity,
} from "../state/control.ts";
import type { BusContext } from "./context.ts";

interface DeliverySession {
  readonly pending: PendingLifecycle;
  readonly token: string;
  claimed: boolean;
  release?: () => void;
  users: number;
}

const sessions = new WeakMap<BusContext, DeliverySession>();

/** Bind only after acquiring the runner singleton locks. */
export function bindDeliveryRunner(context: BusContext, token: string = randomUUID()): void {
  sessions.set(context, { claimed: false, pending: { tail: Promise.resolve() }, token, users: 0 });
  deliveryRunnerReady(context);
}

export function unbindDeliveryRunner(context: BusContext): void {
  sessions.delete(context);
}

/** Internal direct calls use the same singleton exclusion as the resident runner. */
export async function withDeliveryRunner<T>(
  context: BusContext,
  run: () => Promise<T>,
): Promise<T> {
  const session = sessions.get(context) ?? holdDeliveryRunner(context);
  session.users += 1;
  try {
    return await run();
  } finally {
    session.users -= 1;
    if (session.users === 0) {
      session.release?.();
    }
  }
}

function holdDeliveryRunner(context: BusContext): DeliverySession {
  const runner = holdLock(context.paths.runnerLock, { nonBlocking: true });
  let loop;
  try {
    const heldLoop = holdLock(context.paths.loopLock, { nonBlocking: true });
    loop = heldLoop;
    bindDeliveryRunner(context);
    const session = sessions.get(context)!;
    // Keep a direct caller's singleton through overlapping or nested uses of this session.
    session.release = () => {
      unbindDeliveryRunner(context);
      heldLoop.release();
      runner.release();
    };
    return session;
  } catch (error) {
    unbindDeliveryRunner(context);
    loop?.release();
    runner.release();
    throw error;
  }
}

function controlStore(context: BusContext) {
  return { dir: context.paths.dir, now: () => new Date(context.clock.now() * 1000).toISOString() };
}

/** Missing control blocks admission while the existing runner continues observing. */
export function deliveryRunnerReady(context: BusContext): boolean {
  const session = sessions.get(context);
  if (session === undefined) {
    return false;
  }
  if (!session.claimed) {
    try {
      claimDeliveryRunner(controlStore(context), session.token);
      session.claimed = true;
    } catch (error) {
      context.log(`bus: delivery control unavailable; admission blocked (${String(error)})`);
    }
  }
  return session.claimed;
}

export function beginDeliveryWork(
  context: BusContext,
  state: "checking" | "deploying",
  sha: string | null,
  resume = false,
): string | undefined {
  if (!deliveryRunnerReady(context)) {
    return undefined;
  }
  const session = sessions.get(context)!;
  const id = randomUUID();
  try {
    const begin = resume ? resumeDeliveryActivity : beginDeliveryActivity;
    return begin(controlStore(context), session.token, { id, sha, state }) ? id : undefined;
  } catch (error) {
    context.log(`bus: delivery control unavailable; admission blocked (${String(error)})`);
    return undefined;
  }
}

export function updateDeliveryWork(
  context: BusContext,
  id: string,
  state: "checking" | "deploying" | "failed",
  sha: string | null,
): void {
  const session = sessions.get(context);
  if (session !== undefined) {
    try {
      updateDeliveryActivity(controlStore(context), session.token, { id, sha, state });
    } catch (error) {
      context.log(`bus: delivery observation unavailable (${String(error)})`);
    }
  }
}

export function endDeliveryWork(context: BusContext, id: string): void {
  const session = sessions.get(context);
  if (session !== undefined) {
    try {
      endDeliveryActivity(controlStore(context), session.token, id);
    } catch (error) {
      context.log(`bus: delivery observation unavailable (${String(error)})`);
    }
  }
}

export function settleDeliveryRunner(
  context: BusContext,
  state: "idle" | "stopped" | "failed",
): void {
  const session = sessions.get(context);
  if (session?.claimed === true) {
    try {
      const sha =
        state === "failed"
          ? (readDeliveryControl(controlStore(context)).observed?.sha ?? null)
          : null;
      setObservedDelivery(controlStore(context), session.token, { sha, state });
    } catch (error) {
      context.log(`bus: delivery observation unavailable (${String(error)})`);
    }
  }
}

/** A deployment attempt of one pending deployment, and its outcome. */
export interface DeploymentAttempt {
  readonly pending: { readonly sha: string; readonly work: string };
  readonly result: Promise<boolean>;
}

/** The pending-deployment operations of one session, serialized; deploy.ts gives them meaning. */
export interface PendingLifecycle {
  tail: Promise<void>;
  lastAttempt?: DeploymentAttempt;
}

/** The runner singleton excludes other processes. Queue only pending deployment operations. */
export function withPendingLifecycle<T>(
  context: BusContext,
  run: (lifecycle: PendingLifecycle, prior: DeploymentAttempt | undefined) => Promise<T>,
): Promise<T> {
  return withDeliveryRunner(context, () => {
    const lifecycle = sessions.get(context)!.pending;
    const prior = lifecycle.lastAttempt;
    const result = lifecycle.tail.then(() => run(lifecycle, prior));
    lifecycle.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  });
}
