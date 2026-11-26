"use strict";

// The client-side request budget (budget.js createLimiter, A1) and the
// timeframe/signal ordering of sweeps (loop.js makeQueue / refreshTF, A2).
// Measured 2026-09-18: the boundary candle sweeps exhausted the
// exchange's clock-aligned per-minute window and the allMids poll was
// refused for 40-56 s per roll. These tests pin the guarantees the fix
// rests on: consumption in any 60 s span is bounded by burst + rate, the
// ctx lane goes before the candle lane, the mids poll never waits, a 429
// holds the lanes until the next :00 and cuts the rate, the rate restores
// after a clean hour, and stacked timeframes run one after another with
// live-signal coins first.

const test = require("node:test");
const assert = require("node:assert");
const budget = require("../src/budget.js");
const { createLoop, makeQueue, tfRank, hasLiveSignal, TFS } = require("../src/loop.js");

const realFetch = globalThis.fetch;
test.afterEach(function () { globalThis.fetch = realFetch; });

const T0 = Date.UTC(2026, 8, 18, 12, 0, 0);

// Deterministic clock + scheduler: the limiter's only time dependencies.
function fakeTime(start) {
  let t = start;
  const pending = [];
  let seq = 0;
  const api = {
    now: function () { return t; },
    setTimeout: function (fn, ms) { const id = ++seq; pending.push({ id: id, at: t + ms, fn: fn }); return id; },
    clearTimeout: function (id) { const i = pending.findIndex(function (p) { return p.id === id; }); if (i >= 0) pending.splice(i, 1); },
    // Advance the clock, firing due timers in order (each may re-arm).
    advance: async function (ms) {
      const target = t + ms;
      for (;;) {
        pending.sort(function (a, b) { return a.at - b.at; });
        if (!pending.length || pending[0].at > target) break;
        const p = pending.shift();
        t = Math.max(t, p.at);
        p.fn();
        await Promise.resolve(); await Promise.resolve();
      }
      t = target;
      await Promise.resolve(); await Promise.resolve();
    },
    pendingCount: function () { return pending.length; }
  };
  return api;
}

function makeLimiter(ft, extra) {
  const lines = [];
  const l = budget.createLimiter(Object.assign({
    now: ft.now, setTimeout: ft.setTimeout, clearTimeout: ft.clearTimeout,
    log: function (x) { lines.push(x); }
  }, extra || {}));
  l.lines = lines;
  return l;
}

test("burst grants immediately; beyond it, acquires are paced at the rate (any 60 s span <= burst + rate)", async function () {
  const ft = fakeTime(T0);
  const L = makeLimiter(ft, { ratePerMin: 2400, burst: 120 });   // 2 candles/s, 6-candle burst
  const granted = [];
  const N = 300;   // 2.5 minutes of work: more than any one 60 s span may hold
  for (let i = 0; i < N; i++) {
    L.acquire(20, "candle").then(function () { granted.push(ft.now()); });
  }
  await ft.advance(0);
  assert.strictEqual(granted.length, 6, "the burst covers exactly six candles at once");
  await ft.advance(1000);
  assert.strictEqual(granted.length, 8, "two more per second after the burst");
  await ft.advance(146000);
  assert.strictEqual(granted.length, N, "all granted within 147 s (6 burst + 2/s)");
  // No 60 s span holds more than burst + rate (6 + 120 = 126 candles). The
  // pin is EXACT so it can fail: a half-open [t, t+60s) span starting at
  // the burst holds the 6 burst grants plus 119 refill grants at 0.5 s
  // steps (0.5 .. 59.5) = 125 (audit 2026-09-18: with 60 requests the old
  // <= 126 assertion could not fail at all).
  let maxInSpan = 0;
  for (let i = 0; i < granted.length; i++) {
    const inSpan = granted.filter(function (g) { return g >= granted[i] && g < granted[i] + 60000; }).length;
    if (inSpan > maxInSpan) maxInSpan = inSpan;
  }
  assert.strictEqual(maxInSpan, 125, "the densest 60 s span holds burst + 119 refill grants");
  assert.strictEqual(L.stats().waits, N);
  assert.ok(L.stats().maxWaitMs >= 146000, "the last waiter waited ~147 s");
});

test("the ctx lane is granted before waiting candle work", async function () {
  const ft = fakeTime(T0);
  const L = makeLimiter(ft, { ratePerMin: 2400, burst: 20 });    // one candle of burst
  const order = [];
  L.acquire(20, "candle").then(function () { order.push("c1"); });
  L.acquire(20, "candle").then(function () { order.push("c2"); });
  L.acquire(20, "candle").then(function () { order.push("c3"); });
  await ft.advance(0);
  assert.deepStrictEqual(order, ["c1"], "burst covers the first candle only");
  L.acquire(20, "ctx").then(function () { order.push("ctx"); });
  await ft.advance(1500);
  assert.deepStrictEqual(order, ["c1", "ctx", "c2", "c3"], "ctx jumped the queued candles");
});

test("take() never waits: it always deducts (into debt), and reports whether the bucket covered it", async function () {
  const ft = fakeTime(T0);
  const L = makeLimiter(ft, { ratePerMin: 2400, burst: 40 });
  assert.strictEqual(L.take(20), true);
  assert.strictEqual(L.stats().tokens, 20);
  assert.strictEqual(L.take(30), false, "not covered, but still deducted - into debt");
  assert.strictEqual(L.stats().tokens, -10);
  assert.strictEqual(L.stats().midsUncovered, 1);
  assert.strictEqual(L.take(20), false);
  assert.strictEqual(L.stats().tokens, -30);
  assert.strictEqual(L.stats().midsUncovered, 2);
  // A lane waits for the debt to be repaid AND its own cost: -30 -> +20 is
  // 50 units at 40/s = 1.25 s.
  const granted = [];
  L.acquire(20, "candle").then(function () { granted.push(ft.now() - T0); });
  await ft.advance(1200);
  assert.deepStrictEqual(granted, []);
  await ft.advance(100);
  assert.deepStrictEqual(granted, [1250]);
});

