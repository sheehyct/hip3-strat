"use strict";

// Rule engine unit tests:
// score_cross hysteresis, live_signal per-bar dedup, invalidation pairing,
// price_level crossing direction, rvol_spike per-bar dedup.
// node builtins only: node --test

const test = require("node:test");
const assert = require("node:assert");
const { createRuleEngine } = require("../src/rules.js");

function makeConfig(overrides) {
  const base = {
    ftfcTfs: ["1h"],
    quietHoursUtc: null,
    rules: {
      live_signal: { enabled: false, tfs: ["1h"], kinds: ["rev"] },
      invalidation: { enabled: false },
      score_cross: { enabled: false, threshold: 60, rearm: 45 },
      ftfc_flip: { enabled: false, rearmSec: 0 }, // 0 = legacy immediate re-arm; hysteresis tests override
      price_level: { enabled: false, levels: {}, rearmPct: 0 },
      rvol_spike: { enabled: false, threshold: 3.0 },
      move_spike: { enabled: false, mult: 3, minPct: 0.75 }
    }
  };
  for (const k of Object.keys(overrides.rules || {})) {
    Object.assign(base.rules[k], overrides.rules[k]);
  }
  if (overrides.ftfcTfs) base.ftfcTfs = overrides.ftfcTfs;
  return base;
}

function makeEngine(configOverrides, engineOpts) {
  const sent = [];
  const opts = Object.assign({ statePath: null }, engineOpts || {});
  const engine = createRuleEngine(makeConfig(configOverrides), function (msg) {
    sent.push(msg);
    return true;
  }, opts);
  return { engine, sent };
}

// A coin whose 1h slot has one live rev signal on a fixed forming bar.
function liveCoin(barT) {
  return {
    name: "xyz:NVDA", sym: "NVDA", mid: 199.0, hist: [], ctx: null,
    tf: {
      "1h": {
        closed: [{ t: 1, o: 197, h: 199, l: 196, c: 198 }, { t: 2, o: 198, h: 198.8, l: 197.6, c: 198.5 }],
        forming: { t: barT, T: barT + 3600000, o: 198.5, h: 199.1, l: 198.3, c: 199.0, v: 10 },
        an: {
          types: [null, "2U"], formingType: "2U", formingDir: "up", completed: null,
          setups: [], invalidated: false,
          live: [{ name: "2D-1-2U", dir: "up", entry: 198.88, stop: 197.59, target: 199.40, kind: "rev" }]
        }
      }
    }
  };
}

test("live_signal fires once per forming bar, again on a new bar", function () {
  const { engine, sent } = makeEngine({ rules: { live_signal: { enabled: true } } });
  const coin = liveCoin(1000);
  engine.evaluateCoin(coin, 5000);
  engine.evaluateCoin(coin, 9000);   // same bar -> dedup
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^\[LIVE\] NVDA 1H 2D-1-2U up \| entry >198\.88 stop 197\.59 tgt 199\.40 \| score /);
  // bar rolls -> same pattern on the new forming bar fires again
  const coin2 = liveCoin(2000);
  engine.evaluateCoin(coin2, 12000);
  assert.strictEqual(sent.length, 2);
});

test("live_signal ignores kinds not in config (cont is not a fresh entry)", function () {
  const { engine, sent } = makeEngine({ rules: { live_signal: { enabled: true } } });
  const coin = liveCoin(1000);
  coin.tf["1h"].an.live = [{ name: "2U-1-2U", dir: "up", entry: 199, stop: 198, target: null, kind: "cont" }];
  engine.evaluateCoin(coin, 5000);
  assert.strictEqual(sent.length, 0);
});

test("live_signal ignores timeframes not in config", function () {
  const { engine, sent } = makeEngine({ rules: { live_signal: { enabled: true, tfs: ["4h"] } } });
  engine.evaluateCoin(liveCoin(1000), 5000);  // signal lives on 1h
  assert.strictEqual(sent.length, 0);
});

test("invalidation fires only for previously-alerted signals, once", function () {
  const { engine, sent } = makeEngine({
    rules: { live_signal: { enabled: true }, invalidation: { enabled: true } }
  });
  const coin = liveCoin(1000);
  engine.evaluateCoin(coin, 5000);          // LIVE fires
  assert.strictEqual(sent.length, 1);
  coin.tf["1h"].an.invalidated = true;      // forming bar went 3
  coin.tf["1h"].an.formingType = "3";
  engine.evaluateCoin(coin, 9000);
  engine.evaluateCoin(coin, 13000);         // no re-fire
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1], "[INVAL] NVDA 1H 2D-1-2U went 3 - invalidation exit");
});

test("invalidation does NOT fire without a prior live alert", function () {
  const { engine, sent } = makeEngine({ rules: { invalidation: { enabled: true } } });
  const coin = liveCoin(1000);
  coin.tf["1h"].an.invalidated = true;
  engine.evaluateCoin(coin, 5000);          // live_signal disabled -> never alerted
  assert.strictEqual(sent.length, 0);
});

