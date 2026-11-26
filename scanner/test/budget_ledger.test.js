"use strict";

// The exchange request ledger (budget.js createLedger) and its wiring into
// loop.js post()/postMids(). The ledger is the MEASUREMENT channel for the
// exchange's refusal threshold (measured 2026-09-18): one line per clock
// minute, per-kind attempts/outcomes, 10 s ok/429 buckets, and the
// successes-before-first-429 count that reads the window budget directly.
// These tests pin the accounting so a line in the deploy log means what
// the analysis assumes it means.

const test = require("node:test");
const assert = require("node:assert");
const { createLedger, kindOf } = require("../src/budget.js");
const { createLoop } = require("../src/loop.js");

const realFetch = globalThis.fetch;
test.afterEach(function () { globalThis.fetch = realFetch; });

const T0 = Date.UTC(2026, 8, 18, 12, 0, 0);   // 12:00:00.000Z, a minute boundary

// Tests that simulate a 429 through post() inject a limiter that never
// holds: the real one would hold the lanes until the next clock minute.
const NO_LIMIT = {
  acquire: async function () {}, take: function () { return true; },
  penalize: function () {}, stats: function () { return {}; }, stop: function () {}
};

function makeLedger(lines) {
  let t = T0;
  const ledger = createLedger({ now: function () { return t; }, log: function (l) { lines.push(l); } });
  ledger.setNow = function (v) { t = v; };
  return ledger;
}

test("kindOf maps the three exchange request types; anything else is other", function () {
  assert.strictEqual(kindOf({ type: "candleSnapshot", req: {} }), "candle");
  assert.strictEqual(kindOf({ type: "metaAndAssetCtxs", dex: "xyz" }), "ctx");
  assert.strictEqual(kindOf({ type: "allMids" }), "mids");
  assert.strictEqual(kindOf({ type: "l2Book" }), "other");
  assert.strictEqual(kindOf(null), "other");
});

test("a minute line carries per-kind counts, 10 s buckets, and okBefore429 in that kind's units", function () {
  const lines = [];
  const L = makeLedger(lines);
  // 12:00: 3 candle ok in bucket 0, then a 429 at +12 s (bucket 1), then a
  // mids ok at +15 s (after the first 429), a mids 429 at +20 s, a net error.
  L.attempt("candle", T0 + 1000); L.outcome("candle", "ok", T0 + 1200);
  L.attempt("candle", T0 + 2000); L.outcome("candle", "ok", T0 + 2200);
  L.attempt("mids", T0 + 4000);   L.outcome("mids", "ok", T0 + 4100);
  L.attempt("candle", T0 + 3000); L.outcome("candle", "ok", T0 + 3200);
  L.attempt("candle", T0 + 12000); L.outcome("candle", "429", T0 + 12300);
  L.attempt("mids", T0 + 15000);  L.outcome("mids", "ok", T0 + 15100);
  L.attempt("mids", T0 + 20000);  L.outcome("mids", "429", T0 + 20100);
  L.attempt("ctx", T0 + 30000);   L.outcome("ctx", "net", T0 + 45000);
  assert.strictEqual(lines.length, 0, "nothing emitted until the minute rolls");
  // The first record of the NEXT minute emits 12:00.
  L.attempt("mids", T0 + 60000 + 500);
  assert.strictEqual(lines.length, 1);
  const line = lines[0];
  assert.match(line, /^\[reqs\] 12:00Z /);
  assert.ok(line.indexOf("candle a=4 ok=3 429=1") >= 0, line);
  assert.ok(line.indexOf("mids a=3 ok=2 429=1") >= 0, line);
  assert.ok(line.indexOf("ctx a=1 ok=0 net=1") >= 0, line);
  // Buckets: +1.2/+2.2/+3.2/+4.1 s land in bucket 0; the 429 at +12.3 s and
  // the mids ok at +15.1 s in bucket 1; the mids 429 at +20.1 s in bucket 2.
  assert.ok(line.indexOf("10s ok/429: 4/0 1/1 0/1 0/0 0/0 0/0") >= 0, line);
  assert.ok(line.indexOf("first429=+12.3s") >= 0, line);
  // okBefore429: 3 candle + 1 mids landed before the 429 at +12.3 s; the
  // mids at +15.1 s is AFTER it.
  assert.ok(line.indexOf("okBefore429 candle=3 mids=1") >= 0, line);
  assert.ok(line.indexOf("okAfter429=1") >= 0, line);
});

