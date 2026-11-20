// Portable UNIX-cron schedule evaluator. Dependency-free and browser-safe
// (Intl-only time zones, no Node APIs) so platform UIs, servers, and tests
// can share it via `librebot-tools/contract` instead of keeping copies.
//
// Contract: five-field UNIX cron (`minute hour dayOfMonth month dayOfWeek`)
// plus an IANA time zone. Vixie day semantics: when either day field starts
// with "*" the day must match both sets, otherwise matching either fires.
// Times that never occur (spring-forward gaps) are skipped; times that occur
// twice (fall-back) fire only as their first occurrence.

export const CRON_TRIGGER_EVENT_TYPES = Object.freeze(["cron.tick"]);

const MIN = 60000;
const HOUR = 3600000;

// Date steps (6h) must stay well under the shortest real wall date (~22h);
// every wall date that contains any minute is then always sampled.
const DATE_STEP = 6 * HOUR;
// Minute scan caps: the longest wall dates (fall-back) are ~25h = 1500min.
const DAY_SCAN_CAP = 1600;
// 6h steps over 400 Gregorian years; never-matching schedules throw. The
// long horizon covers sparse combos (e.g. Feb 29 on a given weekday, whose
// leap/weekday cycles beat every ~28 years, modulo century years like 2100).
const MAX_DATE_STEPS = 600000;

const FIELD_RANGES = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (7 is Sunday, normalized to 0)
];

const FIELD_NAMES = ["minute", "hour", "dayOfMonth", "month", "dayOfWeek"];

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function lookupName(names, token) {
  // Guard against inherited keys ("__proto__", "constructor", "toString"):
  // only own table entries are month/weekday names.
  const key = token.toLowerCase();
  if (names && Object.hasOwn(names, key)) return names[key];
  return undefined;
}

function parseValue(token, field, range, names) {
  const named = lookupName(names, token);
  if (named !== undefined) return named;
  if (!/^\d+$/.test(token)) throw new Error(`schedule.expression field ${field} has an invalid value ${token}`);
  const n = Number(token);
  if (n < range.min || n > range.max) throw new Error(`schedule.expression field ${field} value ${token} is out of range`);
  return n;
}

function parseField(text, index) {
  const field = FIELD_NAMES[index];
  const range = FIELD_RANGES[index];
  const names = index === 3 ? MONTH_NAMES : index === 4 ? DOW_NAMES : undefined;
  const span = range.max - range.min + 1;
  const values = new Set();
  for (const item of text.split(",")) {
    if (!item) throw new Error(`schedule.expression field ${field} has an empty entry`);
    const slash = item.indexOf("/");
    const base = slash < 0 ? item : item.slice(0, slash);
    const stepText = slash < 0 ? undefined : item.slice(slash + 1);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) throw new Error(`schedule.expression field ${field} has an invalid step ${stepText}`);
      step = Number(stepText);
      if (step < 1 || step >= span) throw new Error(`schedule.expression field ${field} step ${stepText} is out of range`);
    }
    if (!base) throw new Error(`schedule.expression field ${field} has an empty base`);
    let lo;
    let hi;
    if (base === "*") {
      lo = range.min;
      hi = range.max;
    } else {
      const dash = base.indexOf("-");
      if (dash < 0) {
        lo = parseValue(base, field, range, names);
        hi = stepText !== undefined ? range.max : lo;
      } else {
        lo = parseValue(base.slice(0, dash), field, range, names);
        hi = parseValue(base.slice(dash + 1), field, range, names);
        if (base.slice(dash + 1).includes("-")) throw new Error(`schedule.expression field ${field} has an invalid range ${base}`);
        if (lo > hi) throw new Error(`schedule.expression field ${field} range ${base} is reversed`);
      }
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  // Vixie day semantics key off the field text: a day field starting with
  // "*" ("*", "*/n") forces day-of-month AND day-of-week; otherwise the two
  // fields OR. Thus "*/2" alone still means odd dates, while "*/2" with a
  // restricted weekday means odd-date matching weekdays.
  return { values, starPrefix: text.startsWith("*") };
}

