"use strict";

// score_v 3 momentum (design review 2026-07-20 D3): r60 is EXACT-horizon from
// the mid tape - the anchor no longer jumps at 15m candle rolls - with the
// pre-v3 candle anchor as the labeled fallback while the tape is immature,
// and max-age guards so a stalled tape can never stretch a labeled window.
// Preregistered unit vector: price unchanged across a 15m roll leaves the
// exact r60 unchanged while the candle-anchored one jumps (the old defect).
// node builtins only.

const test = require("node:test");
const assert = require("node:assert");
const { momentum } = require("../src/metrics.js");

const NOW = 10 * 3600000; // fixed injectable clock; fixtures are relative
function tape(ages, mids) { // ages in ms before NOW, oldest first
  return ages.map(function (a, i) { return { t: NOW - a, m: mids[i] }; });
}
function candles15(closes) {
  return closes.map(function (c, i) { return { t: i, o: c, h: c, l: c, c: c, v: 1 }; });
}
function coinOf(hist, closes, mid) {
  return { mid: mid, hist: hist,
           tf: closes ? { "15m": { closed: candles15(closes), forming: null, an: null } } : {} };
}

test("r60 exact: anchored to the latest tape sample at/before now-60m", function () {
  // samples 61.5m / 60.5m / 30m / 4s old -> anchor is the 60.5m one (m=100)
  const c = coinOf(tape([3690000, 3630000, 1800000, 4000], [98, 100, 103, 104.9]), null, 105);
  const m = momentum(c, NOW);
  assert.strictEqual(m.r60Src, "exact");
  assert.ok(Math.abs(m.r60 - 5) < 1e-9);
});

test("r60 falls back to the 15m close 4 bars back while the tape is immature", function () {
  const c = coinOf(tape([1800000, 4000], [103, 104.9]), [100, 101, 102, 103, 104], 105);
  const m = momentum(c, NOW);
  assert.strictEqual(m.r60Src, "candle");
  assert.ok(Math.abs(m.r60 - (105 / 101 - 1) * 100) < 1e-9);
});

test("preregistered D3 vector: unchanged price across a 15m roll - exact r60 holds, candle r60 jumps", function () {
  const hist = tape([3630000, 1800000, 4000], [100, 102, 105]);
  const before = momentum(coinOf(hist, [100, 101, 102, 103, 104], 105), NOW);
  // the roll: the closed 15m set shifts one bar; tape and mid identical
  const after = momentum(coinOf(hist, [101, 102, 103, 104, 105], 105), NOW);
  assert.strictEqual(before.r60Src, "exact");
  assert.strictEqual(after.r60, before.r60, "exact path ignores the roll");
  // contrast: without a tape the same roll moves the anchor (the old defect)
  const cBefore = momentum(coinOf([], [100, 101, 102, 103, 104], 105), NOW);
  const cAfter = momentum(coinOf([], [101, 102, 103, 104, 105], 105), NOW);
  assert.strictEqual(cBefore.r60Src, "candle");
  assert.notStrictEqual(cAfter.r60, cBefore.r60, "candle anchor jumps at the roll");
});

test("age guards: a stalled tape cannot stretch r5, nor serve an over-aged r60 anchor", function () {
  // endpoint 60s old -> stale (> MID_STALE_MS); r5 null
  const stalled = momentum(coinOf(tape([600000, 60000], [100, 101]), null, 102), NOW);
  assert.strictEqual(stalled.r5, null);
  // r60 anchor exists but is older than the 62-min retention bound -> unused;
  // no candles either -> r60 stays null with a null source
  const ancient = momentum(coinOf(tape([4000000], [90]), null, 102), NOW);
  assert.strictEqual(ancient.r60, null);
  assert.strictEqual(ancient.r60Src, null);
  // r5 still exact when the anchor sits inside its 7-min bound
  const fresh = momentum(coinOf(tape([360000, 4000], [100, 101.9]), null, 102), NOW);
  assert.ok(Math.abs(fresh.r5 - 2) < 1e-9);
});