test("a quiet minute between two active ones is emitted as an empty line, never a silent hole", function () {
  const lines = [];
  const L = makeLedger(lines);
  L.attempt("mids", T0 + 1000); L.outcome("mids", "ok", T0 + 1100);
  L.attempt("mids", T0 + 3 * 60000 + 1000);   // 12:03 - 12:01 and 12:02 had nothing
  assert.strictEqual(lines.length, 3);
  assert.match(lines[0], /^\[reqs\] 12:00Z mids a=1 ok=1 \| 10s ok\/429: 1\/0 0\/0 0\/0 0\/0 0\/0 0\/0$/);
  assert.match(lines[1], /^\[reqs\] 12:01Z  \| 10s ok\/429: 0\/0 0\/0 0\/0 0\/0 0\/0 0\/0$/);
  assert.match(lines[2], /^\[reqs\] 12:02Z  \| /);
});

test("stats(): lifetime totals plus the last completed and the in-progress minute", function () {
  const lines = [];
  const L = makeLedger(lines);
  L.attempt("candle", T0 + 1000); L.outcome("candle", "ok", T0 + 1200);
  L.attempt("candle", T0 + 2000); L.outcome("candle", "429", T0 + 2200);
  L.attempt("candle", T0 + 61000); L.outcome("candle", "http", T0 + 61200);
  const s = L.stats(T0 + 62000);
  assert.deepStrictEqual(s.lifetime.candle, { attempts: 3, ok: 1, r429: 1, http: 1, net: 0 });
  assert.deepStrictEqual(s.lifetime.mids, { attempts: 0, ok: 0, r429: 0, http: 0, net: 0 });
  assert.strictEqual(s.lastMinute.minute, "12:00Z");
  assert.strictEqual(s.lastMinute.perKind.candle.r429, 1);
  assert.strictEqual(s.lastMinute.first429AtMs, 2200);
  assert.strictEqual(s.currentMinute.minute, "12:01Z");
  assert.strictEqual(s.currentMinute.perKind.candle.http, 1);
  assert.strictEqual(s.currentMinute.first429AtMs, null);
  // stats() at a later minute rolls the record (the in-progress minute is
  // the one containing the probe's clock), so /health never shows a stale
  // "current" minute.
  const s2 = L.stats(T0 + 5 * 60000);
  assert.strictEqual(s2.currentMinute.minute, "12:05Z");
  assert.strictEqual(s2.lastMinute.minute, "12:04Z");
});

// --- wiring: loop.js records every exchange request through the ledger ---

function res(status, body) {
  return { status: status, ok: status >= 200 && status < 300, json: async function () { return body; } };
}

test("post() records kind and outcome for every attempt INCLUDING ladder retries", async function () {
  const lines = [];
  const L = makeLedger(lines);
  let n = 0;
  globalThis.fetch = async function (url, opts) {
    n++;
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.type, "metaAndAssetCtxs");
    if (n === 1) return res(429, {});
    return res(200, [{ universe: [{ name: "xyz:NVDA" }] }, [{ midPx: "1", markPx: "1" }]]);
  };
  const loop = createLoop({}, { universes: [{ id: "xyz", dex: "xyz" }], log: function () {}, ledger: L, limiter: NO_LIMIT });
  await loop.refreshCtxs();
  const s = L.stats();
  assert.deepStrictEqual(s.lifetime.ctx, { attempts: 2, ok: 1, r429: 1, http: 0, net: 0 },
    "the 429 and its retry are two attempts, two outcomes");
  assert.strictEqual(loop.ledger, L, "the loop exposes the ledger it records into");
});

