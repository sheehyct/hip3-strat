"use strict";

// Stage 2 of the candle feed: the
// 30m/1h/4h/1d slots of a COVERED coin roll LOCALLY from the 15m slot. The
// forming higher bar is the fold of the period's closed 15m children (F6
// rule: synthetic children never set the open or the range) UNION the live
// 15m forming bar UNION the previous forming of the same period; a higher
// period closes the instant the 15m slot moves past it - at the first trade
// or at the local roll 4 s past the boundary - and REST's boundary sweep
// becomes the reconcile that confirms the period (restT) and wins when it
// lands, with every locally rolled closed bar compared first.

const test = require("node:test");
const assert = require("node:assert");
const { createLoop, TFS, HIGHER } = require("../src/loop.js");
const budget = require("../src/budget.js");

const realFetch = globalThis.fetch;
const realNow = Date.now;
// The per-TF sweep flags live on the module-level TFS objects: a sweep a test
// left hanging must not gate the next test's sweeps.
test.afterEach(function () {
  globalThis.fetch = realFetch; Date.now = realNow;
  TFS.forEach(function (t) { t.refetching = false; t.retryAfter = 0; });
});

const M15 = 900000, M30 = 1800000, H1 = 3600000, H4 = 14400000, D1 = 86400000;
const byId = {};
TFS.forEach(function (t) { byId[t.id] = t; });

function stubFeed(covered) {
  const set = new Set(covered || []);
  return {
    set: set,
    covers: function (n) { return set.has(n); },
    setCoins: function () {}, start: function () {}, stop: function () {},
    snapshot: function () { return { connected: true, wanted: set.size, acked: set.size }; }
  };
}

function makeLoop(feed) {
  const lines = [];
  const limiter = budget.createLimiter({ ratePerMin: 60000, burst: 20000, log: function () {} });
  const loop = createLoop({}, {
    universes: [{ id: "perps", dex: null }], log: function (l) { lines.push(l); }, limiter: limiter, feed: feed
  });
  loop.lines = lines;
  return loop;
}

function bar(t, ms, o, h, l, c, v) { return { t: t, T: t + ms - 1, o: o, h: h, l: l, c: c, v: v }; }
function b15(t, o, h, l, c, v) { return bar(t, M15, o, h, l, c, v); }
function push(t, o, h, l, c, v, n) { return { t: t, T: t + M15 - 1, o: o, h: h, l: l, c: c, v: v, n: n }; }
function copy(b) { return JSON.parse(JSON.stringify(b)); }

// REST stub: a sweep's fetch is recorded in `seen` and answered from `rest`
// (key "COIN:tf", bars in the API's string shape) - a key with no entry
// HANGS, so slots the test does not feed by REST are only ever moved by the
// feed paths.
function restFetch(seen, rest) {
  globalThis.fetch = async function (url, opts) {
    const body = JSON.parse(opts.body);
    const key = body.req.coin + ":" + body.req.interval;
    if (seen) seen.push(key);
    const data = rest && rest[key];
    if (!data) await new Promise(function () {});
    return { status: 200, ok: true, json: async function () { return data; } };
  };
}
function hangFetch(seen) { restFetch(seen, null); }
function api(b) { return { t: b.t, T: b.T, o: String(b.o), h: String(b.h), l: String(b.l), c: String(b.c), v: String(b.v) }; }
function settle() { return new Promise(function (r) { setTimeout(r, 30); }); }

function registerCoin(loop, name) {
  loop.state.coins[name] = { name: name, sym: name, uni: "perps", ctx: null, mid: null, tf: {}, hist: [] };
  loop.state.order.push(name);
}

// 2026-09-21 03:00 UTC: a 15m, 30m and 1h boundary (the 4h period is 00:00,
// the day 09-21). REST snapshots as the sweeps would have landed at 03:16Z,
// one minute into the 03:15 child: every higher forming bar already holds
// the 03:00 child in full plus the 03:15 child's first minute (v 5).
const T0300 = Date.UTC(2026, 8, 21, 3, 0, 0);
const T0315 = T0300 + M15, T0330 = T0300 + M30, T0345 = T0330 + M15, T0400 = T0300 + H1;
const T0000 = Date.UTC(2026, 8, 21, 0, 0, 0);

function seedStandard(loop, name) {
  Date.now = function () { return T0315 + 60000; };
  loop.setCandles(name, byId["15m"], { closed: [
    b15(T0300 - 2 * M15, 9, 11, 8, 10, 100), b15(T0300 - M15, 10, 12, 9, 11, 100), b15(T0300, 11, 12, 10, 10.5, 100)
  ], forming: b15(T0315, 10.5, 10.8, 10.2, 10.6, 5) });
  // The feed is live on the child: a push with the same values as REST's forming bar (sets feedAt).
  loop.applyFeedBar(name, push(T0315, 10.5, 10.8, 10.2, 10.6, 5, 2), "15m", T0315 + 59000);
  loop.setCandles(name, byId["30m"], { closed: [
    bar(T0300 - 2 * M30, M30, 8, 9, 7.5, 9, 150), bar(T0300 - M30, M30, 9, 12, 8, 11, 200)
  ], forming: bar(T0300, M30, 11, 12, 10, 10.6, 105) });
  loop.setCandles(name, byId["1h"], { closed: [
    bar(T0300 - 2 * H1, H1, 8, 9.5, 7, 9, 300), bar(T0300 - H1, H1, 9, 12, 7.5, 11, 350)
  ], forming: bar(T0300, H1, 11, 12, 10, 10.6, 105) });
  loop.setCandles(name, byId["4h"], { closed: [
    bar(T0000 - H4, H4, 8, 10, 7, 9.5, 1200)
  ], forming: bar(T0000, H4, 9.5, 12, 7, 10.6, 1500) });
  loop.setCandles(name, byId["1d"], { closed: [
    bar(T0000 - 2 * D1, D1, 7, 9, 6, 8, 5000), bar(T0000 - D1, D1, 8, 10, 7, 9.5, 6000)
  ], forming: bar(T0000, D1, 9.5, 12, 7, 10.6, 1500) });
}

test("HIGHER is every fetched timeframe above the 15m base, in rank order", function () {
  assert.deepStrictEqual(HIGHER.map(function (t) { return t.id; }), ["30m", "1h", "4h", "1d"]);
});

test("no feed: setCandles writes the slot shape it always did (no agg / restT / localFrom)", function () {
  const loop = makeLoop(undefined);
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  const s = loop.state.coins.A.tf["30m"];
  assert.deepStrictEqual(Object.keys(s).sort(), ["an", "closed", "fetchedAt", "forming"]);
  assert.deepStrictEqual(Object.keys(loop.state.coins.A.tf["1h"]).sort(), ["an", "closed", "fetchedAt", "forming", "referenceClosed"]);
});

test("REST seeds the accumulator from its own aggregate: the live child's volume is netted out and the child is left to fold at its close; restT confirms the period", function () {
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  const s30 = loop.state.coins.A.tf["30m"];
  assert.deepStrictEqual(s30.agg, { t: T0300, o: 11, h: 12, l: 10, c: 10.6, v: 100, traded: true, lastT: T0300, approx: false, skipV: null, cFrom: 0 },
    "price from REST; v = the feed's closed 03:00 child (100), not REST's 105 which holds the live child's 5; lastT = the child before the one in progress");
  assert.strictEqual(s30.restT, T0300);
  assert.strictEqual(s30.localFrom, null);
  assert.deepStrictEqual(s30.unverified, []);
  assert.deepStrictEqual(s30.forming, bar(T0300, M30, 11, 12, 10, 10.6, 105), "served forming = seed + the live child: equals REST's bar");
  const a4 = loop.state.coins.A.tf["4h"].agg;
  assert.deepStrictEqual({ v: a4.v, lastT: a4.lastT, approx: a4.approx }, { v: 1495, lastT: T0300, approx: true },
    "the 15m buffer does not reach the 4h period start: REST's v net of the live child, flagged approximate");
});

test("a same-period push flows into every higher forming bar: o from the period's first traded child, h/l the union with the live child and with mids, c the latest, v the fold plus the live child; no revision bump", function () {
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  const c = loop.state.coins.A;
  const rev = loop.state.revision;
  loop.applyFeedBar("A", push(T0315, 10.5, 11.5, 10.2, 11.2, 40, 10), "15m", T0315 + 70000);
  assert.deepStrictEqual(c.tf["30m"].forming, bar(T0300, M30, 11, 12, 10, 11.2, 140));
  assert.deepStrictEqual(c.tf["1h"].forming, bar(T0300, H1, 11, 12, 10, 11.2, 140));
  assert.deepStrictEqual(c.tf["4h"].forming, bar(T0000, H4, 9.5, 12, 7, 11.2, 1535));
  assert.deepStrictEqual(c.tf["1d"].forming, bar(T0000, D1, 9.5, 12, 7, 11.2, 1535));
  assert.ok(c.tf["30m"].an && c.tf["4h"].an && c.tf["1d"].an, "reanalyzed");
  assert.strictEqual(loop.state.revision, rev, "no revision bump on a same-period push");
  // The 4 s mids tick expanded the 30m forming bar above any trade: it persists through the next push.
  c.tf["30m"].forming.h = 13;
  loop.applyFeedBar("A", push(T0315, 10.5, 11.5, 10.2, 11.0, 45, 12), "15m", T0315 + 80000);
  assert.strictEqual(c.tf["30m"].forming.h, 13, "the mids high stays (union with the previous forming)");
  assert.strictEqual(c.tf["30m"].forming.c, 11.0);
  assert.strictEqual(c.tf["30m"].forming.v, 145);
  assert.strictEqual(c.tf["1h"].forming.h, 12, "another slot's mids expansion does not leak");
});

