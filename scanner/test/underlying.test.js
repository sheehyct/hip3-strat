"use strict";

// Underlying-equity adapter tests: the raw-bars guard (the response must
// CONFIRM adjusted=false), header-only auth (the key must never reach the URL),
// the vendor error taxonomy, malformed-bar rejection, and the per-timeframe
// minimum-history gate. All network calls are injected - node --test, no
// network, no key required.

const test = require("node:test");
const assert = require("node:assert");
const {
  MIN_TRADING_DAYS,
  ERR,
  normalizeBar,
  fetchDailyBars,
  analyzeContinuity,
  usableTimeframes,
  supportsTimeframe
} = require("../src/underlying.js");

const DAY = 86400000;

// Build a run of consecutive daily bars at a roughly flat price.
function series(startT, count, price, stepDays) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      t: startT + i * (stepDays || 1) * DAY,
      open: price, high: price * 1.01, low: price * 0.99, close: price, volume: 1
    });
  }
  return out;
}

// Minimal fetch double. Records every call so tests can assert on the URL and
// headers, which is how the "key never travels in a URL" rule is enforced.
function fakeFetch(response, opts) {
  opts = opts || {};
  const calls = [];
  const impl = function (url, init) {
    calls.push({ url: url, init: init });
    if (opts.throws) return Promise.reject(new Error(opts.throws));
    return Promise.resolve({
      ok: response.status === undefined ? true : response.status >= 200 && response.status < 300,
      status: response.status === undefined ? 200 : response.status,
      json: function () {
        if (opts.notJson) return Promise.reject(new Error("invalid json"));
        return Promise.resolve(response.body);
      }
    });
  };
  impl.calls = calls;
  return impl;
}

function bar(t, o, h, l, c, v) { return { t: t, o: o, h: h, l: l, c: c, v: v }; }

function okBody(results) {
  return { status: "OK", adjusted: false, results: results };
}

// ---- the raw-bars guard (rule 1) ----

test("fetchDailyBars requests adjusted=false and returns bars when confirmed", async function () {
  const f = fakeFetch({ body: okBody([bar(1, 10, 12, 9, 11, 100)]) });
  const r = await fetchDailyBars("AAPL", "2026-07-01", "2026-07-31", { apiKey: "k", fetchImpl: f });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.adjusted, false);
  assert.strictEqual(r.count, 1);
  assert.deepStrictEqual(r.bars[0], { t: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 });
  assert.ok(/adjusted=false/.test(f.calls[0].url), "must request unadjusted bars");
});

test("fetchDailyBars REJECTS a response that came back adjusted", async function () {
  // The failure this guards is silent: adjusted bars look completely normal and
  // simply move every break level, so it must be an error and not a warning.
  const f = fakeFetch({ body: { status: "OK", adjusted: true, results: [bar(1, 10, 12, 9, 11, 100)] } });
  const r = await fetchDailyBars("AAPL", "2026-07-01", "2026-07-31", { apiKey: "k", fetchImpl: f });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, ERR.ADJUSTED);
});

test("fetchDailyBars refuses when the adjusted field is absent (cannot confirm)", async function () {
  const f = fakeFetch({ body: { status: "OK", results: [bar(1, 10, 12, 9, 11, 100)] } });
  const r = await fetchDailyBars("AAPL", "2026-07-01", "2026-07-31", { apiKey: "k", fetchImpl: f });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, ERR.ADJUSTED);
});

// ---- auth handling (rule 2) ----

test("the api key travels in the Authorization header and NEVER in the URL", async function () {
  const f = fakeFetch({ body: okBody([bar(1, 10, 12, 9, 11, 100)]) });
  await fetchDailyBars("AAPL", "2026-07-01", "2026-07-31", { apiKey: "SECRET_KEY_VALUE", fetchImpl: f });
  const call = f.calls[0];
  assert.strictEqual(call.init.headers.Authorization, "Bearer SECRET_KEY_VALUE");
  assert.ok(!/SECRET_KEY_VALUE/.test(call.url), "key must not appear in the URL");
  assert.ok(!/apiKey/i.test(call.url), "must not use the apiKey query parameter");
});

test("fetchDailyBars fails cleanly with no key, and does not leak it in messages", async function () {
  const f = fakeFetch({ body: okBody([]) });
  const r = await fetchDailyBars("AAPL", "2026-07-01", "2026-07-31", { apiKey: "", fetchImpl: f });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, ERR.AUTH);
  assert.strictEqual(f.calls.length, 0, "must not call the vendor without a key");
});

