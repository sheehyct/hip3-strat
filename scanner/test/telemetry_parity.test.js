"use strict";

// Telemetry-vs-/api/state PARITY. The API is the parity REFERENCE: whatever
// score and rvol buildApiState serves for a state, lineFor must record for
// the same state and the same injected clock - null must equal null. The
// two gates under test are the ones the API applies and v2 telemetry
// skipped:
//   - TRUE-UP SCOPE (demand cut, design decision 2026-08-17): a coin whose
//     universe is outside state.trueUpUniverses has its forming 15m volume
//     frozen at the roll-time sample, so its pace-adjusted rvol DECAYS
//     toward zero across the bar. The API serves rvol null; v2 telemetry
//     recorded the decaying number and scored with it.
//   - READINESS (design decision 2026-08-15): while any configured timeframe lacks
//     analysis the API serves score null; v2 telemetry recorded a numeric
//     score off the flat-padded summary.
// Three fixture classes: in-scope ready, out-of-scope ready with NONZERO
// forming volume (the contaminated-perps case), and unready. The last test
// pins that the out-of-scope fixture genuinely discriminates - the ungated
// rvol yields a DIFFERENT score than the served one, so this file fails
// against the unrepaired lineFor (verified red before the repair landed).

const test = require("node:test");
const assert = require("node:assert");
const { createTelemetry } = require("../src/telemetry.js");
const { buildApiState } = require("../src/apistate.js");
const metrics = require("../src/metrics.js");

const FTFC = ["15m", "1h"];
const T0 = Date.UTC(2026, 7, 24, 12, 5, 0); // 2026-08-24T12:05Z
function r3(v) { return Math.round(v * 1000) / 1000; }

function an(dir) {
  return { types: ["2U"], formingType: "2U", formingDir: dir, completed: null,
           shape: null, setups: [], invalidated: false, live: [] };
}

// 15m slot: 8 closed bars of volume 30 (avg 30) and a forming bar 5 min old
// carrying volume 20, so rvol15 = 20 / (30 * (300000/900000)) = 2.0 exactly.
// The volume is deliberately NONZERO: for the out-of-scope coin it is the
// frozen roll-time sample the v2 series scored with.
function slot15() {
  const closed = [];
  for (let i = 8; i >= 1; i--) {
    const T = T0 - 300000 - (i - 1) * 900000;
    closed.push({ t: T - 900000, T: T, o: 100, h: 101, l: 99, c: 100, v: 30 });
  }
  return {
    closed: closed,
    forming: { t: T0 - 300000, T: T0 + 600000, o: 100, h: 102.5, l: 99.5, c: 102, v: 20 },
    an: an("up")
  };
}

function slot1h() {
  return {
    closed: [{ t: T0 - 7500000, T: T0 - 3900000, o: 100, h: 101, l: 99, c: 100, v: 30 }],
    forming: { t: T0 - 3900000, T: T0 + 3600000 - 3900000, o: 100, h: 102.5, l: 99.5, c: 102, v: 20 },
    an: an("up")
  };
}

// mid 102 over flat-100 closes: r60 lands on the 15m candle anchor (2%), the
// 1h yardstick is absent (1 closed bar), so momNorm saturates on the fixed
// 1.5 scale and dir is nonzero - REQUIRED, or the activity term (the only
// place rvol enters the score) could not change the score and the
// out-of-scope fixture would not discriminate.
function mkCoin(name, sym, uni, opts) {
  const tf = { "15m": slot15(), "1h": slot1h() };
  if (opts && opts.unready) tf["1h"].an = null; // slot present, analysis missing
  return { name: name, sym: sym, uni: uni, mid: 102, hist: [], ctx: {}, tf: tf };
}

