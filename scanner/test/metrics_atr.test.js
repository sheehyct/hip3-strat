"use strict";

// ATR metrics: daily Wilder-14 ATR% (atrPct), the trailing-20 average 15m
// true range % (tr15AvgPct) that move_spike normalizes against, and its 1h
// sibling (tr1hAvgPct) that the score's momentum term normalizes against
// (score_v 3).
// node builtins only: node --test

const test = require("node:test");
const assert = require("node:assert");
const { atrPct, tr15AvgPct, tr1hAvgPct, TR1H_STALE_MS } = require("../src/metrics.js");

function dailyCoin(n) {
  const closed = [];
  for (let i = 0; i < n; i++) {
    // constant true range 2 on a 100 close -> ATR% = 2
    closed.push({ t: i, o: 100, h: 101, l: 99, c: 100 });
  }
  return { tf: { "1d": { closed: closed, forming: null, an: null } } };
}

test("atrPct: Wilder ATR as % of last close; null under 15 dailies", function () {
  assert.strictEqual(atrPct(dailyCoin(14)), null);
  assert.ok(Math.abs(atrPct(dailyCoin(15)) - 2) < 1e-9);
  assert.ok(Math.abs(atrPct(dailyCoin(220)) - 2) < 1e-9); // smoothing of a constant is constant
  assert.strictEqual(atrPct({ tf: {} }), null);
});

test("tr15AvgPct: trailing-20 avg TR%; null under 21 closed bars", function () {
  const closed = [];
  for (let i = 0; i < 21; i++) closed.push({ t: i, o: 100, h: 100.05, l: 99.95, c: 100 });
  const coin = { tf: { "15m": { closed: closed, forming: null, an: null } } };
  assert.ok(Math.abs(tr15AvgPct(coin) - 0.1) < 1e-9);
  coin.tf["15m"].closed = closed.slice(0, 20);
  assert.strictEqual(tr15AvgPct(coin), null);
});

// 21 contiguous closed 1h bars, newest ending `endAge` ms before NOW.
const NOW = 20 * 86400000;
function hourly21(endAge) {
  const closed = [];
  for (let i = 0; i < 21; i++) {
    const T = NOW - endAge - (20 - i) * 3600000;
    // constant true range 1 on a 100 close -> 1%
    closed.push({ t: T - 3600000, T: T, o: 100, h: 100.5, l: 99.5, c: 100 });
  }
  return { tf: { "1h": { closed: closed, forming: null, an: null } } };
}

test("tr1hAvgPct: trailing-20 avg 1h TR%; null under 21 closed bars", function () {
  const coin = hourly21(60000);
  assert.ok(Math.abs(tr1hAvgPct(coin, NOW) - 1) < 1e-9);
  coin.tf["1h"].closed = coin.tf["1h"].closed.slice(0, 20);
  assert.strictEqual(tr1hAvgPct(coin, NOW), null);
  assert.strictEqual(tr1hAvgPct({ tf: {} }, NOW), null);
});

// Review 2026-07-25 F3: a failed boundary refetch preserves the old slot
// wholesale, so 21 elements alone used to keep a dead yardstick "available"
// indefinitely (ATR branch active, telemetry unflagged). The slot is now
// unavailable once the newest closed hour is OVERDUE: its end + the next
// bar's hour + a 15 min refetch grace.
test("tr1hAvgPct freshness: an overdue slot is unavailable; the boundary is inclusive", function () {
  // newest bar just closed -> fresh
  assert.ok(tr1hAvgPct(hourly21(1000), NOW) > 0);
  // exactly AT the bound (end age == 1h + 15m) -> still fresh
  assert.ok(tr1hAvgPct(hourly21(TR1H_STALE_MS), NOW) > 0);
  // one ms past -> stale, yardstick unavailable (score falls back, flagged)
  assert.strictEqual(tr1hAvgPct(hourly21(TR1H_STALE_MS + 1), NOW), null);
  // recovery: a successful refetch replaces the slot wholesale -> fresh again
  const healed = hourly21(60000);
  assert.ok(tr1hAvgPct(healed, NOW) > 0);
  // bars without T (legacy/synthetic shape) fall back to t + 1h as the end
  const noT = hourly21(60000);
  noT.tf["1h"].closed.forEach(function (b) { delete b.T; });
  assert.ok(tr1hAvgPct(noT, NOW) > 0, "t + 1h substitutes for a missing T");
});