// ---- error taxonomy ----

test("fetchDailyBars maps vendor status codes to distinct error codes", async function () {
  const cases = [
    [401, ERR.AUTH],
    [403, ERR.FORBIDDEN],
    [429, ERR.RATE_LIMIT]
  ];
  for (const [status, code] of cases) {
    const f = fakeFetch({ status: status, body: {} });
    const r = await fetchDailyBars("AAPL", "2026-07-01", "2026-07-31", { apiKey: "k", fetchImpl: f });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, code, "HTTP " + status + " should map to " + code);
  }
});

test("fetchDailyBars reports a network failure without throwing", async function () {
  const f = fakeFetch({ body: {} }, { throws: "ECONNRESET" });
  const r = await fetchDailyBars("AAPL", "2026-07-01", "2026-07-31", { apiKey: "k", fetchImpl: f });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, ERR.NETWORK);
});

test("fetchDailyBars distinguishes an empty result set from an error", async function () {
  const f = fakeFetch({ body: okBody([]) });
  const r = await fetchDailyBars("NOSUCH", "2026-07-01", "2026-07-31", { apiKey: "k", fetchImpl: f });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, ERR.NO_DATA);
});

// ---- bar normalization ----

test("normalizeBar rejects geometrically impossible bars", function () {
  assert.strictEqual(normalizeBar(bar(1, 10, 9, 11, 10)), null, "high below low");
  assert.strictEqual(normalizeBar(bar(1, 99, 12, 9, 11)), null, "open above high");
  assert.strictEqual(normalizeBar(bar(1, 10, 12, 9, 99)), null, "close above high");
  assert.strictEqual(normalizeBar(bar(1, 10, 12, 9, 1)), null, "close below low");
  assert.strictEqual(normalizeBar({ t: 1, o: 10, h: 12, l: 9 }), null, "missing close");
  assert.strictEqual(normalizeBar(null), null);
  assert.ok(normalizeBar(bar(1, 10, 12, 9, 11)), "a valid bar survives");
});

test("fetchDailyBars drops malformed bars, counts them, and keeps the good ones", async function () {
  // A corrupt bar does not throw during classification - it silently produces a
  // wrong break - so it has to be filtered at ingest.
  const f = fakeFetch({ body: okBody([bar(2, 10, 12, 9, 11), bar(1, 10, 9, 11, 10)]) });
  const r = await fetchDailyBars("AAPL", "2026-07-01", "2026-07-31", { apiKey: "k", fetchImpl: f });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.rejected, 1);
});

test("fetchDailyBars sorts bars ascending even if the vendor does not", async function () {
  const f = fakeFetch({ body: okBody([bar(3, 10, 12, 9, 11), bar(1, 10, 12, 9, 11), bar(2, 10, 12, 9, 11)]) });
  const r = await fetchDailyBars("AAPL", "2026-07-01", "2026-07-31", { apiKey: "k", fetchImpl: f });
  assert.deepStrictEqual(r.bars.map(function (b) { return b.t; }), [1, 2, 3]);
});

// ---- the minimum-history gate ----

test("usableTimeframes reproduces the roster map's per-symbol assessments", function () {
  // Trading-day counts as of 2026-08-01 from
  // docs/XYZ_ROSTER_UNDERLYING_MAP_2026-08-01.md. These thresholds were derived
  // independently (4 complete bars per timeframe) and must agree with it.
  assert.deepStrictEqual(usableTimeframes(5).usable, ["daily"], "CXMT ~5d: daily only");
  assert.deepStrictEqual(usableTimeframes(16).usable, ["daily"], "SKHY ~16d: no weekly yet");
  assert.deepStrictEqual(usableTimeframes(35).usable, ["daily", "weekly"], "SPCX ~35d: no monthly");
  assert.deepStrictEqual(usableTimeframes(115).usable, ["daily", "weekly", "monthly"], "SHAZ ~115d: no quarterly");
  assert.deepStrictEqual(usableTimeframes(400).usable, ["daily", "weekly", "monthly", "quarterly"]);
});

test("usableTimeframes reports the unusable set explicitly", function () {
  // The caller must be able to say "insufficient history" rather than emit a
  // neutral zero, which would read as "no alignment" - a claim we cannot make.
  const r = usableTimeframes(5);
  assert.deepStrictEqual(r.unusable, ["weekly", "monthly", "quarterly"]);
  assert.strictEqual(r.barCount, 5);
});