test("a push for the next 15m period across a 30m boundary rolls the 30m AT ONCE: the fold closes, the new forming opens from the push, the 1h only folds; revision bumps; the period is unconfirmed until REST lands", function () {
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  const c = loop.state.coins.A;
  loop.applyFeedBar("A", push(T0315, 10.5, 11.5, 10.2, 11.2, 40, 10), "15m", T0315 + 70000);
  const rev = loop.state.revision;
  loop.applyFeedBar("A", push(T0330, 11.3, 11.4, 11.1, 11.35, 2, 1), "15m", T0330 + 500);
  const s30 = c.tf["30m"], s1h = c.tf["1h"];
  assert.strictEqual(s30.closed.length, 3);
  assert.deepStrictEqual(s30.closed[2], bar(T0300, M30, 11, 12, 10, 11.2, 140), "03:00 child + 03:15 child (raw push, no mids)");
  assert.deepStrictEqual(s30.forming, bar(T0330, M30, 11.3, 11.4, 11.1, 11.35, 2), "opens from the first trade of the new period");
  assert.deepStrictEqual(s30.agg, { t: T0330, o: 11.2, h: 11.2, l: 11.2, c: 11.2, v: 0, traded: false, lastT: T0315, approx: false, skipV: null, cFrom: 0 });
  assert.strictEqual(s30.localFrom, T0300);
  assert.deepStrictEqual(s30.unverified, [], "a feed-seeded bar is a parity sample");
  assert.strictEqual(s30.restT, T0300, "REST has confirmed 03:00 only");
  assert.strictEqual(loop.state.feed.rollups["30m"], 1);
  assert.strictEqual(loop.state.feed.rollups["1h"], 0);
  assert.deepStrictEqual(s1h.forming, bar(T0300, H1, 11, 12, 10, 11.35, 142), "the 1h folds the child (v 100 + 40) and adds the live child (2)");
  assert.strictEqual(s1h.closed.length, 2, "no 1h roll at 03:30");
  assert.ok(loop.state.revision > rev, "a roll bumps the revision");
});

test("the timer's local 15m roll at T + 4 s rolls the higher slots with NO push (zero lag), the new period opens synthetic from the carried close, and only the unconfirmed timeframe is REST-swept", async function () {
  const seen = [];
  hangFetch(seen);
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  loop.barRollTick(T0330 + 3000);
  assert.strictEqual(c.tf["30m"].forming.t, T0300, "3 s past: nothing rolls yet (the exchange gets a beat)");
  loop.barRollTick(T0330 + 5000);
  const s30 = c.tf["30m"];
  assert.deepStrictEqual(c.tf["15m"].closed[3], b15(T0315, 10.5, 10.8, 10.2, 10.6, 5), "the 15m closed REST's raw forming bar (feedBar)");
  assert.deepStrictEqual(s30.closed[2], bar(T0300, M30, 11, 12, 10, 10.6, 105), "fold of both children");
  assert.deepStrictEqual(s30.forming, bar(T0330, M30, 10.6, 10.6, 10.6, 10.6, 0), "synthetic from the carried close until the first trade");
  assert.strictEqual(c.tf["1h"].forming.t, T0300, "the 1h did not roll");
  assert.strictEqual(c.tf["1h"].forming.v, 105);
  assert.strictEqual(c.tf["4h"].forming.t, T0000);
  assert.strictEqual(loop.state.feed.rollups["30m"], 1);
  assert.strictEqual(loop.state.feed.localRolls, 1);
  await new Promise(function (r) { setTimeout(r, 30); });
  assert.deepStrictEqual(seen, ["A:30m"], "the 30m sweep still runs (the reconcile); 1h/4h/1d are confirmed and current, 15m is covered");
  // The first trade of the new period replaces the synthetic open; the carried close stays inside the range.
  loop.applyFeedBar("A", push(T0330, 10.9, 11.1, 10.9, 11.0, 2, 1), "15m", T0330 + 12000);
  assert.deepStrictEqual(s30.forming, bar(T0330, M30, 10.9, 11.1, 10.6, 11.0, 2));
  loop.stop();
});

test("REST lands after a local roll: the locally rolled closed bar is compared (zero mismatches when equal, o/h/l/c vs v counted apart, logged), REST wins, the period is confirmed and not swept again", async function () {
  const seen = [], rest = {};
  restFetch(seen, rest);
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  // The reconcile sweep the local roll triggers: REST agrees with the fold for
  // 03:00 and brings the new period's first trades.
  rest["A:30m"] = [api(bar(T0300 - M30, M30, 9, 12, 8, 11, 200)), api(bar(T0300, M30, 11, 12, 10, 10.6, 105)), api(bar(T0330, M30, 10.7, 10.75, 10.65, 10.7, 3))];
  Date.now = function () { return T0330 + 6000; };    // the sweep's fetch instant
  loop.barRollTick(T0330 + 5000);
  await settle();
  assert.deepStrictEqual(seen, ["A:30m"]);
  assert.strictEqual(byId["30m"].refetching, false, "the sweep landed");
  let s30 = c.tf["30m"];
  const r = loop.state.feed.rollupReconcile;
  assert.deepStrictEqual({ barsCompared: r.barsCompared, mismatches: r.mismatches }, { barsCompared: 1, mismatches: 0 });
  assert.strictEqual(s30.restT, T0330, "confirmed");
  assert.strictEqual(s30.localFrom, null, "REST replaced every locally rolled bar");
  assert.deepStrictEqual(s30.agg, { t: T0330, o: 10.7, h: 10.75, l: 10.65, c: 10.7, v: 0, traded: true, lastT: T0315, approx: false, skipV: null, cFrom: 0 },
    "price is REST's raw aggregate; volume is the feed's (no closed child in the period yet: 0); the live child folds at its close");
  assert.deepStrictEqual(s30.forming, bar(T0330, M30, 10.7, 10.75, 10.6, 10.7, 0),
    "REST's bar UNION the forming it replaces - the carried close 10.6 stays inside the range (the rule every refetch has always applied); REST's close since the live child has not traded; the feed owns v, so the live child's pushes supply it");
  seen.length = 0;
  loop.barRollTick(T0330 + 40000);
  await settle();
  assert.deepStrictEqual(seen, [], "confirmed and current: no sweep");
  // A later REST bar that DISAGREES with a locally rolled one: counted as an o/h/l/c mismatch, logged, REST wins.
  rest["A:30m"] = [api(bar(T0300, M30, 11, 12, 10, 10.6, 105)), api(bar(T0330, M30, 10.7, 10.9, 10.65, 10.7, 3.5)), api(bar(T0400, M30, 10.7, 10.7, 10.7, 10.7, 1))];
  loop.barRollTick(T0345 + 5000);
  await settle();
  assert.deepStrictEqual(seen, [], "03:45: the 30m is confirmed and its period is running");
  Date.now = function () { return T0400 + 6000; };
  loop.barRollTick(T0400 + 5000);                      // 03:30 closes locally (two synthetic children), 04:00 opens
  s30 = c.tf["30m"];
  assert.deepStrictEqual(s30.closed[s30.closed.length - 1], bar(T0330, M30, 10.7, 10.75, 10.65, 10.7, 0), "the local close before REST lands (both children synthetic: v 0)");
  assert.strictEqual(s30.localFrom, T0330);
  await settle();
  assert.deepStrictEqual(seen, ["A:30m", "A:1h", "A:4h"], "04:00 is also a 1h and a 4h boundary: those rolled locally too and their reconciles dispatch in rank order");
  assert.strictEqual(r.barsCompared, 2);
  assert.strictEqual(r.mismatches, 1);
  assert.strictEqual(r.mismatchesOhlc, 1);
  assert.strictEqual(r.mismatchesVolume, 0);
  assert.deepStrictEqual(r.lastMismatch.fields, ["h", "v"]);
  assert.strictEqual(r.lastMismatch.tf, "30m");
  assert.ok(loop.lines.some(function (l) { return /^rollup MISMATCH A 30m t=2026-09-21T03:30:00\.000Z h local=10\.75 rest=10\.9 v local=0 rest=3\.5$/.test(l); }), loop.lines.join("|"));
  assert.strictEqual(c.tf["30m"].closed[c.tf["30m"].closed.length - 1].h, 10.9, "REST won");
  loop.stop();
});

test("the comparator tolerates float summation on volume (children 0.1 + 0.2 vs REST's 0.3) while o/h/l/c stay strict", async function () {
  const seen = [], rest = {};
  restFetch(seen, rest);
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  Date.now = function () { return T0315 + 60000; };
  loop.setCandles("A", byId["15m"], { closed: [b15(T0300 - M15, 10, 12, 9, 11, 1), b15(T0300, 11, 12, 10, 10.5, 0.1)], forming: b15(T0315, 10.5, 10.8, 10.2, 10.6, 0.2) });
  loop.applyFeedBar("A", push(T0315, 10.5, 10.8, 10.2, 10.6, 0.2, 2), "15m", T0315 + 59000);
  loop.setCandles("A", byId["30m"], { closed: [bar(T0300 - M30, M30, 9, 12, 8, 11, 2)], forming: bar(T0300, M30, 11, 12, 10, 10.6, 0.3) });
  loop.state.loaded = true;
  const s30 = loop.state.coins.A.tf["30m"];
  assert.strictEqual(s30.agg.v, 0.1, "the feed's closed child");
  rest["A:30m"] = [api(bar(T0300 - M30, M30, 9, 12, 8, 11, 2)), api(bar(T0300, M30, 11, 12, 10, 10.6, 0.3)), api(bar(T0330, M30, 10.6, 10.6, 10.6, 10.6, 0))];
  Date.now = function () { return T0330 + 6000; };
  loop.barRollTick(T0330 + 5000);
  assert.strictEqual(s30.closed[s30.closed.length - 1].v, 0.1 + 0.2, "the fold's sum is 0.30000000000000004");
  assert.notStrictEqual(0.1 + 0.2, 0.3);
  await settle();
  const r = loop.state.feed.rollupReconcile;
  assert.deepStrictEqual({ barsCompared: r.barsCompared, mismatches: r.mismatches }, { barsCompared: 1, mismatches: 0 });
  loop.stop();
});

