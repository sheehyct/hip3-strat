"use strict";

// Deploy 1 additive /api/state fields (feasibility report Part F items 4-6):
// top-level `snapshot_id`, per-coin `overnight_change_pct` and `impactBand`.
// node builtins only: node --test
//
// The overnight tests exist for one reason above all: /api/state and the
// premarket briefing must never publish different overnight moves for the same
// coin at the same instant. They now call one helper (src/cash_close.js), and
// the agreement test below builds BOTH surfaces from a single state object so a
// future divergence fails here rather than in someone's spreadsheet.

const test = require("node:test");
const assert = require("node:assert");
const { buildApiState, BOOT_EPOCH } = require("../src/apistate.js");
const { buildBriefingSnapshot, previousUsCashClose } = require("../src/briefing.js");
const { MAX_REFERENCE_LAG_MS } = require("../src/cash_close.js");

const HOUR = 3600000;
const DAY = 86400000;
// Wed Jul 22 2026, 08:30 New York (EDT) - the briefing suite's own reference
// instant, so both suites exercise the same calendar branch.
const NOW = Date.UTC(2026, 6, 22, 12, 30);
const FTFC = ["1h"];

function analysis() {
  return {
    types: ["2D", "1", "2U"],
    formingType: "2U",
    formingDir: "up",
    completed: null,
    setups: [],
    invalidated: false,
    live: []
  };
}

// `count` closed 1h bars whose LAST bar ends at `end`, all closing at `base`.
function hourlyBars(end, count, base) {
  const out = [];
  for (let i = count; i > 0; i--) {
    const T = end - (i - 1) * HOUR - 1;
    out.push({ t: T - HOUR + 1, T: T, o: base - 1, h: base + 1, l: base - 2, c: base, v: 10 });
  }
  return out;
}

// Mirrors test/briefing.test.js's fixture: mid 110 against a prior-cash-close
// print of 100, i.e. a +10% overnight move with zero reference lag.
function stateAt(now, overrides) {
  overrides = overrides || {};
  const close = previousUsCashClose(now);
  const reference = hourlyBars(close.target_ms, 100, 100);
  const dayStart = Date.UTC(2026, 6, 22);
  const coin = {
    name: "xyz:NVDA",
    sym: "NVDA",
    uni: "xyz",
    mid: 110,
    hist: [],
    ctx: {
      markPx: "110",
      prevDayPx: "108",
      dayNtlVlm: "123456",
      funding: "0.0001",
      premium: "0.0002",
      openInterest: "1000"
    },
    tf: {
      "1h": {
        closed: reference.slice(-30),
        referenceClosed: reference,
        forming: { t: now - 30 * 60000, T: now + 30 * 60000, o: 109, h: 111, l: 108, c: 110, v: 5 },
        an: analysis()
      },
      "1d": {
        closed: [{ t: dayStart - DAY, T: dayStart - 1, o: 100, h: 108, l: 99, c: 107, v: 100 }],
        forming: { t: dayStart, T: dayStart + DAY - 1, o: 105, h: 112, l: 104, c: 110, v: 50 },
        an: analysis()
      }
    }
  };
  if (Object.prototype.hasOwnProperty.call(overrides, "ctx")) Object.assign(coin.ctx, overrides.ctx);
  if (Object.prototype.hasOwnProperty.call(overrides, "tf1h")) coin.tf["1h"] = overrides.tf1h;
  if (Object.prototype.hasOwnProperty.call(overrides, "mid")) coin.mid = overrides.mid;
  return {
    order: [coin.name],
    coins: { "xyz:NVDA": coin },
    universes: ["xyz"],
    expectedMarketsByUni: { xyz: [coin.name] },
    loaded: true,
    lastMids: now - 5000,
    lastCandles: now - 60000,
    lastContexts: now - 30000
  };
}

function rowAt(now, overrides) {
  return buildApiState(stateAt(now, overrides), FTFC, "xyz", now).coins[0];
}

// ---------------------------------------------------------------- snapshot_id

