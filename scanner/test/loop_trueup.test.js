"use strict";

// The 5-min 15m true-up's universe SCOPING (loop.js trueUp15m, P0-6 demand
// cut, design decision 2026-08-17). At 271 coins the all-coins true-up cost ~5,420
// rate-limit weight per burst against Hyperliquid's 1,200/min per-IP budget -
// the largest single line item behind the measured mids stalls. The true-up
// now runs only for hooks.trueUpUniverses (production: the alert universes,
// whose rvol_spike needs intra-period volume); absent or empty keeps the
// legacy all-coins behavior so unit tests and alerts-disabled deploys are
// unchanged. Bar-roll refetches are NOT scoped - analysis correctness is
// untouched everywhere.

const test = require("node:test");
const assert = require("node:assert");
const { createLoop } = require("../src/loop.js");

const realFetch = globalThis.fetch;
test.afterEach(function () { globalThis.fetch = realFetch; });

function stubCandles() {
  const snaps = [];
  globalThis.fetch = async function (url, opts) {
    const body = JSON.parse(opts.body);
    if (body.type === "candleSnapshot") snaps.push(body.req.coin);
    return { status: 200, ok: true, json: async function () { return []; } };
  };
  return snaps;
}

function seedCoin(loop, name, uni) {
  loop.state.coins[name] = {
    name: name, sym: name.split(":")[1] || name, uni: uni,
    ctx: null, mid: 100, tf: {}, hist: []
  };
  loop.state.order.push(name);
}

const UNIS = [{ id: "xyz", dex: "xyz" }, { id: "perps", dex: null }];

test("trueUp15m fetches ONLY coins in the scoped universes", async function () {
  const snaps = stubCandles();
  const loop = createLoop({}, { universes: UNIS, trueUpUniverses: ["xyz"], log: function () {} });
  seedCoin(loop, "xyz:NVDA", "xyz");
  seedCoin(loop, "BTC", "perps");
  await loop.trueUp15m();
  assert.deepStrictEqual(snaps, ["xyz:NVDA"], "perps coin excluded from the true-up burst");
  assert.deepStrictEqual(loop.state.trueUpUniverses, ["xyz"], "scope rides state for /health + apistate");
});

test("no scope hook keeps the legacy all-coins true-up", async function () {
  const snaps = stubCandles();
  const loop = createLoop({}, { universes: UNIS, log: function () {} });
  seedCoin(loop, "xyz:NVDA", "xyz");
  seedCoin(loop, "BTC", "perps");
  await loop.trueUp15m();
  assert.deepStrictEqual(snaps.sort(), ["BTC", "xyz:NVDA"], "every coin trued");
  assert.deepStrictEqual(loop.state.trueUpUniverses, ["xyz", "perps"],
    "unscoped resolves to ALL tracked ids - consumers read one shape either way");
});

test("an EMPTY scope array trues up NOTHING (review: never expand to all)", async function () {
  // This test previously pinned [] -> all-tracked. That expansion is the
  // budget hole: an empty broadcast alert scope (e.g. UNIVERSES=perps with
  // favorites-only alerting) silently re-created the all-perps candle burst
  // the demand cut removed. [] now means exactly what it says; only ABSENT falls back
  // to the legacy all-tracked behavior (previous test).
  const snaps = stubCandles();
  const loop = createLoop({}, { universes: UNIS, trueUpUniverses: [], log: function () {} });
  seedCoin(loop, "BTC", "perps");
  await loop.trueUp15m();
  assert.deepStrictEqual(snaps, [], "no universe in scope, no true-up fetches");
  assert.deepStrictEqual(loop.state.trueUpUniverses, [],
    "consumers see the empty scope and serve rvol null everywhere");
});

test("a scope with no registered coins fetches nothing and releases the tf guard", async function () {
  const snaps = stubCandles();
  const loop = createLoop({}, { universes: UNIS, trueUpUniverses: ["xyz"], log: function () {} });
  seedCoin(loop, "BTC", "perps");
  await loop.trueUp15m();
  assert.deepStrictEqual(snaps, [], "no candleSnapshot fired");
  const tf = loop.TFS.find(function (t) { return t.id === "15m"; });
  assert.strictEqual(!!tf.refetching, false, "guard not left held");
});
