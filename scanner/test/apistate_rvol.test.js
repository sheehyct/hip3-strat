"use strict";

// rvol nulling for universes outside the volume true-up scope (apistate.js,
// demand cut, design decision 2026-08-17). rvol15 is pace-adjusted off the FORMING
// bar's volume, and volume only moves on a candle fetch - a universe whose
// 5-min true-up was scoped away has its forming volume frozen at the
// roll-time sample, so a computed rvol would DECAY toward zero across the
// bar. The payload serves null instead (an already-legal state: coins with
// fewer than 8 closed 15m bars serialize null today). These tests pin that
// the discriminator is the UNIVERSE, not the data: identical candles, one
// serves a number, the other serves null.

const test = require("node:test");
const assert = require("node:assert");
const { buildApiState } = require("../src/apistate.js");

const NOW = 10000000;

// Coin with a 15m slot rich enough for rvol15: 8 closed bars of v=100
// (avg 100) and a forming bar 5 min old with v=50 -> frac 1/3 -> rvol 1.5.
function coin(name, sym, uni) {
  const closed = [];
  for (let i = 0; i < 8; i++) {
    closed.push({ t: i, o: 100, h: 101, l: 99, c: 100, v: 100 });
  }
  return {
    name: name, sym: sym, uni: uni, mid: 100, hist: [],
    ctx: { markPx: "100", prevDayPx: "99", dayNtlVlm: "1000" },
    tf: {
      "15m": {
        closed: closed,
        forming: { t: NOW - 300000, T: NOW + 600000, o: 100, h: 101, l: 99, c: 100, v: 50 }
      }
    }
  };
}

function stateOf(trueUpUniverses) {
  const st = {
    order: ["xyz:NVDA", "BTC"],
    coins: {
      "xyz:NVDA": coin("xyz:NVDA", "NVDA", "xyz"),
      "BTC": coin("BTC", "BTC", "perps")
    },
    loaded: true,
    universes: ["xyz", "perps"]
  };
  if (trueUpUniverses) st.trueUpUniverses = trueUpUniverses;
  return st;
}

function byName(out) {
  const m = {};
  out.coins.forEach(function (c) { m[c.name] = c; });
  return m;
}

test("rvol: number inside the true-up scope, null outside - same candles", function () {
  const out = byName(buildApiState(stateOf(["xyz"]), ["15m"], null, NOW));
  assert.ok(Math.abs(out["xyz:NVDA"].rvol - 1.5) < 1e-9, "scoped universe serves the computed rvol");
  assert.strictEqual(out["BTC"].rvol, null, "unscoped universe serves null, not a decaying number");
});

test("rvol: a state without trueUpUniverses (legacy) serves every coin's rvol", function () {
  const out = byName(buildApiState(stateOf(null), ["15m"], null, NOW));
  assert.ok(Math.abs(out["xyz:NVDA"].rvol - 1.5) < 1e-9);
  assert.ok(Math.abs(out["BTC"].rvol - 1.5) < 1e-9, "no scope declared -> no nulling");
});

test("rvol: a scope listing every universe changes nothing", function () {
  const out = byName(buildApiState(stateOf(["xyz", "perps"]), ["15m"], null, NOW));
  assert.ok(Math.abs(out["xyz:NVDA"].rvol - 1.5) < 1e-9);
  assert.ok(Math.abs(out["BTC"].rvol - 1.5) < 1e-9);
});