// Score control: ftfcTfs = ["1h"], forming dir up, one live rev up, rvol >= 3
// -> dir = 0.45*1 + 0.35*momNorm + 0.20*0.5, act = 1.
// With r60 = +2% (momNorm 1): score = 90. With formingDir flat and no live:
// score = 0.
function scoreCoin(high) {
  const closes = [];
  for (let i = 0; i < 25; i++) {
    closes.push({ t: i * 900000, T: (i + 1) * 900000 - 1, o: 100, h: 101, l: 99, c: 100, v: 10 });
  }
  const barT = 25 * 900000;
  const coin = {
    name: "xyz:GOLD", sym: "GOLD", mid: high ? 102 : 100, hist: [], ctx: null,
    tf: {
      "15m": {
        closed: closes,
        forming: { t: barT, T: barT + 900000, o: 100, h: 102, l: 100, c: 102, v: 100 }, // rvol >> 3
        an: null
      },
      "1h": {
        closed: [],
        forming: { t: barT, T: barT + 3600000, o: 100, h: 102, l: 100, c: high ? 102 : 100, v: 0 },
        an: {
          types: [], formingType: "2U", formingDir: high ? "up" : "flat", completed: null,
          setups: [], invalidated: false,
          live: high ? [{ name: "2D-2U", dir: "up", entry: 101, stop: 99, target: 103, kind: "rev" }] : []
        }
      }
    }
  };
  return coin;
}

test("score_cross fires on crossing +60, no re-fire until abs(score) < 45", function () {
  const { engine, sent } = makeEngine({ rules: { score_cross: { enabled: true } } });
  const now = 25 * 900000 + 300000; // 5 min into the forming 15m bar
  engine.evaluateCoin(scoreCoin(true), now);       // score 90 -> fire
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^\[SCORE\] GOLD \+90 \(crossed \+60\) \| 1h \+2\.0% rvol /);
  engine.evaluateCoin(scoreCoin(true), now + 4000); // still high -> no re-fire
  assert.strictEqual(sent.length, 1);
  engine.evaluateCoin(scoreCoin(false), now + 8000); // score 0 -> re-arm
  engine.evaluateCoin(scoreCoin(true), now + 12000); // crosses again -> fire
  assert.strictEqual(sent.length, 2);
});

test("price_level fires once per crossing direction with silent baseline", function () {
  const { engine, sent } = makeEngine({
    rules: { price_level: { enabled: true, levels: { GOLD: [101] } } }
  });
  function at(mid) {
    const c = scoreCoin(false);
    c.mid = mid;
    return c;
  }
  const now = 25 * 900000 + 300000;
  engine.evaluateCoin(at(100), now);         // baseline below -> silent
  assert.strictEqual(sent.length, 0);
  engine.evaluateCoin(at(102), now + 4000);  // below -> above: fire
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^\[LEVEL\] GOLD crossed above 101\.00 \| mid 102\.00$/);
  engine.evaluateCoin(at(103), now + 8000);  // still above -> no fire
  assert.strictEqual(sent.length, 1);
  engine.evaluateCoin(at(100), now + 12000); // above -> below: fire
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1], /^\[LEVEL\] GOLD crossed below 101\.00 \| mid 100\.00$/);
});

test("rvol_spike fires once per 15m bar", function () {
  const { engine, sent } = makeEngine({ rules: { rvol_spike: { enabled: true } } });
  const now = 25 * 900000 + 300000;
  engine.evaluateCoin(scoreCoin(true), now);        // rvol >> 3 -> fire
  engine.evaluateCoin(scoreCoin(true), now + 4000); // same bar -> dedup
  assert.strictEqual(sent.length, 1);
  // scoreCoin forming: v 100 * c 102 = $10.2k notional in the message tail
  assert.match(sent[0], /^\[RVOL\] GOLD 15m rvol \d+\.\dx \(>= 3\) \| ntl \$10\.2k \| 15m /);
});

test("rvol_spike notional floor: dust blocked WITHOUT consuming the bar's dedup key", function () {
  const { engine, sent } = makeEngine({
    rules: { rvol_spike: { enabled: true, minNotional: 25000 } }
  });
  const now = 25 * 900000 + 300000;
  // rvol reads 30x but only $10.2k has traded (v 100 * c 102) -> no fire,
  // and the per-bar key must stay unwritten so a later true-up can fire.
  engine.evaluateCoin(scoreCoin(true), now);
  assert.strictEqual(sent.length, 0);
  // Volume trues up within the SAME bar: v 300 * c 102 = $30.6k -> fires.
  const trued = scoreCoin(true);
  trued.tf["15m"].forming.v = 300;
  engine.evaluateCoin(trued, now + 300000);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^\[RVOL\] GOLD 15m rvol \d+\.\dx \(>= 3\) \| ntl \$30\.6k \| 15m /);
  // And the fire consumed the key: same bar stays deduped afterwards.
  engine.evaluateCoin(trued, now + 304000);
  assert.strictEqual(sent.length, 1);
});