test("a production-cadence mids poll costs a full request unit, so the candle lane gets the remainder", async function () {
  // Measured 2026-09-18: 20 spaced allMids cost 22 candle-equivalents
  // against a candles-only control. Two universes polled every 4 s = 30
  // units/min out of 120: the candle lane must see ~88/min, not ~117.
  assert.strictEqual(budget.COST.mids, budget.COST.candle);
  const ft = fakeTime(T0);
  const L = makeLimiter(ft, { ratePerMin: 2400, burst: 120 });
  let candles = 0;
  for (let i = 0; i < 400; i++) L.acquire(20, "candle").then(function () { candles++; });
  for (let s = 0; s < 120; s++) {          // two minutes, two polls every 4 s
    await ft.advance(1000);
    if (s % 4 === 3) { L.take(20); L.take(20); }
  }
  // 120 s x 40 units/s = 4,800 + burst 120 = 4,920 units; mids took 60
  // polls x 20 = 1,200 -> ~3,720 for candles = 186, i.e. ~90/min.
  assert.ok(candles >= 180 && candles <= 192, "candles granted in two minutes: " + candles);
});

test("a 429 drains the bucket, holds both lanes until the next :00 + slack, and cuts the rate 15%", async function () {
  const ft = fakeTime(T0 + 20000);   // 12:00:20
  const L = makeLimiter(ft, { ratePerMin: 2400, burst: 120 });
  const granted = [];
  L.penalize("candle");
  assert.strictEqual(L.stats().tokens, 0);
  assert.strictEqual(L.stats().ratePerMin, 2040);
  assert.strictEqual(L.stats().holdUntil, new Date(T0 + 60000 + budget.HOLD_SLACK_MS).toISOString());
  assert.strictEqual(L.stats().holds, 1);
  assert.match(L.lines[0], /^\[budget\] 429 \(candle\): hold until 12:01:01\.500Z, rate 2400 -> 2040\/min$/);
  L.acquire(20, "ctx").then(function () { granted.push("ctx@" + (ft.now() - T0)); });
  L.acquire(20, "candle").then(function () { granted.push("candle@" + (ft.now() - T0)); });
  await ft.advance(39000);            // 12:00:59
  assert.deepStrictEqual(granted, [], "nothing granted during the hold");
  await ft.advance(2500);             // 12:01:01.5
  // Tokens refill (to the burst cap) DURING the hold, so the release opens
  // with the normal six-candle burst into the fresh window - ctx first.
  assert.deepStrictEqual(granted, ["ctx@61500", "candle@61500"], "both granted at the hold's end, ctx lane first");
  assert.strictEqual(L.stats().holdUntil, null, "hold expired");
  // A NEW exhaustion event (outside the expired hold) cuts the rate again.
  L.penalize("mids");
  assert.strictEqual(L.take(2), false, "the mids poll still deducts during a hold and is never queued");
  assert.strictEqual(L.stats().ratePerMin, 1734);
  assert.strictEqual(L.stats().holds, 2);
});

test("429s INSIDE an active hold extend nothing and never compound the rate cut (the mids canary keeps polling)", async function () {
  const ft = fakeTime(T0 + 2000);           // 12:00:02
  const L = makeLimiter(ft, { ratePerMin: 2400, burst: 120 });
  L.penalize("candle");
  assert.strictEqual(L.stats().ratePerMin, 2040);
  const hold = L.stats().holdUntil;
  // Fourteen refused polls on the real 4 s cadence, 12:00:06 .. 12:00:58 -
  // time advances between them, so a hold that re-extended on each refusal
  // would show a later holdUntil (audit 2026-09-18: one stamp could not).
  for (let i = 0; i < 14; i++) { await ft.advance(4000); L.penalize("mids"); }
  assert.strictEqual(ft.now(), T0 + 58000);
  assert.strictEqual(L.stats().ratePerMin, 2040, "one cut per exhaustion event, not per refusal");
  assert.strictEqual(L.stats().holds, 1);
  assert.strictEqual(L.stats().heldRefusals, 14);
  assert.strictEqual(L.stats().holdUntil, hold, "the hold end is the next :00 + slack, unchanged");
  assert.strictEqual(L.stats().tokens, 0, "each refusal still drains whatever refilled");
  assert.strictEqual(L.lines.length, 1, "one log line for the event, none for the expected refusals");
});

test("a 429 stamped EXACTLY on the minute holds through the next window, not 1.5 s into the exhausted one (audit M1)", async function () {
  const ft = fakeTime(T0);                    // 12:00:00.000 exactly
  const L = makeLimiter(ft, { ratePerMin: 2400, burst: 120 });
  L.penalize("candle");
  assert.strictEqual(L.stats().holdUntil, new Date(T0 + 60000 + budget.HOLD_SLACK_MS).toISOString(),
    "hold ends at 12:01:01.5, the next window");
  const granted = [];
  L.acquire(20, "candle").then(function () { granted.push(ft.now() - T0); });
  await ft.advance(1500);
  assert.deepStrictEqual(granted, [], "12:00:01.5 is inside the exhausted window");
  await ft.advance(60000);
  assert.deepStrictEqual(granted, [61500]);
});