test("snapshot_id is <bootEpoch>-<revision> in the pinned compact-UTC format", function () {
  const st = stateAt(NOW);
  st.revision = 1545;
  const out = buildApiState(st, FTFC, "xyz", NOW);
  assert.match(out.snapshot_id, /^\d{8}T\d{9}Z-\d+$/,
    "YYYYMMDDTHHMMSSmmmZ-<revision>, e.g. 20260824T120000123Z-1545");
  assert.strictEqual(out.snapshot_id, BOOT_EPOCH + "-1545");
  assert.match(BOOT_EPOCH, /^\d{8}T\d{9}Z$/,
    "no separators, milliseconds included (review: same-second restarts collided), explicit Z");
  // revision itself is untouched: snapshot_id rides beside it, never replaces it
  assert.strictEqual(out.revision, 1545);
});

test("snapshot_id tracks revision but keeps one boot epoch for the process", function () {
  const st = stateAt(NOW);
  st.revision = 10;
  const first = buildApiState(st, FTFC, "xyz", NOW).snapshot_id;
  st.revision = 11;
  const second = buildApiState(st, FTFC, "xyz", NOW).snapshot_id;
  assert.notStrictEqual(first, second, "a state change produces a new snapshot identity");
  assert.strictEqual(first.split("-")[0], second.split("-")[0],
    "the epoch half is fixed at process start - only a restart moves it");
  assert.strictEqual(second.split("-")[1], "11");
  // Same revision, later wall clock, different universe filter -> same identity:
  // the id names the STATE, not the request.
  assert.strictEqual(buildApiState(st, FTFC, null, NOW + 90000).snapshot_id, second);
});

test("snapshot_id is honest about a fresh, never-mutated loop state", function () {
  const st = stateAt(NOW);
  delete st.revision;
  assert.strictEqual(buildApiState(st, FTFC, "xyz", NOW).snapshot_id, BOOT_EPOCH + "-0");
});

// ------------------------------------------------------- overnight_change_pct

test("overnight_change_pct matches the briefing on the same state", function () {
  const st = stateAt(NOW);
  const api = buildApiState(st, FTFC, "xyz", NOW);
  const briefing = buildBriefingSnapshot(st, FTFC, "xyz", NOW);
  assert.strictEqual(api.coins[0].overnight_change_pct, 10,
    "mid 110 against a 100 print at the 2026-07-21 16:00 ET close");
  assert.strictEqual(api.coins[0].overnight_change_pct,
    briefing.rows[0].overnight_change_pct,
    "one helper, two surfaces - these must not drift");
});

test("overnight_change_pct is null when no prior-close reference exists", function () {
  // no 1h slot at all
  assert.strictEqual(rowAt(NOW, { tf1h: undefined }).overnight_change_pct, null);
  // a 1h slot with an empty tape
  assert.strictEqual(
    rowAt(NOW, { tf1h: { closed: [], referenceClosed: [], forming: null, an: analysis() } })
      .overnight_change_pct, null);
});

test("overnight_change_pct is null when the nearest bar is stale beyond the lag bound", function () {
  const close = previousUsCashClose(NOW);
  // Tape ends an hour past MAX_REFERENCE_LAG_MS before the close, so its last
  // bar is not that close's price. Unknown, never a confident wrong percentage.
  const stale = hourlyBars(close.target_ms - MAX_REFERENCE_LAG_MS - HOUR, 10, 100);
  assert.strictEqual(
    rowAt(NOW, { tf1h: { closed: stale, referenceClosed: stale, forming: null, an: analysis() } })
      .overnight_change_pct, null);
});

test("overnight_change_pct ignores bars that close after the cash close", function () {
  const close = previousUsCashClose(NOW);
  const future = hourlyBars(close.target_ms + 6 * HOUR, 4, 100);
  assert.strictEqual(
    rowAt(NOW, { tf1h: { closed: future, referenceClosed: future, forming: null, an: analysis() } })
      .overnight_change_pct, null,
    "the reference is the price AT the close, not after it");
});

