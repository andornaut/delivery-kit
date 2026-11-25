// The clock the runner reads and sleeps on. Epoch values are whole seconds; an abort ends a sleep
// early.

export interface Clock {
  /** Epoch seconds. */
  now(): number;
  sleep(seconds: number, signal?: AbortSignal): Promise<void>;
}

/** Resolve after `milliseconds`, or at once when `signal` aborts. */
export function sleepMs(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, milliseconds));
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export const systemClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
  sleep: (seconds, signal) => sleepMs(Math.max(0, seconds) * 1000, signal),
};
