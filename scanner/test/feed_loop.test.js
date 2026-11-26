"use strict";

// The loop's side of the WebSocket candle feed (stage 1 of the
// feed migration): pushes update the
// forming bar under the union-with-mids rule and keep the raw feedBar; a
// roll closes the period with the RAW last push (never the mids-expanded
// forming) and synthesizes skipped periods as REST would; the timer rolls
// a covered coin locally and never REST-sweeps it; the true-up skips
// covered coins; the reconciliation comparator counts mismatches before
// REST wins; candlesAgeMs stamps on every accepted push; with no feed the
// loop is unchanged.

const test = require("node:test");
const assert = require("node:assert");
const { createLoop, TFS, FEED_RECONCILE_MS } = require("../src/loop.js");
const budget = require("../src/budget.js");

const realFetch = globalThis.fetch;
test.afterEach(function () { globalThis.fetch = realFetch; });

const MS = 900000;
const P0 = Date.UTC(2026, 8, 21, 2, 0, 0);       // a 15m period start
const tf15 = TFS[0];

function stubFeed(covered) {
  const set = new Set(covered || []);
  const calls = { setCoins: [], start: 0, stop: 0 };
  return {
    calls: calls, set: set,
    covers: function (n) { return set.has(n); },
    setCoins: function (names) { calls.setCoins.push(names.slice()); },
    start: function () { calls.start++; },
    stop: function () { calls.stop++; },
    snapshot: function () { return { connected: true, wanted: set.size, acked: set.size }; }
  };
}

function makeLoop(feed, extra) {
  const lines = [];
  const limiter = budget.createLimiter({ ratePerMin: 60000, burst: 20000, log: function () {} });
  const loop = createLoop(Object.assign({}, extra || {}), {
    universes: [{ id: "perps", dex: null }], log: function (l) { lines.push(l); }, limiter: limiter,
    feed: feed
  });
  loop.lines = lines;
  return loop;
}

function bar(t, o, h, l, c, v) { return { t: t, T: t + MS - 1, o: o, h: h, l: l, c: c, v: v }; }
function push(t, o, h, l, c, v, n) { return { t: t, T: t + MS - 1, o: o, h: h, l: l, c: c, v: v, n: n }; }

// A coin with a 15m slot: three closed bars ending at P0 - 1, forming at P0.
function seed(loop, name, forming) {
  loop.state.coins[name] = {
    name: name, sym: name, uni: "perps", ctx: null, mid: 10, hist: [],
    tf: { "15m": {
      closed: [bar(P0 - 3 * MS, 9, 11, 8, 10, 100), bar(P0 - 2 * MS, 10, 12, 9, 11, 100), bar(P0 - MS, 11, 12, 10, 10.5, 100)],
      forming: forming === undefined ? bar(P0, 10.5, 10.8, 10.2, 10.6, 5) : forming,
      an: null, fetchedAt: P0
    } }
  };
  loop.state.order.push(name);
}

test("TF15 is the first fetched timeframe and the reconcile default is one hour", function () {
  assert.strictEqual(tf15.id, "15m");
  assert.strictEqual(FEED_RECONCILE_MS, 3600000);
});

test("no feed: the loop exports null and never touches the 15m slot shape", function () {
  const loop = makeLoop(undefined, {});
  assert.strictEqual(loop.feed, null);
  assert.strictEqual(loop.feedHealth(), null);
  seed(loop, "A");
  loop.applyFeedBar("A", push(P0, 1, 1, 1, 1, 1, 1), "15m", P0 + 1000);
  assert.strictEqual(loop.state.feed.ignored, 0, "the handler still counts, but nothing calls it without a feed");
  assert.strictEqual(loop.state.coins.A.tf["15m"].feedBar, undefined, "no feedBar field without a feed");
});

