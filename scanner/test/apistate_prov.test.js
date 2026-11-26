"use strict";

// Per-coin `prov` (additive, feasibility report D5): underlying kind from the
// generated map plus the US cash-session state, and the shared usCashSession
// clock in src/cash_close.js it derives from. Injected clocks throughout -
// no boot, no fetch. node builtins only: node --test

const test = require("node:test");
const assert = require("node:assert");
const { usCashSession } = require("../src/cash_close.js");
const { buildApiState } = require("../src/apistate.js");

// ---------------------------------------------------- usCashSession clock
// The session predicate rides the SAME calendar previousUsCashClose walks
// (weekday/holiday/early-close), so these fixtures deliberately reuse the
// calibration dates test/cash_close.test.js already pins.

test("usCashSession: a summer weekday mid-session is rth (EDT, UTC-4)", function () {
  // Wed 2026-08-26 11:00 ET
  assert.strictEqual(usCashSession(Date.UTC(2026, 7, 26, 15, 0)), "rth");
});

test("usCashSession: a winter weekday mid-session is rth (EST, UTC-5)", function () {
  // Wed 2026-01-14 10:00 ET - 15:00 UTC is inside RTH in BOTH offsets, so
  // the pre-open case below is what actually pins DST awareness
  assert.strictEqual(usCashSession(Date.UTC(2026, 0, 14, 15, 0)), "rth");
  // 14:00 UTC = 09:00 EST: pre-open in winter, though 14:00 UTC would be
  // 10:00 EDT (open) under the summer offset
  assert.strictEqual(usCashSession(Date.UTC(2026, 0, 14, 14, 0)), "closed");
});

test("usCashSession: boundaries - open instant is rth, close instant is closed", function () {
  // Wed 2026-08-26: 13:30 UTC = 09:30 EDT, 20:00 UTC = 16:00 EDT
  assert.strictEqual(usCashSession(Date.UTC(2026, 7, 26, 13, 30)), "rth");
  assert.strictEqual(usCashSession(Date.UTC(2026, 7, 26, 13, 29)), "closed");
  assert.strictEqual(usCashSession(Date.UTC(2026, 7, 26, 20, 0)), "closed",
    "the close instant matches previousUsCashClose's target <= now convention");
});

test("usCashSession: weekends are closed", function () {
  // Sat 2026-08-29, an hour that would be RTH on a weekday
  assert.strictEqual(usCashSession(Date.UTC(2026, 7, 29, 15, 0)), "closed");
});

test("usCashSession: an observed holiday is closed all day", function () {
  // Fri 2026-07-03 - July 4 2026 is a Saturday, so this Friday is the
  // observed holiday (same calibration date as the cash_close tests)
  assert.strictEqual(usCashSession(Date.UTC(2026, 6, 3, 15, 0)), "closed");
});

test("usCashSession: a scheduled 13:00 early close ends the session early", function () {
  // Fri 2026-11-27, day after Thanksgiving (EST): 17:30 UTC = 12:30 ET
  assert.strictEqual(usCashSession(Date.UTC(2026, 10, 27, 17, 30)), "rth");
  // 18:30 UTC = 13:30 ET - after the early close, before a normal 16:00
  assert.strictEqual(usCashSession(Date.UTC(2026, 10, 27, 18, 30)), "closed");
});

// ------------------------------------------------------- prov in /api/state

// Minimal coin, same idiom as test/apistate.test.js.
function coin(name, sym, uni) {
  return {
    name: name, sym: sym, uni: uni, mid: 100, hist: [],
    ctx: { markPx: "100", prevDayPx: "99", dayNtlVlm: "1000" },
    tf: {}
  };
}

function stateOf() {
  const coins = {
    "xyz:NVDA": coin("xyz:NVDA", "NVDA", "xyz"),       // us_equity
    "xyz:TSM": coin("xyz:TSM", "TSM", "xyz"),          // adr - US-listed
    "xyz:XYZ100": coin("xyz:XYZ100", "XYZ100", "xyz"), // index
    "xyz:GOLD": coin("xyz:GOLD", "GOLD", "xyz"),       // commodity
    "xyz:ZZZFAKE": coin("xyz:ZZZFAKE", "ZZZFAKE", "xyz"), // not in the map
    "BTC": coin("BTC", "BTC", "perps")
  };
  return { order: Object.keys(coins), coins: coins, loaded: true, universes: ["xyz", "perps"] };
}

const FTFC = ["1h"];
const RTH_NOW = Date.UTC(2026, 7, 26, 15, 0);     // Wed 11:00 EDT - rth
const WEEKEND_NOW = Date.UTC(2026, 7, 29, 15, 0); // Sat - closed

function provsAt(now) {
  const byName = {};
  buildApiState(stateOf(), FTFC, null, now).coins.forEach(function (c) {
    byName[c.name] = c.prov;
  });
  return byName;
}

test("prov: an xyz us_equity coin during RTH", function () {
  assert.deepStrictEqual(provsAt(RTH_NOW)["xyz:NVDA"],
    { kind: "us_equity", us_session: "rth" });
});

test("prov: the same us_equity coin on a weekend reads closed", function () {
  assert.deepStrictEqual(provsAt(WEEKEND_NOW)["xyz:NVDA"],
    { kind: "us_equity", us_session: "closed" });
});

test("prov: a US-listed ADR gets the session reading too", function () {
  assert.deepStrictEqual(provsAt(RTH_NOW)["xyz:TSM"],
    { kind: "adr", us_session: "rth" });
});

test("prov: a perps coin is crypto with NO session - 24/7 renders from kind", function () {
  // null even while the US session is open: us_session describes the
  // underlying's cash market, and crypto has none
  assert.deepStrictEqual(provsAt(RTH_NOW)["BTC"],
    { kind: "crypto", us_session: null });
});

test("prov: index and commodity kinds serve us_session null even during RTH", function () {
  const p = provsAt(RTH_NOW);
  assert.deepStrictEqual(p["xyz:XYZ100"], { kind: "index", us_session: null });
  assert.deepStrictEqual(p["xyz:GOLD"], { kind: "commodity", us_session: null });
});

test("prov: an xyz symbol missing from the map is kind null - unknown, never a guess", function () {
  assert.deepStrictEqual(provsAt(RTH_NOW)["xyz:ZZZFAKE"],
    { kind: null, us_session: null });
});
