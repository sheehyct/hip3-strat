"use strict";

// Served target rules v2 (design decisions 2026-09-22/23 and 2026-10-31).
// The continuations and the 3-2
// target the first prior level not yet taken out beyond the trigger, judged on
// finished bars (the signal timeframe's, then the daily history before that
// window); bar 0's far extreme is the walk's first candidate. Nothing beyond:
// no target at a true all-time extreme, else entry +/- 1.5%. Every setup and
// live row says which rule produced its target (tgt_rule).

const test = require("node:test");
const assert = require("node:assert");
const core = require("../src/strat_core.js");
const { createLoop, TFS } = require("../src/loop.js");
const budget = require("../src/budget.js");

function bar(t, h, l, o, c) {
  return { t: t, T: t + 1, o: o === undefined ? (h + l) / 2 : o, h: h, l: l, c: c === undefined ? (h + l) / 2 : c };
}
function setup(an, name, dir) { return an.setups.find((s) => s.name === name && (!dir || s.dir === dir)); }

test("targetVersion is 2", () => {
  assert.strictEqual(core.targetVersion(), 2);
});

test("V1: a 2U-1-2U targets bar 0's high when it stands beyond the trigger - structural", () => {
  const closed = [bar(0, 100, 90), bar(1, 105, 99), bar(2, 103, 100)];   // ref, 2U, inside
  const s = setup(core.analyzeTF(closed, null), "2U-1-2U");
  assert.deepStrictEqual([s.kind, s.trigger, s.target, s.tgt_rule], ["cont", 103, 105, "structural"]);
});

test("V2: bar 0 equal to the trigger is not beyond it - the walk continues to the first untaken older high - level", () => {
  // Q 110, then A inside Q, P a 2U to 103, the inside bar L also topping at 103
  const closed = [bar(0, 110, 95), bar(1, 100, 96), bar(2, 103, 97), bar(3, 103, 98)];
  const an = core.analyzeTF(closed, null);
  assert.deepStrictEqual(an.types.slice(1), ["1", "2U", "1"]);
  const s = setup(an, "2U-1-2U");
  assert.deepStrictEqual([s.trigger, s.target, s.tgt_rule], [103, 110, "level"]);
});

test("V3: a level a later bar took out is skipped - 3-2U targets the newer, higher one", () => {
  // A 108, then B 109 takes A out, C inside, the 3 (D) to 105
  const closed = [bar(0, 108, 100), bar(1, 109, 101), bar(2, 104, 102), bar(3, 105, 101.5)];
  const an = core.analyzeTF(closed, null);
  assert.strictEqual(an.types[3], "3");
  const s = setup(an, "3-2U");
  assert.deepStrictEqual([s.trigger, s.target, s.tgt_rule], [105, 109, "level"]);
});

test("V4/V5: an all-time extreme has NO target when the history is complete, entry +/- 1.5% when it is not", () => {
  const closed = [bar(10, 100, 95), bar(11, 105, 94)];                  // ref, 3
  const daily = [bar(1, 99, 96), bar(5, 98, 95.5)];                       // nothing beyond 105 / below 94
  const full = core.analyzeTF(closed, null, null, { daily: daily, complete: true });
  assert.deepStrictEqual([setup(full, "3-2U").target, setup(full, "3-2U").tgt_rule], [null, "none"]);
  assert.deepStrictEqual([setup(full, "3-2D").target, setup(full, "3-2D").tgt_rule], [null, "none"]);
  const part = core.analyzeTF(closed, null, null, { daily: daily, complete: false });
  assert.deepStrictEqual([setup(part, "3-2U").target, setup(part, "3-2U").tgt_rule], [105 * 1.015, "fallback"]);
  assert.deepStrictEqual([setup(part, "3-2D").target, setup(part, "3-2D").tgt_rule], [94 * 0.985, "fallback"]);
  const none = core.analyzeTF(closed, null);                             // no ctx: completeness unknown
  assert.strictEqual(setup(none, "3-2U").tgt_rule, "fallback");
  const empty = core.analyzeTF(closed, null, null, { daily: [], complete: true });   // a listing with no closed daily yet
  assert.strictEqual(setup(empty, "3-2U").tgt_rule, "none");
});

