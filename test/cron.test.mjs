// Cron schedule evaluator tests: validation, occurrence math, DST behavior.
// Imports the `librebot-tools/contract` surface, as platform code does.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CRON_TRIGGER_EVENT_TYPES,
  validateCronSchedule,
  nextCronOccurrence,
  latestCronOccurrence,
} from "../src/contract.js";

const UTC = { expression: "* * * * *", timeZone: "UTC" };

describe("CRON_TRIGGER_EVENT_TYPES", () => {
  it("exposes the cron tick event", () => {
    assert.deepEqual([...CRON_TRIGGER_EVENT_TYPES], ["cron.tick"]);
    assert.ok(Object.isFrozen(CRON_TRIGGER_EVENT_TYPES));
  });
});

describe("validateCronSchedule", () => {
  it("accepts a valid schedule and returns the normalized form", () => {
    assert.deepEqual(
      validateCronSchedule({ expression: "  0   9 * * 1-5 ", timeZone: " America/New_York " }),
      { expression: "0 9 * * 1-5", timeZone: "America/New_York" },
    );
  });

  it("accepts names, steps, ranges, and lists", () => {
    assert.deepEqual(validateCronSchedule({ expression: "5/15 9-17 * JAN-MAR MON,FRI", timeZone: "UTC" }), {
      expression: "5/15 9-17 * JAN-MAR MON,FRI",
      timeZone: "UTC",
    });
  });

  it("rejects non-objects, extra keys, and missing fields", () => {
    assert.throws(() => validateCronSchedule("0 * * * *"), /schedule must be an object/);
    assert.throws(() => validateCronSchedule(["0 * * * *"]), /schedule must be an object/);
    assert.throws(() => validateCronSchedule(null), /schedule must be an object/);
    assert.throws(
      () => validateCronSchedule({ expression: "0 * * * *", timeZone: "UTC", extra: true }),
      /unsupported field/,
    );
    assert.throws(() => validateCronSchedule({ timeZone: "UTC" }), /schedule\.expression/);
    assert.throws(() => validateCronSchedule({ expression: "0 * * * *" }), /schedule\.timeZone/);
  });

  it("rejects malformed expressions", () => {
    for (const expression of [
      "0 0 * *", // four fields
      "0 0 * * * *", // six fields
      "60 * * * *", // minute out of range
      "* 24 * * *", // hour out of range
      "* * 0 * *", // day-of-month out of range
      "* * * 13 *", // month out of range
      "*/0 * * * *", // bad step
      "5-2 * * * *", // reversed range
      "MON-FRI * * *", // four fields with names
      "nope * * * *", // invalid value
      "",
    ]) {
      assert.throws(() => validateCronSchedule({ expression, timeZone: "UTC" }), /schedule\.expression/, expression);
    }
  });

  it("rejects numeric UTC offsets and accepts named zones", () => {
    // Intl accepts these offset forms; schedules require named IANA zones.
    for (const timeZone of ["+01:00", "-05:00", "+0130"]) {
      assert.throws(
        () => validateCronSchedule({ expression: "0 * * * *", timeZone }),
        /not a valid IANA time zone/,
        timeZone,
      );
    }
    assert.deepEqual(validateCronSchedule({ expression: "0 * * * *", timeZone: "Etc/GMT+5" }), {
      expression: "0 * * * *",
      timeZone: "Etc/GMT+5",
    });
  });

  it("rejects inherited object keys as names", () => {
    for (const expression of ["0 0 * __proto__ *", "0 0 * * constructor", "0 0 * TOSTRING *"]) {
      assert.throws(() => validateCronSchedule({ expression, timeZone: "UTC" }), /schedule\.expression/, expression);
    }
  });

  it("rejects only when no day can match and OR cannot rescue", () => {
    // AND day semantics (a day field starts with "*"): no satisfiable pair.
    for (const expression of ["0 0 30 2 *", "0 0 31 4 *", "0 0 31 2,4 *", "0 0 31 2 */2"]) {
      assert.throws(() => validateCronSchedule({ expression, timeZone: "UTC" }), /can never match/, expression);
    }
    // Any satisfiable day/month pair keeps the schedule (Feb 29 fires on
    // leap years), and under OR semantics a restricted weekday rescues an
    // impossible month-day (Fridays in February still fire).
    for (const expression of ["0 0 29 2 *", "0 0 31 * *", "0 0 * 2 *", "0 0 30 2-3 *", "0 0 29-31 2 *", "0 0 30 2 5", "0 0 31 4 5"]) {
      validateCronSchedule({ expression, timeZone: "UTC" });
    }
  });

  it("rejects unknown time zones", () => {
    assert.throws(() => validateCronSchedule({ expression: "0 * * * *", timeZone: "" }), /schedule\.timeZone/);
    assert.throws(() => validateCronSchedule({ expression: "0 * * * *", timeZone: 42 }), /schedule\.timeZone/);
    assert.throws(
      () => validateCronSchedule({ expression: "0 * * * *", timeZone: "Mars/Olympus" }),
      /not a valid IANA time zone/,
    );
  });
});

