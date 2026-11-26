"use strict";

// US regular-session cash-close reference math: WHEN the last scheduled cash
// close was, WHAT this perp printed around it, and HOW FAR it has moved since.
//
// Extracted from briefing.js when /api/state gained `overnight_change_pct`.
// The briefing published this contract first and owned the only copy; a second
// implementation of a DST-aware NY calendar, an NYSE holiday table and three
// scheduled 13:00 early closes is exactly how two surfaces start disagreeing
// about what "overnight" means while both look correct in isolation. One
// implementation, two callers.
//
// Dependency direction matters: briefing.js requires apistate.js, so this
// module requires NEITHER. It is leaf math over already-fetched state.

const NY_TZ = "America/New_York";
const MINUTE_MS = 60000;
const HOUR_MS = 3600000;
const DAY_MS = 86400000;
// A reference bar further than this from the close is not that close's price.
const MAX_REFERENCE_LAG_MS = 6 * HOUR_MS;

const nyFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

function finite(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function pct(last, reference) {
  last = finite(last);
  reference = finite(reference);
  return last !== null && reference !== null && reference !== 0
    ? (last - reference) / reference * 100
    : null;
}

function utcDateKey(year, month, day) {
  return Date.UTC(year, month - 1, day);
}

function ymd(dateKey) {
  const d = new Date(dateKey);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function nyParts(ms) {
  const out = {};
  nyFormatter.formatToParts(new Date(ms)).forEach(function (part) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  });
  return out;
}

// Convert an unambiguous New York wall-clock time (cash closes are 13:00 or
// 16:00, never in the DST transition window) into an epoch. Iterating the
// formatter-derived offset avoids hard-coding EDT/EST dates.
function zonedToUtc(year, month, day, hour, minute) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute || 0, 0);
  let guess = wanted;
  for (let i = 0; i < 4; i++) {
    const p = nyParts(guess);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const delta = represented - wanted;
    if (delta === 0) break;
    guess -= delta;
  }
  return guess;
}

function nthWeekday(year, month, weekday, nth) {
  const first = utcDateKey(year, month, 1);
  const firstDow = new Date(first).getUTCDay();
  return first + ((weekday - firstDow + 7) % 7 + (nth - 1) * 7) * DAY_MS;
}

function lastWeekday(year, month, weekday) {
  const last = Date.UTC(year, month, 0);
  const lastDow = new Date(last).getUTCDay();
  return last - ((lastDow - weekday + 7) % 7) * DAY_MS;
}

function observedFixed(year, month, day) {
  const exact = utcDateKey(year, month, day);
  const dow = new Date(exact).getUTCDay();
  if (dow === 6) return exact - DAY_MS;
  if (dow === 0) return exact + DAY_MS;
  return exact;
}

// New Year's Day is the ONE fixed holiday whose Saturday case is NOT observed
// on the preceding Friday - that Friday is Dec 31 of the PRIOR year, and NYSE
// keeps it a full session (Rule 7.2's month-boundary exception; Dec 31 2021
// traded a full day with Jan 1 2022 a Saturday, and the exchange lists no
// observed holiday for 2028 either - review). Sunday still observes
// Monday. Returns null when nothing is observed.
function observedNewYear(year) {
  const exact = utcDateKey(year, 1, 1);
  const dow = new Date(exact).getUTCDay();
  if (dow === 6) return null;
  if (dow === 0) return exact + DAY_MS;
  return exact;
}

// Meeus/Jones/Butcher Gregorian Easter algorithm. NYSE Good Friday is two
// days before Easter Sunday.
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = (h + l - 7 * m + 114) % 31 + 1;
  return utcDateKey(year, month, day);
}

const holidayCache = new Map();
function marketHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const set = new Set();
  [
    observedNewYear(year),
    // The following year's observed New Year could only land in THIS year on
    // Dec 31, and that Saturday case is exactly the one NYSE does not
    // observe (observedNewYear returns null for it) - kept for the shape,
    // filtered below.
    observedNewYear(year + 1),
    nthWeekday(year, 1, 1, 3),       // Martin Luther King Jr. Day
    nthWeekday(year, 2, 1, 3),       // Washington's Birthday
    easterSunday(year) - 2 * DAY_MS, // Good Friday
    lastWeekday(year, 5, 1),         // Memorial Day
    observedFixed(year, 7, 4),       // Independence Day
    nthWeekday(year, 9, 1, 1),       // Labor Day
    nthWeekday(year, 11, 4, 4),      // Thanksgiving
    observedFixed(year, 12, 25)      // Christmas
  ].forEach(function (v) { if (v !== null) set.add(v); });
  if (year >= 2022) set.add(observedFixed(year, 6, 19)); // Juneteenth
  holidayCache.set(year, set);
  return set;
}

function isMarketHoliday(dateKey) {
  return marketHolidays(ymd(dateKey).year).has(dateKey);
}

function isOpenWeekday(dateKey) {
  const dow = new Date(dateKey).getUTCDay();
  return dow !== 0 && dow !== 6 && !isMarketHoliday(dateKey);
}

function nextOpenDay(dateKey) {
  let d = dateKey + DAY_MS;
  while (!isOpenWeekday(d)) d += DAY_MS;
  return d;
}