test("ftfc_flip fires on entering full alignment, re-arms on leaving it", function () {
  const { engine, sent } = makeEngine({ rules: { ftfc_flip: { enabled: true } } });
  const now = 25 * 900000 + 300000;
  engine.evaluateCoin(scoreCoin(false), now);        // mixed baseline -> silent
  assert.strictEqual(sent.length, 0);
  engine.evaluateCoin(scoreCoin(true), now + 4000);  // mixed -> up: fire
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^\[FTFC\] GOLD FTFC up \(1H\) \| score /);
  engine.evaluateCoin(scoreCoin(true), now + 8000);  // still up -> no re-fire
  assert.strictEqual(sent.length, 1);
  engine.evaluateCoin(scoreCoin(false), now + 12000); // leaves full -> re-arm
  engine.evaluateCoin(scoreCoin(true), now + 16000);  // fires again
  assert.strictEqual(sent.length, 2);
});

// Roster recovery (loop.js refreshCtxs) registers coins into the RUNNING loop
// with tf:{}. coinSummary reports a missing slot as "flat", which rolls up to
// a perfectly legitimate-looking "mixed" - so an empty coin would consume the
// silent baseline with a verdict derived from no data, and the first
// observation that actually HAS candles would fire instead of establishing it.
// Reproduced pre-fix: an empty-then-aligned coin emitted "[FTFC] NEW FTFC up"
// while an identical coin whose candles were present from the start emitted
// nothing. Unreachable before roster recovery landed, because start() awaits
// the initial candle load before startTimers() (code review
// 2026-08-07).
test("ftfc_flip stays silent for a coin with no candles and does not burn its baseline", function () {
  const { engine, sent } = makeEngine({ rules: { ftfc_flip: { enabled: true } } });
  const now = 25 * 900000 + 300000;

  const empty = scoreCoin(true);
  empty.tf = {};                                      // just registered, no candles yet
  engine.evaluateCoin(empty, now);
  assert.strictEqual(sent.length, 0, "an unjudgeable coin fires nothing");
  assert.strictEqual(engine._state.ftfcState["xyz:GOLD"], undefined,
    "no baseline recorded from an observation with no data behind it");

  engine.evaluateCoin(scoreCoin(true), now + 4000);   // candles land, already aligned
  assert.strictEqual(sent.length, 0, "the first EVALUABLE observation is the silent baseline");
  assert.deepStrictEqual(engine._state.ftfcState["xyz:GOLD"], { fired: "up", leftAt: null });

  engine.evaluateCoin(scoreCoin(false), now + 8000);  // leaves alignment -> re-arm
  engine.evaluateCoin(scoreCoin(true), now + 12000);  // genuine transition
  assert.strictEqual(sent.length, 1, "a real transition after the baseline still fires");
  assert.match(sent[0], /^\[FTFC\] GOLD FTFC up \(1H\) \| score /);
});

// A partially-loaded coin was already safe (a missing slot is "flat" and flat
// never completes an alignment); the gate must not change that, only defer the
// baseline until the whole configured set is judgeable.
test("ftfc_flip defers the baseline while any configured timeframe is unanalyzed", function () {
  const { engine, sent } = makeEngine({
    ftfcTfs: ["1h", "4h"],
    rules: { ftfc_flip: { enabled: true } }
  });
  const now = 25 * 900000 + 300000;
  const partial = scoreCoin(true);                    // has 1h, never had 4h
  engine.evaluateCoin(partial, now);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(engine._state.ftfcState["xyz:GOLD"], undefined,
    "baseline waits for the 4h slot rather than banking a half-known verdict");
});

// ============================================================================
// Additional coverage.
// ============================================================================

const { momentum, rvol15, coinSummary, heatScore } = require("../src/metrics.js");
const { analyzeTF } = require("../src/strat_core.js");

// Score-controllable coin: ftfcTfs = ["1h"], no live signals, rvol pinned at
// 30 (act = 1), so score = round(100 * (0.45*ftfcNet + 0.35*clamp(r60/1.5)))
// and r60 = mid - 100 (all 15m closes at 100). midForUp/midForDown invert that.
function heatCoin(mid, ftfcDir) {
  const closes = [];
  for (let i = 0; i < 25; i++) {
    closes.push({ t: i * 900000, T: (i + 1) * 900000 - 1, o: 100, h: 101, l: 99, c: 100, v: 10 });
  }
  const barT = 25 * 900000;
  return {
    name: "xyz:SILVER", sym: "SILVER", mid: mid, hist: [], ctx: null,
    tf: {
      "15m": {
        closed: closes,
        forming: { t: barT, T: barT + 900000, o: 100, h: Math.max(101, mid), l: Math.min(99, mid), c: mid, v: 100 },
        an: null
      },
      "1h": {
        closed: [],
        forming: { t: barT, T: barT + 3600000, o: 100, h: Math.max(101, mid), l: Math.min(99, mid), c: mid, v: 0 },
        an: {
          types: [], formingType: null, formingDir: ftfcDir, completed: null,
          setups: [], invalidated: false, live: []
        }
      }
    }
  };
}
const HEAT_NOW = 25 * 900000 + 300000; // 5 min into the forming 15m bar
function upAt(score) { return heatCoin(100 + 1.5 * ((score / 100 - 0.45) / 0.35), "up"); }
function downAt(score) { return heatCoin(100 + 1.5 * ((score / 100 + 0.45) / 0.35), "down"); }
function scoreOf(coin, now) {
  return heatScore(coinSummary(coin, ["1h"]), momentum(coin, now), rvol15(coin, now));
}