test("F6: a synthetic first child never sets the open or the range - the first TRADED child does; a period whose children are all synthetic closes as REST's synthetic bar", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  // A thin market with no trade since 02:30. 02:50Z: the 15m slot (REST: no forming bar -> synthesized 02:45).
  Date.now = function () { return T0300 - 10 * 60000; };
  loop.setCandles("A", byId["15m"], { closed: [
    b15(T0300 - 3 * M15, 10, 12, 9, 11, 100), b15(T0300 - 2 * M15, 11, 12, 10, 10.5, 100)
  ], forming: null });
  loop.state.loaded = true;
  loop.barRollTick(T0300 + 5000);                     // the local roll: 02:45 closes synthetic, 03:00 opens synthetic (feedAt set)
  // 03:00:30Z: the 30m reconcile lands - REST has no forming bar for 03:00 either.
  Date.now = function () { return T0300 + 30000; };
  loop.setCandles("A", byId["30m"], { closed: [
    bar(T0300 - 2 * M30, M30, 8, 9, 7.5, 9, 150), bar(T0300 - M30, M30, 9, 12, 8, 10.5, 200)
  ], forming: null });
  const c = loop.state.coins.A;
  const s30 = c.tf["30m"];
  assert.deepStrictEqual(s30.forming, bar(T0300, M30, 10.5, 10.5, 10.5, 10.5, 0), "REST synthesized the forming bar");
  assert.deepStrictEqual(s30.agg, { t: T0300, o: 10.5, h: 10.5, l: 10.5, c: 10.5, v: 0, traded: false, lastT: T0300 - M15, approx: false, skipV: null, cFrom: 0 },
    "live seed: the feed rolled the 15m slot into 03:00");
  // 03:15:05 - still no trade: the 03:00 child closes synthetic, the 30m stays synthetic.
  loop.barRollTick(T0315 + 5000);
  assert.deepStrictEqual(c.tf["15m"].closed[3], b15(T0300, 10.5, 10.5, 10.5, 10.5, 0));
  assert.deepStrictEqual(s30.forming, bar(T0300, M30, 10.5, 10.5, 10.5, 10.5, 0));
  assert.strictEqual(s30.agg.lastT, T0300);
  // The first trade of the 30m period prints in its SECOND child: the open is
  // 10.9, not the carried 10.5. The carried close stays inside the FORMING
  // range (the union rule the 15m slot applies to its own synthetic open);
  // the CLOSED bar is the raw fold and excludes it (F6).
  loop.applyFeedBar("A", push(T0315, 10.9, 11.2, 10.8, 11.0, 7, 3), "15m", T0315 + 20000);
  assert.deepStrictEqual(c.tf["15m"].forming, b15(T0315, 10.9, 11.2, 10.5, 11.0, 7), "stage-1 rule on the child itself");
  assert.deepStrictEqual(s30.forming, bar(T0300, M30, 10.9, 11.2, 10.5, 11.0, 7));
  loop.barRollTick(T0330 + 5000);
  assert.deepStrictEqual(c.tf["15m"].closed[4], b15(T0315, 10.9, 11.2, 10.8, 11.0, 7), "the child closed RAW");
  assert.deepStrictEqual(s30.closed[2], bar(T0300, M30, 10.9, 11.2, 10.8, 11.0, 7), "the synthetic child set neither open nor range; the carried close is not in the closed bar");
  assert.deepStrictEqual(s30.forming, bar(T0330, M30, 11.0, 11.0, 11.0, 11.0, 0));
  // 03:30-03:59 with no trade at all: closes as the synthetic bar REST serves for a trade-less period.
  loop.barRollTick(T0345 + 5000);
  loop.barRollTick(T0400 + 5000);
  assert.deepStrictEqual(s30.closed[3], bar(T0330, M30, 11.0, 11.0, 11.0, 11.0, 0));
  assert.deepStrictEqual(s30.forming, bar(T0400, M30, 11.0, 11.0, 11.0, 11.0, 0));
  assert.strictEqual(loop.state.feed.rollups["30m"], 2);
  loop.stop();
});

test("the 00:00 UTC roll closes 30m, 1h, 4h and 1d together from one local 15m roll, and the derived W/M rebuild on the new daily", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  const D = Date.UTC(2026, 8, 22, 0, 0, 0);            // Tuesday 2026-09-22 00:00Z
  const L = D - M15;                                   // 23:45 child
  Date.now = function () { return L + 60000; };
  loop.setCandles("A", byId["15m"], { closed: [b15(L - 2 * M15, 9, 11, 8, 10, 10), b15(L - M15, 10, 12, 9, 11, 10)], forming: b15(L, 11, 11.5, 10.5, 11.2, 4) });
  loop.applyFeedBar("A", push(L, 11, 11.5, 10.5, 11.2, 4, 2), "15m", L + 59000);   // the feed is live on the child
  loop.setCandles("A", byId["30m"], { closed: [bar(D - 2 * M30, M30, 9, 11, 8, 10, 20)], forming: bar(D - M30, M30, 10, 12, 9, 11.2, 14) });
  loop.setCandles("A", byId["1h"], { closed: [bar(D - 2 * H1, H1, 9, 11, 8, 10, 40)], forming: bar(D - H1, H1, 10, 12, 9, 11.2, 30) });
  loop.setCandles("A", byId["4h"], { closed: [bar(D - 2 * H4, H4, 9, 11, 8, 10, 100)], forming: bar(D - H4, H4, 10, 12, 9, 11.2, 80) });
  loop.setCandles("A", byId["1d"], { closed: [bar(D - 3 * D1, D1, 7, 9, 6, 8, 500), bar(D - 2 * D1, D1, 8, 10, 7, 9, 600)], forming: bar(D - D1, D1, 9, 12, 8, 11.2, 700) });
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  const rev = loop.state.revision;
  loop.barRollTick(D + 5000);
  ["30m", "1h", "4h", "1d"].forEach(function (id) {
    const s = c.tf[id];
    assert.strictEqual(s.forming.t, D, id + " forming is the new period");
    assert.strictEqual(s.closed[s.closed.length - 1].T, D - 1, id + " closed the old period");
    assert.strictEqual(s.closed[s.closed.length - 1].c, 11.2, id + " close = the last traded child's close");
    assert.strictEqual(s.restT, D - byId[id].ms, id + " unconfirmed until REST lands");
    assert.strictEqual(loop.state.feed.rollups[id], 1);
  });
  assert.deepStrictEqual(c.tf["1d"].closed[c.tf["1d"].closed.length - 1], bar(D - D1, D1, 9, 12, 8, 11.2, 700),
    "the 15m buffer does not reach 00:00: REST's seed (v 700 incl. the live child's 4) minus 4, plus the child's 4 at its close");
  assert.deepStrictEqual(c.tf["1d"].unverified, [D - D1], "an approximate seed closes an UNVERIFIED bar");
  assert.deepStrictEqual(c.tf["30m"].unverified, [], "the 30m seed came from the feed's children");
  assert.strictEqual(c.tf["30m"].closed[c.tf["30m"].closed.length - 1].v, 14, "10 (closed 23:30 child) + 4 (23:45 child at its close)");
  assert.ok(c.tf["1w"] && c.tf["1M"], "derived slots rebuilt");
  assert.strictEqual(c.tf["1w"].closed.length + (c.tf["1w"].forming ? 1 : 0) > 0, true);
  const wk = c.tf["1w"];
  const wkAll = wk.closed.concat(wk.forming ? [wk.forming] : []);
  assert.ok(wkAll.some(function (b) { return b.t <= D - D1 && b.T >= D - D1; }), "the new daily is inside a weekly bar");
  assert.ok(loop.state.revision >= rev + 5, "the 15m roll and four higher rolls each bump the revision");
  loop.stop();
});

test("REST behind the local view (a thin market whose periods the exchange has not materialized): REST's history wins where it exists, the local tail and the local forming stay, the period stays unconfirmed so the sweep retries as today", async function () {
  const seen = [], rest = {};
  restFetch(seen, rest);
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  // A thin market whose last trade was before 02:30. Boot at 02:50Z: REST has
  // no bar past 02:00 on the 30m (forming synthesized on 02:30) and none
  // past 02:15 on the 15m (forming synthesized on 02:30).
  Date.now = function () { return T0300 - 10 * 60000; };
  loop.setCandles("A", byId["15m"], { closed: [b15(T0300 - 3 * M15, 11, 12, 10, 10.5, 100)], forming: null });
  loop.setCandles("A", byId["30m"], { closed: [bar(T0300 - 3 * M30, M30, 8, 9, 7.5, 9, 150), bar(T0300 - 2 * M30, M30, 9, 12, 8, 10.5, 200)], forming: null });
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  const seen30 = function () { return seen.filter(function (x) { return /:30m$/.test(x); }); };
  // 03:00:05 - the local roll closes 02:30 and 02:45 synthetic on the 15m; the 30m closes 02:30 locally and
  // opens 03:00; the reconcile sweep dispatches. REST STILL has nothing past 02:00: its synthesized forming
  // lands on 02:30, one period behind the local view.
  rest["A:30m"] = [api(bar(T0300 - 3 * M30, M30, 8, 9, 7.5, 9, 150)), api(bar(T0300 - 2 * M30, M30, 9, 12, 8, 10.5, 200))];
  Date.now = function () { return T0300 + 6000; };
  loop.barRollTick(T0300 + 5000);
  assert.strictEqual(c.tf["30m"].forming.t, T0300);
  assert.strictEqual(c.tf["30m"].closed[2].t, T0300 - M30);
  await settle();
  assert.deepStrictEqual(seen30(), ["A:30m"]);
  const s30 = c.tf["30m"];
  assert.strictEqual(s30.forming.t, T0300, "the local forming stays");
  assert.deepStrictEqual(s30.closed.map(function (b) { return b.t; }), [T0300 - 3 * M30, T0300 - 2 * M30, T0300 - M30], "REST history + the local 02:30 bar");
  assert.deepStrictEqual(s30.closed[2], bar(T0300 - M30, M30, 10.5, 10.5, 10.5, 10.5, 0));
  assert.strictEqual(s30.restT, T0300 - M30, "REST confirmed 02:30 only");
  assert.strictEqual(s30.localFrom, T0300 - M30);
  assert.deepStrictEqual(s30.unverified, [T0300 - M30], "the boot seed was approximate: carried with the tail");
  assert.ok(s30.agg && s30.agg.t === T0300, "the accumulator is kept");
  seen.length = 0;
  loop.barRollTick(T0300 + 45000);                     // > 30 s after the fetch: retried, as a thin market is today
  await settle();
  assert.deepStrictEqual(seen30(), ["A:30m"]);
  loop.stop();
});