const earlyCloseCache = new Map();
function marketEarlyCloses(year) {
  if (earlyCloseCache.has(year)) return earlyCloseCache.get(year);
  const set = new Set();
  // Standard 13:00 ET sessions: July 3 and December 24 WHEN EACH IS ITSELF A
  // TRADING DAY, plus the day after Thanksgiving. NOT "the trading day before
  // the observed closure" - when the holiday's observance lands ON Jul 3 /
  // Dec 24 (July 4 or Christmas on a Saturday) or pushes past it (on a
  // Sunday), the preceding Thursday/Friday is a FULL session: NYSE 2026 lists
  // NO July early close (Jul 3 is the observed holiday; review caught
  // Jul 2 misclassified), and 2021's Dec 23 / 2022's Jul 1 were full sessions.
  // Exceptional exchange notices are intentionally surfaced as a documented
  // limitation rather than guessed.
  const july3 = utcDateKey(year, 7, 3);
  if (isOpenWeekday(july3)) set.add(july3);
  set.add(nextOpenDay(nthWeekday(year, 11, 4, 4)));
  const dec24 = utcDateKey(year, 12, 24);
  if (isOpenWeekday(dec24)) set.add(dec24);
  earlyCloseCache.set(year, set);
  return set;
}

function marketCloseHour(dateKey) {
  if (!isOpenWeekday(dateKey)) return null;
  return marketEarlyCloses(ymd(dateKey).year).has(dateKey) ? 13 : 16;
}

function previousUsCashClose(now) {
  now = finite(now);
  if (now === null) now = Date.now();
  const local = nyParts(now);
  let dateKey = utcDateKey(local.year, local.month, local.day);
  for (let i = 0; i < 15; i++) {
    const hour = marketCloseHour(dateKey);
    if (hour !== null) {
      const date = ymd(dateKey);
      const target = zonedToUtc(date.year, date.month, date.day, hour, 0);
      if (target <= now) {
        return {
          target_ms: target,
          target_utc: iso(target),
          local_date: String(date.year) + "-" + String(date.month).padStart(2, "0")
            + "-" + String(date.day).padStart(2, "0"),
          local_time: String(hour).padStart(2, "0") + ":00",
          kind: hour === 13 ? "scheduled_early_close" : "regular_close",
          time_zone: NY_TZ
        };
      }
    }
    dateKey -= DAY_MS;
  }
  return null;
}

// "rth" | "closed": is the US regular session open at `now`? Open is 09:30
// ET; the close is marketCloseHour's 16:00 - or a scheduled 13:00 early
// close - through the SAME weekday/holiday calendar previousUsCashClose
// walks, so "is it open" and "when did it last close" can never disagree
// about what a trading day is. The close instant itself is "closed",
// matching previousUsCashClose's `target <= now` convention. KNOWLEDGE
// LIMIT: the scheduled calendar above is all this function knows -
// exceptional exchange notices are not modeled, and a closure the holiday
// table does not list reads as a normal weekday here.
function usCashSession(now) {
  now = finite(now);
  if (now === null) now = Date.now();
  const local = nyParts(now);
  const hour = marketCloseHour(utcDateKey(local.year, local.month, local.day));
  if (hour === null) return "closed";
  const open = zonedToUtc(local.year, local.month, local.day, 9, 30);
  const close = zonedToUtc(local.year, local.month, local.day, hour, 0);
  return now >= open && now < close ? "rth" : "closed";
}

function findPriorClose(coin, close) {
  if (!close || !coin || !coin.tf) return null;
  const slot = coin.tf["1h"];
  let bars = slot && (slot.referenceClosed || slot.closed);
  if (!Array.isArray(bars) || !bars.length) return null;
  // Include the forming bar as a candidate WHEN ITS PERIOD HAS ENDED. At the
  // cash-close rollover the just-ended bar sits in `forming` for a few seconds
  // (longer on failed refetches) before the roll moves it to `closed`; without
  // it the newest qualifying bar is an hour older and, being inside the 6h lag
  // bound, silently misanchors the percentage (review LOW: 90 prior /
  // 100 just-ended / 110 mid read 22.22% instead of 10%). The end-time gate
  // below already rejects a forming bar whose period is still running.
  if (slot && slot.forming) bars = bars.concat([slot.forming]);
  let best = null;
  let bestEnd = -Infinity;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i] || {};
    const end = finite(bar.T) !== null ? finite(bar.T)
      : (finite(bar.t) !== null ? finite(bar.t) + HOUR_MS - 1 : null);
    const price = finite(bar.c);
    if (end === null || price === null || end > close.target_ms + 1000 || end <= bestEnd) continue;
    best = { price: price, at_ms: end };
    bestEnd = end;
  }
  if (!best) return null;
  const lag = Math.max(0, close.target_ms - best.at_ms);
  if (lag > MAX_REFERENCE_LAG_MS) return null;
  return {
    price: best.price,
    at_utc: iso(best.at_ms),
    lag_minutes: Math.round(lag / MINUTE_MS * 100) / 100
  };
}

// The percent move since the prior cash close, given that close's reference
// bar (findPriorClose above) and the current price. null - never zero - when
// there is no usable reference: absent, too stale, or a zero reference price.
//
// Deliberately takes the ALREADY-RESOLVED prior rather than a coin, because
// both callers need the reference object itself (the briefing publishes its
// price, timestamp and lag as their own columns) and neither should walk the
// 1h tape twice.
function overnightChangePct(prior, last) {
  return prior ? pct(last, prior.price) : null;
}

module.exports = {
  MAX_REFERENCE_LAG_MS,
  finite,
  iso,
  pct,
  previousUsCashClose,
  usCashSession,
  findPriorClose,
  overnightChangePct
};
