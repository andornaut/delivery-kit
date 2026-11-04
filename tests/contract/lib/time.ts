// Epoch helpers. HOUR is a top-of-hour instant in America/Toronto and UTC (whole-hour offsets).
export const HOUR = 1793556000;

/** Epoch seconds at local minute:second of the hour starting at HOUR + hours * 3600. */
export function at(minute: number, second = 0, hours = 0): number {
  return HOUR + hours * 3600 + minute * 60 + second;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
