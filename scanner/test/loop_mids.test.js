"use strict";

// The mids-tape ladder EXEMPTION (loop.js postMids, P0-6 2026-08-17). The 4s
// mids poll must fail FAST: its cadence is the retry mechanism, and a retry
// ladder inside one poll (the candle/ctx post() behavior) converts a transient
// 429 window into a 31-52s mids gap - measured live: every 5-min all-coins 15m
// true-up burst (~5,420 weight vs the venue's 1,200/min IP budget) opened a
// ~30s 429 window, the ladder stretched it past metrics.MID_STALE_MS (30s),
// and the dashboard's momentum blanked (the "-" flicker). These tests pin the
// ASYMMETRY: refreshMids makes exactly one attempt per universe while the ctx
// path keeps its ladder - the exemption must never silently spread or vanish.

const test = require("node:test");
const assert = require("node:assert");
const { createLoop } = require("../src/loop.js");

const realFetch = globalThis.fetch;
test.afterEach(function () { globalThis.fetch = realFetch; });

function res429() { return { status: 429, ok: false, json: async function () { return {}; } }; }
function res200(body) { return { status: 200, ok: true, json: async function () { return body; } }; }

// A 429 through post() penalizes the loop's request budget, which holds the
// candle/ctx lanes until the next REAL clock minute; tests that simulate a
// 429 inject a limiter that never holds (the budget has its own tests).
const NO_LIMIT = {
  acquire: async function () {}, take: function () { return true; },
  penalize: function () {}, stats: function () { return {}; }, stop: function () {}
};

function seedCoin(loop, name, uni) {
  loop.state.coins[name] = {
    name: name, sym: name.split(":")[1] || name, uni: uni,
    ctx: null, mid: null, tf: {}, hist: []
  };
  loop.state.order.push(name);
}

test("refreshMids fails fast on 429: ONE attempt, no retry ladder", async function () {
  const calls = [];
  globalThis.fetch = async function (url, opts) {
    calls.push(JSON.parse(opts.body));
    return res429();
  };
  const loop = createLoop({}, { universes: [{ id: "xyz", dex: "xyz" }], log: function () {} });
  const ok = await loop.refreshMids();
  // The candle/ctx ladder would have made SIX attempts on a persistent 429;
  // one call is the proof the mids path is exempt.
  assert.strictEqual(calls.length, 1, "exactly one attempt per universe");
  assert.deepStrictEqual(calls[0], { type: "allMids", dex: "xyz" });
  assert.strictEqual(ok, false);
  assert.strictEqual(loop.state.midsFailures, 1, "failure counted for /health");
  assert.strictEqual(loop.state.lastMids, 0, "freshness never advances on failure");
});

test("one universe 429ing does not sink the other; the failure is counted", async function () {
  globalThis.fetch = async function (url, opts) {
    const body = JSON.parse(opts.body);
    if (body.dex === "xyz") return res429();
    return res200({ NVDA: "123.5" });
  };
  const loop = createLoop({}, {
    universes: [{ id: "xyz", dex: "xyz" }, { id: "perps", dex: null }],
    log: function () {}
  });
  seedCoin(loop, "NVDA", "perps");
  const ok = await loop.refreshMids();
  assert.strictEqual(ok, true, "the healthy universe still lands");
  assert.strictEqual(loop.state.midsFailures, 1);
  assert.ok(loop.state.lastMidsByUni.perps > 0, "healthy universe stamped fresh");
  assert.strictEqual(loop.state.lastMidsByUni.xyz, undefined, "failed universe not stamped");
  assert.strictEqual(loop.state.coins.NVDA.mid, 123.5);
});

test("refreshMids success writes mid and tape sample together (momentum contract)", async function () {
  globalThis.fetch = async function () { return res200({ "xyz:TSLA": "42.5" }); };
  const loop = createLoop({}, { universes: [{ id: "xyz", dex: "xyz" }], log: function () {} });
  seedCoin(loop, "xyz:TSLA", "xyz");
  const revBefore = loop.state.revision;
  const ok = await loop.refreshMids();
  assert.strictEqual(ok, true);
  const c = loop.state.coins["xyz:TSLA"];
  assert.strictEqual(c.mid, 42.5);
  assert.strictEqual(c.hist.length, 1, "tape sample pushed with the mid");
  assert.strictEqual(c.hist[0].m, 42.5, "sample IS the endpoint observation");
  assert.ok(loop.state.lastMids > 0);
  assert.strictEqual(loop.state.midsFailures, 0);
  assert.ok(loop.state.revision > revBefore, "mids tick bumps the snapshot revision");
});

test("the ctx path KEEPS its retry ladder (the asymmetry, pinned)", async function () {
  // First response 429, second 200: post()'s ladder must absorb the 429 and
  // succeed on the retry. If someone "simplifies" ctx onto the fast path,
  // this fails - and the 2026-08-07 boot-429 incident class reopens.
  let n = 0;
  globalThis.fetch = async function () {
    n++;
    if (n === 1) return res429();
    return res200([{ universe: [{ name: "xyz:NVDA" }] }, [{ midPx: "100", markPx: "100" }]]);
  };
  const loop = createLoop({}, { universes: [{ id: "xyz", dex: "xyz" }], log: function () {}, limiter: NO_LIMIT });
  await loop.refreshCtxs();
  assert.strictEqual(n, 2, "429 retried, not surfaced");
  assert.deepStrictEqual(loop.state.order, ["xyz:NVDA"], "refresh succeeded through the ladder");
  assert.strictEqual(loop.state.midsFailures, 0, "ctx failures never touch the mids counter");
});