test("the rate floors at MIN_RATE_PER_MIN and restores to the configured rate after a clean hour", async function () {
  const ft = fakeTime(T0);
  const L = makeLimiter(ft, { ratePerMin: 700, burst: 20 });
  L.penalize("candle");
  assert.strictEqual(L.stats().ratePerMin, 600, "700 x 0.85 = 595 floors at 600");
  L.penalize("candle");
  assert.strictEqual(L.stats().ratePerMin, 600);
  await ft.advance(budget.RECOVER_AFTER_MS - 1);
  L.acquire(20, "candle");
  await ft.advance(0);
  assert.strictEqual(L.stats().ratePerMin, 600, "not yet");
  await ft.advance(2);
  L.acquire(20, "candle");
  await ft.advance(0);
  assert.strictEqual(L.stats().ratePerMin, 700, "restored on the first pump after the clean hour");
  assert.strictEqual(L.stats().restores, 1);
  assert.ok(L.lines.some(function (x) { return /^\[budget\] rate restored 600 -> 700\/min after 60 clean minutes$/.test(x); }));
});

test("restore is one step per clean hour, so two events need two clean hours to undo", async function () {
  const ft = fakeTime(T0);
  const L = makeLimiter(ft, { ratePerMin: 2400, burst: 20 });
  L.penalize("candle");                       // 2040
  await ft.advance(90000);
  L.penalize("candle");                       // 1734, a new event after the hold
  assert.strictEqual(L.stats().ratePerMin, 1734);
  await ft.advance(budget.RECOVER_AFTER_MS);
  L.acquire(20, "candle"); await ft.advance(0);
  assert.strictEqual(L.stats().ratePerMin, 2040, "one step back, not the full rate");
  assert.ok(L.lines.some(function (x) { return /rate restored 1734 -> 2040\/min after 60 clean minutes \(configured 2400\)$/.test(x); }));
  await ft.advance(budget.RECOVER_AFTER_MS - 1000);
  L.acquire(20, "candle"); await ft.advance(0);
  assert.strictEqual(L.stats().ratePerMin, 2040, "the second step needs its own clean hour");
  await ft.advance(2000);
  L.acquire(20, "candle"); await ft.advance(0);
  assert.strictEqual(L.stats().ratePerMin, 2400);
  assert.strictEqual(L.stats().restores, 2);
});

test("stop() clears the pending pump timer", async function () {
  const ft = fakeTime(T0);
  const L = makeLimiter(ft, { ratePerMin: 2400, burst: 20 });
  L.acquire(20, "candle"); L.acquire(20, "candle");
  await ft.advance(0);
  assert.strictEqual(ft.pendingCount(), 1);
  L.stop();
  assert.strictEqual(ft.pendingCount(), 0);
});

test("a hold with nobody waiting arms no timer; a waiter arriving during the hold arms one for the hold's end", async function () {
  const ft = fakeTime(T0 + 20000);
  const L = makeLimiter(ft, { ratePerMin: 2400, burst: 120 });
  L.penalize("mids");
  assert.strictEqual(ft.pendingCount(), 0, "nothing to wake, no timer (a stray 61 s timer kept test processes alive)");
  const granted = [];
  L.acquire(20, "candle").then(function () { granted.push(ft.now() - T0); });
  await ft.advance(0);
  assert.strictEqual(ft.pendingCount(), 1);
  await ft.advance(41500);
  assert.deepStrictEqual(granted, [61500]);
  assert.strictEqual(ft.pendingCount(), 0, "granted, queue empty, timer gone");
});

test("defaults: the measured rate and a six-candle burst; a bad override falls back", function () {
  const a = budget.createLimiter({});
  assert.strictEqual(a.stats().configuredRatePerMin, budget.DEFAULT_RATE_PER_MIN);
  assert.strictEqual(a.stats().burst, 6 * budget.COST.candle);
  const b = budget.createLimiter({ ratePerMin: "junk" });
  assert.strictEqual(b.stats().configuredRatePerMin, budget.DEFAULT_RATE_PER_MIN);
  const c = budget.createLimiter({ ratePerMin: 100 });
  assert.strictEqual(c.stats().configuredRatePerMin, budget.MIN_RATE_PER_MIN, "cannot configure below the floor");
  assert.throws(function () { a.acquire(20, "mids"); }, /unknown budget lane/);
  a.stop(); b.stop(); c.stop();
});

// --- A2: the priority queue and sweep ordering --------------------------

function stepQueue(release, n) {
  return (async function () {
    for (let i = 0; i < n; i++) { release.shift()(); await Promise.resolve(); await Promise.resolve(); }
  })();
}

test("makeQueue: within ONE batch the lowest rank dispatches first, FIFO within a rank", async function () {
  const enqueue = makeQueue(1);
  const ran = [];
  const release = [];
  function job(name) {
    return function () { return new Promise(function (res) { ran.push(name); release.push(res); }); };
  }
  const b = enqueue.newBatch();
  enqueue(job("d1"), 4, b); enqueue(job("d2"), 4, b);
  enqueue(job("m1"), 0, b); enqueue(job("h1"), 2, b); enqueue(job("m2"), 0, b);
  await Promise.resolve();
  assert.deepStrictEqual(ran, ["d1"], "the first job was already running (nothing else was queued)");
  assert.strictEqual(enqueue.pending(), 4);
  await stepQueue(release, 1);
  assert.deepStrictEqual(ran, ["d1", "m1"], "rank 0 before the queued 1d job of the same batch");
  enqueue(job("m3"), 0, b);
  await stepQueue(release, 4);
  assert.deepStrictEqual(ran, ["d1", "m1", "m2", "m3", "h1", "d2"]);
  release.shift()();
  assert.strictEqual(enqueue.pending(), 0);
});

test("makeQueue: a LATER batch never pre-empts an earlier one, whatever its rank (the daily-starvation fix)", async function () {
  // 2026-09-19 00:00 UTC: the daily sweep was still unfinished 52 minutes
  // after the roll because every later 15m sweep (rank 0) jumped its queued
  // 1d jobs (rank 4). Batches are FIFO; rank orders only inside a batch.
  const enqueue = makeQueue(1);
  const ran = [];
  const release = [];
  function job(name) {
    return function () { return new Promise(function (res) { ran.push(name); release.push(res); }); };
  }
  const stack = enqueue.newBatch();
  enqueue(job("15m-a"), 0, stack); enqueue(job("1d-a"), 4, stack); enqueue(job("1d-b"), 4, stack);
  await Promise.resolve();
  const later = enqueue.newBatch();               // the 00:15 sweep arrives
  enqueue(job("15m-later"), 0, later);
  await stepQueue(release, 3);
  assert.deepStrictEqual(ran, ["15m-a", "1d-a", "1d-b", "15m-later"], "the stack's daily jobs finish before the later 15m sweep");
  release.shift()();
});