// Review 2026-07-25 F1: the guards used to bound only now - anchor.t; a
// per-coin/per-universe mids gap left the ENDPOINT stale while the wall-clock
// target slid along the tape - a 55-minute span labeled "exact", and the
// stale endpoint pinned r5 to 0 against itself. Anchors are now relative to
// the endpoint's own clock and a > 30s-stale endpoint is labeled.
test("stale endpoint: a 5m mids gap cannot pass as exact, nor pin r5 to 0", function () {
  // the review's literal failure vector: anchor 60m before the CLOCK,
  // endpoint 5m stale -> pre-fix this was a 55-minute span labeled "exact"
  // (and r5 = 0 against itself); now there is no sample 60m before the
  // ENDPOINT, so with no candles nothing is served at all
  const lit = momentum(coinOf(tape([3600000, 300000], [100, 110]), null, 110), NOW);
  assert.strictEqual(lit.r5, null, "no fresh endpoint -> no 5m return (was 0 pre-fix)");
  assert.strictEqual(lit.r60, null, "a 55m span can no longer serve as a 60m return");
  assert.strictEqual(lit.r60Src, null);
  // last sample 5 min old; a TRUE 60m-earlier anchor exists on the tape ->
  // the span-correct value is served, honestly labeled
  const c = coinOf(tape([3900000, 300000], [100, 110]), null, 110);
  const m = momentum(c, NOW);
  assert.strictEqual(m.r5, null);
  assert.strictEqual(m.r60Src, "stale", "span-correct value served, honestly labeled");
  assert.ok(Math.abs(m.r60 - 10) < 1e-9, "anchored 60m before the ENDPOINT, not the clock");
  // r15/r30 share the stale numerator -> withheld too
  const c2 = coinOf(tape([3900000, 300000], [100, 110]), [100, 101, 102, 103, 104], 110);
  const m2 = momentum(c2, NOW);
  assert.strictEqual(m2.r15, null);
  assert.strictEqual(m2.r30, null);
  assert.strictEqual(m2.r60Src, "stale", "candle fallback under a stale endpoint is stale too");
});

test("stale endpoint: a single 60m-old sample is never its own exact anchor", function () {
  // pre-fix: the same sample served as numerator AND anchor -> r60 = 0 "exact"
  const solo = momentum(coinOf(tape([3600000], [100]), null, 100), NOW);
  assert.strictEqual(solo.r60, null, "no sample 60m before the endpoint -> no exact r60");
  assert.strictEqual(solo.r60Src, null);
  // with candles the fallback serves, but labeled stale, and never 0-by-identity
  const soloC = momentum(coinOf(tape([3600000], [104]), [100, 101, 102, 103, 104], 104), NOW);
  assert.strictEqual(soloC.r60Src, "stale");
  assert.ok(Math.abs(soloC.r60 - (104 / 101 - 1) * 100) < 1e-9);
});

test("endpoint staleness boundary: exactly 30s is fresh, 30.001s is stale", function () {
  const atBound = momentum(coinOf(tape([3630000 + 30000, 30000], [100, 105]), null, 105), NOW);
  assert.strictEqual(atBound.r60Src, "exact");
  assert.ok(atBound.r5 === null, "anchor 61m before endpoint serves r60, not r5");
  const past = momentum(coinOf(tape([3630001 + 30001, 30001], [100, 105]), null, 105), NOW);
  assert.strictEqual(past.r60Src, "stale");
});

test("anchor selection boundaries: exact target equality selects; max-age equality passes, +1ms fails", function () {
  // sample exactly AT endpoint-60m is selected (<=)
  const onTarget = momentum(coinOf(tape([3604000, 4000], [100, 104.9]), null, 105), NOW);
  assert.strictEqual(onTarget.r60Src, "exact");
  assert.ok(Math.abs(onTarget.r60 - 5) < 1e-9);
  // anchor exactly at the 62-min bound (endpoint clock) is accepted...
  const atMax = momentum(coinOf(tape([3724000, 4000], [100, 104.9]), null, 105), NOW);
  assert.strictEqual(atMax.r60Src, "exact");
  // ...one ms older is rejected (no candles -> null)
  const pastMax = momentum(coinOf(tape([3724001, 4000], [100, 104.9]), null, 105), NOW);
  assert.strictEqual(pastMax.r60, null);
  // r5: anchor exactly at the 7-min bound accepted, +1ms rejected
  const r5At = momentum(coinOf(tape([424000, 4000], [100, 101.9]), null, 102), NOW);
  assert.ok(Math.abs(r5At.r5 - 2) < 1e-9);
  const r5Past = momentum(coinOf(tape([424001, 4000], [100, 101.9]), null, 102), NOW);
  assert.strictEqual(r5Past.r5, null);
});

test("no mid: everything null; r15/r30 keep their candle anchors", function () {
  const none = momentum(coinOf(tape([3630000], [100]), [100, 101, 103, 104], null), NOW);
  assert.deepStrictEqual(none, { r5: null, r15: null, r30: null, r60: null, r60Src: null });
  const m = momentum(coinOf([], [100, 101, 103, 104], 105), NOW);
  assert.ok(Math.abs(m.r15 - (105 / 104 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(m.r30 - (105 / 103 - 1) * 100) < 1e-9);
});