test("boot-shaped seed (the 15m slot is minutes older than the higher slot, the feed not yet connected): REST's volume is kept, the child in progress is covered not folded, and the bar it closes is UNVERIFIED - skipped by the comparator while a feed-built bar is compared", async function () {
  const seen = [], rest = {};
  restFetch(seen, rest);
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  // 02:50Z: the boot load fetches the 15m slot (forming 02:45, v 50 so far).
  Date.now = function () { return T0300 - 10 * 60000; };
  loop.setCandles("A", byId["15m"], { closed: [b15(T0300 - 3 * M15, 9, 11, 8, 10, 100), b15(T0300 - 2 * M15, 10, 12, 9, 11, 100)], forming: b15(T0300 - M15, 11, 12, 10, 10.5, 50) });
  // 03:05Z: the 30m slot lands - REST's 03:00 bar already holds five minutes of the 03:00 child.
  Date.now = function () { return T0300 + 5 * 60000; };
  loop.setCandles("A", byId["30m"], { closed: [bar(T0300 - M30, M30, 9, 12, 8, 10.5, 200)], forming: bar(T0300, M30, 10.6, 10.9, 10.4, 10.8, 40) });
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  const s30 = c.tf["30m"];
  assert.deepStrictEqual(s30.agg, { t: T0300, o: 10.6, h: 10.9, l: 10.4, c: 10.8, v: 40, traded: true, lastT: T0300 - M15, approx: true, skipV: T0300, cFrom: 0 },
    "the 15m slot is not on the live child: REST's v, the child's price still folds at its close but its volume is covered");
  // The feed connects: its first push rolls the stale 15m slot into 03:00 (v 45 so far in the child).
  loop.applyFeedBar("A", push(T0300, 10.6, 10.9, 10.4, 10.85, 45, 20), "15m", T0300 + 5 * 60000 + 10000);
  assert.strictEqual(s30.forming.v, 40, "the live child is covered by the seed: not added again");
  assert.strictEqual(s30.forming.c, 10.85);
  loop.barRollTick(T0315 + 5000);                     // the 03:00 child closes (v 45): its price folds, its volume is covered
  assert.strictEqual(s30.agg.v, 40);
  assert.strictEqual(s30.agg.c, 10.85);
  assert.strictEqual(s30.agg.lastT, T0300);
  rest["A:30m"] = [api(bar(T0300 - M30, M30, 9, 12, 8, 10.5, 200)), api(bar(T0300, M30, 10.6, 10.9, 10.4, 10.85, 45)), api(bar(T0330, M30, 10.85, 10.85, 10.85, 10.85, 0))];
  Date.now = function () { return T0330 + 6000; };
  loop.barRollTick(T0330 + 5000);                     // 03:00 closes locally on the approximate seed; the reconcile sweep dispatches
  assert.deepStrictEqual(s30.closed[s30.closed.length - 1], bar(T0300, M30, 10.6, 10.9, 10.4, 10.85, 40), "price exact; v = REST's as of 03:05 - the child's volume tail is lost until REST");
  assert.deepStrictEqual(s30.unverified, [T0300]);
  await settle();
  const r = loop.state.feed.rollupReconcile;
  assert.deepStrictEqual({ barsCompared: r.barsCompared, mismatches: r.mismatches, unverified: r.unverified }, { barsCompared: 0, mismatches: 0, unverified: 1 },
    "the approximate bar is not a parity sample");
  assert.strictEqual(c.tf["30m"].closed[c.tf["30m"].closed.length - 1].v, 45, "REST won anyway");
  assert.deepStrictEqual(c.tf["30m"].unverified, [], "REST replaced it");
  assert.strictEqual(c.tf["30m"].agg.approx, false, "the reseed is feed-owned now: the 15m slot is live on 03:30 and the buffer covers the period");
  // The next period is feed-built and IS compared.
  loop.barRollTick(T0345 + 5000);
  rest["A:30m"] = [api(bar(T0300, M30, 10.6, 10.9, 10.4, 10.85, 45)), api(bar(T0330, M30, 10.85, 10.85, 10.85, 10.85, 0)), api(bar(T0400, M30, 10.85, 10.85, 10.85, 10.85, 0))];
  Date.now = function () { return T0400 + 6000; };
  loop.barRollTick(T0400 + 5000);
  await settle();
  assert.deepStrictEqual({ barsCompared: r.barsCompared, mismatches: r.mismatches, unverified: r.unverified }, { barsCompared: 1, mismatches: 0, unverified: 1 });
  loop.stop();
});

test("a 15m REST pass that REPAIRS a closed bar drops the confirmation of the coin's higher slots (REST confirms them again); a pass that changes nothing leaves them alone", async function () {
  const seen = [], rest = {};
  restFetch(seen, rest);
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  loop.applyFeedBar("A", push(T0315, 10.5, 10.9, 10.3, 10.7, 42, 9), "15m", T0315 + 70000);
  loop.applyFeedBar("A", push(T0330, 10.8, 10.8, 10.8, 10.8, 1, 1), "15m", T0330 + 500);   // 03:15 closes from the feed; the 30m rolls
  assert.strictEqual(c.tf["1h"].restT, T0300);
  assert.strictEqual(c.tf["4h"].restT, T0000);
  // Control: an hourly pass whose REST bars equal what the slot holds.
  const same = [api(b15(T0300 - 2 * M15, 9, 11, 8, 10, 100)), api(b15(T0300 - M15, 10, 12, 9, 11, 100)), api(b15(T0300, 11, 12, 10, 10.5, 100)),
                api(b15(T0315, 10.5, 10.9, 10.3, 10.7, 42)), api(b15(T0330, 10.8, 10.8, 10.8, 10.8, 1))];
  rest["A:15m"] = same;
  Date.now = function () { return T0330 + 20000; };
  const p1 = await loop.reconcileFeed("hourly");
  assert.strictEqual(p1.mismatches, 0);
  assert.strictEqual(c.tf["1h"].restT, T0300, "nothing repaired: still confirmed");
  assert.strictEqual(c.tf["4h"].restT, T0000);
  assert.strictEqual(c.tf["1d"].restT, T0000);
  assert.strictEqual(loop.state.feed.rollupReconcile.reconfirms, 0);
  // A pass that repairs the feed-closed 03:30 bar (REST attributes a last trade the stream coalesced away: the F8 class).
  loop.applyFeedBar("A", push(T0345, 10.9, 10.9, 10.9, 10.9, 1, 1), "15m", T0345 + 500);
  rest["A:15m"] = [api(b15(T0300, 11, 12, 10, 10.5, 100)), api(b15(T0315, 10.5, 10.9, 10.3, 10.7, 42)), api(b15(T0330, 10.8, 10.8, 10.8, 10.8, 1.5)), api(b15(T0345, 10.9, 10.9, 10.9, 10.9, 1))];
  Date.now = function () { return T0345 + 20000; };
  const p2 = await loop.reconcileFeed("hourly");
  assert.strictEqual(p2.mismatches, 1, "the stage-1 comparator saw it");
  assert.strictEqual(p2.mismatchesVolume, 1);
  assert.strictEqual(c.tf["1h"].restT, null, "the 1h must be confirmed again");
  assert.strictEqual(c.tf["4h"].restT, null);
  assert.strictEqual(c.tf["1d"].restT, null);
  assert.strictEqual(loop.state.feed.rollupReconcile.reconfirms, 1);
  // The next tick sweeps them (the 30m too: it rolled locally at 03:30 and REST never landed).
  seen.length = 0;
  loop.barRollTick(T0345 + 40000);
  await settle();
  assert.deepStrictEqual(seen.filter(function (x) { return !/:15m$/.test(x); }), ["A:30m", "A:1h", "A:4h", "A:1d"]);
  loop.stop();
});

// ---- code review 2026-10-25: eight sequences, each reproduced here before the fix ----

test("review F1 (HIGH): a 15m slot REST restored to an OLDER period, then a late push for that period, must not contaminate the newer higher forming bar", function () {
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  const c = loop.state.coins.A;
  loop.applyFeedBar("A", push(T0315, 10.5, 11.5, 10.2, 11.2, 40, 10), "15m", T0315 + 70000);
  loop.applyFeedBar("A", push(T0330, 13.0, 13.2, 13.0, 13.1, 2, 1), "15m", T0330 + 500);    // the 30m rolls; new period's low 13.0
  assert.strictEqual(c.tf["30m"].forming.t, T0330);
  assert.strictEqual(c.tf["30m"].forming.l, 13.0);
  // A 15m REST response dispatched before the boundary lands now and restores the slot to 03:15.
  Date.now = function () { return T0330 + 2000; };
  loop.setCandles("A", byId["15m"], { closed: [b15(T0300 - 2 * M15, 9, 11, 8, 10, 100), b15(T0300 - M15, 10, 12, 9, 11, 100), b15(T0300, 11, 12, 10, 10.5, 100)],
    forming: b15(T0315, 10.5, 11.5, 10.2, 11.2, 40), at: T0330 - 1000 });
  assert.strictEqual(c.tf["15m"].forming.t, T0315, "the 15m slot is behind the higher slot for a moment");
  assert.strictEqual(c.tf["30m"].forming.t, T0330, "the higher slot is left alone");
  assert.strictEqual(c.tf["30m"].forming.l, 13.0);
  // The coalesced final 03:15 frame arrives late and is accepted by the 15m slot.
  loop.applyFeedBar("A", push(T0315, 10.5, 11.5, 10.2, 11.2, 41, 11), "15m", T0330 + 2500);
  assert.strictEqual(c.tf["30m"].forming.t, T0330);
  assert.strictEqual(c.tf["30m"].forming.l, 13.0, "the 03:15 child's low 10.2 must not enter the 03:30 bar");
  // The next 03:30 push re-rolls the 15m slot; the higher bar is still clean.
  loop.applyFeedBar("A", push(T0330, 13.0, 13.3, 13.0, 13.2, 3, 2), "15m", T0330 + 3000);
  assert.strictEqual(c.tf["30m"].forming.l, 13.0);
  assert.strictEqual(c.tf["30m"].forming.h, 13.3);
});

