// Desired control and token-bound runner activities share one short atomic update lock.
import { join } from "node:path";

import { readJsonIfExists, writeJsonDurable } from "../durable.ts";
import { withLock } from "../lock.ts";

export type DesiredDeliveryState = "enabled" | "paused";
export type DeliveryActivityState = "checking" | "deploying" | "failed";
export type ObservedDeliveryState = DeliveryActivityState | "stopped" | "idle";

export interface ControlStore {
  readonly dir: string;
  readonly now?: () => string;
}

export interface DesiredDeliveryInput {
  readonly state: DesiredDeliveryState;
  readonly reason: string;
  readonly requester: string;
}

export interface DeliveryActivity {
  readonly state: DeliveryActivityState;
  readonly sha: string | null;
  readonly updatedAt: string;
}

export interface DeliveryActivityInput {
  readonly id: string;
  readonly state: DeliveryActivityState;
  readonly sha: string | null;
}

export interface DeliveryObservation extends Omit<DeliveryActivity, "state"> {
  readonly state: ObservedDeliveryState;
  readonly runnerToken: string;
}

export interface DeliveryControl {
  readonly schema: 1;
  readonly revision: number;
  readonly desired: DesiredDeliveryInput & {
    readonly updatedAt: string;
    readonly revision: number;
  };
  readonly observed: DeliveryObservation | null;
  readonly activities: Readonly<Record<string, DeliveryActivity>>;
  readonly lastFailure?: DeliveryObservation | null;
}

export class ControlMissing extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`${path}: delivery control is missing; explicit operator initialization required`);
    this.name = "ControlMissing";
    this.path = path;
  }
}

export class ControlInvalid extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`${path}: delivery control is invalid or unreadable`);
    this.name = "ControlInvalid";
    this.path = path;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4096;
}

