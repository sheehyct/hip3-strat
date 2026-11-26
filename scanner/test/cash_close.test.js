"use strict";

// Regressions for src/cash_close.js from a code review:
// the early-close calendar rule and the rollover forming-bar anchor.
// node builtins only: node --test

const test = require("node:test");
const assert = require("node:assert");
const { previousUsCashClose, findPriorClose, overnightChangePct, usCashSession } = require("../src/cash_close.js");

const HOUR = 3600000;

// -------------------------------------------------- New Year Saturday rule
// New Year's is the ONE fixed holiday whose Saturday case is NOT observed on
// the preceding Friday (review): Dec 31 belongs to the prior year and
// NYSE keeps it a full session. Dec 31 2021 really traded (Jan 1 2022 was a
// Saturday), and NYSE lists no observed holiday around Jan 1 2028 either.
// July 4 / Christmas Saturday observance still moves to Friday.

test("2021-12-31 was a full session (New Year 2022 fell on a Saturday)", function () {
  const c = previousUsCashClose(Date.UTC(2021, 11, 31, 22, 0));
  assert.strictEqual(c.target_utc, "2021-12-31T21:00:00.000Z");
  assert.strictEqual(c.kind, "regular_close");
});

test("2027-12-31 10:00 ET is rth (the audit's exact prov-field case)", function () {
  assert.strictEqual(usCashSession(Date.UTC(2027, 11, 31, 15, 0)), "rth");
  const c = previousUsCashClose(Date.UTC(2028, 0, 1, 12, 0));
  assert.strictEqual(c.target_utc, "2027-12-31T21:00:00.000Z",
    "Dec 31 2027 closes normally; nothing observed for Saturday Jan 1 2028");
});

test("a Sunday New Year still observes Monday (Jan 2 2023 closed)", function () {
  const c = previousUsCashClose(Date.UTC(2023, 0, 2, 22, 0));
  assert.strictEqual(c.target_utc, "2022-12-30T21:00:00.000Z",
    "Mon Jan 2 2023 is the observed holiday; prior close is Fri Dec 30");
  assert.strictEqual(usCashSession(Date.UTC(2023, 0, 2, 15, 0)), "closed");
});

// ---------------------------------------------------------- early-close rule
// NYSE 13:00 sessions are July 3 and Dec 24 WHEN EACH IS ITSELF A TRADING DAY
// (plus the day after Thanksgiving) - never "the trading day before the
// observed closure". The audit's calibration case: 2026-07-04 is a Saturday,
// July 3 is the observed holiday, and July 2 is a NORMAL 16:00 session.

test("2026-07-02 is a regular 16:00 session (review MEDIUM)", function () {
  const c = previousUsCashClose(Date.UTC(2026, 6, 2, 21, 0));
  assert.strictEqual(c.target_utc, "2026-07-02T20:00:00.000Z");
  assert.strictEqual(c.kind, "regular_close");
});

test("2026-07-03 is the observed holiday: the prior close is July 2 regular", function () {
  const c = previousUsCashClose(Date.UTC(2026, 6, 3, 22, 0));
  assert.strictEqual(c.target_utc, "2026-07-02T20:00:00.000Z");
  assert.strictEqual(c.kind, "regular_close");
});

test("2025-07-03 IS a 13:00 early close (July 4 2025 is a Friday holiday)", function () {
  const c = previousUsCashClose(Date.UTC(2025, 6, 3, 18, 0));
  assert.strictEqual(c.target_utc, "2025-07-03T17:00:00.000Z");
  assert.strictEqual(c.kind, "scheduled_early_close");
});

test("2021-12-23 was a full session (Christmas observed Fri Dec 24)", function () {
  const c = previousUsCashClose(Date.UTC(2021, 11, 23, 22, 0));
  assert.strictEqual(c.target_utc, "2021-12-23T21:00:00.000Z");
  assert.strictEqual(c.kind, "regular_close");
});

test("2022-07-01 was a full session (July 4 2022 fell on a Monday)", function () {
  const c = previousUsCashClose(Date.UTC(2022, 6, 1, 21, 0));
  assert.strictEqual(c.target_utc, "2022-07-01T20:00:00.000Z");
  assert.strictEqual(c.kind, "regular_close");
});

test("the day after Thanksgiving and a weekday Dec 24 stay early closes", function () {
  const bf = previousUsCashClose(Date.UTC(2026, 10, 27, 19, 0));
  assert.strictEqual(bf.target_utc, "2026-11-27T18:00:00.000Z");
  assert.strictEqual(bf.kind, "scheduled_early_close");
  const xmasEve = previousUsCashClose(Date.UTC(2026, 11, 24, 19, 0));
  assert.strictEqual(xmasEve.target_utc, "2026-12-24T18:00:00.000Z");
  assert.strictEqual(xmasEve.kind, "scheduled_early_close");
});

// ------------------------------------------------- rollover forming-bar anchor
// At the cash close the just-ended 1h bar sits in `forming` for a few seconds
// before the roll moves it to `closed`. The anchor must use it, not the bar an
// hour older (review LOW: 90 prior / 100 just-ended / 110 mid read 22.22%
// instead of 10%).

function barsFixture(target) {
  return {
    older: { t: target - 2 * HOUR, T: target - HOUR - 1, o: 89, h: 91, l: 88, c: 90, v: 5 },
    justEnded: { t: target - HOUR, T: target - 1, o: 99, h: 101, l: 98, c: 100, v: 5 }
  };
}

test("findPriorClose uses the just-ended forming bar at rollover", function () {
  const target = Date.UTC(2026, 6, 22, 20, 0);
  const b = barsFixture(target);
  const coin = { tf: { "1h": { closed: [b.older], forming: b.justEnded } } };
  const prior = findPriorClose(coin, { target_ms: target });
  assert.strictEqual(prior.price, 100, "just-ended forming bar is the anchor");
  assert.strictEqual(overnightChangePct(prior, 110), 10, "+10%, not +22.22% off the older bar");
});

test("a forming bar whose period is still running is NOT an anchor", function () {
  const target = Date.UTC(2026, 6, 22, 20, 0);
  const b = barsFixture(target);
  const stillRunning = { t: target - 30 * 60000, T: target + 30 * 60000 - 1, o: 104, h: 106, l: 103, c: 105, v: 2 };
  const coin = { tf: { "1h": { closed: [b.older, b.justEnded], forming: stillRunning } } };
  const prior = findPriorClose(coin, { target_ms: target });
  assert.strictEqual(prior.price, 100, "live partial bar rejected by the end-time gate");
});