test("a same-period push updates feedBar raw and the forming bar under the union: o/c/v from the push, h/l the max/min with the mids-expanded forming; no revision bump; candlesAgeMs stamps", function () {
  const feed = stubFeed(["A"]);
  const loop = makeLoop(feed);
  seed(loop, "A");
  const slot = loop.state.coins.A.tf["15m"];
  // mids ran the forming's h above what the trades will show
  slot.forming.h = 11.0; slot.forming.l = 10.0;
  const rev = loop.state.revision;
  loop.applyFeedBar("A", push(P0, 10.5, 10.9, 10.3, 10.7, 42, 9), "15m", P0 + 60000);
  assert.deepStrictEqual(slot.feedBar, push(P0, 10.5, 10.9, 10.3, 10.7, 42, 9), "the raw push is kept");
  assert.strictEqual(slot.forming.o, 10.5);
  assert.strictEqual(slot.forming.c, 10.7);
  assert.strictEqual(slot.forming.v, 42);
  assert.strictEqual(slot.forming.h, 11.0, "the mids high stays (union)");
  assert.strictEqual(slot.forming.l, 10.0, "the mids low stays (union)");
  assert.ok(slot.an, "reanalyzed");
  assert.strictEqual(loop.state.revision, rev, "no revision bump on a same-period push");
  assert.strictEqual(loop.state.lastCandles, P0 + 60000);
  assert.strictEqual(loop.state.lastCandlesByUni.perps, P0 + 60000);
  assert.strictEqual(loop.state.feed.pushes, 1);
  // A push with a wider trade range widens the forming bar.
  loop.applyFeedBar("A", push(P0, 10.5, 11.4, 9.9, 11.2, 60, 15), "15m", P0 + 70000);
  assert.strictEqual(slot.forming.h, 11.4);
  assert.strictEqual(slot.forming.l, 9.9);
  // Another interval is ignored; a push for a coin without a slot is counted as ignored.
  loop.applyFeedBar("A", push(P0, 1, 1, 1, 1, 1, 1), "1h", P0 + 80000);
  assert.strictEqual(slot.forming.c, 11.2);
  loop.applyFeedBar("NOPE", push(P0, 1, 1, 1, 1, 1, 1), "15m", P0 + 80000);
  assert.strictEqual(loop.state.feed.ignored, 1);
});

test("a push for the NEXT period rolls: the RAW last push closes the period (not the mids-expanded forming), the push becomes the forming bar, the revision bumps", function () {
  const feed = stubFeed(["A"]);
  const loop = makeLoop(feed);
  seed(loop, "A");
  const slot = loop.state.coins.A.tf["15m"];
  loop.applyFeedBar("A", push(P0, 10.5, 10.9, 10.3, 10.7, 42, 9), "15m", P0 + 60000);
  slot.forming.h = 12.5;            // mids expansion after the last push
  const rev = loop.state.revision;
  loop.applyFeedBar("A", push(P0 + MS, 10.8, 10.8, 10.8, 10.8, 1, 1), "15m", P0 + MS + 500);
  assert.strictEqual(slot.closed.length, 4);
  assert.deepStrictEqual(slot.closed[3], bar(P0, 10.5, 10.9, 10.3, 10.7, 42), "closed = the raw push, no n, no mids high");
  assert.deepStrictEqual(slot.forming, bar(P0 + MS, 10.8, 10.8, 10.8, 10.8, 1));
  assert.deepStrictEqual(slot.feedBar, push(P0 + MS, 10.8, 10.8, 10.8, 10.8, 1, 1));
  assert.strictEqual(loop.state.revision, rev + 1);
  assert.strictEqual(loop.state.feed.pushRolls, 1);
  assert.strictEqual(slot.feedFrom, P0, "the comparator's range starts at the first feed-closed bar");
  // A late push for the closed period is dropped.
  loop.applyFeedBar("A", push(P0, 1, 1, 1, 1, 1, 1), "15m", P0 + MS + 600);
  assert.strictEqual(slot.closed[3].o, 10.5);
  assert.strictEqual(loop.state.feed.late, 1);
});