function parseCronExpression(expression) {
  if (typeof expression !== "string") throw new Error("schedule.expression must be a string");
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((f) => !f)) throw new Error("schedule.expression must have exactly five fields");
  const parsed = fields.map((text, index) => parseField(text, index));
  // Normalize Sunday 7 to 0.
  if (parsed[4].values.has(7)) {
    parsed[4].values.delete(7);
    parsed[4].values.add(0);
  }
  return parsed;
}

// Longest month lengths (February counts 29: leap years exist), used to
// reject day-of-month/month combinations that can never occur.
const LONGEST_MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function rejectImpossibleDates(parsed) {
  // Under OR day semantics (neither day field starts with "*") a restricted
  // weekday always fires eventually, so the day condition is satisfiable.
  // Under AND semantics the weekday cannot rescue an impossible month-day.
  if (!parsed[2].starPrefix && !parsed[4].starPrefix) return;
  for (const day of parsed[2].values) {
    for (const month of parsed[3].values) {
      // Any day/month pair that can occur keeps the schedule satisfiable;
      // e.g. Feb 29 fires on leap years even beside never-days like Feb 30.
      if (LONGEST_MONTH_DAYS[month - 1] >= day) return;
    }
  }
  throw new Error("schedule.expression can never match: no selected day of month occurs in the selected month(s)");
}

function normalizeTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone.trim()) throw new Error("schedule.timeZone must be a non-empty string");
  const trimmed = timeZone.trim();
  // Intl accepts numeric UTC offsets ("+01:00", "-0500"); schedules require
  // a named IANA zone. IANA names never start with +/- and never hold ":".
  if (/^[+-]/.test(trimmed) || trimmed.includes(":")) {
    throw new Error("schedule.timeZone is not a valid IANA time zone");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
  } catch {
    throw new Error("schedule.timeZone is not a valid IANA time zone");
  }
  return trimmed;
}

/**
 * Validate an author- or binding-supplied cron schedule. Throws an Error
 * naming the offending field on invalid input; otherwise returns the
 * normalized `{ expression, timeZone }` schedule.
 * @param {unknown} value
 * @returns {{ expression: string, timeZone: string }}
 */
export function validateCronSchedule(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("schedule must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "expression" && key !== "timeZone") throw new Error(`schedule contains unsupported field ${key}`);
  }
  const parsed = parseCronExpression(value.expression);
  normalizeTimeZone(value.timeZone);
  rejectImpossibleDates(parsed);
  return {
    expression: value.expression.trim().split(/\s+/).join(" "),
    timeZone: value.timeZone.trim(),
  };
}

const formatters = new Map();
function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallParts(timeZone, epochMs) {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  if (hour === 24) hour = 0;
  // Weekday is pure calendar math on the wall date: time-zone independent.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, weekday };
}

const dateKey = (parts) => parts.year * 10000 + parts.month * 100 + parts.day;

function dayMatches(parsed, parts) {
  if (!parsed[3].values.has(parts.month)) return false;
  const domHit = parsed[2].values.has(parts.day);
  const dowHit = parsed[4].values.has(parts.weekday);
  if (parsed[2].starPrefix || parsed[4].starPrefix) return domHit && dowHit;
  return domHit || dowHit;
}

function fullMatch(parsed, parts) {
  return parsed[0].values.has(parts.minute) && parsed[1].values.has(parts.hour) && dayMatches(parsed, parts);
}

function tzOffsetMs(timeZone, epochMs) {
  const parts = wallParts(timeZone, epochMs);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Math.floor(epochMs / MIN) * MIN;
}

// A repeated (fall-back) wall minute fires only as its first UTC occurrence.
// Offset arithmetic instead of a minute-by-minute lookback: without a
// recent transition the offset is unchanged and the minute is trivially
// first; otherwise the wall minute is re-resolved with the pre-transition
// offset, and a round-trip hit at a different instant proves a repeat.
function isFirstOccurrence(timeZone, minuteMs) {
  const offsetNow = tzOffsetMs(timeZone, minuteMs);
  // Transitions are at least days apart, so the offset 12h back is the
  // pre-transition offset whenever a transition is in effect here.
  const offsetBefore = tzOffsetMs(timeZone, minuteMs - 12 * HOUR);
  if (offsetNow === offsetBefore) return true;
  const want = wallParts(timeZone, minuteMs);
  const firstGuess = Date.UTC(want.year, want.month - 1, want.day, want.hour, want.minute) - offsetBefore;
  if (firstGuess === minuteMs) return true;
  const seen = wallParts(timeZone, firstGuess);
  return !(
    seen.year === want.year && seen.month === want.month && seen.day === want.day &&
    seen.hour === want.hour && seen.minute === want.minute
  );
}