test("V6: the search continues into the daily bars that START before the signal window, carrying what the window took out", () => {
  const closed = [bar(10, 100, 95), bar(11, 101, 94)];                   // ref, 3 (a 4h-style window)
  const daily = [bar(1, 99, 80), bar(5, 98, 90), bar(10, 101, 93)];      // the t=10 bar starts IN the window: skipped
  const an = core.analyzeTF(closed, null, null, { daily: daily, complete: true });
  const s = setup(an, "3-2D");
  assert.deepStrictEqual([s.trigger, s.target, s.tgt_rule], [94, 90, "level"]);
  // a daily high the window already exceeded is taken out
  const up = setup(core.analyzeTF(closed, null, null, { daily: [bar(1, 120, 90), bar(5, 100.5, 91)], complete: true }), "3-2U");
  assert.deepStrictEqual([up.trigger, up.target], [101, 120]);
});

test("V7: the v1 negative-target class (a wide monthly 3-2D) never serves a price at or below zero", () => {
  const closed = [bar(10, 50, 40), bar(11, 60, 10)];                     // ref, a wide 3: v1 served 10 - 1.5 x 50 = -65
  const full = setup(core.analyzeTF(closed, null, null, { daily: [], complete: true }), "3-2D");
  assert.deepStrictEqual([full.target, full.tgt_rule], [null, "none"]);
  const part = setup(core.analyzeTF(closed, null), "3-2D");
  assert.ok(part.target > 0);
  assert.strictEqual(part.target, 10 * 0.985);
});

test("V8: the forming bar never moves a target (fixed when the setup forms, design decision 2026-10-31)", () => {
  const closed = [bar(0, 108, 100), bar(1, 109, 101), bar(2, 104, 102), bar(3, 105, 101.5)];
  const forming = bar(4, 200, 104, 104.5, 199);                           // ran far past 109
  const an = core.analyzeTF(closed, forming);
  assert.strictEqual(setup(an, "3-2U").target, 109);
  const live = an.live.find((l) => l.name === "3-2U");
  assert.deepStrictEqual([live.target, live.tgt_rule], [109, "level"]);
});

test("3-1-2 continuation follows the same order (design decision 2026-10-31): the 3's extreme, else the first untaken older level", () => {
  // green 3 to 106, inside bar also topping at 106: the 3 is not beyond the trigger
  const closed = [bar(0, 112, 90), bar(1, 100, 95), bar(2, 106, 94, 95, 105), bar(3, 106, 100)];
  const an = core.analyzeTF(closed, null);
  assert.deepStrictEqual(an.types.slice(1), ["1", "3", "1"]);
  const s = setup(an, "3-1-2U");
  assert.deepStrictEqual([s.kind, s.trigger, s.target, s.tgt_rule], ["cont", 106, 112, "level"]);
});

test("tgt_rule labels every kind: fixed wicks structural, PMG level, info none; live rows copy it, the 1-3 is structural", () => {
  const rev = setup(core.analyzeTF([bar(0, 106, 100), bar(1, 105, 97), bar(2, 103, 97.5)], null), "2D-1-2U");
  assert.strictEqual(rev.tgt_rule, "structural");
  const info = setup(core.analyzeTF([bar(0, 106, 100), bar(1, 105, 101), bar(2, 104, 102)], null), "1-1-2U");
  assert.deepStrictEqual([info.target, info.tgt_rule], [null, "none"]);
  const pmgBars = [];
  for (let i = 0; i < 7; i++) pmgBars.push(bar(i, 120 - i * 2, 100 - i * 2.5));   // 6 lower highs in a row
  const pmg = core.analyzeTF(pmgBars, null).setups.find((s) => s.name === "PMG");
  assert.strictEqual(pmg.tgt_rule, "level");
  const closed13 = [bar(0, 108, 99), bar(1, 110, 95, 102, 105), bar(2, 107, 101)];
  const an13 = core.analyzeTF(closed13, bar(3, 108, 100, 103, 107.5), "down");
  assert.strictEqual(an13.live.find((l) => l.name === "1-3").tgt_rule, "structural");
  for (const l of an13.live) assert.ok(typeof l.tgt_rule === "string", l.name);
});

// ---- the worker builds the daily context ----