test("a period with no push closes as the SYNTHETIC bar REST serves (o=h=l=c=previous close, v=0), and skipped periods are filled the same way, carrying the close forward", function () {
  const feed = stubFeed(["A"]);
  const loop = makeLoop(feed);
  seed(loop, "A");                                   // forming at P0, synthesized-looking (no feedBar)
  const slot = loop.state.coins.A.tf["15m"];
  slot.forming.h = 13; slot.forming.l = 9;          // mids moved it; irrelevant to the closed bar
  // First push arrives three periods later.
  loop.applyFeedBar("A", push(P0 + 3 * MS, 10.9, 11, 10.9, 11, 3, 2), "15m", P0 + 3 * MS + 1000);
  assert.strictEqual(slot.closed.length, 6);
  assert.deepStrictEqual(slot.closed[3], bar(P0, 10.5, 10.5, 10.5, 10.5, 0), "previous close 10.5 carried; the mids range is NOT a closed bar");
  assert.deepStrictEqual(slot.closed[4], bar(P0 + MS, 10.5, 10.5, 10.5, 10.5, 0));
  assert.deepStrictEqual(slot.closed[5], bar(P0 + 2 * MS, 10.5, 10.5, 10.5, 10.5, 0));
  assert.deepStrictEqual(slot.forming, bar(P0 + 3 * MS, 10.9, 11, 10.9, 11, 3));
  assert.strictEqual(loop.state.feed.synthesized, 3);
  assert.strictEqual(slot.feedFrom, P0);
});

test("closed history is capped at the analysis depth (40 bars) across rolls", function () {
  const feed = stubFeed(["A"]);
  const loop = makeLoop(feed);
  seed(loop, "A");
  const slot = loop.state.coins.A.tf["15m"];
  for (let i = 1; i <= 60; i++) loop.applyFeedBar("A", push(P0 + i * MS, 10, 10, 10, 10, 1, 1), "15m", P0 + i * MS + 1);
  assert.strictEqual(slot.closed.length, 40);
  assert.strictEqual(slot.closed[39].t, P0 + 59 * MS);
  assert.strictEqual(slot.forming.t, P0 + 60 * MS);
});

test("the timer rolls a COVERED coin locally at T + 4 s (closed gets feedBar, forming is synthesized from the last close) and never REST-sweeps it; an UNCOVERED coin is swept by REST as before", async function () {
  const fetched = [];
  globalThis.fetch = async function (url, opts) {
    const body = JSON.parse(opts.body);
    fetched.push(body.req.coin + ":" + body.req.interval);
    return { status: 200, ok: true, json: async function () { return []; } };
  };
  const feed = stubFeed(["A"]);
  const loop = makeLoop(feed);
  seed(loop, "A");
  seed(loop, "B");                                   // not covered
  loop.state.loaded = true;
  const slotA = loop.state.coins.A.tf["15m"];
  loop.applyFeedBar("A", push(P0, 10.5, 10.9, 10.3, 10.7, 42, 9), "15m", P0 + 60000);
  const rev = loop.state.revision;
  // 3 s after the boundary: nothing rolls yet (the exchange gets a beat).
  loop.barRollTick(P0 + MS + 3000);
  assert.strictEqual(slotA.closed.length, 3);
  // 5 s after: A rolls locally, B is REST-swept (its slot is stale).
  loop.barRollTick(P0 + MS + 5000);
  assert.strictEqual(slotA.closed.length, 4);
  assert.deepStrictEqual(slotA.closed[3], bar(P0, 10.5, 10.9, 10.3, 10.7, 42));
  assert.deepStrictEqual(slotA.forming, bar(P0 + MS, 10.7, 10.7, 10.7, 10.7, 0), "synthetic forming from the last close");
  assert.strictEqual(slotA.feedBar, null);
  assert.strictEqual(loop.state.feed.localRolls, 1);
  assert.strictEqual(loop.state.revision, rev + 1);
  await new Promise(function (r) { setTimeout(r, 30); });
  const f15 = function () { return fetched.filter(function (x) { return /:15m$/.test(x); }); };
  assert.deepStrictEqual(f15(), ["B:15m"], "only the uncovered coin was 15m-fetched (the seeded coins have no other slots, so those are recovered as usual)");
  // The first trade of the new period replaces the synthetic open.
  loop.applyFeedBar("A", push(P0 + MS, 10.9, 11.1, 10.9, 11.0, 2, 1), "15m", P0 + MS + 12000);
  assert.strictEqual(slotA.forming.o, 10.9);
  assert.strictEqual(slotA.forming.l, 10.7, "the synthetic open stays inside the range (union), as under REST");
  // Feed drops A: the next boundary is REST-swept again.
  feed.set.delete("A");
  fetched.length = 0;
  loop.barRollTick(P0 + 2 * MS + 5000);
  await new Promise(function (r) { setTimeout(r, 30); });
  assert.ok(f15().indexOf("A:15m") >= 0, "uncovered again: REST sweeps A");
  loop.limiter.stop();
});