describe("nextCronOccurrence", () => {
  it("advances to the next minute boundary", () => {
    assert.equal(nextCronOccurrence(UTC, Date.UTC(2026, 0, 1, 0, 0, 45)), Date.UTC(2026, 0, 1, 0, 1));
  });

  it("is strictly exclusive of afterMs", () => {
    const hourly = { expression: "0 * * * *", timeZone: "UTC" };
    assert.equal(nextCronOccurrence(hourly, Date.UTC(2026, 0, 1, 5, 0)), Date.UTC(2026, 0, 1, 6, 0));
  });

  it("handles steps, ranges, and lists", () => {
    assert.equal(
      nextCronOccurrence({ expression: "*/15 * * * *", timeZone: "UTC" }, Date.UTC(2026, 0, 1, 0, 7)),
      Date.UTC(2026, 0, 1, 0, 15),
    );
    assert.equal(
      nextCronOccurrence({ expression: "0 9-17 * * *", timeZone: "UTC" }, Date.UTC(2026, 0, 1, 8, 0)),
      Date.UTC(2026, 0, 1, 9, 0),
    );
    assert.equal(
      nextCronOccurrence({ expression: "0 9,21 * * *", timeZone: "UTC" }, Date.UTC(2026, 0, 1, 10, 0)),
      Date.UTC(2026, 0, 1, 21, 0),
    );
    assert.equal(
      nextCronOccurrence({ expression: "5/15 * * * *", timeZone: "UTC" }, Date.UTC(2026, 0, 1, 0, 0)),
      Date.UTC(2026, 0, 1, 0, 5),
    );
  });

  it("treats Sunday 7 as Sunday", () => {
    // 2026-01-03 is a Saturday.
    assert.equal(
      nextCronOccurrence({ expression: "0 0 * * 7", timeZone: "UTC" }, Date.UTC(2026, 0, 3, 12, 0)),
      Date.UTC(2026, 0, 4, 0, 0),
    );
  });

  it("matches month and weekday names", () => {
    // 2026-01-04 is a Sunday.
    assert.equal(
      nextCronOccurrence({ expression: "0 12 * * MON", timeZone: "UTC" }, Date.UTC(2026, 0, 4, 0, 0)),
      Date.UTC(2026, 0, 5, 12, 0),
    );
  });

  it("fires when either day-of-month or day-of-week matches", () => {
    // 2026-02-02 is a Monday; next is Sunday Feb 8 (weekday), before Mar 1 (month-day).
    assert.equal(
      nextCronOccurrence({ expression: "0 0 1 * 0", timeZone: "UTC" }, Date.UTC(2026, 1, 2, 0, 0)),
      Date.UTC(2026, 1, 8, 0, 0),
    );
  });

  it("requires the day only when one day field is restricted", () => {
    // Feb 1 2026 is a Sunday; with dom restricted and dow star, only the 1st fires.
    assert.equal(
      nextCronOccurrence({ expression: "0 0 1 * *", timeZone: "UTC" }, Date.UTC(2026, 1, 2, 0, 0)),
      Date.UTC(2026, 2, 1, 0, 0),
    );
  });

  it("reaches Feb 29 across non-leap years", () => {
    assert.equal(
      nextCronOccurrence({ expression: "0 0 29 2 *", timeZone: "UTC" }, Date.UTC(2025, 0, 1)),
      Date.UTC(2028, 1, 29, 0, 0),
    );
  });

  it("skips times lost to the spring-forward gap", () => {
    // America/New_York jumps 2026-03-08 02:00 -> 03:00; 02:30 never occurs.
    const atGap = { expression: "30 2 * * *", timeZone: "America/New_York" };
    assert.equal(
      nextCronOccurrence(atGap, Date.UTC(2026, 2, 8, 5, 0)),
      Date.UTC(2026, 2, 9, 6, 30),
    );
    // 03:00 exists (EDT is already in effect); it fires the same morning.
    assert.equal(
      nextCronOccurrence({ expression: "0 3 * * *", timeZone: "America/New_York" }, Date.UTC(2026, 2, 8, 5, 0)),
      Date.UTC(2026, 2, 8, 7, 0),
    );
  });

  it("ANDs days when either day field starts with star", () => {
    // 2026-01-08 is a Thursday. "*/2" starts with "*", so day-of-month AND
    // day-of-week apply: Friday Jan 9 is odd, so it fires.
    assert.equal(
      nextCronOccurrence({ expression: "0 0 */2 * 5", timeZone: "UTC" }, Date.UTC(2026, 0, 8, 0, 0)),
      Date.UTC(2026, 0, 9, 0, 0),
    );
    // Past that Friday, the next odd-date Friday is Jan 23 (Jan 16 is even).
    assert.equal(
      nextCronOccurrence({ expression: "0 0 */2 * 5", timeZone: "UTC" }, Date.UTC(2026, 0, 9, 0, 1)),
      Date.UTC(2026, 0, 23, 0, 0),
    );
    // With a bare "*" day-of-month, Fridays alone decide.
    assert.equal(
      nextCronOccurrence({ expression: "0 0 * * 5", timeZone: "UTC" }, Date.UTC(2026, 0, 9, 0, 1)),
      Date.UTC(2026, 0, 16, 0, 0),
    );
  });

  it("reaches sparse leap/weekday combos across decades", () => {
    // "*/30" is {1, 31} and starts with "*", so Feb 1st Mondays fire.
    assert.equal(
      nextCronOccurrence({ expression: "0 0 */30 2 1", timeZone: "UTC" }, Date.UTC(2026, 0, 1)),
      Date.UTC(2027, 1, 1, 0, 0),
    );
    // After Feb 2027 the next Feb-1 Monday is 2038: an 11-year gap the
    // horizon must survive.
    assert.equal(
      nextCronOccurrence({ expression: "0 0 */30 2 1", timeZone: "UTC" }, Date.UTC(2027, 1, 2)),
      Date.UTC(2038, 1, 1, 0, 0),
    );
    // 2100 is not a leap year, so Feb 29 resumes in 2104.
    assert.equal(
      nextCronOccurrence({ expression: "0 0 29 2 *", timeZone: "UTC" }, Date.UTC(2099, 5, 1)),
      Date.UTC(2104, 1, 29, 0, 0),
    );
  });

  it("finds mid-month days after skipping into their month", () => {
    assert.equal(
      nextCronOccurrence({ expression: "0 0 15 * *", timeZone: "UTC" }, Date.UTC(2026, 2, 10, 12, 0)),
      Date.UTC(2026, 2, 15, 0, 0),
    );
  });

  it("fires the first occurrence of a repeated fall-back minute", () => {
    // America/New_York repeats 2026-11-01 01:00-02:00; first 01:30 EDT is 05:30Z.
    const repeated = { expression: "30 1 * * *", timeZone: "America/New_York" };
    assert.equal(nextCronOccurrence(repeated, Date.UTC(2026, 10, 1, 4, 0)), Date.UTC(2026, 10, 1, 5, 30));
  });

  it("throws on invalid schedules, bad input, and impossible dates", () => {
    assert.throws(() => nextCronOccurrence({ expression: "nope", timeZone: "UTC" }, 0), /schedule\.expression/);
    assert.throws(() => nextCronOccurrence({ expression: "0 * * * *", timeZone: "Mars" }, 0), /schedule\.timeZone/);
    assert.throws(() => nextCronOccurrence(UTC, Number.NaN), /afterMs/);
    // Feb 30 never exists in any year.
    assert.throws(
      () => nextCronOccurrence({ expression: "0 0 30 2 *", timeZone: "UTC" }, Date.UTC(2026, 0, 1)),
      /no occurrence within 400 years/,
    );
  });
});