test("makeQueue: jobs enqueued without a batch share batch 0 and keep plain rank order", async function () {
  const enqueue = makeQueue(1);
  const ran = [];
  const release = [];
  function job(name) {
    return function () { return new Promise(function (res) { ran.push(name); release.push(res); }); };
  }
  enqueue(job("x"), 4); enqueue(job("y"), 4); enqueue(job("z"), 0);
  await Promise.resolve();
  await stepQueue(release, 2);
  assert.deepStrictEqual(ran, ["x", "z", "y"]);
  release.shift()();
});

test("tfRank is the fetched-timeframe order; derived W/M never rank", function () {
  const ids = TFS.filter(function (t) { return !t.derived; }).map(function (t) { return t.id; });
  assert.deepStrictEqual(ids, ["15m", "30m", "1h", "4h", "1d"]);
  assert.deepStrictEqual(ids.map(function (id) { return tfRank(TFS.find(function (t) { return t.id === id; })); }), [0, 1, 2, 3, 4]);
});

test("hasLiveSignal reads an.live on any timeframe slot", function () {
  assert.strictEqual(hasLiveSignal(null), false);
  assert.strictEqual(hasLiveSignal({ tf: {} }), false);
  assert.strictEqual(hasLiveSignal({ tf: { "15m": { an: { live: [] } }, "1d": { an: null } } }), false);
  assert.strictEqual(hasLiveSignal({ tf: { "15m": { an: { live: [] } }, "1d": { an: { live: [{ name: "2-2" }] } } } }), true);
});

function seed(loop, name, live) {
  loop.state.coins[name] = {
    name: name, sym: name, uni: "perps", ctx: null, mid: 1, hist: [],
    tf: live ? { "1h": { closed: [], forming: null, an: { live: [{ name: "2-2", dir: "up" }] } } } : {}
  };
  loop.state.order.push(name);
}

test("a stacked roll runs one timeframe after another, live-signal coins first within each", async function () {
  // Six coins, one worker's worth of concurrency is irrelevant here: the
  // ORDER requests reach fetch in is what the priority queue decides.
  const seen = [];
  const gates = [];
  globalThis.fetch = async function (url, opts) {
    const body = JSON.parse(opts.body);
    seen.push(body.req.interval + ":" + body.req.coin);
    await new Promise(function (res) { gates.push(res); });
    return { status: 200, ok: true, json: async function () { return []; } };
  };
  const ft = fakeTime(T0);
  const limiter = makeLimiter(ft, { ratePerMin: 60000, burst: 20000 });   // budget is not the subject here
  const loop = createLoop({}, { universes: [{ id: "perps", dex: null }], log: function () {}, limiter: limiter });
  ["A", "B", "C", "D"].forEach(function (n) { seed(loop, n, n === "B" || n === "D"); });
  const tf15 = TFS.find(function (t) { return t.id === "15m"; });
  const tf1d = TFS.find(function (t) { return t.id === "1d"; });
  const tf1h = TFS.find(function (t) { return t.id === "1h"; });
  // Enqueue in the timer's order but with the 1d and 1h BEFORE the 15m, as
  // a FIFO would interleave them; the queue must still run 15m first. All
  // three share one batch, exactly as the timer tick passes it.
  const batch = loop.newBatch();
  const p1 = loop.refreshTF(tf1d, undefined, batch);
  const p2 = loop.refreshTF(tf1h, undefined, batch);
  const p3 = loop.refreshTF(tf15, undefined, batch);
  await new Promise(function (r) { setTimeout(r, 20); });
  // Six workers took the first six jobs: with the 1d enqueued first and
  // running immediately (nothing else was queued), the dispatch order is
  // the 1d's first six... unless ranks reorder the QUEUED tail. Release all
  // and inspect the complete order.
  async function drain() {
    while (seen.length < 12) {
      while (gates.length) gates.shift()();
      await new Promise(function (r) { setTimeout(r, 5); });
    }
    while (gates.length) gates.shift()();
  }
  await drain();
  await Promise.all([p1, p2, p3]);
  // The queue is six wide: the four 1d jobs took four workers at once
  // (nothing else was queued), the first two 1h jobs took the remaining
  // two - dispatched work cannot be recalled. Everything QUEUED from that
  // point dispatches by rank: all four 15m jobs before the last two 1h.
  assert.deepStrictEqual(seen.slice(0, 4), ["1d:B", "1d:D", "1d:A", "1d:C"], "live-signal coins B and D lead the 1d sweep");
  assert.deepStrictEqual(seen.slice(4, 6), ["1h:B", "1h:D"], "two free workers took the 1h's live-first head");
  assert.deepStrictEqual(seen.slice(6), ["15m:B", "15m:D", "15m:A", "15m:C", "1h:A", "1h:C"],
    "queued work runs 15m before the rest of the 1h, live-first within each");
  limiter.stop();
});