test("the true-up skips covered coins and is idle when every coin is covered", async function () {
  const fetched = [];
  globalThis.fetch = async function (url, opts) {
    const body = JSON.parse(opts.body);
    fetched.push(body.req.coin);
    return { status: 200, ok: true, json: async function () { return []; } };
  };
  const feed = stubFeed(["A"]);
  const loop = makeLoop(feed);
  seed(loop, "A"); seed(loop, "B");
  await loop.trueUp15m();
  assert.deepStrictEqual(fetched, ["B"], "only the uncovered coin");
  assert.ok(loop.lines.some(function (l) { return l === "15m true-up done (1/2 coins)"; }), loop.lines.join("|"));
  feed.set.add("B");
  fetched.length = 0;
  await loop.trueUp15m();
  assert.deepStrictEqual(fetched, [], "idle");
  loop.limiter.stop();
});

test("reconciliation: REST bars are compared against FEED-closed bars only (o/h/l/c/v strict), mismatches counted and logged, then REST wins and the range resets", async function () {
  const restBars = {
    A: [
      // REST history: the same three seed bars, then the feed-closed period P0 with a DIFFERENT high, then the forming bar
      { t: P0 - 3 * MS, T: P0 - 2 * MS - 1, o: "9", h: "11", l: "8", c: "10", v: "100" },
      { t: P0 - 2 * MS, T: P0 - MS - 1, o: "10", h: "12", l: "9", c: "11", v: "100" },
      { t: P0 - MS, T: P0 - 1, o: "11", h: "12", l: "10", c: "10.5", v: "100" },
      { t: P0, T: P0 + MS - 1, o: "10.5", h: "10.95", l: "10.3", c: "10.7", v: "42" },
      { t: P0 + MS, T: P0 + 2 * MS - 1, o: "10.8", h: "10.8", l: "10.8", c: "10.8", v: "1" }
    ]
  };
  const realNow = Date.now;
  Date.now = function () { return P0 + MS + 20000; };   // inside the second period, so the last REST bar is forming
  try {
    globalThis.fetch = async function (url, opts) {
      const body = JSON.parse(opts.body);
      return { status: 200, ok: true, json: async function () { return restBars[body.req.coin] || []; } };
    };
    const feed = stubFeed(["A"]);
    const loop = makeLoop(feed);
    seed(loop, "A");
    const slot = loop.state.coins.A.tf["15m"];
    loop.applyFeedBar("A", push(P0, 10.5, 10.9, 10.3, 10.7, 42, 9), "15m", P0 + 60000);
    loop.applyFeedBar("A", push(P0 + MS, 10.8, 10.8, 10.8, 10.8, 1, 1), "15m", P0 + MS + 500);
    assert.strictEqual(slot.feedFrom, P0);
    const pass = await loop.reconcileFeed("test");
    assert.deepStrictEqual(pass, { reason: "test", coins: 1, barsCompared: 1, mismatches: 1, mismatchesOhlc: 1, mismatchesVolume: 0, fetchFailures: 0, check: true },
      "only the feed-closed bar at P0 is compared; the seed bars came from REST");
    const r = loop.state.feed.reconcile;
    assert.strictEqual(r.passes, 1);
    assert.strictEqual(r.mismatches, 1);
    assert.deepStrictEqual(r.lastMismatch.fields, ["h"]);
    assert.strictEqual(r.lastMismatch.feed.h, 10.9);
    assert.strictEqual(r.lastMismatch.rest.h, 10.95);
    assert.ok(loop.lines.some(function (l) { return /^feed reconcile MISMATCH A t=.* h feed=10.9 rest=10.95$/.test(l); }), loop.lines.join("|"));
    assert.ok(loop.lines.some(function (l) { return l === "feed reconcile (test): 1 coins, 1 bars compared, 1 mismatches (1 ohlc, 0 volume-only), 0 fetch failures"; }), loop.lines.join("|"));
    // REST won: the slot now carries REST's bar and the comparator range is reset.
    assert.strictEqual(loop.state.coins.A.tf["15m"].closed[3].h, 10.95);
    assert.strictEqual(loop.state.coins.A.tf["15m"].feedFrom, null);
    assert.deepStrictEqual(loop.state.coins.A.tf["15m"].feedBar, { t: P0 + MS, T: P0 + 2 * MS - 1, o: 10.8, h: 10.8, l: 10.8, c: 10.8, v: 1 },
      "feedBar = the exchange's forming bar as REST returned it (pre-union)");
    // A second pass with nothing feed-closed compares nothing.
    const pass2 = await loop.reconcileFeed("hourly");
    assert.strictEqual(pass2.barsCompared, 0);
    assert.strictEqual(r.passes, 2);
    const health = loop.feedHealth(P0 + MS + 20000);
    assert.strictEqual(health.enabled, true);
    assert.strictEqual(health.coveredCoins, 1);
    assert.strictEqual(health.reconcile.mismatches, 1);
    assert.strictEqual(health.reconcile.intervalMs, FEED_RECONCILE_MS);
    assert.strictEqual(health.pushRolls, 1);
    loop.limiter.stop();
  } finally {
    Date.now = realNow;
  }
});

