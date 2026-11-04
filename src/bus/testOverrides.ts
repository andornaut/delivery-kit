// Test-only clock and load overrides for the contract harness, never configuration.
//
// DELIVERY_KIT_TEST_CLOCK names a JSON file {epoch, realStartMs, speed, maxRealSleep?}. Virtual
// seconds are epoch + the sum of the numbers in a `clock-offsets` file beside it (one per line)
// + (Date.now() - realStartMs) * speed / 1000. Both files are re-read on every reading, so a
// harness can reset or step time. A sleep lasts until virtual time has advanced by its full
// interval. With maxRealSleep (seconds) set, it waits in real slices of at most that length and
// re-reads the clock after each one, so a stepped clock ends it promptly; without it, it waits
// interval / speed real seconds. Unset, the runner uses the system clock.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Clock } from "./context.ts";

export const TEST_CLOCK_VARIABLE = "DELIVERY_KIT_TEST_CLOCK";

interface ClockFile {
  readonly epoch: number;
  readonly realStartMs: number;
  readonly speed: number;
  readonly maxRealSleep?: number;
}

function offsets(path: string): number {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .reduce((sum, line) => sum + Number(line), 0);
  } catch {
    return 0;
  }
}

function readClockFile(file: string): ClockFile {
  const value = JSON.parse(readFileSync(file, "utf8")) as ClockFile;
  const valid =
    [value.epoch, value.realStartMs, value.speed].every(Number.isFinite) &&
    value.speed > 0 &&
    (value.maxRealSleep === undefined ||
      (Number.isFinite(value.maxRealSleep) && value.maxRealSleep > 0));
  if (!valid) {
    throw new Error(
      [
        `${TEST_CLOCK_VARIABLE}: ${file} must hold finite epoch, realStartMs and speed,`,
        "and a positive maxRealSleep if set",
      ].join(" "),
    );
  }
  return value;
}

function wait(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
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

export function testClock(env: NodeJS.ProcessEnv): Clock | undefined {
  const file = env[TEST_CLOCK_VARIABLE];
  if (file === undefined || file === "") {
    return undefined;
  }
  let current = readClockFile(file);
  const offsetsFile = join(dirname(file), "clock-offsets");
  // A file caught mid-rewrite keeps the last valid reading.
  const refresh = (): ClockFile => {
    try {
      current = readClockFile(file);
    } catch {
      // Keep the previous reading.
    }
    return current;
  };
  const exact = (): number => {
    const value = refresh();
    return (
      value.epoch + offsets(offsetsFile) + ((Date.now() - value.realStartMs) * value.speed) / 1000
    );
  };
  return {
    now: () => Math.floor(exact()),
    sleep: async (seconds, signal) => {
      const target = exact() + Math.max(0, seconds);
      for (;;) {
        const remaining = target - exact();
        if (remaining <= 0 || signal?.aborted === true) {
          return;
        }
        const { maxRealSleep, speed } = current;
        const slice = (remaining * 1000) / speed;
        // Sequential slices are the mechanism.
        // eslint-disable-next-line no-await-in-loop
        await wait(
          maxRealSleep === undefined ? slice : Math.min(slice, maxRealSleep * 1000),
          signal,
        );
      }
    },
  };
}

// DELIVERY_KIT_TEST_LOADAVG holds a one-minute load average, a finite decimal number of at least
// 0 such as "0.5" or "30", read in place of the host's load when set, so load-limit cases do not
// depend on the host. Unset, the runner reads the host load.
export const TEST_LOAD_VARIABLE = "DELIVERY_KIT_TEST_LOADAVG";

export function testLoad(env: NodeJS.ProcessEnv): number | undefined {
  const text = env[TEST_LOAD_VARIABLE];
  if (text === undefined || text === "") {
    return undefined;
  }
  const value = /^\d+(\.\d+)?$/.test(text.trim()) ? Number(text) : Number.NaN;
  if (!Number.isFinite(value)) {
    throw new Error(`${TEST_LOAD_VARIABLE} must be a decimal number of at least 0, not ${text}`);
  }
  return value;
}

/** Context options for the test overrides that are set: `clock` and `loadAverage`. */
export function testOptions(env: NodeJS.ProcessEnv): {
  readonly clock?: Clock;
  readonly loadAverage?: () => number;
} {
  const clock = testClock(env);
  const load = testLoad(env);
  return {
    ...(clock === undefined ? {} : { clock }),
    ...(load === undefined ? {} : { loadAverage: () => load }),
  };
}