test("the timer's real shape: every timeframe enqueued in one tick runs 15m, then 30m, then 1d", async function () {
  const seen = [];
  globalThis.fetch = async function (url, opts) {
    const body = JSON.parse(opts.body);
    seen.push(body.req.interval);
    await new Promise(function (r) { setTimeout(r, 2); });
    return { status: 200, ok: true, json: async function () { return []; } };
  };
  const ft = fakeTime(T0);
  const limiter = makeLimiter(ft, { ratePerMin: 60000, burst: 20000 });
  const loop = createLoop({}, { universes: [{ id: "perps", dex: null }], log: function () {}, limiter: limiter });
  for (let i = 0; i < 9; i++) seed(loop, "C" + i, false);
  const byId = function (id) { return TFS.find(function (t) { return t.id === id; }); };
  // Same synchronous tick, TFS order - exactly what the 5 s bar-roll timer does.
  const batch = loop.newBatch();
  await Promise.all([loop.refreshTF(byId("15m"), undefined, batch), loop.refreshTF(byId("30m"), undefined, batch), loop.refreshTF(byId("1d"), undefined, batch)]);
  assert.strictEqual(seen.length, 27);
  assert.deepStrictEqual(seen.slice(0, 9), Array(9).fill("15m"), "the 15m sweep completes first");
  assert.deepStrictEqual(seen.slice(9, 18), Array(9).fill("30m"), "then the 30m");
  assert.deepStrictEqual(seen.slice(18), Array(9).fill("1d"), "then the 1d");
  limiter.stop();
});

test("the 5-min true-up yields while a stack is queued (never holds the 15m flag behind 1,400 fetches)", async function () {
  const { TRUEUP_YIELD_PENDING } = require("../src/loop.js");
  const gates = [];
  let fetched = 0;
  globalThis.fetch = async function () {
    fetched++;
    await new Promise(function (res) { gates.push(res); });
    return { status: 200, ok: true, json: async function () { return []; } };
  };
  const ft = fakeTime(T0);
  const limiter = makeLimiter(ft, { ratePerMin: 60000, burst: 20000 });
  const lines = [];
  const loop = createLoop({}, { universes: [{ id: "perps", dex: null }], log: function (l) { lines.push(l); }, limiter: limiter });
  for (let i = 0; i < TRUEUP_YIELD_PENDING + 20; i++) seed(loop, "C" + i, false);
  const tf1d = TFS.find(function (t) { return t.id === "1d"; });
  const stack = loop.refreshTF(tf1d);                     // 220 jobs, six in flight, the rest queued
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.ok(loop.queuePending() > TRUEUP_YIELD_PENDING, "stack queued: " + loop.queuePending());
  const before = fetched;
  await loop.trueUp15m();
  assert.strictEqual(fetched, before, "no true-up fetch was queued");
  assert.ok(lines.some(function (l) { return /^15m true-up skipped \(\d+ candle fetches queued\)$/.test(l); }), lines.join("|"));
  assert.strictEqual(tf1d.refetching, undefined, "refreshTF itself never touches the flag");
  assert.ok(!TFS.find(function (t) { return t.id === "15m"; }).refetching, "the 15m flag is not held");
  while (fetched < TRUEUP_YIELD_PENDING + 20) { while (gates.length) gates.shift()(); await new Promise(function (r) { setTimeout(r, 2); }); }
  while (gates.length) gates.shift()();
  await stack;
  limiter.stop();
});

test("every post() acquires its lane before fetch and a 429 penalizes; the mids poll takes (a full unit) without waiting", async function () {
  const calls = [];
  // acquire resolves only when the test releases it, so a post() that
  // stopped awaiting permission would reach fetch before "granted"
  // (audit 2026-09-18: an immediately resolved acquire could not tell).
  const grants = [];
  const limiter = {
    acquire: function (cost, lane) {
      calls.push("acquire:" + lane + ":" + cost);
      return new Promise(function (res) { grants.push(function () { calls.push("granted"); res(); }); });
    },
    take: function (cost) { calls.push("take:" + cost); return true; },
    penalize: function (kind) { calls.push("penalize:" + kind); },
    stats: function () { return {}; }, stop: function () {}
  };
  const releaseAll = setInterval(function () { while (grants.length) grants.shift()(); }, 1);
  let n = 0;
  globalThis.fetch = async function (url, opts) {
    const body = JSON.parse(opts.body);
    calls.push("fetch:" + body.type);
    n++;
    if (body.type === "allMids") return { status: 429, ok: false, json: async function () { return {}; } };
    if (body.type === "metaAndAssetCtxs") {
      if (n === 2) return { status: 429, ok: false, json: async function () { return {}; } };
      return { status: 200, ok: true, json: async function () { return [{ universe: [] }, []]; } };
    }
    return { status: 200, ok: true, json: async function () { return []; } };
  };
  const loop = createLoop({}, { universes: [{ id: "xyz", dex: "xyz" }], log: function () {}, limiter: limiter });
  await loop.refreshMids();
  assert.deepStrictEqual(calls, ["take:20", "fetch:allMids", "penalize:mids"], "mids: take a full unit, never acquire; its 429 is the canary");
  calls.length = 0;
  await loop.refreshCtxs();
  assert.deepStrictEqual(calls,
    ["acquire:ctx:20", "granted", "fetch:metaAndAssetCtxs", "penalize:ctx", "acquire:ctx:20", "granted", "fetch:metaAndAssetCtxs"],
    "ctx: acquire and WAIT for the grant before EACH attempt, including the ladder retry after the 429");
  calls.length = 0;
  seed(loop, "xyz:NVDA", false);
  await loop.trueUp15m();
  assert.deepStrictEqual(calls, ["acquire:candle:20", "granted", "fetch:candleSnapshot"]);
  assert.strictEqual(loop.limiter, limiter, "the loop exposes the limiter it uses");
  clearInterval(releaseAll);
});

test("a thrown fetch (timeout, reset) re-acquires before its retry; a network failure never penalizes", async function () {
  const calls = [];
  const limiter = {
    acquire: async function (cost, lane) { calls.push("acquire:" + lane); },
    take: function () { return true; }, penalize: function (kind) { calls.push("penalize:" + kind); },
    stats: function () { return {}; }, stop: function () {}
  };
  let n = 0;
  globalThis.fetch = async function () {
    n++;
    if (n === 1) throw new Error("fetch failed");
    return { status: 200, ok: true, json: async function () { return []; } };
  };
  const loop = createLoop({}, { universes: [{ id: "xyz", dex: "xyz" }], log: function () {}, limiter: limiter });
  seed(loop, "xyz:NVDA", false);
  await loop.trueUp15m();
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(calls, ["acquire:candle", "acquire:candle"],
    "two attempts, two acquires; the failed attempt's budget is not refunded (receipt by the exchange is unknown)");
});