test("heatCoin fixture produces the intended scores (guards the hover test)", function () {
  assert.strictEqual(scoreOf(upAt(62), HEAT_NOW), 62);
  assert.strictEqual(scoreOf(upAt(59), HEAT_NOW), 59);
  assert.strictEqual(scoreOf(upAt(44), HEAT_NOW), 44);
  assert.strictEqual(scoreOf(downAt(-62), HEAT_NOW), -62);
});

test("score_cross hover 62..59..62 does NOT re-fire until abs(score) < 45", function () {
  const { engine, sent } = makeEngine({ rules: { score_cross: { enabled: true } } });
  engine.evaluateCoin(upAt(62), HEAT_NOW);           // crosses +60 -> fire
  assert.strictEqual(sent.length, 1);
  engine.evaluateCoin(upAt(59), HEAT_NOW + 4000);    // dips below 60 but >= 45
  engine.evaluateCoin(upAt(62), HEAT_NOW + 8000);    // back above 60 -> NO re-fire
  assert.strictEqual(sent.length, 1);
  engine.evaluateCoin(upAt(44), HEAT_NOW + 12000);   // abs(score) < 45 -> re-arm
  engine.evaluateCoin(upAt(62), HEAT_NOW + 16000);   // crosses again -> fire
  assert.strictEqual(sent.length, 2);
});

test("score_cross is per direction: +62 then -62 both fire, neither re-fires", function () {
  const { engine, sent } = makeEngine({ rules: { score_cross: { enabled: true } } });
  engine.evaluateCoin(upAt(62), HEAT_NOW);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^\[SCORE\] SILVER \+62 \(crossed \+60\)/);
  engine.evaluateCoin(downAt(-62), HEAT_NOW + 4000);  // never dipped under 45: down arm is separate
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1], /^\[SCORE\] SILVER -62 \(crossed -60\)/);
  engine.evaluateCoin(upAt(62), HEAT_NOW + 8000);     // both disarmed now
  engine.evaluateCoin(downAt(-62), HEAT_NOW + 12000);
  assert.strictEqual(sent.length, 2);
});

test("score_cross is per coin: same score on a second coin fires independently", function () {
  const { engine, sent } = makeEngine({ rules: { score_cross: { enabled: true } } });
  engine.evaluateCoin(upAt(62), HEAT_NOW);
  const other = upAt(62);
  other.name = "xyz:URANIUM"; other.sym = "URANIUM";
  engine.evaluateCoin(other, HEAT_NOW + 4000);
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1], /^\[SCORE\] URANIUM \+62 /);
});

test("live_signal ignores kind info (structure without a valid reference)", function () {
  const { engine, sent } = makeEngine({ rules: { live_signal: { enabled: true } } });
  const coin = liveCoin(1000);
  coin.tf["1h"].an.live = [{ name: "1-1-2U", dir: "up", entry: 199, stop: 198, target: null, kind: "info" }];
  engine.evaluateCoin(coin, 5000);
  assert.strictEqual(sent.length, 0);
});

test("ftfc_flip direction flip up -> mixed -> down fires the down", function () {
  const { engine, sent } = makeEngine({ rules: { ftfc_flip: { enabled: true } } });
  engine.evaluateCoin(heatCoin(100, "flat"), HEAT_NOW);       // mixed baseline -> silent
  engine.evaluateCoin(heatCoin(100.6, "up"), HEAT_NOW + 4000); // enters full up -> fire
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^\[FTFC\] SILVER FTFC up /);
  engine.evaluateCoin(heatCoin(100.6, "up"), HEAT_NOW + 8000); // stays up -> silent
  engine.evaluateCoin(heatCoin(100, "flat"), HEAT_NOW + 12000); // up -> mixed: silent re-arm
  assert.strictEqual(sent.length, 1);
  engine.evaluateCoin(heatCoin(99.4, "down"), HEAT_NOW + 16000); // mixed -> down: fire
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1], /^\[FTFC\] SILVER FTFC down /);
});

test("price_level re-arm band: chop inside the band never fires", function () {
  const { engine, sent } = makeEngine({
    rules: { price_level: { enabled: true, levels: { COPPER: [100] }, rearmPct: 1 } }
  });
  function at(mid) {
    return { name: "xyz:COPPER", sym: "COPPER", mid: mid, hist: [], ctx: null, tf: {} };
  }
  // band = 1%: above only when mid > 101, below only when mid < 99
  engine.evaluateCoin(at(98), 1000);       // baseline below -> silent
  engine.evaluateCoin(at(100.5), 2000);    // inside band -> side unchanged, no fire
  engine.evaluateCoin(at(100.9), 3000);    // chop at the level -> no fire
  engine.evaluateCoin(at(99.2), 4000);     // still inside band -> no fire
  assert.strictEqual(sent.length, 0);
  engine.evaluateCoin(at(102), 5000);      // clears the band -> below -> above: fire
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^\[LEVEL\] COPPER crossed above 100\.00 \| mid 102\.00$/);
  engine.evaluateCoin(at(100.5), 6000);    // back inside band -> no fire
  assert.strictEqual(sent.length, 1);
  engine.evaluateCoin(at(98.5), 7000);     // clears the band down -> fire
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1], /^\[LEVEL\] COPPER crossed below 100\.00 \| mid 98\.500$/);
});