function timestamp(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function activity(value: unknown, observed = false): boolean {
  return (
    object(value) &&
    (value.sha === null || (typeof value.sha === "string" && /^[0-9a-f]{40}$/.test(value.sha))) &&
    timestamp(value.updatedAt) &&
    (value.state === "checking" ||
      value.state === "deploying" ||
      value.state === "failed" ||
      (observed && (value.state === "idle" || value.state === "stopped")))
  );
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(value);
}

function selected(
  activities: Readonly<Record<string, DeliveryActivity>>,
): DeliveryActivity | undefined {
  const priority = { checking: 1, deploying: 0, failed: 2 };
  const first = Object.entries(activities).sort(
    ([a, left], [b, right]) =>
      priority[left.state] - priority[right.state] || (a < b ? -1 : a > b ? 1 : 0),
  )[0];
  return first?.[1];
}

export function validateDeliveryControl(store: ControlStore, value: unknown): DeliveryControl {
  const invalid = (): never => {
    throw new ControlInvalid(join(store.dir, "delivery-control.json"));
  };
  if (
    !object(value) ||
    value.schema !== 1 ||
    !revision(value.revision) ||
    !object(value.desired) ||
    !revision(value.desired.revision) ||
    value.desired.revision > value.revision ||
    !timestamp(value.desired.updatedAt) ||
    !text(value.desired.reason) ||
    !text(value.desired.requester) ||
    (value.desired.state !== "enabled" && value.desired.state !== "paused") ||
    !object(value.activities)
  ) {
    return invalid();
  }
  if (
    value.observed !== null &&
    (!object(value.observed) ||
      !activity(value.observed, true) ||
      !identifier(value.observed.runnerToken))
  ) {
    return invalid();
  }
  for (const [id, item] of Object.entries(value.activities)) {
    if (!identifier(id) || !activity(item)) {
      return invalid();
    }
  }
  const control = value as unknown as DeliveryControl;
  if (
    control.lastFailure != null &&
    (!activity(control.lastFailure, true) ||
      control.lastFailure.state !== "failed" ||
      !identifier(control.lastFailure.runnerToken) ||
      control.lastFailure.runnerToken !== control.observed?.runnerToken)
  ) {
    return invalid();
  }
  const active = selected(control.activities);
  if (
    active !== undefined &&
    (control.observed === null ||
      control.observed.state !== active.state ||
      control.observed.sha !== active.sha)
  ) {
    return invalid();
  }
  if (
    active === undefined &&
    (control.observed?.state === "checking" || control.observed?.state === "deploying")
  ) {
    return invalid();
  }
  return control;
}

/** Atomic rename permits read-only snapshots without creating a file or taking a lock. */
export function readDeliveryControl(store: ControlStore): DeliveryControl {
  const path = join(store.dir, "delivery-control.json");
  let value: unknown;
  try {
    value = readJsonIfExists(path);
  } catch {
    throw new ControlInvalid(path);
  }
  if (value === undefined) {
    throw new ControlMissing(path);
  }
  return validateDeliveryControl(store, value);
}

function now(store: ControlStore): string {
  return store.now?.() ?? new Date().toISOString();
}

function persist(store: ControlStore, next: DeliveryControl): DeliveryControl {
  const valid = validateDeliveryControl(store, next);
  writeJsonDurable(join(store.dir, "delivery-control.json"), valid);
  return valid;
}

function locked<T>(store: ControlStore, action: () => T): T {
  return withLock(join(store.dir, "control.lock"), action, { timeoutSeconds: 30 });
}

/** The operator CLI alone calls this. Missing state is initialized, corrupt state is preserved. */
export function setDesiredDelivery(
  store: ControlStore,
  input: DesiredDeliveryInput,
): DeliveryControl {
  return locked(store, () => {
    let current: DeliveryControl | undefined;
    try {
      current = readDeliveryControl(store);
    } catch (error) {
      if (!(error instanceof ControlMissing)) {
        throw error;
      }
    }
    const nextRevision = (current?.revision ?? 0) + 1;
    return persist(store, {
      activities: current?.activities ?? {},
      desired: { ...input, revision: nextRevision, updatedAt: now(store) },
      lastFailure: current?.lastFailure ?? null,
      observed: current?.observed ?? null,
      revision: nextRevision,
      schema: 1,
    });
  });
}

/** Caller must hold the resident singleton locks and use a fresh token for each incarnation. */
export function claimDeliveryRunner(store: ControlStore, runnerToken: string): DeliveryControl {
  return locked(store, () => {
    const current = readDeliveryControl(store);
    // Reclaiming the same incarnation must not erase already admitted work.
    if (current.observed?.runnerToken === runnerToken) {
      return current;
    }
    return persist(store, {
      ...current,
      activities: {},
      lastFailure: null,
      observed: { runnerToken, sha: null, state: "idle", updatedAt: now(store) },
      revision: current.revision + 1,
    });
  });
}

function mutateRunner(
  store: ControlStore,
  runnerToken: string,
  change: (current: DeliveryControl) => DeliveryControl | undefined,
): boolean {
  return locked(store, () => {
    const current = readDeliveryControl(store);
    if (current.observed?.runnerToken !== runnerToken) {
      return false;
    }
    const next = change(current);
    if (next === undefined) {
      return false;
    }
    persist(store, { ...next, revision: current.revision + 1 });
    return true;
  });
}

function withActivities(
  store: ControlStore,
  current: DeliveryControl,
  activities: Readonly<Record<string, DeliveryActivity>>,
): DeliveryControl {
  const active = selected(activities) ?? current.lastFailure ?? undefined;
  return {
    ...current,
    activities,
    observed: {
      runnerToken: current.observed?.runnerToken ?? "",
      sha: active?.sha ?? null,
      state: active?.state ?? "idle",
      updatedAt: now(store),
    },
  };
}

function start(
  store: ControlStore,
  runnerToken: string,
  resumed: boolean,
  input: DeliveryActivityInput,
): boolean {
  return mutateRunner(store, runnerToken, (current) => {
    if (
      (!resumed && current.desired.state !== "enabled") ||
      Object.hasOwn(current.activities, input.id) ||
      input.state === "failed"
    ) {
      return undefined;
    }
    return withActivities(
      store,
      { ...current, lastFailure: resumed ? (current.lastFailure ?? null) : null },
      {
        ...current.activities,
        [input.id]: { sha: input.sha, state: input.state, updatedAt: now(store) },
      },
    );
  });
}

/** The desired check and persisted admission linearize under control.lock. */
export function beginDeliveryActivity(
  store: ControlStore,
  runnerToken: string,
  input: DeliveryActivityInput,
): boolean {
  return start(store, runnerToken, false, input);
}

/** Trusted runner caller must prove this work was already persisted as unfinished CI/deploy. */
export function resumeDeliveryActivity(
  store: ControlStore,
  runnerToken: string,
  input: DeliveryActivityInput,
): boolean {
  return start(store, runnerToken, true, input);
}

/** Admitted work can progress after pause without seeking a new admission. */
export function updateDeliveryActivity(
  store: ControlStore,
  runnerToken: string,
  input: DeliveryActivityInput,
): boolean {
  return mutateRunner(store, runnerToken, (current) => {
    if (!Object.hasOwn(current.activities, input.id)) {
      return undefined;
    }
    const item = { sha: input.sha, state: input.state, updatedAt: now(store) };
    const lastFailure =
      input.state === "failed" ? { ...item, runnerToken } : (current.lastFailure ?? null);
    return withActivities(
      store,
      { ...current, lastFailure },
      {
        ...current.activities,
        [input.id]: item,
      },
    );
  });
}

export function endDeliveryActivity(store: ControlStore, runnerToken: string, id: string): boolean {
  return mutateRunner(store, runnerToken, (current) => {
    const ended = Object.hasOwn(current.activities, id) ? current.activities[id] : undefined;
    if (ended === undefined) {
      return undefined;
    }
    const activities = Object.fromEntries(
      Object.entries(current.activities).filter(([key]) => key !== id),
    );
    return withActivities(store, current, activities);
  });
}

export function setObservedDelivery(
  store: ControlStore,
  runnerToken: string,
  input: { readonly state: "idle" | "stopped" | "failed"; readonly sha: string | null },
): boolean {
  return mutateRunner(store, runnerToken, (current) => {
    if (
      Object.keys(current.activities).length > 0 ||
      (input.state === "idle" &&
        (current.observed?.state === "failed" || current.lastFailure != null))
    ) {
      return undefined;
    }
    return {
      ...current,
      lastFailure:
        input.state === "failed"
          ? { ...input, runnerToken, updatedAt: now(store) }
          : (current.lastFailure ?? null),
      observed: { ...input, runnerToken, updatedAt: now(store) },
    };
  });
}