test("a matching feed history reconciles with zero mismatches (the gate's green shape)", async function () {
  const restBars = {
    A: [
      { t: P0 - MS, T: P0 - 1, o: "11", h: "12", l: "10", c: "10.5", v: "100" },
      { t: P0, T: P0 + MS - 1, o: "10.5", h: "10.9", l: "10.3", c: "10.7", v: "42" },
      { t: P0 + MS, T: P0 + 2 * MS - 1, o: "10.7", h: "10.7", l: "10.7", c: "10.7", v: "0" },   // REST's synthetic bar
      { t: P0 + 2 * MS, T: P0 + 3 * MS - 1, o: "10.9", h: "11", l: "10.9", c: "11", v: "3" }
    ]
  };
  const realNow = Date.now;
  Date.now = function () { return P0 + 2 * MS + 20000; };
  try {
    globalThis.fetch = async function (url, opts) {
      const body = JSON.parse(opts.body);
      return { status: 200, ok: true, json: async function () { return restBars[body.req.coin] || []; } };
    };
    const feed = stubFeed(["A"]);
    const loop = makeLoop(feed);
    seed(loop, "A");
    loop.applyFeedBar("A", push(P0, 10.5, 10.9, 10.3, 10.7, 42, 9), "15m", P0 + 60000);
    loop.applyFeedBar("A", push(P0 + 2 * MS, 10.9, 11, 10.9, 11, 3, 2), "15m", P0 + 2 * MS + 1000);   // P0+MS had no trade
    const pass = await loop.reconcileFeed("test");
    assert.strictEqual(pass.barsCompared, 2, "P0 (pushed) and P0+MS (synthetic)");
    assert.strictEqual(pass.mismatches, 0);
    loop.limiter.stop();
  } finally {
    Date.now = realNow;
  }
});

test("a reconcile pass in flight is not doubled; start() hands the roster to the feed after the load and stop() stops it", async function () {
  let release = null;
  globalThis.fetch = async function () {
    await new Promise(function (r) { release = r; });
    return { status: 200, ok: true, json: async function () { return []; } };
  };
  const feed = stubFeed(["A"]);
  const loop = makeLoop(feed);
  seed(loop, "A");
  const p1 = loop.reconcileFeed("hourly");
  await new Promise(function (r) { setTimeout(r, 10); });
  const p2 = await loop.reconcileFeed("reconnect");
  assert.strictEqual(p2, null);
  assert.ok(loop.lines.some(function (l) { return l === "feed reconcile skipped (previous pass in flight)"; }));
  release();
  await p1;
  assert.strictEqual(loop.state.feed.reconcile.passes, 1);
  loop.stop();
  assert.strictEqual(feed.calls.stop, 1);
  loop.limiter.stop();
});

