"use strict";

// chgUtc tests: the UTC-session change served by /api/state, and specifically
// the daily-roll guard. The guard is the reason this field exists separately
// from chg24 - without it a briefly stale pre-roll daily measures "today's
// change" from yesterday's open and renders as a completely ordinary number.
// node builtins only: node --test

const test = require("node:test");
const assert = require("node:assert");
const { buildApiState, utcSessionDaily } = require("../src/apistate.js");

// 2026-08-05T00:00:00Z, and a "now" partway through that UTC session.
const SESSION_START = Date.UTC(2026, 7, 5);
const NOW = SESSION_START + 6 * 3600 * 1000;
const PREV_SESSION_START = Date.UTC(2026, 7, 4);

// mid 110 against a 100 session open = +10%.
function coinWith(dailyForming, mid) {
  return {
    name: "xyz:NVDA", sym: "NVDA", uni: "xyz",
    mid: mid === undefined ? 110 : mid,
    hist: [], ctx: { markPx: "110", prevDayPx: "100", dayNtlVlm: "1000" },
    tf: {
      "1d": {
        closed: [],
        forming: dailyForming,
        an: { types: [null, "2U"], formingType: "2U", formingDir: "up", completed: null, setups: [], invalidated: false, live: [] }
      }
    }
  };
}

function stateOf(dailyForming, mid) {
  return {
    order: ["xyz:NVDA"],
    coins: { "xyz:NVDA": coinWith(dailyForming, mid) },
    loaded: true, universes: ["xyz"]
  };
}

function chgUtcOf(dailyForming, mid) {
  return buildApiState(stateOf(dailyForming, mid), ["1d"], null, NOW).coins[0].chgUtc;
}

const TODAY = { t: SESSION_START, T: SESSION_START + 86400000, o: 100, h: 115, l: 99, c: 110 };

test("chgUtc measures the move from the current UTC session open", function () {
  assert.strictEqual(chgUtcOf(TODAY), 10);
});

test("ROLL GUARD: a stale pre-roll daily yields null, NOT a stale percentage", function () {
  // The dangerous case. Yesterday's candle is still in the forming slot; using
  // it would report a change measured from the wrong session open, and the
  // number would look entirely normal.
  const stale = { t: PREV_SESSION_START, T: PREV_SESSION_START + 86400000, o: 50, h: 115, l: 49, c: 110 };
  assert.strictEqual(chgUtcOf(stale), null, "must refuse rather than measure from yesterday");
  // Proof the guard is what rejected it: the same candle stamped today works.
  assert.strictEqual(chgUtcOf({ ...stale, t: SESSION_START }), 120);
});

test("chgUtc is null - not zero - whenever the session open is unknown", function () {
  // null means "no opinion". Zero would be a claim that price is unchanged,
  // which is a different and wrong statement.
  assert.strictEqual(chgUtcOf(null), null, "no forming daily");
  assert.strictEqual(chgUtcOf({ t: SESSION_START, o: 0, h: 1, l: 0, c: 1 }), null, "zero open cannot divide");
  assert.strictEqual(chgUtcOf({ t: SESSION_START, o: null, h: 1, l: 0, c: 1 }), null, "null open");
  assert.strictEqual(chgUtcOf(TODAY, null), null, "no mid");
  assert.strictEqual(chgUtcOf({ t: "not-a-number", o: 100 }), null, "junk timestamp");
});

test("chgUtc and chg24 are independent and can legitimately disagree", function () {
  // chg24 uses the exchange's prevDayPx (window undefined by this codebase);
  // chgUtc uses the 00:00 UTC open. Different references, different answers -
  // that difference is the entire reason the field was added.
  const out = buildApiState(stateOf(TODAY), ["1d"], null, NOW).coins[0];
  assert.strictEqual(out.chg24, 10, "110 vs prevDayPx 100");
  const shifted = buildApiState(stateOf({ ...TODAY, o: 55 }), ["1d"], null, NOW).coins[0];
  assert.strictEqual(shifted.chg24, 10, "exchange reference is unchanged");
  assert.strictEqual(shifted.chgUtc, 100, "UTC session open of 55 gives a different figure");
});

test("chgUtc uses coin.mid, not the markPx fallback, so it matches briefing", function () {
  // briefing's utc_session_change_pct reads coin.mid. If this used the markPx
  // fallback the two published numbers would diverge whenever mid was absent.
  const st = stateOf(TODAY, null);
  st.coins["xyz:NVDA"].ctx.markPx = "200";
  const out = buildApiState(st, ["1d"], null, NOW).coins[0];
  assert.strictEqual(out.mid, 200, "mid falls back to markPx for display");
  assert.strictEqual(out.chgUtc, null, "but chgUtc refuses rather than using the fallback");
});

test("utcSessionDaily is exported and rejects candles outside the session", function () {
  const c = coinWith(TODAY);
  assert.strictEqual(utcSessionDaily(c, NOW), c.tf["1d"].forming);
  assert.strictEqual(utcSessionDaily(c, NOW + 86400000), null, "tomorrow: today's candle is stale");
  assert.strictEqual(utcSessionDaily({}, NOW), null);
  assert.strictEqual(utcSessionDaily(null, NOW), null);
});
