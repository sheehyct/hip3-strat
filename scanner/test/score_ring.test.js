"use strict";

// Ring semantics for the served-score delta (Deploy 1 item 3): depth
// bound, roster eviction, per-universe rank, window fill rules, null
// propagation, and the documented h1 full-ring boundary concession.
// Pure module tests with injected clocks - the sampled-equals-served
// guarantee lives in test/loop_scoredelta.test.js against the real
// derivation path. node builtins only: node --test

const test = require("node:test");
const assert = require("node:assert");
const ring = require("../src/score_ring.js");

const T0 = 1700000000000;
const G = ring.GRAIN_MS;
const NULLS = { m5: null, m15: null, h1: null };

function row(name, uni, score) { return { name: name, uni: uni, score: score }; }

test("the grain and depth contract the loop's timer builds on is pinned", function () {
  assert.strictEqual(ring.GRAIN_MS, 30000, "30-second grain");
  assert.strictEqual(ring.DEPTH, 121,
    "121 samples = 120 intervals = exactly the 1h span, so strict h1 qualifies (review)");
  assert.deepStrictEqual(ring.WINDOW_MS, { m5: 300000, m15: 900000, h1: 3600000 });
});

test("all three windows are null immediately after boot", function () {
  const store = {};
  ring.recordSample(store, [row("BTC", "perps", 10)], T0);
  assert.deepStrictEqual(ring.scoreDelta(store, "BTC"), NULLS,
    "one sample cannot fill any window");
  // a coin never sampled, and a state without a ring at all, serve the
  // same all-null shape - the field is safely additive
  assert.deepStrictEqual(ring.scoreDelta(store, "ETH"), NULLS);
  assert.deepStrictEqual(ring.scoreDelta(undefined, "BTC"), NULLS);
});

test("m5 fills strictly at span age: 299s is not a 5-minute window", function () {
  const store = {};
  ring.recordSample(store, [row("BTC", "perps", -80)], T0);
  ring.recordSample(store, [row("BTC", "perps", 20)], T0 + 299000);
  assert.deepStrictEqual(ring.scoreDelta(store, "BTC"), NULLS,
    "restart-honest: null until the window actually refills");
});

test("a filled m5 window serves the D4 three-way split: -80 -> +20 is +100/-60/up", function () {
  const store = {};
  ring.recordSample(store, [row("BTC", "perps", -80)], T0);
  ring.recordSample(store, [row("BTC", "perps", 20)], T0 + 300000);
  const d = ring.scoreDelta(store, "BTC");
  assert.deepStrictEqual(d.m5, { signed: 100, mag: -60, flip: "up", rank: 0 },
    "signed nets to +100, magnitude drops 60 (both ends less extreme), and the flip is real");
  assert.strictEqual(d.m15, null, "the longer windows stay null until they fill");
  assert.strictEqual(d.h1, null);
});

test("\"then\" is the NEWEST sample at least the span old, not the oldest", function () {
  const store = {};
  ring.recordSample(store, [row("BTC", "perps", -80)], T0);
  ring.recordSample(store, [row("BTC", "perps", -50)], T0 + 60000);
  ring.recordSample(store, [row("BTC", "perps", 20)], T0 + 360000);
  // both earlier samples are >= 5m old; the NEWER one (-50, aged exactly
  // 300s) is the endpoint
  assert.strictEqual(ring.scoreDelta(store, "BTC").m5.signed, 70);
});

test("flip is down on +/- crossings only; a zero endpoint never flips", function () {
  function m5Of(thenScore, nowScore) {
    const store = {};
    ring.recordSample(store, [row("BTC", "perps", thenScore)], T0);
    ring.recordSample(store, [row("BTC", "perps", nowScore)], T0 + 300000);
    return ring.scoreDelta(store, "BTC").m5;
  }
  assert.deepStrictEqual(m5Of(80, -20), { signed: -100, mag: -60, flip: "down", rank: 0 });
  assert.strictEqual(m5Of(10, 30).flip, null, "same-sign move is not a flip");
  assert.strictEqual(m5Of(0, 20).flip, null, "a zero endpoint is neither side");
  assert.strictEqual(m5Of(-80, 0).flip, null);
});

test("null propagates from an ENDPOINT, not from any sample inside the window", function () {
  const store = {};
  ring.recordSample(store, [row("BTC", "perps", -80)], T0);
  ring.recordSample(store, [row("BTC", "perps", null)], T0 + 300000);
  assert.strictEqual(ring.scoreDelta(store, "BTC").m5, null,
    "a null now-endpoint makes the window unknown");

  const store2 = {};
  ring.recordSample(store2, [row("BTC", "perps", null)], T0);
  ring.recordSample(store2, [row("BTC", "perps", 20)], T0 + 300000);
  assert.strictEqual(ring.scoreDelta(store2, "BTC").m5, null,
    "a null then-endpoint makes the window unknown");

  const store3 = {};
  ring.recordSample(store3, [row("BTC", "perps", -80)], T0);
  ring.recordSample(store3, [row("BTC", "perps", null)], T0 + 150000);
  ring.recordSample(store3, [row("BTC", "perps", 20)], T0 + 300000);
  assert.deepStrictEqual(ring.scoreDelta(store3, "BTC").m5,
    { signed: 100, mag: -60, flip: "up", rank: 0 },
    "a mid-window null (a transient unready spell) does not poison real endpoints");

  // NaN is the same unknown null is (the finite-or-null convention) - it must
  // record as null, never rank, and never arithmetic into a delta
  const store4 = {};
  ring.recordSample(store4, [row("BTC", "perps", NaN)], T0);
  assert.strictEqual(store4["BTC"][0].score, null);
  assert.strictEqual(store4["BTC"][0].rank, null);
});