test("usableTimeframes handles junk input as zero history", function () {
  for (const junk of [0, -5, NaN, Infinity, undefined, null, "40"]) {
    assert.deepStrictEqual(usableTimeframes(junk).usable, [], "junk input: " + String(junk));
  }
});

test("supportsTimeframe agrees with the threshold table and rejects unknown timeframes", function () {
  assert.strictEqual(supportsTimeframe(MIN_TRADING_DAYS.weekly, "weekly"), true);
  assert.strictEqual(supportsTimeframe(MIN_TRADING_DAYS.weekly - 1, "weekly"), false);
  assert.strictEqual(supportsTimeframe(9999, "hourly"), false, "unknown timeframe is never supported");
});

// ---- continuity / ticker reuse ----

test("analyzeContinuity reports a clean series as continuous", function () {
  const r = analyzeContinuity(series(0, 100, 50));
  assert.strictEqual(r.continuous, true);
  assert.strictEqual(r.breaks.length, 0);
  assert.strictEqual(r.effectiveBars, 100);
});

test("analyzeContinuity catches the SPCX ticker-reuse shape", function () {
  // Reproduces the real case found live on 2026-08-01: a flat ~23.61 security
  // for a long stretch, a 67-day hole, then a different ~108 security. The raw
  // count would clear every timeframe gate; the effective count must not.
  const before = series(0, 420, 23.61);
  const afterStart = before[before.length - 1].t + 67 * DAY;
  const after = series(afterStart, 31, 108.37);
  const r = analyzeContinuity(before.concat(after));

  assert.strictEqual(r.continuous, false);
  assert.strictEqual(r.breaks.length, 1);
  assert.strictEqual(r.breaks[0].reason, "gap_and_jump", "both signals fire on a ticker reuse");
  assert.strictEqual(r.breaks[0].gapDays, 67);
  assert.strictEqual(r.totalBars, 451);
  assert.strictEqual(r.effectiveBars, 31, "only the post-reuse stretch counts");

  // The whole point: the raw count lies, the effective count does not.
  assert.ok(usableTimeframes(r.totalBars).usable.includes("quarterly"),
    "raw count would wrongly clear quarterly");
  assert.deepStrictEqual(usableTimeframes(r.effectiveBars).usable, ["daily", "weekly"],
    "effective count correctly refuses monthly and quarterly");
});

test("analyzeContinuity separates a halt from a corporate action", function () {
  // Gap with no price jump = a trading halt; the instrument is the same.
  const halt = series(0, 30, 50).concat(series(30 * DAY + 40 * DAY, 30, 51));
  const h = analyzeContinuity(halt);
  assert.strictEqual(h.breaks[0].reason, "gap", "a quiet gap is a halt, not a reuse");

  // Jump with no gap = a corporate action on a raw series (e.g. an unadjusted
  // split), which we also want surfaced rather than silently traded through.
  const split = series(0, 30, 100).concat(series(30 * DAY, 30, 25));
  const s = analyzeContinuity(split);
  assert.strictEqual(s.breaks[0].reason, "jump");
});

test("analyzeContinuity tolerates weekends and holiday weekends", function () {
  // 3-day and 5-day steps must NOT register - otherwise every Monday is a break.
  assert.strictEqual(analyzeContinuity(series(0, 40, 50, 3)).continuous, true);
  assert.strictEqual(analyzeContinuity(series(0, 40, 50, 5)).continuous, true);
});

test("analyzeContinuity only sees breaks inside the window it was given", function () {
  // Documents a real limitation rather than a behavior: the free tier serves
  // two years, so a reuse older than that is off-screen and the symbol looks
  // clean. Widening the range later can turn a clean symbol dirty - that is the
  // analysis improving, not the instrument degrading.
  const full = series(0, 30, 20).concat(series(30 * DAY + 60 * DAY, 30, 100));
  assert.strictEqual(analyzeContinuity(full).continuous, false, "the break is visible in the full range");
  const windowed = full.slice(31);
  assert.strictEqual(analyzeContinuity(windowed).continuous, true,
    "the same instrument looks continuous once the break falls outside the window");
});

test("analyzeContinuity handles empty and single-bar input", function () {
  const e = analyzeContinuity([]);
  assert.strictEqual(e.continuous, true);
  assert.strictEqual(e.effectiveBars, 0);
  assert.strictEqual(e.effectiveFromT, null);
  assert.strictEqual(analyzeContinuity(series(0, 1, 50)).effectiveBars, 1);
  assert.strictEqual(analyzeContinuity(null).totalBars, 0);
});