// --- candleSnapshot size component (2026-09-19) ---------------------------

test("costOf: the base unit plus one per 60 bars requested for candleSnapshot; every other kind is the base unit", function () {
  const now = Date.UTC(2026, 8, 19, 16, 0, 0);
  function candle(interval, bars, ms) {
    return { type: "candleSnapshot", req: { coin: "xyz:NVDA", interval: interval, startTime: now - bars * ms, endTime: now } };
  }
  assert.strictEqual(budget.costOf(candle("15m", 40, 900000)), 20, "15m x 40 (the base tf)");
  assert.strictEqual(budget.costOf(candle("15m", 60, 900000)), 21);
  assert.strictEqual(budget.costOf(candle("30m", 12, 1800000)), 20, "30m x BARS_BACK");
  assert.strictEqual(budget.costOf(candle("1h", 168, 3600000)), 22, "1h x briefingBars 168");
  assert.strictEqual(budget.costOf(candle("4h", 12, 14400000)), 20);
  assert.strictEqual(budget.costOf(candle("1d", 220, 86400000)), 23, "1d x 220");
  assert.strictEqual(budget.costOf(candle("1d", 5000, 86400000)), 20 + 83);
  assert.strictEqual(budget.costOf({ type: "candleSnapshot", req: { coin: "BTC", interval: "7m", startTime: 0, endTime: now } }), 20, "unknown interval: base only");
  assert.strictEqual(budget.costOf({ type: "candleSnapshot", req: { coin: "BTC", interval: "1h", startTime: now, endTime: now } }), 20, "empty span: base only");
  assert.strictEqual(budget.costOf({ type: "candleSnapshot" }), 20, "no req: base only");
  assert.strictEqual(budget.costOf({ type: "metaAndAssetCtxs", dex: "xyz" }), 20);
  assert.strictEqual(budget.costOf({ type: "allMids" }), 20);
  assert.strictEqual(budget.costOf({ type: "userRole" }), 20);
  assert.strictEqual(budget.barsRequested({ interval: "1d", startTime: now - 220 * 86400000 + 1, endTime: now }), 220, "a partial bar counts whole");
});

test("post() acquires the size-inclusive cost: the 1d sweep pays 23 per coin, the 1h briefing tape 22, the 15m and 4h 20", async function () {
  const calls = [];
  const limiter = {
    acquire: async function (cost, lane) { calls.push(lane + ":" + cost); },
    take: function () { return true; }, penalize: function () {}, stats: function () { return {}; }, stop: function () {}
  };
  globalThis.fetch = async function () { return { status: 200, ok: true, json: async function () { return []; } }; };
  const loop = createLoop({}, { universes: [{ id: "xyz", dex: "xyz" }], log: function () {}, limiter: limiter });
  seed(loop, "xyz:NVDA", false);
  const byId = function (id) { return TFS.find(function (t) { return t.id === id; }); };
  await loop.refreshTF(byId("1d"), ["xyz:NVDA"]);
  await loop.refreshTF(byId("1h"), ["xyz:NVDA"]);
  await loop.refreshTF(byId("15m"), ["xyz:NVDA"]);
  await loop.refreshTF(byId("4h"), ["xyz:NVDA"]);
  assert.deepStrictEqual(calls, ["candle:23", "candle:22", "candle:20", "candle:20"]);
});

test("a cost above the burst is granted at a full bucket and the excess becomes debt (never a wait that cannot end)", async function () {
  const ft = fakeTime(T0);
  const L = makeLimiter(ft, { ratePerMin: 2400, burst: 20 });
  const granted = [];
  L.acquire(23, "candle").then(function () { granted.push(ft.now() - T0); });
  await ft.advance(0);
  assert.deepStrictEqual(granted, [0], "the full bucket covers the burst share at once");
  assert.strictEqual(L.stats().tokens, -3, "the excess is debt");
  L.acquire(20, "candle").then(function () { granted.push(ft.now() - T0); });
  await ft.advance(574);
  assert.deepStrictEqual(granted, [0]);
  await ft.advance(1);
  assert.deepStrictEqual(granted, [0, 575], "-3 -> 20 is 23 units at 40/s = 575 ms");
});

test("review 2026-09-19: the interval table matches TFS, the burst covers the largest real cost, and a broken span is capped", function () {
  // MED 1: the interval-to-ms map is the exchange's vocabulary, duplicated
  // from TFS; a TF whose ms diverged or a new fetched interval missing here
  // would silently mis-price its requests.
  TFS.filter(function (t) { return !t.derived; }).forEach(function (t) {
    assert.strictEqual(budget.INTERVAL_MS[t.id], t.ms, "INTERVAL_MS[" + t.id + "]");
  });
  // MED 2: every real request costs less than the burst, so the
  // excess-as-debt branch never fires in production.
  const now = Date.UTC(2026, 8, 19, 16, 0, 0);
  const BARS_BACK = 12;
  TFS.filter(function (t) { return !t.derived; }).forEach(function (t) {
    const bars = t.briefingBars || t.bars || BARS_BACK;
    const cost = budget.costOf({ type: "candleSnapshot", req: { coin: "BTC", interval: t.id, startTime: now - bars * t.ms, endTime: now } });
    assert.ok(cost <= 23 && cost < budget.DEFAULT_BURST, t.id + " costs " + cost);
  });
  // MED 3: the size component caps at the exchange's 5,000-candle maximum
  // (83 extra units), whatever the span says.
  const cap = 20 + Math.floor(budget.MAX_BARS_PER_REQUEST / budget.ITEMS_PER_EXTRA_UNIT);
  assert.strictEqual(cap, 103);
  assert.ok(cap < budget.DEFAULT_BURST, "even the capped maximum is under the burst");
  assert.strictEqual(budget.costOf({ type: "candleSnapshot", req: { coin: "BTC", interval: "1m", startTime: 0, endTime: now } }), cap, "epoch-0 start on a 1m interval");
  assert.strictEqual(budget.costOf({ type: "candleSnapshot", req: { coin: "BTC", interval: "1m", startTime: null, endTime: now } }), cap, "null start reads as 0");
  assert.strictEqual(budget.costOf({ type: "candleSnapshot", req: { coin: "BTC", interval: "1m", startTime: -Infinity, endTime: now } }), cap, "an infinite span");
  assert.strictEqual(budget.costOf({ type: "candleSnapshot", req: { coin: "BTC", interval: "1m", startTime: NaN, endTime: now } }), 20, "NaN span is no span");
});