test("rvol_spike re-fires on a NEW 15m bar identity", function () {
  const { engine, sent } = makeEngine({ rules: { rvol_spike: { enabled: true } } });
  const c1 = heatCoin(100, "flat");                       // rvol 30 >> 3
  engine.evaluateCoin(c1, HEAT_NOW);
  engine.evaluateCoin(c1, HEAT_NOW + 4000);               // same bar -> dedup
  assert.strictEqual(sent.length, 1);
  const c2 = heatCoin(100, "flat");
  c2.tf["15m"].forming.t += 900000;                       // next 15m bar
  c2.tf["15m"].forming.T += 900000;
  engine.evaluateCoin(c2, HEAT_NOW + 900000);
  assert.strictEqual(sent.length, 2);
});

// End-to-end with the REAL detection core: guards the field-name contract
// between strat_core live entries ({name,dir,entry,stop,target,kind}) and
// rules.js message formatting, plus invalidation pairing off an actual
// forming-bar-goes-3 transition.
function coreCoin(forming) {
  const closed = [
    { t: 0, o: 105, h: 110, l: 100, c: 104 },
    { t: 1, o: 104, h: 109, l: 99, c: 101 },   // 2D
    { t: 2, o: 101, h: 105, l: 101, c: 103 }   // 1 (inside) -> 2D-1-2U rev setup, trig 105
  ];
  return {
    name: "xyz:NVDA", sym: "NVDA", mid: forming.c, hist: [], ctx: null,
    tf: { "1h": { closed: closed, forming: forming, an: analyzeTF(closed, forming) } }
  };
}

test("live_signal + invalidation off real analyzeTF output", function () {
  const { engine, sent } = makeEngine({
    rules: { live_signal: { enabled: true }, invalidation: { enabled: true } }
  });
  const barT = 3000;
  // forming bar breaks the inside-bar high -> 2D-1-2U goes LIVE (2U forming)
  const c1 = coreCoin({ t: barT, T: barT + 3600000, o: 103, h: 105.5, l: 102, c: 105.2 });
  assert.strictEqual(c1.tf["1h"].an.live.length, 1);
  assert.strictEqual(c1.tf["1h"].an.invalidated, false);
  engine.evaluateCoin(c1, 5000);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^\[LIVE\] NVDA 1H 2D-1-2U up \| entry >105\.00 stop 99\.000 tgt 109\.00 \| /);
  // same forming bar expands through the low -> bar goes 3 -> invalidation.
  // The down-side cont (2D-1-2D) also goes live but was never alerted
  // (kinds=["rev"]), so it must NOT get an INVAL alert.
  const c2 = coreCoin({ t: barT, T: barT + 3600000, o: 103, h: 105.5, l: 100.9, c: 101.0 });
  assert.strictEqual(c2.tf["1h"].an.formingType, "3");
  assert.strictEqual(c2.tf["1h"].an.invalidated, true);
  engine.evaluateCoin(c2, 9000);
  engine.evaluateCoin(c2, 13000); // once per key
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1], "[INVAL] NVDA 1H 2D-1-2U went 3 - invalidation exit");
});

// ============================================================================
// Regression tests for review findings (2026-07-02).
// ============================================================================

// Finding: a 3-transition in the final mid-poll gap of the bar (or a sub-4s
// traded wick, or process downtime) is never seen on the FORMING bar; the
// CLOSED bar is authoritative and must pair the [INVAL] at the roll.
test("invalidation fires at bar roll when the alerted bar CLOSED as a 3", function () {
  const { engine, sent } = makeEngine({
    rules: { live_signal: { enabled: true }, invalidation: { enabled: true } }
  });
  const barT = 3000;
  // forming bar breaks the inside-bar high -> [LIVE] 2D-1-2U (not yet a 3)
  const c1 = coreCoin({ t: barT, T: barT + 3600000, o: 103, h: 105.5, l: 102, c: 105.2 });
  engine.evaluateCoin(c1, 5000);
  assert.strictEqual(sent.length, 1);
  // the 3-transition happens AFTER the last mids tick: the forming path
  // never observes it. At the roll the bar arrives CLOSED as a 3 and a new
  // forming bar (inside, no live signals) replaces it.
  const closed = [
    { t: 0, o: 105, h: 110, l: 100, c: 104 },
    { t: 1, o: 104, h: 109, l: 99, c: 101 },
    { t: 2, o: 101, h: 105, l: 101, c: 103 },
    { t: barT, o: 103, h: 105.5, l: 100.9, c: 101.0 } // closed as a 3
  ];
  const newForming = { t: barT + 3600000, T: barT + 7200000, o: 101, h: 102, l: 100.95, c: 101.5 };
  const an = analyzeTF(closed, newForming);
  assert.strictEqual(an.types[an.types.length - 1], "3");
  assert.strictEqual(an.invalidated, false); // NEW forming bar is clean
  const c2 = {
    name: "xyz:NVDA", sym: "NVDA", mid: 101.5, hist: [], ctx: null,
    tf: { "1h": { closed: closed, forming: newForming, an: an } }
  };
  engine.evaluateCoin(c2, 3610000);
  engine.evaluateCoin(c2, 3614000); // once per key
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1], "[INVAL] NVDA 1H 2D-1-2U went 3 - invalidation exit");
});

