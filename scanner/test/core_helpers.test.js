"use strict";

// Pure helpers importable without network (task: forming-bar math lives in
// non-exported loop closures, so what IS testable standalone is the exported
// surface: strat_core calendar/classification helpers + the loop's TF table
// and constructor). No network, no timers started.

const test = require("node:test");
const assert = require("node:assert");
const {
  classify, classifySeries, weekStart, monthStart, nextMonthStart, aggregateBars
} = require("../src/strat_core.js");
const { createLoop, TFS, splitClosedBars } = require("../src/loop.js");

// ---- classification: strict inequalities (equal high/low is NOT a break) ----

test("classify uses strict inequalities: equal high/low is an inside bar", function () {
  assert.strictEqual(classify(100, 99, 100, 99), "1");    // equal H and L -> no break
  assert.strictEqual(classify(100.1, 99, 100, 99), "2U");
  assert.strictEqual(classify(100, 98.9, 100, 99), "2D");
  assert.strictEqual(classify(100.1, 98.9, 100, 99), "3");
});

test("classifySeries: first element is null (no prior bar)", function () {
  const t = classifySeries([
    { t: 0, o: 1, h: 10, l: 1, c: 5 },
    { t: 1, o: 5, h: 11, l: 2, c: 6 }
  ]);
  assert.deepStrictEqual(t, [null, "2U"]);
});

// ---- calendar helpers (native HL 1w/1M buckets are WRONG for STRAT; these
// ---- must be true Monday-anchored weeks and calendar months) ----

test("weekStart returns Monday 00:00 UTC of the containing week", function () {
  const mon = Date.UTC(2026, 5, 29);                 // Mon 2026-06-29
  assert.strictEqual(weekStart(Date.UTC(2026, 6, 1, 12)), mon);   // Wed -> that Monday
  assert.strictEqual(weekStart(mon), mon);                        // Monday maps to itself
  assert.strictEqual(weekStart(Date.UTC(2026, 6, 5, 23, 59)), mon); // Sunday ends the week
  assert.strictEqual(weekStart(Date.UTC(2026, 5, 28, 23, 59)), Date.UTC(2026, 5, 22)); // prior week
});

test("monthStart / nextMonthStart are calendar-correct incl. year rollover", function () {
  assert.strictEqual(monthStart(Date.UTC(2026, 6, 15, 7)), Date.UTC(2026, 6, 1));
  assert.strictEqual(nextMonthStart(Date.UTC(2026, 6, 15)), Date.UTC(2026, 7, 1));
  assert.strictEqual(nextMonthStart(Date.UTC(2026, 11, 31)), Date.UTC(2027, 0, 1));
});

// dailies 2026-06-25 (Thu) .. 2026-07-05 (Sun); o/h/l/c encode the day index
// so bucket union math is checkable exactly.
function dailies(startDay, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = Date.UTC(2026, 5, startDay + i);       // Date.UTC normalizes overflow into July
    out.push({ t: t, T: t + 86400000 - 1, o: 100 + i, h: 110 + i, l: 90 - i, c: 101 + i });
  }
  return out;
}

test("aggregateBars(week) drops the partial first bucket and unions H/L", function () {
  const days = dailies(25, 11);                      // Thu 6/25 .. Sun 7/5
  const out = aggregateBars(days, "week");
  // week of 6/22 is partial (first daily is Thursday) -> dropped
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].t, Date.UTC(2026, 5, 29));            // Mon 6/29
  assert.strictEqual(out[0].T, Date.UTC(2026, 5, 29) + 604800000 - 1);
  assert.strictEqual(out[0].o, 104);                 // Monday's open (day index 4)
  assert.strictEqual(out[0].h, 120);                 // max high of 6/29..7/5 (index 10)
  assert.strictEqual(out[0].l, 80);                  // min low
  assert.strictEqual(out[0].c, 111);                 // Sunday's close
});

test("aggregateBars(week) with the forming daily last yields the forming W bar", function () {
  const days = dailies(29, 4);                       // Mon 6/29 .. forming Thu 7/2
  const out = aggregateBars(days, "week");
  assert.strictEqual(out.length, 1);                 // starts on Monday -> nothing dropped
  assert.strictEqual(out[0].t, Date.UTC(2026, 5, 29));
  assert.strictEqual(out[0].h, 113);                 // includes the forming daily's high
  assert.strictEqual(out[0].l, 87);
  assert.strictEqual(out[0].c, 104);                 // forming daily's (live) close
  // T is in the future relative to the forming daily -> the loop pops it as forming
  assert.ok(out[0].T > Date.UTC(2026, 6, 2));
});

test("aggregateBars(month) drops the partial first month, keeps the calendar one", function () {
  const days = dailies(28, 6);                       // 6/28 .. 7/3
  const out = aggregateBars(days, "month");
  assert.strictEqual(out.length, 1);                 // June partial -> dropped
  assert.strictEqual(out[0].t, Date.UTC(2026, 6, 1));
  assert.strictEqual(out[0].T, Date.UTC(2026, 7, 1) - 1);
  assert.strictEqual(out[0].o, 103);                 // July 1 open (day index 3)
  assert.strictEqual(out[0].c, 106);                 // July 3 close
});

// ---- loop exported surface (no network: start() is never called) ----

test("TFS: W/M are derived-only (never fetched); fetch depths per Section 5", function () {
  assert.deepStrictEqual(TFS.map(function (t) { return t.id; }),
    ["15m", "30m", "1h", "4h", "1d", "1w", "1M"]);
  const byId = {};
  TFS.forEach(function (t) { byId[t.id] = t; });
  assert.strictEqual(byId["1w"].derived, "week");
  assert.strictEqual(byId["1M"].derived, "month");
  ["15m", "30m", "1h", "4h", "1d"].forEach(function (id) {
    assert.ok(!byId[id].derived, id + " must be fetched, not derived");
  });
  assert.strictEqual(byId["15m"].bars, 40);          // feeds momentum + RVOL
  assert.strictEqual(byId["1h"].bars, 30);           // score_v 3 hourly yardstick
  assert.strictEqual(byId["1h"].briefingBars, 168);  // separate prior-close reference tape
  assert.strictEqual(byId["1d"].bars, 220);          // feeds W/M aggregation
  assert.strictEqual(byId["15m"].ms, 900000);
  assert.strictEqual(byId["1w"].ms, 604800000);
});

test("createLoop constructs and stops cleanly without any network", function () {
  const loop = createLoop({}, {});
  assert.deepStrictEqual(loop.state.coins, {});
  assert.deepStrictEqual(loop.state.order, []);
  assert.strictEqual(loop.state.loaded, false);
  assert.strictEqual(typeof loop.start, "function");
  loop.stop();                                       // no timers started -> no-op, no throw
});

test("briefing reference retention does not widen the score/STRAT 1h input", function () {
  const oneHour = TFS.find(function (tf) { return tf.id === "1h"; });
  const bars = Array.from({ length: oneHour.briefingBars }, function (_, i) { return { t: i }; });
  const retained = splitClosedBars(oneHour, bars);
  assert.strictEqual(retained.reference.length, 168);
  assert.strictEqual(retained.analysis.length, 30);
  assert.strictEqual(retained.analysis[0].t, 138);
});