// 2026-09-20: batch-FIFO keyed by 15-minute PERIOD, not by timer tick.
// Measured on boot ad38f88f: at every 04/08/12/16/20:00 stack the 4h
// dispatched alone at the first tick while the 15m/30m/1h flags were held
// by the true-up or a stale-slot mini-sweep; those sweeps arrived 25-30 s
// later as LATER batches and ran behind the whole 4h. At 00:00 the 15m
// ran behind the 1d. One batch per period restores the A2 order.

test("rollBatchKey: every tick of one 15-minute period shares a batch; the next period is a later batch; the span is the base timeframe's", function () {
  const { rollBatchKey, ROLL_BATCH_MS } = require("../src/loop.js");
  assert.strictEqual(ROLL_BATCH_MS, 900000);
  assert.strictEqual(TFS[0].id, "15m", "the base fetched timeframe is the first TFS row");
  assert.strictEqual(TFS[0].ms, ROLL_BATCH_MS);
  const t = Date.UTC(2026, 8, 20, 4, 0, 0);
  assert.strictEqual(rollBatchKey(t + 5998), rollBatchKey(t + 31000), "the 04:00:05 tick and the 04:00:31 tick share a batch");
  assert.strictEqual(rollBatchKey(t + 5998), rollBatchKey(t + 14 * 60000 + 59000), "to the end of the period");
  assert.notStrictEqual(rollBatchKey(t + 5998), rollBatchKey(t + 15 * 60000 + 4000), "the 04:15 tick is a later batch");
  assert.notStrictEqual(rollBatchKey(t - 1), rollBatchKey(t), "03:59:59 is the previous period");
  assert.strictEqual(typeof rollBatchKey(t), "string", "never collides with newBatch()'s numeric ids");
});

test("makeQueue: a job naming a batch id still queued JOINS it at its rank; a drained id starts a fresh tail batch", async function () {
  const enqueue = makeQueue(1);
  const ran = [];
  const release = [];
  function job(name) {
    return function () { return new Promise(function (res) { ran.push(name); release.push(res); }); };
  }
  enqueue(job("4h-1"), 3, "roll:1"); enqueue(job("4h-2"), 3, "roll:1"); enqueue(job("4h-3"), 3, "roll:1");
  await Promise.resolve();
  enqueue(job("tu"), 0, enqueue.newBatch());                                   // a true-up wave arrives after the stack
  enqueue(job("15m-1"), 0, "roll:1"); enqueue(job("30m-1"), 1, "roll:1");    // the held sweeps dispatch a few ticks later
  await stepQueue(release, 5);
  assert.deepStrictEqual(ran, ["4h-1", "15m-1", "30m-1", "4h-2", "4h-3", "tu"],
    "the late sweeps run inside their stack by rank; the later wave still waits");
  await stepQueue(release, 1);
  assert.strictEqual(enqueue.pending(), 0);
  // The id has drained and later batches were queued since: naming it
  // again is a NEW batch behind them, never a revival of its old position.
  enqueue(job("x"), 4, enqueue.newBatch());
  await Promise.resolve();
  enqueue(job("y"), 4, enqueue.newBatch());
  enqueue(job("15m-late"), 0, "roll:1");
  await stepQueue(release, 2);
  assert.deepStrictEqual(ran.slice(6), ["x", "y", "15m-late"]);
  release.shift()();
  assert.strictEqual(enqueue.pending(), 0);
});

test("makeQueue: a batch whose jobs are ALL in flight stays joinable across an unrelated enqueue (review 2026-09-20 MED: no fragmentation)", async function () {
  // A 1-coin stale-slot mini-sweep under the period id dispatches at once
  // (queued count 0, one job in flight). A true-up wave enqueued next must
  // not evict it, so the period's boundary sweep still joins its batch and
  // runs ahead of the true-up, exactly as when the mini-sweep was queued.
  const enqueue = makeQueue(1);
  const ran = [];
  const release = [];
  function job(name) {
    return function () { return new Promise(function (res) { ran.push(name); release.push(res); }); };
  }
  enqueue(job("mini-15m"), 0, "roll:P");
  await Promise.resolve();
  assert.deepStrictEqual(ran, ["mini-15m"]);
  enqueue(job("tu"), 0, enqueue.newBatch());
  enqueue(job("4h-1"), 3, "roll:P"); enqueue(job("4h-2"), 3, "roll:P");
  enqueue(job("15m-1"), 0, "roll:P");
  await stepQueue(release, 4);
  assert.deepStrictEqual(ran, ["mini-15m", "15m-1", "4h-1", "4h-2", "tu"], "the period batch survived the true-up's enqueue");
  release.shift()();
  await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(enqueue.pending(), 0);
});