test("postMids() records the mids kind: one attempt, its outcome, and a thrown fetch as net", async function () {
  const lines = [];
  const L = makeLedger(lines);
  let mode = "429";
  globalThis.fetch = async function () {
    if (mode === "throw") throw new Error("boom");
    return mode === "429" ? res(429, {}) : res(200, { "xyz:TSLA": "1" });
  };
  const loop = createLoop({}, { universes: [{ id: "xyz", dex: "xyz" }], log: function () {}, ledger: L, limiter: NO_LIMIT });
  await loop.refreshMids();
  mode = "ok"; await loop.refreshMids();
  mode = "throw"; await loop.refreshMids();
  assert.deepStrictEqual(L.stats().lifetime.mids, { attempts: 3, ok: 1, r429: 1, http: 0, net: 1 });
  assert.strictEqual(loop.state.midsFailures, 2, "the loop's own failure counter is untouched by the ledger");
});

test("candle fetches record as candle; a non-429 HTTP failure records as http", async function () {
  const lines = [];
  const L = makeLedger(lines);
  let n = 0;
  globalThis.fetch = async function (url, opts) {
    n++;
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.type, "candleSnapshot");
    return n === 1 ? res(404, {}) : res(200, []);
  };
  const loop = createLoop({}, { universes: [{ id: "xyz", dex: "xyz" }], log: function () {}, ledger: L });
  loop.state.coins["xyz:NVDA"] = { name: "xyz:NVDA", sym: "NVDA", uni: "xyz", ctx: null, mid: 1, tf: {}, hist: [] };
  loop.state.coins["xyz:TSLA"] = { name: "xyz:TSLA", sym: "TSLA", uni: "xyz", ctx: null, mid: 1, tf: {}, hist: [] };
  loop.state.order.push("xyz:NVDA", "xyz:TSLA");
  await loop.trueUp15m();
  assert.deepStrictEqual(L.stats().lifetime.candle, { attempts: 2, ok: 1, r429: 0, http: 1, net: 0 });
  assert.strictEqual(loop.state.candleFailures, 1);
});

test("a loop built without a ledger hook creates its own and logs the minute line through the loop log", async function () {
  const lines = [];
  globalThis.fetch = async function () { return res(200, { "xyz:TSLA": "1" }); };
  const loop = createLoop({}, { universes: [{ id: "xyz", dex: "xyz" }], log: function (l) { lines.push(l); } });
  await loop.refreshMids();
  assert.ok(loop.ledger && typeof loop.ledger.stats === "function");
  assert.strictEqual(loop.ledger.stats().lifetime.mids.ok, 1);
  // Roll the default ledger's minute with explicit stamps far from the
  // real clock: the completed minute's line must arrive on the LOOP log
  // (audit 2026-09-18: this test used to assert nothing about the line).
  const far = Date.UTC(2031, 0, 1, 0, 0, 0);
  loop.ledger.attempt("ctx", far); loop.ledger.outcome("ctx", "ok", far + 100);
  loop.ledger.attempt("ctx", far + 60000);
  const reqs = lines.filter(function (l) { return l.indexOf("[reqs] ") === 0; });
  assert.ok(reqs.length >= 1, "a minute line reached the loop log");
  assert.match(reqs[reqs.length - 1], /^\[reqs\] 00:00Z ctx a=1 ok=1 \| /);
});

test("an outcome that lands in the minute after its attempt is shown on that minute's line (audit L1)", function () {
  const lines = [];
  const L = makeLedger(lines);
  L.attempt("ctx", T0 + 59900);
  L.outcome("ctx", "429", T0 + 60100);      // completes at 12:01:00.1
  L.attempt("mids", T0 + 120000);           // roll to 12:02 -> emits 12:00 and 12:01
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /^\[reqs\] 12:00Z ctx a=1 ok=0 \| /);
  assert.match(lines[1], /^\[reqs\] 12:01Z ctx a=0 ok=0 429=1 \| 10s ok\/429: 0\/1 /, "zero attempts, one refusal: still on the line");
  assert.ok(lines[1].indexOf("first429=+0.1s") >= 0, lines[1]);
  const st = L.stats(T0 + 120000);
  assert.strictEqual(st.lastMinute.perKind.ctx.r429, 1, "/health agrees with the line");
});