function mkState() {
  return {
    order: ["xyz:IN", "SCOPED", "xyz:COLD"],
    coins: {
      "xyz:IN": mkCoin("xyz:IN", "IN", "xyz"),               // ready, universe in scope
      "SCOPED": mkCoin("SCOPED", "SCOPED", "perps"),         // ready, universe OUT of scope
      "xyz:COLD": mkCoin("xyz:COLD", "COLD", "xyz", { unready: true })
    },
    loaded: true,
    universes: ["xyz", "perps"],
    // SCOPED true-up list - the P0-6 demand-cut shape. loop.js resolves the
    // unscoped case to the full tracked list, so one indexOf covers both.
    trueUpUniverses: ["xyz"],
    lastMids: 0, lastMidsByUni: {}, lastCandles: 0, lastCandlesByUni: {}
  };
}

function servedBy(api) {
  const m = {};
  api.coins.forEach(function (c) { m[c.name] = c; });
  return m;
}

test("parity: telemetry score and rvol agree with buildApiState for every coin, null included", function () {
  const state = mkState();
  const tel = createTelemetry({ dir: "unused-lineFor-touches-no-fs", ftfcTfs: FTFC });
  const rec = JSON.parse(tel._lineFor(state, T0));
  const api = buildApiState(state, FTFC, undefined, T0);
  assert.strictEqual(rec.v, 3, "parity semantics ride line version 3");
  assert.strictEqual(api.coins.length, state.order.length);

  // Guard the fixture itself so drift cannot hollow the parity loop below:
  // the three classes must actually be served as designed.
  const s = servedBy(api);
  assert.strictEqual(s["xyz:IN"].rvol, 2, "in-scope rvol computes off the nonzero forming volume");
  assert.ok(Number.isInteger(s["xyz:IN"].score) && s["xyz:IN"].score !== 0, "in-scope coin scores");
  assert.strictEqual(s["SCOPED"].rvol, null, "out-of-scope rvol served null (true-up scope)");
  assert.ok(Number.isInteger(s["SCOPED"].score), "out-of-scope coin still scores (activity default)");
  assert.strictEqual(s["xyz:COLD"].score, null, "unready coin served score null");
  assert.strictEqual(s["xyz:COLD"].ready, false);

  for (let i = 0; i < api.coins.length; i++) {
    const served = api.coins[i];
    const tuple = rec.c[served.name];
    assert.ok(tuple, "telemetry line covers " + served.name);
    // Score parity - strictEqual makes null === null a real assertion.
    assert.strictEqual(tuple[0], served.score, served.name + ": recorded score vs served");
    // rvol parity, nullness: flag bit 1 (rvol missing) fires exactly when
    // the API serves rvol null.
    assert.strictEqual((tuple[8] & 1) !== 0, served.rvol === null,
      served.name + ": flag 1 vs served rvol nullness");
    // rvol parity, value: where telemetry records an activity term it must
    // be the one the SERVED rvol produces (heatComponents' documented
    // null-default path when rvol is null).
    if (tuple[4] !== null) {
      const act = 0.5 + 0.5 * Math.min((served.rvol === null ? 1 : served.rvol) / 3, 1);
      assert.strictEqual(tuple[4], r3(act), served.name + ": activity vs served rvol");
    }
  }
});