test("overnight_change_pct is null when the coin has no usable price", function () {
  const row = rowAt(NOW, { mid: null, ctx: { markPx: "" } });
  assert.strictEqual(row.mid, null);
  assert.strictEqual(row.overnight_change_pct, null, "null price -> null move, never 0");
});

// ------------------------------------------------------------------ impactBand

test("impactBand serves the two ctx.impactPxs prices as parsed floats", function () {
  assert.deepStrictEqual(rowAt(NOW, { ctx: { impactPxs: ["109.4", "110.6"] } }).impactBand,
    [109.4, 110.6], "venue order preserved - not sorted, not re-derived");
  assert.deepStrictEqual(rowAt(NOW, { ctx: { impactPxs: [109.4, 110.6] } }).impactBand,
    [109.4, 110.6], "numbers pass through unchanged");
});

test("impactBand is null when the venue omits it", function () {
  assert.strictEqual(rowAt(NOW).impactBand, null, "absent key");
  assert.strictEqual(rowAt(NOW, { ctx: { impactPxs: null } }).impactBand, null);
  assert.strictEqual(rowAt(NOW, { ctx: { impactPxs: "110" } }).impactBand, null, "not an array");
});

test("impactBand is null when either side is non-finite", function () {
  assert.strictEqual(rowAt(NOW, { ctx: { impactPxs: ["abc", "110.6"] } }).impactBand, null);
  assert.strictEqual(rowAt(NOW, { ctx: { impactPxs: ["109.4", null] } }).impactBand, null);
  assert.strictEqual(rowAt(NOW, { ctx: { impactPxs: ["109.4", ""] } }).impactBand, null,
    'empty string is unknown, not 0 - a [109.4, 0] band would read as infinite slippage');
});

test("impactBand is null on wrong arity", function () {
  assert.strictEqual(rowAt(NOW, { ctx: { impactPxs: [] } }).impactBand, null);
  assert.strictEqual(rowAt(NOW, { ctx: { impactPxs: ["110"] } }).impactBand, null,
    "a one-sided quote is not a band");
  assert.strictEqual(rowAt(NOW, { ctx: { impactPxs: ["109", "110", "111"] } }).impactBand, null);
});

test("impactBand rejects coercible-but-non-numeric entries (review)", function () {
  // Number() coercion fabricated prices from these before the strict parser:
  // [false,true] -> [0,1], whitespace -> 0, [[],["109"]] -> [0,109].
  assert.strictEqual(rowAt(NOW, { ctx: { impactPxs: [false, true] } }).impactBand, null,
    "booleans are not prices");
  assert.strictEqual(rowAt(NOW, { ctx: { impactPxs: ["   ", "110.6"] } }).impactBand, null,
    "whitespace string is unknown, not 0");
  assert.strictEqual(rowAt(NOW, { ctx: { impactPxs: [[], ["109"]] } }).impactBand, null,
    "nested arrays are malformed, not prices");
  assert.strictEqual(rowAt(NOW, { ctx: { impactPxs: [{}, "110.6"] } }).impactBand, null);
});

// ------------------------------------------------------------------- additive

test("the three fields are additive: existing values are untouched", function () {
  const st = stateAt(NOW);
  st.revision = 3;
  st.coins["xyz:NVDA"].ctx.impactPxs = ["109.4", "110.6"];
  const withNew = buildApiState(st, FTFC, "xyz", NOW).coins[0];
  const bare = buildApiState(stateAt(NOW), FTFC, "xyz", NOW).coins[0];
  ["name", "sym", "uni", "mid", "chg24", "chgUtc", "vol", "funding", "score",
   "premium", "mark", "oracle", "oiUsd", "ready", "ftfc", "dots"].forEach(function (k) {
    assert.deepStrictEqual(withNew[k], bare[k], k + " unchanged by the additive fields");
  });
  assert.strictEqual(bare.impactBand, null, "a coin without impactPxs still serves the key");
  assert.ok(Object.prototype.hasOwnProperty.call(bare, "overnight_change_pct"));
});