// Finding: PRUNE_MS deleted dedup keys while 1w/1M bars were still forming,
// re-firing the identical [LIVE] every ~48h. Retention is now keyed off the
// bar's END time.
function weeklyLiveCoin(barT) {
  const c = liveCoin(barT);
  c.tf["1w"] = c.tf["1h"];
  delete c.tf["1h"];
  c.tf["1w"].forming.T = barT + 604800000;
  return c;
}

test("prune keeps a weekly dedup key while the bar is still forming (no 48h re-fire)", function () {
  const { engine, sent } = makeEngine({
    rules: { live_signal: { enabled: true, tfs: ["1w"] } }
  });
  const barT = 1000 * 604800000;         // arbitrary week start; ends barT + 7d
  const fireAt = barT + 3600000;         // 1h into the weekly bar
  engine.evaluateCoin(weeklyLiveCoin(barT), fireAt);
  assert.strictEqual(sent.length, 1);
  // 49h later the SAME weekly bar is still forming: key must survive prune
  engine._prune(fireAt + 49 * 3600000);
  assert.strictEqual(Object.keys(engine._state.liveFired).length, 1);
  engine.evaluateCoin(weeklyLiveCoin(barT), fireAt + 49 * 3600000);
  assert.strictEqual(sent.length, 1);    // NO duplicate [LIVE]
  // 48h AFTER the bar ends the key is released
  engine._prune(barT + 604800000 + 48 * 3600000 + 1000);
  assert.strictEqual(Object.keys(engine._state.liveFired).length, 0);
});

test("prune handles monthly keys via calendar month end, falls back to ts otherwise", function () {
  const { engine } = makeEngine({});
  const jan1 = Date.UTC(2026, 0, 1);
  engine._state.liveFired["xyz:NVDA|1M|" + jan1 + "|3-2U"] = Date.UTC(2026, 0, 2);
  engine._state.liveFired["unparseable-legacy-key"] = Date.UTC(2026, 0, 2);
  // Jan 25: monthly bar still forming -> kept even though ts is 23 days old;
  // the unparseable key falls back to ts-based pruning -> dropped.
  engine._prune(Date.UTC(2026, 0, 25));
  assert.deepStrictEqual(Object.keys(engine._state.liveFired),
    ["xyz:NVDA|1M|" + jan1 + "|3-2U"]);
  // Feb 3 00:00:01 (> month end Feb 1 + 48h) -> released
  engine._prune(Date.UTC(2026, 1, 3, 0, 0, 1));
  assert.deepStrictEqual(Object.keys(engine._state.liveFired), []);
});

// Finding: ftfc_flip re-armed on every bar-clock artifact (fresh forming bar
// has c == o -> "flat" dot -> "mixed") and re-fired an unchanged trend.
// Re-arm now requires the departure to PERSIST for rearmSec; a flip to the
// OPPOSITE full alignment still fires immediately.
test("ftfc_flip hysteresis: roll-boundary flat tick does not re-fire an unchanged trend", function () {
  const { engine, sent } = makeEngine({
    rules: { ftfc_flip: { enabled: true, rearmSec: 900 } }
  });
  engine.evaluateCoin(heatCoin(100, "flat"), HEAT_NOW);          // baseline -> silent
  engine.evaluateCoin(heatCoin(100.6, "up"), HEAT_NOW + 4000);   // enters full up -> fire
  assert.strictEqual(sent.length, 1);
  engine.evaluateCoin(heatCoin(100, "flat"), HEAT_NOW + 8000);   // 15m roll: dot flat -> mixed blip
  engine.evaluateCoin(heatCoin(100.6, "up"), HEAT_NOW + 12000);  // trend unchanged -> NO re-fire
  engine.evaluateCoin(heatCoin(100, "flat"), HEAT_NOW + 16000);  // another blip
  engine.evaluateCoin(heatCoin(100.6, "up"), HEAT_NOW + 20000);  // still NO re-fire
  assert.strictEqual(sent.length, 1);
  engine.evaluateCoin(heatCoin(99.4, "down"), HEAT_NOW + 24000); // GENUINE flip -> fires immediately
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1], /^\[FTFC\] SILVER FTFC down /);
});