test("review 2026-09-22 MED: the reconciliation fetches COVERED coins only, holds the 15m flag for the pass, and defers a minute when a sweep holds it; local rolls still run while the flag is held", async function () {
  const fetched = [];
  const releases = [];
  globalThis.fetch = async function (url, opts) {
    const body = JSON.parse(opts.body);
    fetched.push(body.req.coin + ":" + body.req.interval);
    await new Promise(function (r) { releases.push(r); });
    return { status: 200, ok: true, json: async function () { return []; } };
  };
  const feed = stubFeed(["A"]);
  const loop = makeLoop(feed);
  seed(loop, "A"); seed(loop, "B");                  // B is uncovered: the sweep's coin, never the pass's
  loop.state.loaded = true;
  const p = loop.reconcileFeed("hourly");
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.deepStrictEqual(fetched, ["A:15m"], "only the covered coin");
  assert.strictEqual(tf15.refetching, true, "the 15m flag is held for the pass");
  // The timer during the pass: no 15m REST sweep (flag held), but A's local roll still happens.
  loop.applyFeedBar("A", push(P0, 10.5, 10.9, 10.3, 10.7, 42, 9), "15m", P0 + 60000);
  loop.barRollTick(P0 + MS + 5000);
  assert.strictEqual(loop.state.feed.localRolls, 1, "local roll ran while the 15m flag was held");
  assert.deepStrictEqual(fetched.filter(function (x) { return /:15m$/.test(x); }), ["A:15m"], "no 15m sweep started under the flag");
  const skipped = await loop.reconcileFeed("reconnect");
  assert.strictEqual(skipped, null, "a pass in flight is not doubled");
  while (releases.length) releases.shift()();
  await p;
  assert.strictEqual(tf15.refetching, false, "released after the pass");
  assert.strictEqual(loop.state.feed.reconcile.passes, 1);
  // A boundary SWEEP of uncovered coins holds the flag: the pass defers a minute instead of racing it.
  tf15.refetching = true;
  const deferred = await loop.reconcileFeed("hourly");
  assert.strictEqual(deferred, null);
  assert.ok(loop.lines.some(function (l) { return l === "feed reconcile deferred 60 s (15m sweep in flight)"; }), loop.lines.join("|"));
  tf15.refetching = false;
  loop.stop();
  loop.limiter.stop();
});

test("review 2026-09-22 NIT: the first push onto a slot with no forming bar seeds it without counting a roll", function () {
  const feed = stubFeed(["A"]);
  const loop = makeLoop(feed);
  seed(loop, "A", null);
  const slot = loop.state.coins.A.tf["15m"];
  loop.applyFeedBar("A", push(P0, 10.5, 10.9, 10.3, 10.7, 42, 9), "15m", P0 + 60000);
  assert.deepStrictEqual(slot.forming, bar(P0, 10.5, 10.9, 10.3, 10.7, 42));
  assert.strictEqual(slot.closed.length, 3, "nothing closed");
  assert.strictEqual(loop.state.feed.pushRolls, 0);
});