function makeLoop() {
  const limiter = budget.createLimiter({ ratePerMin: 60000, burst: 20000, log: function () {} });
  const loop = createLoop({}, { universes: [{ id: "perps", dex: null }], log: function () {}, limiter: limiter, feed: null });
  loop.state.coins.A = { name: "A", sym: "A", uni: "perps", ctx: null, mid: null, tf: {}, hist: [] };
  loop.state.order.push("A");
  return loop;
}
const byId = {};
TFS.forEach(function (t) { byId[t.id] = t; });
const D1 = 86400000, H4 = 14400000;
const DAY0 = Date.UTC(2026, 9, 1);

test("worker: a young listing's daily history is complete, so a 4h 3-2 at its all-time high gets no target", () => {
  const realNow = Date.now;
  try {
    Date.now = function () { return DAY0 + 20 * D1 + 3 * H4 + 60000; };
    const loop = makeLoop();
    const daily = [];
    for (let i = 0; i < 20; i++) daily.push({ t: DAY0 + i * D1, T: DAY0 + (i + 1) * D1 - 1, o: 50, h: 60, l: 40, c: 50, v: 1 });
    loop.setCandles("A", byId["1d"], { closed: daily, forming: null });
    const t0 = DAY0 + 20 * D1;
    loop.setCandles("A", byId["4h"], { closed: [
      { t: t0, T: t0 + H4 - 1, o: 55, h: 58, l: 52, c: 55, v: 1 },
      { t: t0 + H4, T: t0 + 2 * H4 - 1, o: 55, h: 70, l: 51, c: 69, v: 1 }      // a 3 to a new all-time high
    ], forming: null });
    const s = setup(loop.state.coins.A.tf["4h"].an, "3-2U");
    assert.deepStrictEqual([s.trigger, s.target, s.tgt_rule], [70, null, "none"]);
    const d = setup(loop.state.coins.A.tf["4h"].an, "3-2D");
    assert.deepStrictEqual([d.trigger, d.target, d.tgt_rule], [51, 40, "level"], "the daily lows (40) start before the window");
    loop.stop();
  } finally { Date.now = realNow; }
});

test("worker: a full 220-day daily window is NOT the whole history - a 220-day extreme falls back to entry +/- 1.5%", () => {
  const realNow = Date.now;
  try {
    Date.now = function () { return DAY0 + 230 * D1 + 3 * H4 + 60000; };
    const loop = makeLoop();
    const daily = [];
    for (let i = 0; i < 230; i++) daily.push({ t: DAY0 + i * D1, T: DAY0 + (i + 1) * D1 - 1, o: 50, h: 60, l: 40, c: 50, v: 1 });
    loop.setCandles("A", byId["1d"], { closed: daily, forming: null });
    assert.ok(loop.state.coins.A.tf["1d"].closed.length >= 218, "trimmed to the 220-bar window");
    const t0 = DAY0 + 230 * D1;
    loop.setCandles("A", byId["4h"], { closed: [
      { t: t0, T: t0 + H4 - 1, o: 55, h: 58, l: 52, c: 55, v: 1 },
      { t: t0 + H4, T: t0 + 2 * H4 - 1, o: 55, h: 70, l: 51, c: 69, v: 1 }
    ], forming: null });
    const s = setup(loop.state.coins.A.tf["4h"].an, "3-2U");
    assert.deepStrictEqual([s.target, s.tgt_rule], [70 * 1.015, "fallback"]);
    loop.stop();
  } finally { Date.now = realNow; }
});

// ---- independent review of rules v2 (2026-10-31): H1 (the bridge, chosen), LOW-1, LOW-2 ----