test("review F2 (MED): a higher REST response dispatched BEFORE a 15m repair cannot clear the confirmation that repair demanded", async function () {
  const seen = [], rest = {};
  restFetch(seen, rest);
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  loop.applyFeedBar("A", push(T0315, 10.5, 10.9, 10.3, 10.7, 42, 9), "15m", T0315 + 70000);
  loop.applyFeedBar("A", push(T0330, 10.8, 10.8, 10.8, 10.8, 1, 1), "15m", T0330 + 500);
  // A 15m pass repairs the 03:15 bar at T_rep: every higher slot drops its confirmation.
  rest["A:15m"] = [api(b15(T0300, 11, 12, 10, 10.5, 100)), api(b15(T0315, 10.5, 10.95, 10.3, 10.7, 42)), api(b15(T0330, 10.8, 10.8, 10.8, 10.8, 1))];
  const T_rep = T0330 + 20000;
  Date.now = function () { return T_rep; };
  await loop.reconcileFeed("hourly");
  assert.strictEqual(c.tf["1h"].restT, null);
  // A 1h response dispatched BEFORE the repair (at T_rep - 5 s) lands after it: it must not confirm.
  Date.now = function () { return T_rep + 1000; };
  loop.setCandles("A", byId["1h"], { closed: [bar(T0300 - H1, H1, 9, 12, 7.5, 11, 350)], forming: bar(T0300, H1, 11, 12, 10, 10.8, 143), at: T_rep - 5000 });
  assert.strictEqual(c.tf["1h"].restT, null, "stale response: the repair's confirmation is still owed");
  // A response dispatched AFTER the repair confirms.
  loop.setCandles("A", byId["1h"], { closed: [bar(T0300 - H1, H1, 9, 12, 7.5, 11, 350)], forming: bar(T0300, H1, 11, 12, 10, 10.8, 143), at: T_rep + 500 });
  assert.strictEqual(c.tf["1h"].restT, T0300, "fresh response: confirmed");
  loop.stop();
});

test("review F3 (MED): a higher snapshot taken before the period's first trade but installed after a 15m boundary must still fold the traded child (price, traded, volume consistent)", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  Date.now = function () { return T0300 - 10 * 60000; };
  loop.setCandles("A", byId["15m"], { closed: [b15(T0300 - 3 * M15, 10, 12, 9, 11, 100), b15(T0300 - 2 * M15, 11, 12, 10, 10.5, 100)], forming: null });
  loop.state.loaded = true;
  loop.barRollTick(T0300 + 5000);                     // 15m live on 03:00 (synthetic)
  loop.applyFeedBar("A", push(T0300, 20, 22, 19, 21, 10, 4), "15m", T0300 + 30000);   // the first trade of the hour
  loop.barRollTick(T0315 + 5000);                     // the 03:00 child closes traded; 03:15 opens synthetic
  const c = loop.state.coins.A;
  // The 30m snapshot was taken at 03:00:02 (no trade yet: REST had no bar for 03:00) and lands only now.
  Date.now = function () { return T0315 + 10000; };
  loop.setCandles("A", byId["30m"], { closed: [bar(T0300 - 2 * M30, M30, 8, 9, 7.5, 9, 150), bar(T0300 - M30, M30, 9, 12, 8, 10.5, 200)], forming: null, at: T0300 + 2000 });
  const s30 = c.tf["30m"];
  assert.deepStrictEqual({ o: s30.forming.o, h: s30.forming.h, c: s30.forming.c, v: s30.forming.v }, { o: 20, h: 22, c: 21, v: 10 },
    "the traded child closed after the snapshot folds into the forming bar");
  assert.strictEqual(s30.forming.l, 10.5, "the forming range keeps the carried close REST synthesized before the first trade - the stage-1 rule, as under REST; the CLOSED bar below does not");
  assert.deepStrictEqual({ o: s30.agg.o, h: s30.agg.h, l: s30.agg.l, c: s30.agg.c, v: s30.agg.v, traded: s30.agg.traded }, { o: 20, h: 22, l: 19, c: 21, v: 10, traded: true });
  loop.barRollTick(T0330 + 5000);
  assert.deepStrictEqual(s30.closed[s30.closed.length - 1], bar(T0300, M30, 20, 22, 19, 21, 10), "the 30m closes on the traded child, not flat on the carried close");
  loop.stop();
});

test("review F4 (MED): a child the feed synthesized across a gap is not trustworthy volume coverage - REST's volume wins and the seed is approximate", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  Date.now = function () { return T0300 - 10 * 60000; };
  loop.setCandles("A", byId["15m"], { closed: [b15(T0300 - 3 * M15, 10, 12, 9, 11, 100), b15(T0300 - 2 * M15, 11, 12, 10, 10.5, 100)], forming: null });
  loop.state.loaded = true;
  loop.barRollTick(T0300 + 5000);
  // Socket gap across 03:00: the next push is the 03:15 child. closeFeedPeriods synthesizes 03:00 with v 0.
  loop.applyFeedBar("A", push(T0315, 12, 12.5, 11.8, 12.2, 5, 3), "15m", T0315 + 30000);
  const c = loop.state.coins.A;
  assert.strictEqual(c.tf["15m"].closed[c.tf["15m"].closed.length - 1].v, 0, "the gap child is synthetic");
  // The 30m reconcile lands: REST saw 200 traded in the 03:00 child plus the 5 so far in 03:15.
  Date.now = function () { return T0315 + 31000; };
  loop.setCandles("A", byId["30m"], { closed: [bar(T0300 - 2 * M30, M30, 8, 9, 7.5, 9, 150), bar(T0300 - M30, M30, 9, 12, 8, 10.5, 200)],
    forming: bar(T0300, M30, 11, 13, 10, 12.2, 205), at: T0315 + 30500 });
  const s30 = c.tf["30m"];
  assert.strictEqual(s30.agg.approx, true, "the buffer does not account for what REST says closed: approximate");
  assert.strictEqual(s30.agg.v, 200);
  loop.barRollTick(T0330 + 5000);
  assert.strictEqual(s30.closed[s30.closed.length - 1].v, 205, "200 (REST, the gap child) + 5 (the live child at its close)");
  assert.deepStrictEqual(s30.unverified, [T0300]);
  loop.stop();
});

test("review F5 (MED): a higher response captured before a 15m boundary and installed just after it must not exclude the NEW child's volume (coverage follows the snapshot's child, not the install time)", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  loop.applyFeedBar("A", push(T0315, 10.5, 10.9, 10.3, 10.7, 40, 9), "15m", T0315 + 70000);
  // The 1h response was captured at 03:29:58 (children 03:00 = 100 and 03:15 = 40 so far) and lands at 03:30:01, before the 15m slot rolled.
  Date.now = function () { return T0330 + 1000; };
  loop.setCandles("A", byId["1h"], { closed: [bar(T0300 - H1, H1, 9, 12, 7.5, 11, 350)], forming: bar(T0300, H1, 11, 12, 10, 10.7, 140), at: T0330 - 2000 });
  const s1h = c.tf["1h"];
  assert.strictEqual(s1h.agg.approx, false, "the snapshot's child (03:15) is the live one: a live seed");
  assert.strictEqual(s1h.agg.v, 100, "the closed 03:00 child; 03:15 folds at its close");
  loop.applyFeedBar("A", push(T0330, 10.7, 10.8, 10.7, 10.75, 20, 6), "15m", T0330 + 1500);   // 03:15 closes (40), 03:30 opens with 20 so far
  assert.strictEqual(s1h.forming.v, 160, "100 + 40 + 20");
  loop.barRollTick(T0345 + 5000);
  loop.barRollTick(T0400 + 5000);
  assert.strictEqual(s1h.closed[s1h.closed.length - 1].v, 160, "the hour closes at 160, not 140");
  loop.stop();
});

test("review F6 (MED): when a REST 15m pass ADVANCES a covered coin's 15m slot into the new period just before the tick, the higher slots roll at once instead of waiting for their REST sweep", async function () {
  const seen = [];
  hangFetch(seen);
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  // The hourly pass installs the 15m slot with REST's forming already on 03:30, at 03:30:02.
  Date.now = function () { return T0330 + 2000; };
  loop.setCandles("A", byId["15m"], { closed: [b15(T0300 - 2 * M15, 9, 11, 8, 10, 100), b15(T0300 - M15, 10, 12, 9, 11, 100), b15(T0300, 11, 12, 10, 10.5, 100), b15(T0315, 10.5, 10.8, 10.2, 10.6, 5)],
    forming: b15(T0330, 10.6, 10.7, 10.6, 10.65, 2), at: T0330 + 1500 });
  assert.strictEqual(c.tf["30m"].forming.t, T0330, "rolled locally from the advanced 15m slot");
  assert.deepStrictEqual(c.tf["30m"].closed[c.tf["30m"].closed.length - 1], bar(T0300, M30, 11, 12, 10, 10.6, 105));
  assert.strictEqual(c.tf["30m"].restT, T0300, "unconfirmed: the reconcile sweep follows");
  loop.barRollTick(T0330 + 5000);
  await settle();
  assert.deepStrictEqual(seen, ["A:30m"]);
  loop.stop();
});

test("review F7 (MED): the REST-behind merge keeps the 1h reference tape whole and enforces every depth limit", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  // 40 locally rolled hours (160 quarter hours, no trades): the 1h analysis buffer holds 30, the reference tape 2 + 40.
  for (let k = 1; k <= 160; k++) loop.barRollTick(T0330 + (k - 1) * M15 + 5000);
  const s1h = c.tf["1h"];
  assert.strictEqual(s1h.closed.length, 30);
  assert.strictEqual(s1h.referenceClosed.length, 42);
  const firstLocal = s1h.referenceClosed[2].t;
  // REST, far behind: 128 hours ending just before the first locally rolled hour, nothing newer.
  const restClosed = [];
  for (let i = 128; i >= 1; i--) restClosed.push(bar(firstLocal - i * H1, H1, 9, 12, 8, 11, 7));
  Date.now = function () { return T0330 + 160 * M15 + 9000; };
  loop.setCandles("A", byId["1h"], { closed: restClosed, forming: null, at: T0330 + 160 * M15 + 8000 });
  const after = c.tf["1h"];
  assert.strictEqual(after.referenceClosed.length, 168, "128 REST + 40 local, trimmed to the reference depth");
  for (let i = 1; i < after.referenceClosed.length; i++) assert.strictEqual(after.referenceClosed[i].t - after.referenceClosed[i - 1].t, H1, "no hole in the reference tape");
  assert.strictEqual(after.closed.length, 30, "analysis depth held");
  assert.strictEqual(after.closed[29].t, after.referenceClosed[167].t, "both tapes end on the same hour");
  // 30m depth after a REST-behind merge that adds a local tail.
  const s30 = c.tf["30m"];
  assert.strictEqual(s30.closed.length, 12);
  const rest30 = [];
  for (let i = 12; i >= 1; i--) rest30.push(bar(s30.closed[11].t - i * M30, M30, 9, 12, 8, 11, 7));
  loop.setCandles("A", byId["30m"], { closed: rest30, forming: null, at: T0330 + 160 * M15 + 8000 });
  assert.strictEqual(c.tf["30m"].closed.length, 12, "depth enforced after the concatenation");
  loop.stop();
});