test("boot and reconnect passes are repairs: they replace the bars and skip the comparator; an hourly pass checks", async function () {
  const restBars = {
    A: [
      { t: P0 - MS, T: P0 - 1, o: "11", h: "12", l: "10", c: "10.5", v: "100" },
      { t: P0, T: P0 + MS - 1, o: "10.5", h: "10.95", l: "10.3", c: "10.7", v: "42" },   // differs from the feed-closed bar (h)
      { t: P0 + MS, T: P0 + 2 * MS - 1, o: "10.8", h: "10.8", l: "10.8", c: "10.8", v: "1" }
    ]
  };
  const realNow = Date.now;
  Date.now = function () { return P0 + MS + 20000; };
  try {
    globalThis.fetch = async function (url, opts) {
      const body = JSON.parse(opts.body);
      return { status: 200, ok: true, json: async function () { return restBars[body.req.coin] || []; } };
    };
    const feed = stubFeed(["A"]);
    const loop = makeLoop(feed);
    seed(loop, "A");
    loop.applyFeedBar("A", push(P0, 10.5, 10.9, 10.3, 10.7, 42, 9), "15m", P0 + 60000);
    loop.applyFeedBar("A", push(P0 + MS, 10.8, 10.8, 10.8, 10.8, 1, 1), "15m", P0 + MS + 500);
    const boot = await loop.reconcileFeed("boot");
    assert.deepStrictEqual(boot, { reason: "boot", coins: 1, barsCompared: 0, mismatches: 0, mismatchesOhlc: 0, mismatchesVolume: 0, fetchFailures: 0, check: false });
    assert.strictEqual(loop.state.coins.A.tf["15m"].closed[1].h, 10.95, "REST replaced the partial bar");
    assert.ok(loop.lines.some(function (l) { return l === "feed reconcile (boot, repair only): 1 coins, 0 bars compared, 0 mismatches (0 ohlc, 0 volume-only), 0 fetch failures"; }), loop.lines.join("|"));
    // Feed closes another period, then a reconnect pass: repair only again.
    loop.applyFeedBar("A", push(P0 + 2 * MS, 10.9, 11, 10.9, 11, 3, 2), "15m", P0 + 2 * MS + 1000);
    const rc = await loop.reconcileFeed("reconnect");
    assert.strictEqual(rc.check, false);
    assert.strictEqual(rc.barsCompared, 0);
    // An hourly pass checks.
    loop.applyFeedBar("A", push(P0 + 3 * MS, 10.9, 11, 10.9, 11, 3, 2), "15m", P0 + 3 * MS + 1000);
    const hourly = await loop.reconcileFeed("hourly");
    assert.strictEqual(hourly.check, true);
    assert.strictEqual(loop.state.feed.reconcile.passes, 3);
    loop.limiter.stop();
  } finally {
    Date.now = realNow;
  }
});

test("FEED_BOOT_PASS_MS is one minute", function () {
  const { FEED_BOOT_PASS_MS } = require("../src/loop.js");
  assert.strictEqual(FEED_BOOT_PASS_MS, 60000);
});

test("a volume-only mismatch (the stream under-reporting a bar's closing volume) is counted apart from an o/h/l/c mismatch", async function () {
  const restBars = {
    A: [
      { t: P0 - MS, T: P0 - 1, o: "11", h: "12", l: "10", c: "10.5", v: "100" },
      { t: P0, T: P0 + MS - 1, o: "10.5", h: "10.9", l: "10.3", c: "10.7", v: "42.5" },   // v differs, o/h/l/c equal
      { t: P0 + MS, T: P0 + 2 * MS - 1, o: "10.8", h: "10.8", l: "10.8", c: "10.8", v: "1" }
    ]
  };
  const realNow = Date.now;
  Date.now = function () { return P0 + MS + 20000; };
  try {
    globalThis.fetch = async function (url, opts) {
      const body = JSON.parse(opts.body);
      return { status: 200, ok: true, json: async function () { return restBars[body.req.coin] || []; } };
    };
    const feed = stubFeed(["A"]);
    const loop = makeLoop(feed);
    seed(loop, "A");
    loop.applyFeedBar("A", push(P0, 10.5, 10.9, 10.3, 10.7, 42, 9), "15m", P0 + 60000);
    loop.applyFeedBar("A", push(P0 + MS, 10.8, 10.8, 10.8, 10.8, 1, 1), "15m", P0 + MS + 500);
    const pass = await loop.reconcileFeed("hourly");
    assert.strictEqual(pass.mismatches, 1);
    assert.strictEqual(pass.mismatchesOhlc, 0);
    assert.strictEqual(pass.mismatchesVolume, 1);
    assert.deepStrictEqual(loop.state.feed.reconcile.lastMismatch.fields, ["v"]);
    const h = loop.feedHealth();
    assert.strictEqual(h.reconcile.mismatchesOhlc, 0);
    assert.strictEqual(h.reconcile.mismatchesVolume, 1);
    assert.strictEqual(loop.state.coins.A.tf["15m"].closed[1].v, 42.5, "REST's volume wins");
    loop.limiter.stop();
  } finally {
    Date.now = realNow;
  }
});