test("makeQueue: dispatch skips a batch that is only in flight instead of stalling behind it", async function () {
  const enqueue = makeQueue(2);
  const ran = [];
  const release = [];
  function job(name) {
    return function () { return new Promise(function (res) { ran.push(name); release.push(res); }); };
  }
  enqueue(job("p1"), 0, "roll:P");                 // in flight, batch P has nothing queued
  await Promise.resolve();
  enqueue(job("t1"), 0, enqueue.newBatch());       // a later batch: the second worker takes it now
  await Promise.resolve();
  assert.deepStrictEqual(ran, ["p1", "t1"], "the free worker was not held behind P's in-flight job");
  release.shift()(); release.shift()();
  await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(enqueue.pending(), 0);
});

test("makeQueue: a drained id with NOTHING queued behind it simply continues (no phantom batch churn while a wave is being enqueued)", async function () {
  const enqueue = makeQueue(2);
  const ran = [];
  const release = [];
  function job(name) {
    return function () { return new Promise(function (res) { ran.push(name); release.push(res); }); };
  }
  // Two workers: the first two jobs dispatch as they are enqueued (the
  // batch is momentarily empty between them), the third queues.
  enqueue(job("a"), 0, "roll:7"); enqueue(job("b"), 0, "roll:7"); enqueue(job("c"), 0, "roll:7");
  await Promise.resolve();
  assert.deepStrictEqual(ran, ["a", "b"]);
  assert.strictEqual(enqueue.pending(), 1);
  await stepQueue(release, 1);
  assert.deepStrictEqual(ran, ["a", "b", "c"]);
  release.shift()(); release.shift()();
  await Promise.resolve();
  assert.strictEqual(enqueue.pending(), 0);
});

test("the measured 2026-09-20 stack shape: the 4h dispatched alone at the tick, the held 15m/30m/1h arriving later in the SAME period still run before the 4h's queued tail", async function () {
  const { rollBatchKey } = require("../src/loop.js");
  const seen = [];
  const gates = [];
  globalThis.fetch = async function (url, opts) {
    const body = JSON.parse(opts.body);
    seen.push(body.req.interval);
    await new Promise(function (res) { gates.push(res); });
    return { status: 200, ok: true, json: async function () { return []; } };
  };
  const ft = fakeTime(T0);
  const limiter = makeLimiter(ft, { ratePerMin: 60000, burst: 20000 });
  const loop = createLoop({}, { universes: [{ id: "perps", dex: null }], log: function () {}, limiter: limiter });
  for (let i = 0; i < 12; i++) seed(loop, "C" + i, false);
  const byId = function (id) { return TFS.find(function (t) { return t.id === id; }); };
  const tick1 = Date.UTC(2026, 8, 20, 4, 0, 5, 998);          // 04:00:05.998 - the 4h alone
  const p4h = loop.refreshTF(byId("4h"), undefined, rollBatchKey(tick1));
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.deepStrictEqual(seen, Array(6).fill("4h"), "six workers took the 4h's head; six 4h jobs are queued");
  const tick2 = tick1 + 25002;                                 // 04:00:31.000 - the true-up released the 15m flag
  const p15 = loop.refreshTF(byId("15m"), undefined, rollBatchKey(tick2));
  const p30 = loop.refreshTF(byId("30m"), undefined, rollBatchKey(tick2));
  const p1h = loop.refreshTF(byId("1h"), undefined, rollBatchKey(tick2 + 5000));   // 04:00:36 - one tick later still
  async function drain() {
    while (seen.length < 48) {
      while (gates.length) gates.shift()();
      await new Promise(function (r) { setTimeout(r, 2); });
    }
    while (gates.length) gates.shift()();
  }
  await drain();
  await Promise.all([p4h, p15, p30, p1h]);
  assert.deepStrictEqual(seen.slice(6, 18), Array(12).fill("15m"), "the late 15m sweep runs before the 4h's queued tail");
  assert.deepStrictEqual(seen.slice(18, 30), Array(12).fill("30m"), "then the 30m");
  assert.deepStrictEqual(seen.slice(30, 42), Array(12).fill("1h"), "then the 1h");
  assert.deepStrictEqual(seen.slice(42), Array(6).fill("4h"), "the 4h's tail runs last, as A2 ranks it");
  limiter.stop();
});

test("a sweep in the NEXT period is still a later batch: the 00:15 15m waits behind the 00:00 stack's tail", async function () {
  const { rollBatchKey } = require("../src/loop.js");
  const seen = [];
  const gates = [];
  globalThis.fetch = async function (url, opts) {
    const body = JSON.parse(opts.body);
    seen.push(body.req.interval);
    await new Promise(function (res) { gates.push(res); });
    return { status: 200, ok: true, json: async function () { return []; } };
  };
  const ft = fakeTime(T0);
  const limiter = makeLimiter(ft, { ratePerMin: 60000, burst: 20000 });
  const loop = createLoop({}, { universes: [{ id: "perps", dex: null }], log: function () {}, limiter: limiter });
  for (let i = 0; i < 12; i++) seed(loop, "C" + i, false);
  const byId = function (id) { return TFS.find(function (t) { return t.id === id; }); };
  const tick1 = Date.UTC(2026, 8, 20, 0, 0, 4, 741);
  const p1d = loop.refreshTF(byId("1d"), undefined, rollBatchKey(tick1));
  await new Promise(function (r) { setTimeout(r, 10); });
  const p15 = loop.refreshTF(byId("15m"), undefined, rollBatchKey(tick1 + 15 * 60000));   // 00:15:04
  async function drain() {
    while (seen.length < 24) {
      while (gates.length) gates.shift()();
      await new Promise(function (r) { setTimeout(r, 2); });
    }
    while (gates.length) gates.shift()();
  }
  await drain();
  await Promise.all([p1d, p15]);
  assert.deepStrictEqual(seen.slice(0, 12), Array(12).fill("1d"), "the whole 1d sweep first");
  assert.deepStrictEqual(seen.slice(12), Array(12).fill("15m"), "the next period's 15m sweep waits");
  limiter.stop();
});