test("review F8 (MED): a push after a long gap must fold the last known child into the higher bars BEFORE the 15m buffer trims it away", function () {
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  const c = loop.state.coins.A;
  loop.applyFeedBar("A", push(T0315, 10.5, 20, 10.2, 11, 40, 9), "15m", T0315 + 70000);   // the 03:15 child: high 20, v 40
  // The next push is 42 quarter hours later: 03:15 closes, 41 synthetic periods follow, the buffer trims to 40.
  const late = T0315 + 42 * M15;
  loop.applyFeedBar("A", push(late, 11, 11, 11, 11, 1, 1), "15m", late + 500);
  assert.strictEqual(c.tf["15m"].closed.length, 40);
  assert.ok(c.tf["15m"].closed[0].t > T0315, "the 03:15 child was trimmed from the buffer");
  const h1 = c.tf["1h"].closed.find(function (b) { return b.t === T0300; });
  assert.ok(h1, "the 03:00 hour closed");
  assert.strictEqual(h1.h, 20, "the trimmed child's high reached the hour");
  assert.strictEqual(h1.v, 140, "100 (seed) + 40 (the trimmed child)");
});

// ---- second review 2026-10-26: its two MED items and the named test gaps ----

function seedLiveOn0300(loop) {
  // 15m live on the 03:00 child (v 100 so far), 02:30 and 02:45 closed; no higher slot yet.
  Date.now = function () { return T0300 + 14 * 60000 + 30000; };
  loop.setCandles("A", byId["15m"], { closed: [b15(T0300 - 2 * M15, 10, 12, 9, 11, 100), b15(T0300 - M15, 11, 12, 10, 10.5, 100)], forming: b15(T0300, 10.5, 10.9, 10.3, 10.6, 100) });
  loop.applyFeedBar("A", push(T0300, 10.5, 10.9, 10.3, 10.6, 100, 30), "15m", T0300 + 14 * 60000 + 29000);
}

test("review 2 item 1a: a higher response requested BEFORE a 15m boundary that lands after it, while the 15m slot has not rolled, keeps exact volume (the request-time child is the live one)", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedLiveOn0300(loop);
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  Date.now = function () { return T0315 + 1000; };    // lands at 03:15:01; the tick (03:15:05) has not rolled the 15m slot
  loop.setCandles("A", byId["30m"], { closed: [bar(T0300 - M30, M30, 9, 12, 8, 10.5, 200)], forming: bar(T0300, M30, 10.5, 10.9, 10.3, 10.6, 100), at: T0315 - 1000 });
  const s30 = c.tf["30m"];
  assert.deepStrictEqual({ approx: s30.agg.approx, v: s30.agg.v, lastT: s30.agg.lastT, skipV: s30.agg.skipV }, { approx: false, v: 0, lastT: T0300 - M15, skipV: null });
  assert.strictEqual(s30.forming.v, 100, "the live child supplies the period's volume so far");
  loop.barRollTick(T0315 + 5000);                     // 03:00 closes (v 100) and folds
  loop.applyFeedBar("A", push(T0315, 10.6, 10.8, 10.5, 10.7, 40, 9), "15m", T0315 + 20000);
  assert.strictEqual(s30.forming.v, 140);
  loop.barRollTick(T0330 + 5000);
  assert.strictEqual(s30.closed[s30.closed.length - 1].v, 140, "nothing lost (the old install-time rule dropped the 03:15 child: 100)");
  assert.deepStrictEqual(s30.unverified, []);
  loop.stop();
});

test("review 2 item 1b: a higher response requested just AFTER a 15m boundary, landing before the 15m slot rolled, is still a live seed (the slot may lag the clock by one child) and loses no volume", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedLiveOn0300(loop);
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  Date.now = function () { return T0315 + 2000; };
  // REST's snapshot at 03:15:01 already holds the complete 03:00 child (100) and the first trade of 03:15 (1).
  loop.setCandles("A", byId["30m"], { closed: [bar(T0300 - M30, M30, 9, 12, 8, 10.5, 200)], forming: bar(T0300, M30, 10.5, 10.9, 10.3, 10.65, 101), at: T0315 + 1000 });
  const s30 = c.tf["30m"];
  assert.deepStrictEqual({ approx: s30.agg.approx, v: s30.agg.v, lastT: s30.agg.lastT, skipV: s30.agg.skipV }, { approx: false, v: 0, lastT: T0300 - M15, skipV: null },
    "live on the 03:00 child one tick behind the clock: the fold resumes after 02:45");
  loop.barRollTick(T0315 + 5000);
  loop.applyFeedBar("A", push(T0315, 10.6, 10.8, 10.5, 10.7, 40, 9), "15m", T0315 + 20000);
  loop.barRollTick(T0330 + 5000);
  assert.strictEqual(s30.closed[s30.closed.length - 1].v, 140, "100 + 40; the old rule covered the 03:15 child's volume entirely and closed at ~101");
  assert.deepStrictEqual(s30.unverified, []);
  loop.stop();
});

test("review 2 item 2: a repaired child marks only the timeframes whose held local bars or current period it fed; the pass logs how many coins it marked", async function () {
  const seen = [], rest = {};
  restFetch(seen, rest);
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  loop.applyFeedBar("A", push(T0315, 10.5, 10.9, 10.3, 10.7, 42, 9), "15m", T0315 + 70000);
  loop.applyFeedBar("A", push(T0330, 10.8, 10.8, 10.8, 10.8, 1, 1), "15m", T0330 + 500);   // 30m: local bar 03:00 (localFrom); 1h: agg on 03:00; 4h/1d: agg on 00:00
  // Pass 1 changes only the 02:30 bar: its 30m period (02:30) and 1h period (02:00) are REST's already -> not marked; the 4h/1d periods (00:00) hold it -> marked.
  rest["A:15m"] = [api(b15(T0300 - 2 * M15, 9, 11, 8, 10, 101)), api(b15(T0300 - M15, 10, 12, 9, 11, 100)), api(b15(T0300, 11, 12, 10, 10.5, 100)),
                   api(b15(T0315, 10.5, 10.9, 10.3, 10.7, 42)), api(b15(T0330, 10.8, 10.8, 10.8, 10.8, 1))];
  Date.now = function () { return T0330 + 20000; };
  await loop.reconcileFeed("hourly");
  assert.strictEqual(c.tf["30m"].restT, T0300, "30m untouched: the changed child predates its local bars");
  assert.strictEqual(c.tf["1h"].restT, T0300, "1h untouched: the changed child predates its current period");
  assert.strictEqual(c.tf["4h"].restT, null, "4h marked: 02:30 is inside its current period");
  assert.strictEqual(c.tf["1d"].restT, null);
  assert.ok(loop.lines.some(function (l) { return l === "feed reconcile (hourly): 1 coins marked for higher re-confirm"; }), loop.lines.join("|"));
  // Pass 2 changes the 03:15 bar (inside the 30m's local bar and the 1h's period): both marked now.
  rest["A:15m"] = [api(b15(T0300, 11, 12, 10, 10.5, 100)), api(b15(T0315, 10.5, 10.95, 10.3, 10.7, 42)), api(b15(T0330, 10.8, 10.8, 10.8, 10.8, 1))];
  Date.now = function () { return T0330 + 40000; };
  await loop.reconcileFeed("hourly");
  assert.strictEqual(c.tf["30m"].restT, null);
  assert.strictEqual(c.tf["1h"].restT, null);
  loop.stop();
});

test("review 2 item 3: children that fell out of the 15m buffer while the coin was uncovered make the seed approximate and force one REST confirmation", function () {
  hangFetch();
  const feed = stubFeed(["A"]);
  const loop = makeLoop(feed);
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  assert.strictEqual(c.tf["1d"].restT, T0000);
  // Coverage lost for 12 hours: REST keeps the 15m slot moving (no hook: uncovered); the higher slots are not re-swept (their periods run on).
  feed.set.delete("A");
  const X = T0300 + 12 * H1;
  const closed = [];
  for (let i = 40; i >= 1; i--) closed.push(b15(X - i * M15, 10, 11, 9, 10.5, 3));
  Date.now = function () { return X + 60000; };
  loop.setCandles("A", byId["15m"], { closed: closed, forming: b15(X, 10.5, 10.6, 10.4, 10.5, 1), at: X + 60000 });
  assert.strictEqual(c.tf["1d"].agg.lastT, T0300, "the daily never saw the 12 hours");
  // Coverage returns: the first push folds what the buffer still has and flags the gap.
  feed.set.add("A");
  const before = loop.state.feed.rollupReconcile.reconfirms;
  loop.applyFeedBar("A", push(X, 10.5, 10.6, 10.4, 10.55, 2, 1), "15m", X + 61000);
  assert.strictEqual(c.tf["1d"].agg.approx, true);
  assert.strictEqual(c.tf["1d"].restT, null, "REST must confirm the daily again");
  assert.ok(loop.state.feed.rollupReconcile.reconfirms > before);
  loop.stop();
});

test("review 2 item 4: a same-period REST install of the 15m slot keeps the feed's live mark, so a higher reseed landing right after is not approximate for nothing", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  const c = loop.state.coins.A;
  const feedAt = c.tf["15m"].feedAt;
  assert.ok(feedAt >= T0315);
  Date.now = function () { return T0315 + 5 * 60000; };
  loop.setCandles("A", byId["15m"], { closed: [b15(T0300 - 2 * M15, 9, 11, 8, 10, 100), b15(T0300 - M15, 10, 12, 9, 11, 100), b15(T0300, 11, 12, 10, 10.5, 100)],
    forming: b15(T0315, 10.5, 10.9, 10.2, 10.7, 42), at: T0315 + 5 * 60000 });
  assert.strictEqual(c.tf["15m"].feedAt, feedAt, "carried: the feed still maintains 03:15");
  loop.setCandles("A", byId["30m"], { closed: [bar(T0300 - M30, M30, 9, 12, 8, 11, 200)], forming: bar(T0300, M30, 11, 12, 10, 10.7, 142), at: T0315 + 5 * 60000 + 1000 });
  assert.strictEqual(c.tf["30m"].agg.approx, false);
  assert.strictEqual(c.tf["30m"].agg.v, 100);
  // Gap (c): the REST-installed forming bar and a later push do not double-fold the 03:15 child.
  loop.applyFeedBar("A", push(T0330, 10.7, 10.7, 10.7, 10.7, 2, 1), "15m", T0330 + 500);
  assert.strictEqual(c.tf["30m"].closed[c.tf["30m"].closed.length - 1].v, 142, "100 + 42 once");
  loop.stop();
});

