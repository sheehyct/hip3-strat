"use strict";

// The loop's 30s score sampler (Deploy 1 item 3). The load-bearing
// assertion here is PARITY: the ring records the value computed by
// apistate.servedScore - the exact exported path buildApiState uses -
// and the built payload's own `score` agrees at the same injected
// clock. This is the guarantee that keeps the ring from becoming the
// next forked recorder.
// No timers run and no fetch fires: sampleScores is pure local compute.
// node builtins only: node --test

const test = require("node:test");
const assert = require("node:assert");
const { createLoop } = require("../src/loop.js");
const { buildApiState, servedScore } = require("../src/apistate.js");
const ring = require("../src/score_ring.js");

const UNIS = [{ id: "xyz", dex: "xyz" }, { id: "perps", dex: null }];
const NOW = 1000000;

// A coin that actually scores under ftfcTfs ["1h"] (the same fixture
// shape test/apistate.test.js proves yields a ready, non-null score).
function scoredCoin(name, sym, uni) {
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

function seed(loop, coin) {
  loop.state.coins[coin.name] = coin;
  loop.state.order.push(coin.name);
}

function makeLoop() {
  const loop = createLoop({ ftfcTfs: ["1h"] }, { universes: UNIS, log: function () {} });
  seed(loop, scoredCoin("BTC", "BTC", "perps"));
  // an unready coin: no analyzed timeframes -> served score null
  seed(loop, { name: "xyz:EMPTY", sym: "EMPTY", uni: "xyz", ctx: {}, mid: 50, tf: {}, hist: [] });
  return loop;
}

test("sampleScores records the servedScore path's output - sampled === served", function () {
  const loop = makeLoop();
  const rev0 = loop.state.revision;
  loop.sampleScores(NOW);

  const samples = loop.state.scoreRing["BTC"];
  assert.strictEqual(samples.length, 1);
  // expectation computed through the SAME exported path /api/state uses -
  // not a reimplementation of the gates
  const expect = servedScore(loop.state, loop.state.coins["BTC"], ["1h"], NOW);
  assert.notStrictEqual(expect, null, "fixture must actually score, or this proves nothing");
  assert.strictEqual(samples[0].score, expect, "the ring records the served path's value");
  assert.strictEqual(samples[0].t, NOW, "stamped with the injected clock");

  // and the payload built from the same state at the same clock agrees
  const row = buildApiState(loop.state, ["1h"], null, NOW).coins
    .find(function (c) { return c.name === "BTC"; });
  assert.strictEqual(samples[0].score, row.score, "sampled score === served score");

  // a null served score records as null and never ranks
  const empty = loop.state.scoreRing["xyz:EMPTY"];
  assert.strictEqual(empty[0].score, null);
  assert.strictEqual(empty[0].rank, null);
  assert.strictEqual(samples[0].rank, 1, "alone with a real score in perps");

  // a sample changes what /api/state serializes, so the serialization
  // cache's revision key must move
  assert.ok(loop.state.revision > rev0, "revision bumped on a recorded sample");
});

test("all three windows are null immediately after boot, then m5 fills through the loop", function () {
  const loop = makeLoop();
  loop.sampleScores(NOW);
  assert.deepStrictEqual(ring.scoreDelta(loop.state.scoreRing, "BTC"),
    { m5: null, m15: null, h1: null }, "first sample after boot: nothing filled");

  loop.sampleScores(NOW + 300000);
  const d = ring.scoreDelta(loop.state.scoreRing, "BTC");
  assert.notStrictEqual(d.m5, null, "5 minutes of uptime fills m5");
  // both endpoints proven through the served path at their own clocks
  // (servedScore is pure - recomputing it here mutates nothing)
  const s1 = servedScore(loop.state, loop.state.coins["BTC"], ["1h"], NOW);
  const s2 = servedScore(loop.state, loop.state.coins["BTC"], ["1h"], NOW + 300000);
  assert.deepStrictEqual(d.m5, {
    signed: s2 - s1,
    mag: Math.abs(s2) - Math.abs(s1),
    flip: s1 < 0 && s2 > 0 ? "up" : (s1 > 0 && s2 < 0 ? "down" : null),
    rank: 0
  });
  assert.strictEqual(d.m15, null, "m15 not up long enough");
  assert.strictEqual(d.h1, null);

  // the unready coin's windows stay null: its endpoints recorded null
  assert.deepStrictEqual(ring.scoreDelta(loop.state.scoreRing, "xyz:EMPTY"),
    { m5: null, m15: null, h1: null });

  // and the built payload serves exactly what the ring computed
  const row = buildApiState(loop.state, ["1h"], null, NOW + 300000).coins
    .find(function (c) { return c.name === "BTC"; });
  assert.deepStrictEqual(row.scoreDelta, d);
});

test("a coin removed from the roster drops its ring on the next sample", function () {
  const loop = makeLoop();
  loop.sampleScores(NOW);
  assert.ok("xyz:EMPTY" in loop.state.scoreRing);
  // mirror the loop's own removal shape: coins entry deleted, order filtered
  delete loop.state.coins["xyz:EMPTY"];
  loop.state.order = loop.state.order.filter(function (n) { return n !== "xyz:EMPTY"; });
  loop.sampleScores(NOW + ring.GRAIN_MS);
  assert.ok(!("xyz:EMPTY" in loop.state.scoreRing), "delisted coin's ring evicted");
  assert.strictEqual(loop.state.scoreRing["BTC"].length, 2, "survivors keep their history");
});

test("an empty roster records nothing and does not bump revision", function () {
  const loop = createLoop({ ftfcTfs: ["1h"] }, { universes: UNIS, log: function () {} });
  const rev0 = loop.state.revision;
  loop.sampleScores(NOW);
  assert.deepStrictEqual(loop.state.scoreRing, {});
  assert.strictEqual(loop.state.revision, rev0, "no mutation, no cache invalidation");
});

// The WIRING, not the math (review LOW): every test above drives
// sampleScores directly, so a removed or mis-cadenced production timer -
// or a stop() that leaks it - would leave them all green. Fake timers pin
// installation, the 30s cadence, and cleanup. startTimers (not start(),
// which fetches) installs the intervals; the sibling 4s/5s/60s timers
// fire against a stubbed global fetch and touch no network.
test("the 30s sampler is installed by startTimers and cleared by stop()", function (t) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    return { status: 200, ok: true, json: async function () { return []; } };
  };
  t.after(function () { globalThis.fetch = realFetch; });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const loop = createLoop({ ftfcTfs: ["1h"] }, { universes: UNIS, log: function () {} });
  seed(loop, scoredCoin("xyz:NVDA", "NVDA", "xyz"));
  loop.startTimers();
  t.mock.timers.tick(ring.GRAIN_MS - 1);
  assert.ok(!("xyz:NVDA" in loop.state.scoreRing), "no sample before one full grain");
  t.mock.timers.tick(1);
  assert.strictEqual(loop.state.scoreRing["xyz:NVDA"].length, 1,
    "one sample exactly at the grain boundary - the timer reads ring.GRAIN_MS");
  t.mock.timers.tick(ring.GRAIN_MS);
  assert.strictEqual(loop.state.scoreRing["xyz:NVDA"].length, 2, "steady cadence");
  loop.stop();
  t.mock.timers.tick(10 * ring.GRAIN_MS);
  assert.strictEqual(loop.state.scoreRing["xyz:NVDA"].length, 2,
    "stop() clears the interval - no samples after shutdown");
});