test("v3 flags: 128 on the out-of-scope universe, 256 on the unready coin, neither elsewhere", function () {
  const state = mkState();
  const tel = createTelemetry({ dir: "unused", ftfcTfs: FTFC });
  const rec = JSON.parse(tel._lineFor(state, T0));
  const inT = rec.c["xyz:IN"], out = rec.c["SCOPED"], cold = rec.c["xyz:COLD"];
  // in-scope ready: no parity flag, and rvol present so bit 1 is off too
  assert.strictEqual(inT[8] & (1 | 128 | 256), 0, "in-scope ready coin carries no parity flags");
  // out-of-scope: 128, with bit 1 riding along (rv IS null after the gate) -
  // the documented overlap, same as 16/64
  assert.ok(out[8] & 128, "volume-not-trued-up flagged");
  assert.ok(out[8] & 1, "bit 1 rides along with 128");
  assert.strictEqual(out[8] & 256, 0, "out-of-scope coin is ready");
  // unready: 256 with the null tuple; its universe IS in scope and its rvol
  // still computes, so 128 and 1 stay off - the null score is readiness,
  // not volume
  assert.ok(cold[8] & 256, "unready flagged");
  assert.strictEqual(cold[8] & (1 | 128), 0);
  // ALL five score-term slots null together (code review: asserting
  // only score and activity let a numeric leak in dot/mom/inf pass)
  for (let k = 0; k <= 4; k++) {
    assert.strictEqual(cold[k], null,
      "unready tuple index " + k + " null (terms cannot outlive the score)");
  }
  assert.strictEqual(cold[7], 0, "live count still recorded");
});

test("null tuple oof: an unready coin's analyzed TF still counts out-of-force signals", function () {
  // Code review NIT 1: early v3 lines hard-coded null-tuple index 6
  // to 0, so an unready coin whose ANALYZED timeframe carried a recrossed
  // live signal recorded oof 0 alongside live 1 and flag 256. The count must
  // come from the SAME heatComponents pass the scored branch reads - one
  // in-force plus one recrossed signal pin count-of-EXCLUDED, not
  // length-of-live.
  const state = mkState();
  state.coins["xyz:COLD"].tf["15m"].an.live = [
    { name: "3-2U", dir: "up", kind: "rev", entry: 101, stop: 99, target: 110 },   // in force (102 > 101)
    { name: "2D-1-2U", dir: "up", kind: "rev", entry: 103, stop: 99, target: 112 } // recrossed (102 < 103)
  ];
  const tel = createTelemetry({ dir: "unused", ftfcTfs: FTFC });
  const cold = JSON.parse(tel._lineFor(state, T0)).c["xyz:COLD"];
  assert.ok(cold[8] & 256, "coin still unready");
  assert.strictEqual(cold[0], null, "score still null - diagnostics never resurrect the tuple");
  assert.strictEqual(cold[7], 2, "both live signals counted");
  assert.strictEqual(cold[6], 1, "the recrossed signal is counted as oof, not hard-coded 0");
  // The literal-0 fallback survives ONLY where heatComponents itself is null:
  // an empty configured timeframe set, where no signal can exist to exclude.
  const telEmpty = createTelemetry({ dir: "unused", ftfcTfs: [] });
  const emptyCold = JSON.parse(telEmpty._lineFor(state, T0)).c["xyz:COLD"];
  assert.strictEqual(emptyCold[0], null, "empty TF set cannot score");
  assert.strictEqual(emptyCold[6], 0, "empty TF set records oof 0 - nothing analyzed, nothing excluded");
});

test("the out-of-scope fixture discriminates: the ungated rvol yields a different score", function () {
  // Reconstruct what the UNREPAIRED lineFor recorded for the out-of-scope
  // coin (plain rvol15, no scope gate) and pin that it differs from the
  // served score. If fixture drift ever makes these equal, the parity test
  // above stops being able to catch the v2 defect - fail loudly here.
  const state = mkState();
  const coin = state.coins["SCOPED"];
  const sum = metrics.coinSummary(coin, FTFC);
  const mom = metrics.momentum(coin, T0);
  const staleRv = metrics.rvol15(coin, T0); // what v2 fed the score
  const y = metrics.tr1hAvgPct(coin, T0);
  const unrepaired = metrics.heatComponents(sum, mom, staleRv, coin.mid, y).score;
  const served = servedBy(buildApiState(state, FTFC, undefined, T0))["SCOPED"].score;
  assert.ok(staleRv !== null && staleRv > 0, "frozen forming volume produces a present-and-wrong rvol");
  assert.notStrictEqual(unrepaired, served, "ungated scoring must disagree, or the fixture is toothless");
});