test("ftfc_flip re-arms after the departure persists for rearmSec", function () {
  const { engine, sent } = makeEngine({
    rules: { ftfc_flip: { enabled: true, rearmSec: 60 } }
  });
  engine.evaluateCoin(heatCoin(100, "flat"), HEAT_NOW);            // baseline
  engine.evaluateCoin(heatCoin(100.6, "up"), HEAT_NOW + 4000);     // fire
  assert.strictEqual(sent.length, 1);
  // departure shorter than rearmSec, then back up: no re-fire
  engine.evaluateCoin(heatCoin(100, "flat"), HEAT_NOW + 8000);
  engine.evaluateCoin(heatCoin(100, "flat"), HEAT_NOW + 38000);    // 30s mixed < 60s
  engine.evaluateCoin(heatCoin(100.6, "up"), HEAT_NOW + 42000);
  assert.strictEqual(sent.length, 1);
  // departure sustained past rearmSec -> re-armed -> next full up fires
  engine.evaluateCoin(heatCoin(100, "flat"), HEAT_NOW + 50000);
  engine.evaluateCoin(heatCoin(100, "flat"), HEAT_NOW + 50000 + 61000);
  engine.evaluateCoin(heatCoin(100.6, "up"), HEAT_NOW + 50000 + 65000);
  assert.strictEqual(sent.length, 2);
});

test("ftfc_flip migrates legacy string state without spurious fires", function () {
  const { engine, sent } = makeEngine({
    rules: { ftfc_flip: { enabled: true, rearmSec: 900 } }
  });
  engine._state.ftfcState["xyz:SILVER"] = "up"; // pre-hysteresis persisted format
  engine.evaluateCoin(heatCoin(100.6, "up"), HEAT_NOW);  // already fired for up -> silent
  assert.strictEqual(sent.length, 0);
  engine.evaluateCoin(heatCoin(99.4, "down"), HEAT_NOW + 4000); // genuine flip -> fires
  assert.strictEqual(sent.length, 1);
});

// ============================================================================
// Multi-universe alert gate (evaluateAll SKIPS coins whose `uni` is not in
// ALERT_UNIVERSES). THE safety property: tracking perps for the screener must
// not change alert behavior unless the operator opts perps into alerting.
// ============================================================================

// An xyz-shaped live coin re-badged to an arbitrary name/sym/universe.
function uniCoin(name, sym, uni, barT) {
  const c = liveCoin(barT);
  c.name = name; c.sym = sym; c.uni = uni;
  return c;
}
function mixedLoopState(barT) {
  return {
    order: ["xyz:NVDA", "BTC"],
    coins: {
      "xyz:NVDA": uniCoin("xyz:NVDA", "NVDA", "xyz", barT),
      "BTC": uniCoin("BTC", "BTC", "perps", barT)
    }
  };
}

test("alert gate: perps coin does NOT fire when ALERT_UNIVERSES=xyz", function () {
  const { engine, sent } = makeEngine(
    { rules: { live_signal: { enabled: true } } },
    { alertUniverses: ["xyz"] }
  );
  engine.evaluateAll(mixedLoopState(1000));
  assert.strictEqual(sent.length, 1);          // only the xyz coin
  assert.match(sent[0], /^\[LIVE\] NVDA /);
});

test("alert gate: perps coin DOES fire when ALERT_UNIVERSES=xyz,perps", function () {
  const { engine, sent } = makeEngine(
    { rules: { live_signal: { enabled: true } } },
    { alertUniverses: ["xyz", "perps"] }
  );
  engine.evaluateAll(mixedLoopState(1000));
  assert.strictEqual(sent.length, 2);
  const syms = sent.map(function (m) { return m.split(" ")[1]; }).sort();
  assert.deepStrictEqual(syms, ["BTC", "NVDA"]);
});

test("alert gate: no alertUniverses (legacy) evaluates every coin", function () {
  const { engine, sent } = makeEngine({ rules: { live_signal: { enabled: true } } });
  engine.evaluateAll(mixedLoopState(1000));
  assert.strictEqual(sent.length, 2);
});

test("alert gate: screener-only coins create NO rule state (rule_state.json stays xyz-only)", function () {
  const { engine, sent } = makeEngine(
    { rules: { live_signal: { enabled: true }, score_cross: { enabled: true } } },
    { alertUniverses: ["xyz"] }
  );
  engine.evaluateAll(mixedLoopState(1000));
  assert.strictEqual(sent.length, 1);
  // no dedup / re-arm keys were minted for the skipped perps coin
  const keysMention = function (map) { return Object.keys(map).some(function (k) { return k.indexOf("BTC") >= 0; }); };
  assert.strictEqual(keysMention(engine._state.liveFired), false);
  assert.strictEqual("BTC" in engine._state.scoreArm, false);
});

// A coin with 21 quiet 15m bars (avg true range 0.1% by construction) and a
// live mid; move_spike fixtures push the mid off the last close (100).
function spikeCoin(mid, barT) {
  const closed = [];
  for (let i = 0; i < 21; i++) {
    closed.push({ t: i * 900000, o: 100, h: 100.05, l: 99.95, c: 100 });
  }
  return {
    name: "xyz:NVDA", sym: "NVDA", mid: mid, hist: [], ctx: null,
    tf: {
      "15m": {
        closed: closed,
        forming: { t: barT, T: barT + 900000, o: 100, h: Math.max(100, mid), l: Math.min(100, mid), c: mid, v: 1 },
        an: null
      }
    }
  };
}