test("rank is computed within ONE universe: a cross-universe coin cannot perturb it", function () {
  const store = {};
  // then: X (xyz) sits BETWEEN the two perps scores; a global ranking
  // would read A=1 X=2 B=3
  ring.recordSample(store, [
    row("A", "perps", 50), row("B", "perps", 40), row("X", "xyz", 45)
  ], T0);
  // now: X crosses over everything; a global ranking would demote both
  // perps coins by one
  ring.recordSample(store, [
    row("A", "perps", 50), row("B", "perps", 40), row("X", "xyz", 100)
  ], T0 + 300000);
  assert.strictEqual(ring.scoreDelta(store, "A").m5.rank, 0,
    "A held perps rank 1 both ends - the xyz crossover must not read as a demotion");
  assert.strictEqual(ring.scoreDelta(store, "B").m5.rank, 0);
  assert.strictEqual(ring.scoreDelta(store, "X").m5.rank, 0, "X is alone in xyz at both ends");
});

test("a real rank move within a universe reads positive when the coin climbed", function () {
  const store = {};
  ring.recordSample(store, [row("A", "perps", 50), row("B", "perps", 40)], T0);
  ring.recordSample(store, [row("A", "perps", 41), row("B", "perps", 60)], T0 + 300000);
  assert.strictEqual(ring.scoreDelta(store, "B").m5.rank, 1, "2 -> 1: climbed one");
  assert.strictEqual(ring.scoreDelta(store, "A").m5.rank, -1, "1 -> 2: slipped one");
});

test("a null-score coin is excluded from the ranking, not ranked last", function () {
  const store = {};
  ring.recordSample(store, [
    row("A", "perps", 50), row("B", "perps", null), row("C", "perps", 40)
  ], T0);
  assert.strictEqual(store["A"][0].rank, 1);
  assert.strictEqual(store["B"][0].rank, null, "unknowable, never last place");
  assert.strictEqual(store["C"][0].rank, 2, "the null coin does not occupy a slot");
});

test("ring depth is bounded at DEPTH (121): the oldest samples are evicted", function () {
  const store = {};
  for (let i = 0; i < 130; i++) {
    ring.recordSample(store, [row("BTC", "perps", i)], T0 + i * G);
  }
  assert.strictEqual(ring.DEPTH, 121,
    "121 samples = 120 intervals = exactly the h1 span (review)");
  assert.strictEqual(store["BTC"].length, ring.DEPTH);
  assert.strictEqual(store["BTC"][0].score, 130 - ring.DEPTH, "oldest overflow evicted");
  assert.strictEqual(store["BTC"][ring.DEPTH - 1].score, 129);
});

test("a coin removed from the roster drops its ring on the next sample", function () {
  const store = {};
  ring.recordSample(store, [row("BTC", "perps", 10), row("ETH", "perps", 5)], T0);
  assert.ok("ETH" in store);
  ring.recordSample(store, [row("BTC", "perps", 11)], T0 + G);
  assert.ok(!("ETH" in store), "delisted coin evicted - a re-listed name starts fresh");
  assert.strictEqual(store["BTC"].length, 2);
});

// STRICT h1 semantics (review): a full 121-deep ring at exact 30s
// spacing reaches (121-1)*30s = exactly 3600s, so the oldest sample
// strictly satisfies "at least the span old" - no stand-in, no
// concession. One sample short of full, h1 is null.
test("h1 serves from a full ring under the strict at-least-span rule", function () {
  const store = {};
  for (let i = 0; i < ring.DEPTH; i++) {
    ring.recordSample(store, [row("BTC", "perps", i === 0 ? -80 : 20)], T0 + i * G);
  }
  const d = ring.scoreDelta(store, "BTC");
  assert.deepStrictEqual(d.h1, { signed: 100, mag: -60, flip: "up", rank: 0 },
    "oldest (-80, aged exactly 3600s) is the strict h1 endpoint");
  assert.strictEqual(d.m5.signed, 0);
  assert.strictEqual(d.m15.signed, 0);
});

test("h1 stays null one sample short of a full ring (restart-honest)", function () {
  // DEPTH-1 samples: reach 3570s, strictly short of the 3600s span
  const store = {};
  for (let i = 0; i < ring.DEPTH - 1; i++) {
    ring.recordSample(store, [row("BTC", "perps", 20)], T0 + i * G);
  }
  const d = ring.scoreDelta(store, "BTC");
  assert.strictEqual(d.h1, null, "not up a full hour yet -> unknown");
  assert.notStrictEqual(d.m15, null, "m15 is strictly covered by then");

  // a full ring whose samples are too tightly spaced (oldest more than
  // one grain short of the span) must NOT fake an hour
  const tight = {};
  for (let i = 0; i < ring.DEPTH; i++) {
    ring.recordSample(tight, [row("BTC", "perps", 20)], T0 + i * 20000);
  }
  assert.strictEqual(ring.scoreDelta(tight, "BTC").h1, null,
    "the concession is bounded at one grain, never a broader fudge");
});
