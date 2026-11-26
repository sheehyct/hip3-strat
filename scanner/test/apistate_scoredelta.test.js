"use strict";

// /api/state serves the additive per-coin `scoreDelta` read from the
// loop's ring (state.scoreRing). Serialization-side only: the ring
// write path and the sampled-equals-served proof live in
// test/loop_scoredelta.test.js. node builtins only: node --test

const test = require("node:test");
const assert = require("node:assert");
const { buildApiState } = require("../src/apistate.js");

const NULLS = { m5: null, m15: null, h1: null };

// Same minimal fixture shape as test/apistate.test.js: one analyzed 1h
// slot so the coin is ready (and scored) under FTFC ["1h"].
function coin(name, sym, uni) {
  return {
    name: name, sym: sym, uni: uni, mid: 100, hist: [], ctx: { markPx: "100", prevDayPx: "99", dayNtlVlm: "1000" },
    tf: {
      "1h": {
        closed: [{ t: 1, o: 99, h: 101, l: 98, c: 100 }],
        forming: { t: 2, T: 3600002, o: 100, h: 101, l: 99, c: 100, v: 5 },
        an: { types: [null, "2U"], formingType: "2U", formingDir: "up", completed: null, setups: [], invalidated: false, live: [] }
      }
    }
  };
}

function stateOf() {
  const coins = {
    "xyz:NVDA": coin("xyz:NVDA", "NVDA", "xyz"),
    "BTC": coin("BTC", "BTC", "perps")
  };
  return { order: ["xyz:NVDA", "BTC"], coins: coins, loaded: true, universes: ["xyz", "perps"] };
}

const FTFC = ["1h"];
const NOW = 1000000;

test("scoreDelta is present on every coin; no ring state serves all-null windows", function () {
  // stateOf() carries no scoreRing at all - the shape an older loop (or a
  // bare fixture) presents. Restart-honest AND additive: the field is
  // always there, every window null.
  const out = buildApiState(stateOf(), FTFC, null, NOW);
  assert.strictEqual(out.coins.length, 2);
  out.coins.forEach(function (c) {
    assert.deepStrictEqual(c.scoreDelta, NULLS, c.name + " serves the all-null shape");
  });
});

test("an empty or single-sample ring still serves all-null windows", function () {
  const st = stateOf();
  st.scoreRing = { "BTC": [{ t: NOW - 1000, score: 20, rank: 1 }] };
  const out = buildApiState(st, FTFC, null, NOW);
  out.coins.forEach(function (c) {
    assert.deepStrictEqual(c.scoreDelta, NULLS);
  });
});

test("a filled m5 window serves the D4 three-way split from RING samples", function () {
  const st = stateOf();
  st.scoreRing = {
    "BTC": [
      { t: NOW - 300000, score: -80, rank: 2 },
      { t: NOW, score: 20, rank: 1 }
    ]
  };
  const out = buildApiState(st, FTFC, null, NOW);
  const byName = {};
  out.coins.forEach(function (c) { byName[c.name] = c; });
  assert.deepStrictEqual(byName["BTC"].scoreDelta.m5,
    { signed: 100, mag: -60, flip: "up", rank: 1 },
    "-80 -> +20: +100 signed, -60 magnitude, a real flip, climbed one rank");
  assert.strictEqual(byName["BTC"].scoreDelta.m15, null);
  assert.strictEqual(byName["BTC"].scoreDelta.h1, null);
  // the delta endpoints are the ring's samples, NOT this row's live
  // score: the fixture's served score is a real number that is neither
  // endpoint, and the delta must not bend toward it
  assert.notStrictEqual(byName["BTC"].score, null);
  assert.notStrictEqual(byName["BTC"].score, 20);
  // a coin without ring samples in the same payload stays all-null
  assert.deepStrictEqual(byName["xyz:NVDA"].scoreDelta, NULLS);
});

test("a null ring endpoint serves a null window even for a currently-scored coin", function () {
  const st = stateOf();
  st.scoreRing = {
    "BTC": [
      { t: NOW - 300000, score: null, rank: null },
      { t: NOW, score: 20, rank: 1 }
    ]
  };
  const c = buildApiState(st, FTFC, null, NOW).coins
    .find(function (x) { return x.name === "BTC"; });
  assert.strictEqual(c.scoreDelta.m5, null, "unknown then-endpoint -> unknown window");
  assert.notStrictEqual(c.score, null, "while the live row still serves its real score");
});

test("the ?uni filter keeps scoreDelta on the filtered rows", function () {
  const st = stateOf();
  st.scoreRing = {
    "BTC": [
      { t: NOW - 300000, score: 10, rank: 1 },
      { t: NOW, score: 30, rank: 1 }
    ]
  };
  const out = buildApiState(st, FTFC, "perps", NOW);
  assert.strictEqual(out.coins.length, 1);
  assert.deepStrictEqual(out.coins[0].scoreDelta.m5,
    { signed: 20, mag: 20, flip: null, rank: 0 });
});