// First minute of the wall date `key` containing `minuteMs`. Coarse hourly
// steps back (~25 calls worst case for a 25h date), then minute steps back
// to the boundary (<= 60 calls).
function dateStartBefore(timeZone, minuteMs, key) {
  let start = minuteMs;
  while (dateKey(wallParts(timeZone, start - HOUR)) === key) start -= HOUR;
  while (dateKey(wallParts(timeZone, start - MIN)) === key) start -= MIN;
  return start;
}

/**
 * First minute-boundary occurrence strictly after `afterMs`, as ms epoch.
 * Nonexistent (spring-forward gap) local times never occur and are skipped.
 */
export function nextCronOccurrence(schedule, afterMs) {
  if (!Number.isFinite(afterMs)) throw new Error("afterMs must be a finite number");
  const parsed = parseCronExpression(schedule.expression);
  const timeZone = normalizeTimeZone(schedule.timeZone);
  let cursor = Math.floor(afterMs / MIN) * MIN + MIN;
  // The first minute-boundary past afterMs cannot skip an occurrence, so the
  // first matching date scans straight from the cursor; dates entered after
  // a skip scan from their start. Hot path (a matching tick) is ~2 calls.
  let first = true;
  for (let step = 0; step < MAX_DATE_STEPS; step++) {
    const wall = wallParts(timeZone, cursor);
    if (!dayMatches(parsed, wall)) {
      cursor += DATE_STEP;
      first = false;
      continue;
    }
    const key = dateKey(wall);
    const scanFrom = first ? cursor : dateStartBefore(timeZone, cursor, key);
    first = false;
    let t = scanFrom;
    let i = 0;
    for (; i < DAY_SCAN_CAP; i++, t += MIN) {
      const parts = wallParts(timeZone, t);
      if (dateKey(parts) !== key) break;
      if (fullMatch(parsed, parts) && isFirstOccurrence(timeZone, t)) return t;
    }
    cursor = t;
    if (i >= DAY_SCAN_CAP && dateKey(wallParts(timeZone, cursor)) === key) cursor += DATE_STEP;
  }
  throw new Error("schedule has no occurrence within 400 years");
}

/**
 * Last minute-boundary occurrence at or before `atOrBeforeMs`, as ms epoch.
 * A repeated (fall-back) wall minute counts only as its first occurrence.
 */
export function latestCronOccurrence(schedule, atOrBeforeMs) {
  if (!Number.isFinite(atOrBeforeMs)) throw new Error("atOrBeforeMs must be a finite number");
  const parsed = parseCronExpression(schedule.expression);
  const timeZone = normalizeTimeZone(schedule.timeZone);
  let cursor = Math.floor(atOrBeforeMs / MIN) * MIN;
  const queryKey = dateKey(wallParts(timeZone, cursor));
  for (let step = 0; step < MAX_DATE_STEPS; step++) {
    const wall = wallParts(timeZone, cursor);
    const key = dateKey(wall);
    if (!dayMatches(parsed, wall)) {
      cursor -= DATE_STEP;
      continue;
    }
    if (key === queryKey) {
      // The queried date: scan backward from the cursor to the date start.
      let t = cursor;
      for (let i = 0; i < DAY_SCAN_CAP; i++, t -= MIN) {
        const parts = wallParts(timeZone, t);
        if (dateKey(parts) !== key) break;
        if (fullMatch(parsed, parts) && isFirstOccurrence(timeZone, t)) return t;
      }
      cursor = t;
      continue;
    }
    // An earlier matching date: every minute of it is at or before the
    // query, so scan the whole date and keep the last occurrence.
    const start = dateStartBefore(timeZone, cursor, key);
    let best = -1;
    for (let t = start, i = 0; i < DAY_SCAN_CAP; i++, t += MIN) {
      const parts = wallParts(timeZone, t);
      if (dateKey(parts) !== key) break;
      if (fullMatch(parsed, parts) && isFirstOccurrence(timeZone, t)) best = t;
    }
    if (best >= 0) return best;
    cursor = start - MIN;
  }
  throw new Error("schedule has no occurrence within 400 years");
}