test("move_spike fires once per 15m bar per DIRECTION, re-fires on a new bar", function () {
  const { engine, sent } = makeEngine({ rules: { move_spike: { enabled: true } } });
  engine.evaluateCoin(spikeCoin(100.8, 1000));        // +0.8% >= max(0.75, 3*0.1)
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /\[SPIKE\] NVDA \+0\.8% in 15m/);
  assert.match(sent[0], /8\.0x its normal range/);
  engine.evaluateCoin(spikeCoin(100.9, 1000));        // same bar, same direction: dedup
  assert.strictEqual(sent.length, 1);
  engine.evaluateCoin(spikeCoin(99.1, 1000));         // same bar, OPPOSITE direction: fires
  assert.strictEqual(sent.length, 2);
  assert.match(sent[1], /-0\.9% in 15m/);
  engine.evaluateCoin(spikeCoin(100.8, 1000 + 900000)); // new bar identity: fires again
  assert.strictEqual(sent.length, 3);
});

test("move_spike stays silent below the threshold and when disabled", function () {
  const { engine, sent } = makeEngine({ rules: { move_spike: { enabled: true } } });
  engine.evaluateCoin(spikeCoin(100.5, 1000));        // 0.5% < 0.75% floor
  assert.strictEqual(sent.length, 0);
  const off = makeEngine({});                          // disabled in the base config
  off.engine.evaluateCoin(spikeCoin(105, 1000));
  assert.strictEqual(off.sent.length, 0);
});

test("move_spike threshold is ATR-adaptive: mult*normal-range dominates a low floor", function () {
  // floor lowered to 0.05%: threshold = 3 * 0.1% = 0.3%
  const { engine, sent } = makeEngine({ rules: { move_spike: { enabled: true, minPct: 0.05 } } });
  engine.evaluateCoin(spikeCoin(100.2, 1000));        // 0.2% < 0.3%: quiet coin, no fire
  assert.strictEqual(sent.length, 0);
  engine.evaluateCoin(spikeCoin(100.35, 1000));       // 0.35% >= 0.3%: fires
  assert.strictEqual(sent.length, 1);
});

test("move_spike needs 21 closed 15m bars (no yardstick, no fire)", function () {
  const { engine, sent } = makeEngine({ rules: { move_spike: { enabled: true } } });
  const c = spikeCoin(105, 1000);
  c.tf["15m"].closed = c.tf["15m"].closed.slice(0, 10);
  engine.evaluateCoin(c);
  assert.strictEqual(sent.length, 0);
});

// ---- dropCoins (roster removal support) ----
// The per-bar maps self-prune 48h past bar end, but scoreArm / ftfcState /
// levelSides are per-coin and NEVER pruned. A re-listed name inheriting a
// stale ftfcState skips the silent first-observation baseline and can fire
// on a months-old verdict - so removal must clear everything, making a
// re-list behave exactly like a brand-new listing.
test("dropCoins clears a removed coin's rule state; other coins untouched", function () {
  const engine = createRuleEngine({ rules: {} }, function () {});
  engine._state.ftfcState["xyz:GONE"] = { fired: "up", leftAt: null };
  engine._state.scoreArm["xyz:GONE"] = { up: false, down: true };
  engine._state.levelSides["xyz:GONE|100"] = "above";
  engine._state.liveFired["xyz:GONE|1d|123|3-2U"] = 111;
  engine._state.invalFired["xyz:GONE|1d|123|3-2U"] = 112;
  engine._state.rvolFired["xyz:GONE|456"] = 113;
  engine._state.moveFired["xyz:GONE|456|up"] = 114;
  engine._state.ftfcState["xyz:KEEP"] = { fired: "down", leftAt: null };
  engine._state.levelSides["xyz:KEEP|50"] = "below";
  engine.dropCoins(["xyz:GONE"]);
  assert.strictEqual(engine._state.ftfcState["xyz:GONE"], undefined);
  assert.strictEqual(engine._state.scoreArm["xyz:GONE"], undefined);
  assert.strictEqual(engine._state.levelSides["xyz:GONE|100"], undefined);
  assert.strictEqual(engine._state.liveFired["xyz:GONE|1d|123|3-2U"], undefined);
  assert.strictEqual(engine._state.invalFired["xyz:GONE|1d|123|3-2U"], undefined);
  assert.strictEqual(engine._state.rvolFired["xyz:GONE|456"], undefined);
  assert.strictEqual(engine._state.moveFired["xyz:GONE|456|up"], undefined);
  assert.deepStrictEqual(engine._state.ftfcState["xyz:KEEP"], { fired: "down", leftAt: null });
  assert.strictEqual(engine._state.levelSides["xyz:KEEP|50"], "below");
  engine.dropCoins([]);     // no-op inputs must not throw
  engine.dropCoins(null);
});

test("dropCoins prefix match is exact: BTC never clears BTC2's state", function () {
  const engine = createRuleEngine({ rules: {} }, function () {});
  engine._state.levelSides["BTC|100"] = "above";
  engine._state.levelSides["BTC2|100"] = "below";
  engine._state.ftfcState["BTC2"] = { fired: "up", leftAt: null };
  engine.dropCoins(["BTC"]);
  assert.strictEqual(engine._state.levelSides["BTC|100"], undefined);
  assert.strictEqual(engine._state.levelSides["BTC2|100"], "below");
  assert.deepStrictEqual(engine._state.ftfcState["BTC2"], { fired: "up", leftAt: null });
});