describe("latestCronOccurrence", () => {
  it("is inclusive of atOrBeforeMs", () => {
    const noon = { expression: "0 12 * * *", timeZone: "UTC" };
    assert.equal(latestCronOccurrence(noon, Date.UTC(2026, 0, 5, 12, 0)), Date.UTC(2026, 0, 5, 12, 0));
    assert.equal(latestCronOccurrence(noon, Date.UTC(2026, 0, 5, 11, 59)), Date.UTC(2026, 0, 4, 12, 0));
  });

  it("returns the first occurrence when asked inside a repeated fall-back minute", () => {
    // Second 01:30 EST is 06:30Z; the occurrence counts as the first (05:30Z).
    const repeated = { expression: "30 1 * * *", timeZone: "America/New_York" };
    assert.equal(latestCronOccurrence(repeated, Date.UTC(2026, 10, 1, 6, 30)), Date.UTC(2026, 10, 1, 5, 30));
    assert.equal(latestCronOccurrence(repeated, Date.UTC(2026, 10, 1, 5, 30)), Date.UTC(2026, 10, 1, 5, 30));
  });

  it("looks back across the spring-forward gap", () => {
    const atGap = { expression: "30 2 * * *", timeZone: "America/New_York" };
    // Mar 8 has no 02:30; the latest at Mar 8 12:00Z is Mar 7 02:30 EST (07:30Z).
    assert.equal(latestCronOccurrence(atGap, Date.UTC(2026, 2, 8, 12, 0)), Date.UTC(2026, 2, 7, 7, 30));
  });

  it("scans the whole prior date after skipping back into it", () => {
    // 2026-01-04 is a Sunday, 2026-01-05 a Monday. Landing mid-Sunday after
    // a backward skip must still see Sunday 23:55 later that same date.
    assert.equal(
      latestCronOccurrence({ expression: "55 23 * * 0", timeZone: "UTC" }, Date.UTC(2026, 0, 5, 1, 0)),
      Date.UTC(2026, 0, 4, 23, 55),
    );
  });

  it("ANDs days when either day field starts with star", () => {
    // Odd-date Fridays: Jan 23 2026 is a Friday and odd, Jan 22 is neither.
    const oddFridays = { expression: "0 0 */2 * 5", timeZone: "UTC" };
    assert.equal(latestCronOccurrence(oddFridays, Date.UTC(2026, 0, 23, 0, 0)), Date.UTC(2026, 0, 23, 0, 0));
    assert.equal(latestCronOccurrence(oddFridays, Date.UTC(2026, 0, 22, 12, 0)), Date.UTC(2026, 0, 9, 0, 0));
  });

  it("looks back across decades for sparse combos", () => {
    assert.equal(
      latestCronOccurrence({ expression: "0 0 */30 2 1", timeZone: "UTC" }, Date.UTC(2038, 1, 2)),
      Date.UTC(2038, 1, 1, 0, 0),
    );
  });

  it("throws on bad input and impossible dates", () => {
    assert.throws(() => latestCronOccurrence(UTC, Number.POSITIVE_INFINITY), /atOrBeforeMs/);
    assert.throws(
      () => latestCronOccurrence({ expression: "0 0 30 2 *", timeZone: "UTC" }, Date.UTC(2026, 0, 1)),
      /no occurrence within 400 years/,
    );
  });
});