test("gap (a): REST AHEAD of the local view by a few seconds (its forming already on the new period, the 15m slot not yet rolled) replaces history without a double close, and the forming close is REST's until the child trades", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  Date.now = function () { return T0330 + 2000; };
  loop.setCandles("A", byId["30m"], { closed: [bar(T0300 - M30, M30, 9, 12, 8, 11, 200), bar(T0300, M30, 11, 12, 10, 10.6, 105)],
    forming: bar(T0330, M30, 10.6, 10.65, 10.55, 10.62, 3), at: T0330 + 1000 });
  const s30 = c.tf["30m"];
  assert.strictEqual(s30.closed.length, 2);
  assert.strictEqual(loop.state.feed.rollups["30m"], 0, "REST closed 03:00, not the fold");
  loop.barRollTick(T0330 + 5000);                     // the 15m rolls; its 03:15 child belongs to a period REST already closed
  assert.strictEqual(s30.closed.length, 2, "no second 03:00 bar");
  assert.strictEqual(s30.forming.t, T0330);
  assert.strictEqual(s30.forming.c, 10.62, "REST's close stays until the live child trades");
  loop.applyFeedBar("A", push(T0330, 10.6, 10.7, 10.55, 10.66, 4, 2), "15m", T0330 + 9000);
  assert.strictEqual(s30.forming.c, 10.66);
  loop.stop();
});

test("gap (e): an EMPTY REST response for a higher slot keeps the local slot whole and unconfirmed instead of wiping it", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  loop.barRollTick(T0330 + 5000);
  const s30 = c.tf["30m"];
  assert.strictEqual(s30.closed.length, 3);
  Date.now = function () { return T0330 + 9000; };
  loop.setCandles("A", byId["30m"], { closed: [], forming: null, at: T0330 + 8000 });
  const after = c.tf["30m"];
  assert.strictEqual(after.closed.length, 3, "local history kept");
  assert.strictEqual(after.forming.t, T0330, "local forming kept");
  assert.strictEqual(after.restT, null, "unconfirmed: the sweep retries");
  assert.ok(after.agg && after.agg.t === T0330);
  loop.stop();
});

test("gap (g): the re-confirmation a repair demands restores an extreme the fold missed (REST's forming unions into the local one)", async function () {
  const seen = [], rest = {};
  restFetch(seen, rest);
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  loop.applyFeedBar("A", push(T0315, 10.5, 12.4, 10.3, 10.7, 42, 9), "15m", T0315 + 70000);
  loop.applyFeedBar("A", push(T0330, 10.8, 10.8, 10.8, 10.8, 1, 1), "15m", T0330 + 500);
  assert.strictEqual(c.tf["1h"].forming.h, 12.4, "the feed saw 12.4");
  // REST attributes a 12.5 print the stream coalesced away: the pass repairs 03:15 and marks the 1h.
  rest["A:15m"] = [api(b15(T0300, 11, 12, 10, 10.5, 100)), api(b15(T0315, 10.5, 12.5, 10.3, 10.7, 42)), api(b15(T0330, 10.8, 10.8, 10.8, 10.8, 1))];
  Date.now = function () { return T0330 + 20000; };
  await loop.reconcileFeed("hourly");
  assert.strictEqual(c.tf["1h"].restT, null);
  rest["A:1h"] = [api(bar(T0300 - H1, H1, 9, 12, 7.5, 11, 350)), api(bar(T0300, H1, 11, 12.5, 10, 10.8, 143))];
  Date.now = function () { return T0330 + 25000; };
  loop.barRollTick(T0330 + 25000);
  await settle();
  assert.strictEqual(c.tf["1h"].forming.h, 12.5, "REST's high restored by the union");
  assert.strictEqual(c.tf["1h"].restT, T0300, "confirmed again");
  loop.stop();
});

test("an UNCOVERED coin is untouched by the rollup: its higher slots wait for REST exactly as before", async function () {
  const seen = [];
  hangFetch(seen);
  const loop = makeLoop(stubFeed(["A"]));           // B is not covered
  registerCoin(loop, "B");
  seedStandard(loop, "B");
  loop.state.loaded = true;
  const c = loop.state.coins.B;
  loop.barRollTick(T0330 + 5000);
  assert.strictEqual(c.tf["15m"].forming.t, T0315, "no local 15m roll");
  assert.strictEqual(c.tf["30m"].forming.t, T0300, "no local 30m roll");
  assert.strictEqual(c.tf["30m"].localFrom, null);
  assert.strictEqual(loop.state.feed.rollups["30m"], 0);
  await new Promise(function (r) { setTimeout(r, 30); });
  assert.deepStrictEqual(seen.sort(), ["B:15m", "B:30m"], "REST sweeps the two stale slots, as before");
  loop.stop();
});

test("depth: locally rolled history is trimmed to each timeframe's analysis depth, and the 1h reference tape to its 168 bars", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  // 700 quarter hours of local rolls with no trades (7.3 days).
  for (let k = 1; k <= 700; k++) loop.barRollTick(T0330 + (k - 1) * M15 + 5000);
  assert.strictEqual(c.tf["15m"].closed.length, 40);
  assert.strictEqual(c.tf["30m"].closed.length, 12);
  assert.strictEqual(c.tf["1h"].closed.length, 30);
  assert.strictEqual(c.tf["1h"].referenceClosed.length, 168);
  assert.strictEqual(c.tf["4h"].closed.length, 12);
  assert.strictEqual(c.tf["1d"].closed.length, 2 + 7);
  assert.strictEqual(loop.state.feed.rollups["1d"], 7);
  const last1h = c.tf["1h"].closed[29], lastRef = c.tf["1h"].referenceClosed[167];
  assert.deepStrictEqual(last1h, lastRef, "the two 1h tapes end on the same bar");
  loop.stop();
});

test("feedHealth serves the stage-2 counters: rollups per timeframe, the rollup comparator, and the roll-lag meter (coins behind per timeframe)", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  let h = loop.feedHealth(T0315 + 60000);
  assert.deepStrictEqual(h.rollups, { "30m": 0, "1h": 0, "4h": 0, "1d": 0 });
  assert.deepStrictEqual(h.rollupReconcile, { barsCompared: 0, mismatches: 0, mismatchesOhlc: 0, mismatchesVolume: 0, unverified: 0, reconfirms: 0, lastMismatch: null });
  assert.deepStrictEqual(h.behind, { "15m": 0, "30m": 0, "1h": 0, "4h": 0, "1d": 0 });
  registerCoin(loop, "B");                            // uncovered: the REST path, counted apart
  seedStandard(loop, "B");
  h = loop.feedHealth(T0330 + 4500);
  assert.deepStrictEqual(h.behind, { "15m": 1, "30m": 1, "1h": 0, "4h": 0, "1d": 0 }, "covered coins past the grace, before the tick: the 15m and 30m periods are over");
  assert.deepStrictEqual(h.behindUncovered, { "15m": 1, "30m": 1, "1h": 0, "4h": 0, "1d": 0 });
  loop.barRollTick(T0330 + 5000);
  h = loop.feedHealth(T0330 + 5000);
  assert.deepStrictEqual(h.behind, { "15m": 0, "30m": 0, "1h": 0, "4h": 0, "1d": 0 }, "one tick later every covered slot is on the current period");
  assert.deepStrictEqual(h.behindUncovered, { "15m": 1, "30m": 1, "1h": 0, "4h": 0, "1d": 0 }, "the uncovered coin waits for REST, as before");
  assert.deepStrictEqual(h.rollups, { "30m": 1, "1h": 0, "4h": 0, "1d": 0 });
  loop.stop();
});

// ---- code reviews, 2026-10-27: each sequence reproduced here before the fix ----

test("audit M1: a pass that repairs several children re-confirms every timeframe ANY of them fed - not only the oldest child's", async function () {
  const seen = [], rest = {};
  restFetch(seen, rest);
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  loop.applyFeedBar("A", push(T0315, 10.5, 12.4, 10.3, 10.7, 42, 9), "15m", T0315 + 70000);
  loop.applyFeedBar("A", push(T0330, 10.8, 10.8, 10.8, 10.8, 1, 1), "15m", T0330 + 500);   // 30m: local bar 03:00; 1h: agg on 03:00
  assert.strictEqual(c.tf["1h"].forming.h, 12.4);
  // One pass repairs 02:30 (a period REST already owns for the 30m and 1h) AND 03:15 (inside both).
  rest["A:15m"] = [api(b15(T0300 - 2 * M15, 9, 11, 8, 10, 101)), api(b15(T0300 - M15, 10, 12, 9, 11, 100)), api(b15(T0300, 11, 12, 10, 10.5, 100)),
                   api(b15(T0315, 10.5, 12.5, 10.3, 10.7, 42)), api(b15(T0330, 10.8, 10.8, 10.8, 10.8, 1))];
  Date.now = function () { return T0330 + 20000; };
  await loop.reconcileFeed("hourly");
  assert.strictEqual(c.tf["30m"].restT, null, "the 03:15 repair fed the 30m's local 03:00 bar");
  assert.strictEqual(c.tf["1h"].restT, null, "the 03:15 repair fed the 1h's current period (high 12.4 -> 12.5)");
  assert.strictEqual(c.tf["4h"].restT, null);
  assert.strictEqual(c.tf["1d"].restT, null);
  loop.stop();
});

