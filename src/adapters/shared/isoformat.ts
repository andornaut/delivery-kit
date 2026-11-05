// datetime.fromisoformat() for UTC timestamps, following the CPython 3.12 C parser: the accepted
// timestamp grammar of native collector input.

function digit(character: string | undefined): boolean {
  return character !== undefined && character.length === 1 && character >= "0" && character <= "9";
}

function digitsAt(chars: readonly string[], start: number, count: number): number {
  let value = 0;
  for (let index = start; index < start + count; index += 1) {
    const character = chars[index];
    if (!digit(character)) {
      throw new RangeError("invalid isoformat digits");
    }
    value = value * 10 + Number(character);
  }
  return value;
}

/** _find_isoformat_datetime_separator(); `chars` has at least 7 code points. */
function separatorIndex(chars: readonly string[]): number {
  const length = chars.length;
  if (length === 7) {
    return 7;
  }
  if (chars[4] === "-") {
    if (chars[5] !== "W") {
      return 10;
    }
    if (length > 8 && chars[8] === "-") {
      if (length === 9) {
        throw new RangeError("invalid isoformat week");
      }
      return length > 10 && digit(chars[10]) ? 8 : 10;
    }
    return 8;
  }
  if (chars[4] === "W") {
    let index = 7;
    while (index < length && digit(chars[index])) {
      index += 1;
    }
    if (index < 9) {
      return index;
    }
    return index % 2 === 0 ? 7 : 8;
  }
  return 8;
}

function leapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar. */
function epochDays(year: number, month: number, day: number): number {
  const shifted = month <= 2 ? year - 1 : year;
  const era = Math.floor(shifted / 400);
  const yearOfEra = shifted - era * 400;
  const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** ISO weekday, Monday 1 to Sunday 7. */
function isoWeekday(days: number): number {
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

const FIRST_DAY = epochDays(1, 1, 1);
const LAST_DAY = epochDays(9999, 12, 31);

/** _isoweek_to_gregorian(), as epoch days. */
function isoWeekDays(year: number, week: number, weekday: number): number {
  if (year < 1 || year > 9999) {
    throw new RangeError("isoformat year out of range");
  }
  if (week < 1 || week > 53) {
    throw new RangeError("invalid isoformat week");
  }
  if (week === 53) {
    const first = isoWeekday(epochDays(year, 1, 1));
    if (!(first === 4 || (first === 3 && leapYear(year)))) {
      throw new RangeError("invalid isoformat week");
    }
  }
  if (weekday < 1 || weekday > 7) {
    throw new RangeError("invalid isoformat weekday");
  }
  const january4 = epochDays(year, 1, 4);
  const days = january4 - (isoWeekday(january4) - 1) + (week - 1) * 7 + (weekday - 1);
  if (days < FIRST_DAY || days > LAST_DAY) {
    throw new RangeError("isoformat year out of range");
  }
  return days;
}

/** The C parse_isoformat_date(), as epoch days. */
function dateDays(chars: readonly string[]): number {
  const year = digitsAt(chars, 0, 4);
  const dashed = chars[4] === "-";
  let position = dashed ? 5 : 4;
  if (chars[position] === "W") {
    position += 1;
    const week = digitsAt(chars, position, 2);
    position += 2;
    let weekday = 1;
    if (position < chars.length) {
      if (dashed) {
        if (chars[position] !== "-") {
          throw new RangeError("inconsistent isoformat separator");
        }
        position += 1;
      }
      weekday = digitsAt(chars, position, 1);
    }
    return isoWeekDays(year, week, weekday);
  }
  const month = digitsAt(chars, position, 2);
  position += 2;
  if (dashed) {
    if (chars[position] !== "-") {
      throw new RangeError("inconsistent isoformat separator");
    }
    position += 1;
  }
  const day = digitsAt(chars, position, 2);
  const lengths = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > (lengths[month - 1] ?? 0)) {
    throw new RangeError("isoformat date out of range");
  }
  return epochDays(year, month, day);
}

interface ClockFields {
  /** C `*p != '\0'`: characters remain after the parsed fields. */
  readonly rest: boolean;
  readonly values: readonly [number, number, number, number];
}

/** The C parse_hh_mm_ss_ff(): HH[:?MM[:?SS]][{.,}f+], reading `chars` as a NUL-ended buffer. */
function clockFields(chars: readonly string[], start: number, end: number): ClockFields {
  const values: [number, number, number, number] = [0, 0, 0, 0];
  let position = start;
  let separated = true;
  for (let index = 0; index < 3; index += 1) {
    values[index] = digitsAt(chars, position, 2);
    position += 2;
    const character = chars[position] ?? "";
    position += 1;
    if (index === 0) {
      separated = character === ":";
    }
    if (position >= end) {
      return { rest: character !== "", values };
    }
    if (separated && character === ":") {
      continue;
    }
    if (character === "." || character === ",") {
      break;
    }
    if (separated) {
      throw new RangeError("invalid isoformat time separator");
    }
    position -= 1;
  }
  const count = Math.min(end - position, 6);
  values[3] = digitsAt(chars, position, count) * 10 ** (6 - count);
  position += count;
  while (digit(chars[position])) {
    position += 1;
  }
  return { rest: position < chars.length, values };
}

/** Seconds of the day for a UTC time part, or null for a naive or non-UTC one. */
function utcSeconds(chars: readonly string[], start: number): number | null {
  let zone = start;
  for (;;) {
    const character = chars[zone];
    if (character === "Z" || character === "+" || character === "-") {
      break;
    }
    zone += 1;
    if (zone >= chars.length) {
      break;
    }
  }
  const time = clockFields(chars, start, zone);
  if (zone >= chars.length) {
    return null;
  }
  if (chars[zone] === "Z") {
    if (zone + 1 !== chars.length) {
      throw new RangeError("invalid isoformat zone");
    }
  } else {
    const offset = clockFields(chars, zone + 1, chars.length);
    if (offset.rest) {
      throw new RangeError("invalid isoformat zone");
    }
    if (offset.values.some((value) => value !== 0)) {
      return null;
    }
  }
  const [hour, minute, second, microsecond] = time.values;
  if (hour > 23 || minute > 59 || second > 59) {
    throw new RangeError("isoformat time out of range");
  }
  return (hour * 3600 + minute * 60 + second) * 1_000_000 + microsecond;
}

/**
 * datetime.fromisoformat(value).timestamp() when the value parses with a zero UTC offset, else
 * null. Follows the CPython 3.12 C parser: any single code point separates date and time.
 */
function utcTimestamp(value: string): number | null {
  const chars = Array.from(value);
  if (chars.length < 7) {
    return null;
  }
  try {
    const separator = separatorIndex(chars);
    const days = dateDays(chars.slice(0, separator));
    if (separator + 1 >= chars.length) {
      return null;
    }
    const micros = utcSeconds(chars, separator + 1);
    if (micros === null) {
      return null;
    }
    return (days * 86400 * 1_000_000 + micros) / 1_000_000;
  } catch {
    return null;
  }
}

/**
 * The question attestation stamp: epoch seconds of a timestamp
 * ending in Z or +00:00 that parses with a zero UTC offset, else null.
 */
export function utcStamp(value: unknown): number | null {
  if (typeof value !== "string" || !(value.endsWith("Z") || value.endsWith("+00:00"))) {
    return null;
  }
  return utcTimestamp(value.replaceAll("Z", "+00:00"));
}