test("V9 / review H1: the finished 1h bars bridge the gap between a 15m window and the daily history (today's morning level counts)", () => {
  const M15 = 900000, H1 = 3600000, today = Date.UTC(2026, 9, 30), win = today + 10 * H1;   // window 10:00-20:00Z
  const closed = [];
  for (let i = 0; i < 38; i++) closed.push(bar(win + i * M15, 98 + (i % 3) * 0.3, 95 - (i % 2) * 0.2, 96, 96.5));
  closed.push(bar(win + 38 * M15, 98.5, 95.5, 96, 96));
  closed.push(bar(win + 39 * M15, 100, 94, 96, 97));                                       // the 3: trigger 100
  const daily = [bar(today - 2 * 86400000, 99, 90), bar(today - 86400000, 103, 90)];       // yesterday 103
  const bridge = [];
  for (let k = 0; k < 20; k++) bridge.push(bar(today + k * H1, k === 5 ? 105 : 99, 93));     // 05:00Z printed 105
  const without = setup(core.analyzeTF(closed, null, null, { daily: daily, complete: false }), "3-2U");
  assert.strictEqual(without.target, 103, "the blind spot the review proved");
  const withB = setup(core.analyzeTF(closed, null, null, { bridge: bridge, daily: daily, complete: false }), "3-2U");
  assert.deepStrictEqual([withB.target, withB.tgt_rule], [105, "level"]);
  // bridge bars inside the window are skipped; daily bars are searched only before the OLDEST bridge bar
  const late = [bar(win + 2 * H1, 150, 93)];
  assert.strictEqual(setup(core.analyzeTF(closed, null, null, { bridge: late, daily: daily }), "3-2U").target, 103);
  const covered = [bar(today - 86400000, 99, 93)].concat(bridge.slice(0, 5));               // bridge reaches into yesterday
  assert.strictEqual(setup(core.analyzeTF(closed, null, null, { bridge: covered, daily: daily }), "3-2U").target, 100 * 1.015,
    "yesterday's daily (103) starts at the oldest bridge bar: already covered by finer bars, skipped");
});

test("review LOW-1: completeness is judged by TIME - an old coin's short or empty daily answer is never a whole history", () => {
  const realNow = Date.now;
  try {
    Date.now = function () { return DAY0 + 300 * D1 + 3 * H4 + 60000; };
    const loop = makeLoop();
    const t0 = DAY0 + 300 * D1;
    const fours = [
      { t: t0, T: t0 + H4 - 1, o: 55, h: 58, l: 52, c: 55, v: 1 },
      { t: t0 + H4, T: t0 + 2 * H4 - 1, o: 55, h: 70, l: 51, c: 69, v: 1 }
    ];
    // 30 dailies with gaps, the oldest 219 days back: few bars, but an old coin
    const sparse = [];
    for (let i = 0; i < 30; i++) sparse.push({ t: DAY0 + 81 * D1 + i * 7 * D1, T: DAY0 + 82 * D1 + i * 7 * D1 - 1, o: 50, h: 60, l: 40, c: 50, v: 1 });
    loop.setCandles("A", byId["1d"], { closed: sparse, forming: null });
    loop.setCandles("A", byId["4h"], { closed: fours.slice(), forming: null });
    assert.strictEqual(setup(loop.state.coins.A.tf["4h"].an, "3-2U").tgt_rule, "fallback", "not a false all-time high");
    // an EMPTY REST answer for the daily slot (feed off) is not a whole history either
    loop.setCandles("A", byId["1d"], { closed: [], forming: null });
    assert.strictEqual(setup(loop.state.coins.A.tf["4h"].an, "3-2U").tgt_rule, "fallback");
    loop.stop();
  } finally { Date.now = realNow; }
});

test("review LOW-2: a daily slot that loads AFTER a timeframe re-targets it at once (no stale boot-time fallback)", () => {
  const realNow = Date.now;
  try {
    Date.now = function () { return DAY0 + 20 * D1 + 3 * H4 + 60000; };
    const loop = makeLoop();
    const t0 = DAY0 + 20 * D1;
    loop.setCandles("A", byId["4h"], { closed: [
      { t: t0, T: t0 + H4 - 1, o: 55, h: 58, l: 52, c: 55, v: 1 },
      { t: t0 + H4, T: t0 + 2 * H4 - 1, o: 55, h: 70, l: 51, c: 69, v: 1 }
    ], forming: null });
    assert.strictEqual(setup(loop.state.coins.A.tf["4h"].an, "3-2D").tgt_rule, "fallback", "no daily yet");
    const daily = [];
    for (let i = 0; i < 20; i++) daily.push({ t: DAY0 + i * D1, T: DAY0 + (i + 1) * D1 - 1, o: 50, h: 60, l: 40, c: 50, v: 1 });
    loop.setCandles("A", byId["1d"], { closed: daily, forming: null });
    const d = setup(loop.state.coins.A.tf["4h"].an, "3-2D");
    assert.deepStrictEqual([d.target, d.tgt_rule], [40, "level"], "re-targeted when the daily landed");
    loop.stop();
  } finally { Date.now = realNow; }
});
