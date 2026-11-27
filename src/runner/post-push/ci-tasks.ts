import type { BusContext } from "../context.ts";
import { beginDeliveryWork, endDeliveryWork, updateDeliveryWork } from "../session.ts";
import { unfinishedCi, watchCi } from "./ci.ts";
import { deployAfterCi } from "./deploy.ts";

/** In-runner CI watches, at most one per SHA. Aborted watches resume in the next runner. */
export class CiTasks {
  readonly #running = new Map<string, Promise<unknown>>();
  readonly #activities = new Map<string, string | undefined>();
  readonly #signal: AbortSignal;

  constructor(signal: AbortSignal) {
    this.#signal = signal;
  }

  /** Resume the persisted watches before the runner admits a departure. */
  resume(context: BusContext): void {
    for (const sha of unfinishedCi(context.paths)) {
      this.start(context, sha);
    }
  }

  start(context: BusContext, sha: string): void {
    if (this.#running.has(sha) || this.#signal.aborted) {
      return;
    }
    // startCi is called only for a recorded push or a persisted unfinished CI watch.
    this.#activities.set(sha, beginDeliveryWork(context, "checking", sha, true));
    // The deployment of a pushed SHA runs once its CI passes.
    const task = watchCi(context, sha, { signal: this.#signal })
      .then(async (result) => {
        const activity = this.#activities.get(sha);
        if (result === "success") {
          await deployAfterCi(context, sha);
        } else if (result !== "busy" && activity !== undefined) {
          updateDeliveryWork(context, activity, "failed", sha);
        }
      })
      .catch((error: unknown) => {
        const activity = this.#activities.get(sha);
        if (activity !== undefined && !this.#signal.aborted) {
          updateDeliveryWork(context, activity, "failed", sha);
        }
        context.log(`bus: CI watch ${sha} failed: ${String(error)}`);
      })
      .finally(() => {
        const activity = this.#activities.get(sha);
        if (activity !== undefined) {
          endDeliveryWork(context, activity);
        }
        this.#running.delete(sha);
        this.#activities.delete(sha);
      });
    this.#running.set(sha, task);
  }

  /** Attach observations after an operator explicitly initializes missing control. */
  refresh(context: BusContext): void {
    for (const [sha, activity] of this.#activities) {
      if (activity === undefined) {
        this.#activities.set(sha, beginDeliveryWork(context, "checking", sha, true));
      }
    }
  }

  async drain(): Promise<void> {
    await Promise.all(this.#running.values());
  }
}
