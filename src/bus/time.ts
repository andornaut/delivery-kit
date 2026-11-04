// Wall-clock arithmetic in a named time zone. Epoch values are whole seconds.

export interface ZonedParts {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: number;
  readonly second: number;
  readonly zone: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone);
  if (value === undefined) {
    value = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: timezone,
      timeZoneName: "short",
      year: "numeric",
    });
    formatters.set(timezone, value);
  }
  return value;
}

export function zonedParts(timezone: string, epoch: number): ZonedParts {
  const parts = Object.fromEntries(
    formatter(timezone)
      .formatToParts(new Date(epoch * 1000))
      .map((part) => [part.type, part.value]),
  );
  return {
    day: parts.day ?? "",
    hour: parts.hour ?? "",
    minute: Number(parts.minute),
    month: parts.month ?? "",
    second: Number(parts.second),
    year: parts.year ?? "",
    zone: parts.timeZoneName ?? "",
  };
}

/** `%Y-%m-%d %H:%M %Z`: the stamp that opens departure report and log lines. */
export function stamp(timezone: string, epoch: number): string {
  const p = zonedParts(timezone, epoch);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${String(p.minute).padStart(2, "0")} ${p.zone}`;
}

function minutes(departures: readonly string[]): number[] {
  return departures.map((departure) => Number.parseInt(departure, 10)).sort((a, b) => a - b);
}

/** Seconds until the next departure minute after `now`. */
export function untilNext(timezone: string, departures: readonly string[], now: number): number {
  const { minute, second } = zonedParts(timezone, now);
  const position = minute * 60 + second;
  const sorted = minutes(departures).map((value) => value * 60);
  const next = sorted.find((value) => value > position);
  return next === undefined ? 3600 - position + (sorted[0] ?? 0) : next - position;
}

/** The most recent departure slot at or before `now`. */
export function latestScheduledSlot(
  timezone: string,
  departures: readonly string[],
  now: number,
): number {
  const { minute, second } = zonedParts(timezone, now);
  const hour = now - minute * 60 - second;
  let latest = 0;
  for (const departure of minutes(departures)) {
    let candidate = hour + departure * 60;
    if (candidate > now) {
      candidate -= 3600;
    }
    latest = Math.max(latest, candidate);
  }
  return latest;
}

/** Every whole-minute slot in (after, now] whose wall-clock minute is one of `selected`. */
export function minuteSlots(
  timezone: string,
  selected: readonly number[],
  after: number,
  now: number,
): number[] {
  const slots: number[] = [];
  for (let cursor = after - (after % 60) + 60; cursor <= now; cursor += 60) {
    if (selected.includes(zonedParts(timezone, cursor).minute)) {
      slots.push(cursor);
    }
  }
  return slots;
}

/** The current minute slot when it is in (after, now] and selected; the observer never replays. */
export function currentMinuteSlot(
  timezone: string,
  selected: readonly number[],
  after: number,
  now: number,
): number | undefined {
  const slot = now - (now % 60);
  if (slot <= after || slot > now) {
    return undefined;
  }
  return selected.includes(zonedParts(timezone, slot).minute) ? slot : undefined;
}