test("audit M2: live volume that grows during the round trip cannot validate a buffer that is missing a closed child (the trust check uses the live child's volume AT THE REQUEST)", async function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  Date.now = function () { return T0300 - 10 * 60000; };
  loop.setCandles("A", byId["15m"], { closed: [b15(T0300 - 3 * M15, 10, 12, 9, 11, 100), b15(T0300 - 2 * M15, 11, 12, 10, 10.5, 100)], forming: null });
  loop.state.loaded = true;
  loop.barRollTick(T0300 + 5000);
  await settle();                                     // the sweeps this tick queued park on the hanging fetch, not on the stub below
  // Socket gap across 03:00: the 03:00 child closes synthetic (v 0) while REST holds 200 traded in it.
  loop.applyFeedBar("A", push(T0315, 12, 12.5, 11.8, 12.2, 5, 3), "15m", T0315 + 30000);
  const c = loop.state.coins.A;
  // The 30m reconcile is SENT with the live child at v 5; REST answers 205 (200 + 5); before the
  // response is installed the live child reaches 300.
  Date.now = function () { return T0315 + 31000; };
  globalThis.fetch = async function () {
    loop.applyFeedBar("A", push(T0315, 12, 12.6, 11.8, 12.4, 300, 40), "15m", T0315 + 31400);
    const data = [api(bar(T0300 - 2 * M30, M30, 8, 9, 7.5, 9, 150)), api(bar(T0300 - M30, M30, 9, 12, 8, 10.5, 200)), api(bar(T0300, M30, 11, 13, 10, 12.2, 205))];
    return { status: 200, ok: true, json: async function () { return data; } };
  };
  await loop.refreshTF(byId["30m"], ["A"]);
  const s30 = c.tf["30m"];
  assert.strictEqual(s30.agg.approx, true, "the buffer is short of REST's closed part (200): approximate");
  assert.strictEqual(s30.agg.v, 200);
  loop.barRollTick(T0330 + 5000);
  assert.strictEqual(s30.closed[s30.closed.length - 1].v, 500, "200 (the gap child, REST's) + 300 (the live child at its close)");
  assert.deepStrictEqual(s30.unverified, [T0300]);
  loop.stop();
});

test("audit M3: a seed whose REST volume shows trades AFTER the lagging 15m child keeps REST's (newer) close - the older child does not overwrite it, served or at the close", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedLiveOn0300(loop);                               // 15m live on 03:00: v 100, c 10.6
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  // Sent at 03:15:01, before the tick rolled the 15m slot: REST holds the whole 03:00 child (100)
  // and the first 03:15 trade (v 1 at 10.95).
  Date.now = function () { return T0315 + 2000; };
  loop.setCandles("A", byId["30m"], { closed: [bar(T0300 - M30, M30, 9, 12, 8, 10.5, 200)], forming: bar(T0300, M30, 10.5, 10.95, 10.3, 10.95, 101), at: T0315 + 1000 });
  const s30 = c.tf["30m"];
  assert.strictEqual(s30.forming.c, 10.95, "REST's close is newer than the lagging child's");
  loop.barRollTick(T0315 + 5000);                     // 03:00 closes (c 10.6) and folds; 03:15 opens synthetic
  assert.strictEqual(s30.forming.c, 10.95);
  loop.barRollTick(T0330 + 5000);                     // no 03:15 push ever arrives
  assert.strictEqual(s30.closed[s30.closed.length - 1].c, 10.95, "the period closes on the newest known price");
  loop.stop();
});

test("audit M3 control: a seed whose REST volume does NOT exceed the feed's (REST lagging the exchange) keeps the feed child's close", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedLiveOn0300(loop);
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  Date.now = function () { return T0315 + 2000; };
  loop.setCandles("A", byId["30m"], { closed: [bar(T0300 - M30, M30, 9, 12, 8, 10.5, 200)], forming: bar(T0300, M30, 10.5, 10.9, 10.3, 10.55, 98), at: T0315 + 1000 });
  const s30 = c.tf["30m"];
  assert.strictEqual(s30.forming.c, 10.6, "REST is behind the feed here: the feed's close stands");
  loop.barRollTick(T0315 + 5000);
  loop.barRollTick(T0330 + 5000);
  assert.strictEqual(s30.closed[s30.closed.length - 1].c, 10.6);
  loop.stop();
});

test("request time: `at` is when the request was SENT (after the budget wait), not when it was queued - a 30m request queued before a 15m boundary and sent after it is judged as a post-boundary snapshot", async function () {
  const limiter = budget.createLimiter({ ratePerMin: 60000, burst: 20000, log: function () {} });
  const acquire = limiter.acquire;
  let waitUntil = null;
  limiter.acquire = async function (cost, lane) {
    await acquire.call(limiter, cost, lane);
    if (waitUntil !== null) { const t = waitUntil; Date.now = function () { return t; }; }   // the budget held the request across the boundary
  };
  const loop = createLoop({}, { universes: [{ id: "perps", dex: null }], log: function () {}, limiter: limiter, feed: stubFeed(["A"]) });
  registerCoin(loop, "A");
  seedLiveOn0300(loop);
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  Date.now = function () { return T0315 - 1000; };   // queued at 03:14:59
  waitUntil = T0315 + 1000;                           // sent at 03:15:01
  globalThis.fetch = async function () {
    const data = [api(bar(T0300 - M30, M30, 9, 12, 8, 10.5, 200)), api(bar(T0300, M30, 10.5, 10.95, 10.3, 10.95, 101))];
    return { status: 200, ok: true, json: async function () { return data; } };
  };
  await loop.refreshTF(byId["30m"], ["A"]);
  assert.strictEqual(c.tf["30m"].forming.c, 10.95, "judged as sent at 03:15:01: REST's trade in the 03:15 child is newer than the lagging 03:00 child");
  loop.stop();
});

test("audit M4: coverage that returns after REST advanced the 15m slot rolls the higher slots on the next tick (no push, no wait for the next 15m roll)", function () {
  hangFetch();
  const feed = stubFeed(["A"]);
  const loop = makeLoop(feed);
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  feed.set.delete("A");
  // Uncovered: a REST pass advances the 15m slot into 03:30 (no rollup hook for an uncovered coin).
  Date.now = function () { return T0330 + 2000; };
  loop.setCandles("A", byId["15m"], { closed: [b15(T0300 - 2 * M15, 9, 11, 8, 10, 100), b15(T0300 - M15, 10, 12, 9, 11, 100), b15(T0300, 11, 12, 10, 10.5, 100), b15(T0315, 10.5, 10.9, 10.2, 10.7, 42)],
    forming: b15(T0330, 10.7, 10.8, 10.7, 10.75, 3), at: T0330 + 1500 });
  assert.strictEqual(c.tf["30m"].forming.t, T0300);
  feed.set.add("A");                                  // coverage returns; the 15m slot is current, so no local 15m roll
  loop.barRollTick(T0330 + 5000);
  assert.strictEqual(c.tf["30m"].forming.t, T0330, "the 30m rolled on the tick");
  assert.deepStrictEqual(c.tf["30m"].closed[c.tf["30m"].closed.length - 1], bar(T0300, M30, 11, 12, 10, 10.7, 142));
  assert.strictEqual(loop.feedHealth(T0330 + 5000).behind["30m"], 0);
  loop.stop();
});

// ---- independent review of the third fold (2026-10-29): its LOW regression and the named test gaps ----

test("fold review LOW-1: the 15m slot rolling DURING the round trip (sent one child behind, installed on the new child) judges the seed by the child at the send - no double count of the new child's pre-send trades", async function () {
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedLiveOn0300(loop);                               // 15m live on 03:00: v 100
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  Date.now = function () { return T0315 + 1000; };   // sent at 03:15:01, the slot still on 03:00
  globalThis.fetch = async function () {
    loop.applyFeedBar("A", push(T0315, 10.6, 10.8, 10.5, 10.7, 20, 5), "15m", T0315 + 1400);   // the first 03:15 push lands mid-flight
    const data = [api(bar(T0300 - H1, H1, 9, 12, 8, 10.5, 350)), api(bar(T0300, H1, 10.5, 10.9, 10.3, 10.7, 120))];
    return { status: 200, ok: true, json: async function () { return data; } };
  };
  await loop.refreshTF(byId["1h"], ["A"]);
  hangFetch();
  const s1h = c.tf["1h"];
  assert.strictEqual(s1h.agg.approx, false, "exact: the slot was one behind at the send");
  assert.strictEqual(s1h.forming.v, 120, "100 (03:00, folded) + 20 (03:15 so far) - not 140");
  loop.barRollTick(T0330 + 5000);
  loop.barRollTick(T0345 + 5000);
  loop.barRollTick(T0400 + 5000);
  assert.strictEqual(s1h.closed[s1h.closed.length - 1].v, 120, "the hour closes at 120, not 140");
  assert.deepStrictEqual(s1h.unverified, []);
  loop.stop();
});

test("fold review gap: the audit-M4 tick branch is a no-op in steady state (no revision bump, the mids-set close survives)", function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedStandard(loop, "A");
  loop.state.loaded = true;
  const c = loop.state.coins.A;
  c.tf["30m"].forming.c = 10.65;                     // what the 4 s mids tick does to every forming bar
  const rev = loop.state.revision;
  loop.barRollTick(T0315 + 120000);
  assert.strictEqual(loop.state.revision, rev);
  assert.strictEqual(c.tf["30m"].forming.c, 10.65);
  loop.stop();
});

test("fold review gap: a retried candle request re-stamps `at` and the 15m snapshot at the attempt whose response is used", async function () {
  hangFetch();
  const loop = makeLoop(stubFeed(["A"]));
  registerCoin(loop, "A");
  seedLiveOn0300(loop);
  loop.state.loaded = true;
  Date.now = function () { return T0300 + 14 * 60000 + 31000; };
  let calls = 0;
  globalThis.fetch = async function () {
    calls++;
    if (calls === 1) {                                // a 5xx; the retry goes out later, after more trades
      loop.applyFeedBar("A", push(T0300, 10.5, 10.9, 10.3, 10.6, 130, 40), "15m", T0300 + 14 * 60000 + 31500);
      Date.now = function () { return T0300 + 14 * 60000 + 33000; };
      return { status: 503, ok: false, json: async function () { return null; } };
    }
    const data = [api(bar(T0300 - M30, M30, 9, 12, 8, 10.5, 200)), api(bar(T0300, M30, 10.5, 10.9, 10.3, 10.6, 130))];
    return { status: 200, ok: true, json: async function () { return data; } };
  };
  let seen = null;
  await loop.refreshTF(byId["30m"], ["A"], undefined, function (n, d) { seen = d; });
  assert.strictEqual(calls, 2);
  assert.strictEqual(seen.at, T0300 + 14 * 60000 + 33000);
  assert.deepStrictEqual(seen.f15At, { t: T0300, v: 130 });
  loop.stop();
});
