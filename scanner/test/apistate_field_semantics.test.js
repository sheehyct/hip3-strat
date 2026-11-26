"use strict";

// Deploy 1 item 1 (feasibility report D4 revised): the three additive per-coin
// /api/state fields - `heat_magnitude`, `direction`, `data_quality` - and the
// ABSENCE of the two names D4 rejected. node builtins only: node --test
//
// The absence tests are not pedantry. D4's whole finding was that `priority`
// and `confidence` were semantic over-claims: the signed score nets opposing
// evidence, so its magnitude is directional intensity, not attention, and
// input coverage is not analytical confidence. An attention-grade priority
// ships SHADOW-ONLY until replay validates it. If either name ever appears in
// the served payload without that validation, a consumer will sort on it - so
// the payload asserts they are not there.

const test = require("node:test");
const assert = require("node:assert");
const { buildApiState } = require("../src/apistate.js");

const MIN = 60000;
const HOUR = 3600000;
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
const FTFC = ["15m", "1h"];

// An analyzeTF-shaped analysis whose forming bar points `dir`. Only formingDir
// matters to the score path exercised here (coinSummary's dots).
function an(dir) {
  return {
    types: ["2D", "1", "2U"],
    formingType: dir === "up" ? "2U" : (dir === "down" ? "2D" : "1"),
    formingDir: dir,
    completed: null,
    shape: null,
    setups: [],
    invalidated: false,
    live: []
  };
}

// `count` closed bars of width `span` whose NEWEST bar ends at `end`. Each
// carries a real high/low range so the ATR yardsticks come out > 0 (a
// zero-range tape would make atr1h 0, which is a different case from null).
function bars(end, count, span, base) {
  const out = [];
  for (let i = count; i > 0; i--) {
    const T = end - (i - 1) * span;
    out.push({ t: T - span + 1, T: T, o: base, h: base + 1, l: base - 1, c: base, v: 10 });
  }
  return out;
}

// A coin with NOTHING degraded: both configured timeframes analyzed, a mid
// tape whose newest sample is NOW (fresh) and whose 60-min anchor is inside
// the retention bound (r60Src "exact"), 20 closed 15m bars plus a forming one
// (rvol computable), and 21 closed 1h bars ending just before NOW (atr1h
// computable and not overdue). Every reason string therefore has its trigger
// switched OFF, which is what makes `reasons: []` a real assertion.
function freshCoin(name, dir1, dir2) {
  return {
    name: name,
    sym: name,
    uni: "xyz",
    mid: 100,
    hist: [
      { t: NOW - 60 * MIN, m: 100 },
      { t: NOW - 5 * MIN, m: 100 },
      { t: NOW, m: 100 }
    ],
    ctx: { markPx: "100", prevDayPx: "99", dayNtlVlm: "1000" },
    tf: {
      "15m": {
        closed: bars(NOW - 5 * MIN - 1, 20, 15 * MIN, 100),
        forming: { t: NOW - 5 * MIN, T: NOW + 10 * MIN - 1, o: 100, h: 101, l: 99, c: 100, v: 10 },
        an: an(dir1)
      },
      "1h": {
        closed: bars(NOW - 1, 21, HOUR, 100),
        forming: { t: NOW, T: NOW + HOUR - 1, o: 100, h: 101, l: 99, c: 100, v: 10 },
        an: an(dir2)
      }
    }
  };
}

function stateOf(coins) {
  const map = {};
  coins.forEach(function (c) { map[c.name] = c; });
  return {
    order: coins.map(function (c) { return c.name; }),
    coins: map,
    loaded: true,
    universes: ["xyz"]
  };
}

function build(coins) {
  return buildApiState(stateOf(coins), FTFC, null, NOW).coins;
}

function only(coin) {
  const out = build([coin]);
  assert.strictEqual(out.length, 1);
  return out[0];
}

// A coin missing one configured timeframe's analysis: unready, everything else
// intact. The recurring null-score fixture below.
function partialCoin() {
  const c = freshCoin("PARTIAL", "up", "up");
  delete c.tf["1h"].an;
  return c;
}

// ---------------------------------------------------------------- heat_magnitude

test("heat_magnitude is the served score's absolute value, on the same scale", function () {
  // FTFC up on both configured TFs, r60 flat, no live signals:
  // dir = 0.45 * 1, activity = 1 -> score 45.
  const up = only(freshCoin("UP", "up", "up"));
  assert.strictEqual(up.score, 45, "fixture sanity: a real, positive, scored coin");
  assert.strictEqual(up.heat_magnitude, 45);
  assert.strictEqual(up.heat_magnitude, Math.abs(up.score));

  // The same fixture pointed down: the SIGN moves, the magnitude does not.
  // This is the D4 point in one assertion - magnitude discards direction, so
  // it cannot be an attention rank.
  const down = only(freshCoin("DOWN", "down", "down"));
  assert.strictEqual(down.score, -45);
  assert.strictEqual(down.heat_magnitude, 45);
  assert.strictEqual(down.heat_magnitude, Math.abs(down.score));
  assert.strictEqual(down.heat_magnitude, up.heat_magnitude,
    "opposite scores of equal intensity carry the same magnitude");
});

test("heat_magnitude is null exactly when score is null - never 0", function () {
  // Unready: the readiness gate blanks the score (design decision 2026-08-15),
  // so the derived view must go with it. A 0 here would be indistinguishable
  // from a genuinely neutral coin, which is the exact ambiguity the gate
  // exists to remove.
  const out = only(partialCoin());
  assert.strictEqual(out.score, null, "fixture sanity: unready coin scores null");
  assert.strictEqual(out.heat_magnitude, null);
  assert.notStrictEqual(out.heat_magnitude, 0);
});

test("heat_magnitude tracks score across a mixed payload, coin by coin", function () {
  const out = build([freshCoin("UP", "up", "up"), freshCoin("DOWN", "down", "down"),
                     freshCoin("FLAT", "up", "down"), partialCoin()]);
  assert.strictEqual(out.length, 4);
  out.forEach(function (c) {
    if (c.score === null) {
      assert.strictEqual(c.heat_magnitude, null, c.name + ": null score -> null magnitude");
    } else {
      assert.strictEqual(c.heat_magnitude, Math.abs(c.score), c.name + ": magnitude is abs(score)");
    }
  });
});

// -------------------------------------------------------------------- direction

test("direction maps the score's sign, with flat and null distinguished", function () {
  const up = only(freshCoin("UP", "up", "up"));
  assert.strictEqual(up.score > 0, true);
  assert.strictEqual(up.direction, "up");

  const down = only(freshCoin("DOWN", "down", "down"));
  assert.strictEqual(down.score < 0, true);
  assert.strictEqual(down.direction, "down");

  // One TF up, one down -> dots net to zero, r60 is flat, no live signals:
  // a genuinely neutral SCORED coin. "flat" is a real reading, not a fallback.
  const flat = only(freshCoin("FLAT", "up", "down"));
  assert.strictEqual(flat.score, 0, "fixture sanity: a real zero score, not an absent one");
  assert.strictEqual(flat.direction, "flat");

  // No score at all -> unknown. Distinct from "flat": one says the coin is
  // neutral, the other says we do not know.
  const none = only(partialCoin());
  assert.strictEqual(none.score, null);
  assert.strictEqual(none.direction, null);
  assert.notStrictEqual(none.direction, "flat");
});

test("direction and heat_magnitude recombine losslessly into the score", function () {
  const sign = { up: 1, down: -1, flat: 0 };
  build([freshCoin("UP", "up", "up"), freshCoin("DOWN", "down", "down"),
         freshCoin("FLAT", "up", "down")]).forEach(function (c) {
    assert.strictEqual(sign[c.direction] * c.heat_magnitude, c.score,
      c.name + ": sign(direction) * heat_magnitude reconstructs score");
  });
});

// ----------------------------------------------------------------- data_quality

test("data_quality on a fully fresh coin: coverage 1 and NO reasons", function () {
  const out = only(freshCoin("FRESH", "up", "up"));
  assert.strictEqual(out.ready, true);
  assert.deepStrictEqual(out.data_quality, { coverage: 1, reasons: [] });
  // coverage is a plain 0..1 number, not a percent and not a string
  assert.strictEqual(typeof out.data_quality.coverage, "number");
});

test("data_quality on an unready, missing-TF coin: coverage 0.5 and named gaps", function () {
  const out = only(partialCoin());
  assert.strictEqual(out.ready, false);
  assert.deepStrictEqual(out.missingTfs, ["1h"]);
  assert.strictEqual(out.data_quality.coverage, 0.5, "1 of 2 expected slots analyzed");
  // `unready` and `missing_tf:1h` both appear because readiness IS "missingTfs
  // is empty" today - one condition surfaced at two grains (the gate, and
  // which slot caused it), not two independent checks.
  assert.deepStrictEqual(out.data_quality.reasons, ["unready", "missing_tf:1h"]);
});

test("data_quality names EVERY expected timeframe that is missing", function () {
  // A coin with no analyzed slots at all AND a stalled, degraded feed: the
  // full closed vocabulary in one payload, in its documented order. If a new
  // reason string is ever added, this is where it has to be declared.
  const dark = {
    name: "DARK", sym: "DARK", uni: "xyz", mid: 100,
    // Newest sample 61 min old (stale), with a 60-min-back anchor still inside
    // the tape retention bound -> r60 keeps its last span-correct value,
    // labeled "stale".
    hist: [{ t: NOW - 121 * MIN, m: 100 }, { t: NOW - 61 * MIN, m: 100 }],
    ctx: { markPx: "100", prevDayPx: "99", dayNtlVlm: "1000" },
    tf: {}
  };
  const out = only(dark);
  assert.strictEqual(out.data_quality.coverage, 0, "no expected slot analyzed");
  assert.deepStrictEqual(out.missingTfs, ["15m", "1h"]);
  assert.deepStrictEqual(out.data_quality.reasons,
    ["unready", "missing_tf:15m", "missing_tf:1h", "mids_stale",
     "r60_degraded:stale", "rvol_null", "atr_null"]);
  // missing_tf order follows the CONFIGURED set, so the array is stable across
  // builds rather than iteration-order dependent.
  assert.deepStrictEqual(
    out.data_quality.reasons.filter(function (r) { return r.indexOf("missing_tf:") === 0; }),
    out.missingTfs.map(function (t) { return "missing_tf:" + t; }));
});

test("data_quality: mids_stale and r60_degraded are independent conditions", function () {
  // Warmup, not a stall: the mid tape is FRESH (newest sample at NOW) but does
  // not yet reach 60 minutes back, so r60 falls to the 15m-candle anchor. The
  // coin is fully analyzed. Exactly one reason should fire.
  const warm = freshCoin("WARM", "up", "up");
  warm.hist = [{ t: NOW, m: 100 }];
  const out = only(warm);
  assert.strictEqual(out.mom.r60Src, "candle", "fixture sanity: candle-anchored r60");
  assert.strictEqual(out.data_quality.coverage, 1);
  assert.deepStrictEqual(out.data_quality.reasons, ["r60_degraded:candle"],
    "fresh mids must not be reported stale just because r60 is interpolated");
});

test("data_quality: an EMPTY mid tape is unknown, not stale", function () {
  // A coin we have never sampled is not a coin whose feed stalled. Matching
  // metrics.momentum, which treats a null endpoint clock as not-stale.
  const unsampled = freshCoin("NEW", "up", "up");
  unsampled.hist = [];
  const out = only(unsampled);
  assert.strictEqual(out.data_quality.reasons.indexOf("mids_stale"), -1,
    "never-sampled must not masquerade as a stall");
});

test("data_quality: rvol_null and atr_null fire on their own inputs", function () {
  // rvol needs the forming 15m bar and >= 8 closed ones; atr1h needs 21 closed
  // 1h bars. Drop each in turn, keeping the analysis objects so the coin stays
  // READY - which proves these reasons are not just readiness in disguise.
  const noRvol = freshCoin("NORVOL", "up", "up");
  noRvol.tf["15m"].forming = null;
  const a = only(noRvol);
  assert.strictEqual(a.ready, true);
  assert.strictEqual(a.rvol, null);
  assert.deepStrictEqual(a.data_quality, { coverage: 1, reasons: ["rvol_null"] });

  const noAtr = freshCoin("NOATR", "up", "up");
  noAtr.tf["1h"].closed = noAtr.tf["1h"].closed.slice(-5);
  const b = only(noAtr);
  assert.strictEqual(b.ready, true);
  assert.strictEqual(b.atr1h, null);
  assert.deepStrictEqual(b.data_quality, { coverage: 1, reasons: ["atr_null"] });
});

test("data_quality coverage and missing_tf never disagree", function () {
  // Both derive from ONE metrics.readiness call over the SAME expected set, so
  // "fully covered" and "nothing missing" are one fact stated twice. This test
  // is what fails if some future edit re-derives either half separately.
  const dark = { name: "DARK", sym: "DARK", uni: "xyz", mid: 100, hist: [], ctx: {}, tf: {} };
  build([freshCoin("FRESH", "up", "up"), partialCoin(), dark]).forEach(function (c) {
    const named = c.data_quality.reasons.filter(function (r) {
      return r.indexOf("missing_tf:") === 0;
    }).length;
    assert.strictEqual(named, c.missingTfs.length, c.name + ": one reason per gap");
    assert.strictEqual(c.data_quality.coverage,
      (FTFC.length - c.missingTfs.length) / FTFC.length, c.name + ": coverage matches");
    assert.strictEqual(c.data_quality.coverage === 1, named === 0,
      c.name + ": full coverage iff no missing_tf reason");
  });
});

// ------------------------------------------------------- the names NOT served

test("the payload carries NO priority key, at either level (D4 revised)", function () {
  const out = buildApiState(
    stateOf([freshCoin("UP", "up", "up"), freshCoin("DOWN", "down", "down"), partialCoin()]),
    FTFC, null, NOW);
  // Top level
  assert.ok(!("priority" in out), "no top-level priority");
  assert.ok(!("analytical_confidence" in out), "no top-level analytical_confidence");
  // Per coin. `priority` ships shadow-only (computed and logged, never served)
  // until replay shows it ranks attention; `analytical_confidence` is a
  // separately versioned later field. heat_magnitude is NOT either of them.
  assert.strictEqual(out.coins.length, 3);
  out.coins.forEach(function (c) {
    assert.ok(!("priority" in c), c.name + ": no per-coin priority");
    assert.ok(!("confidence" in c), c.name + ": no per-coin confidence");
    assert.ok(!("analytical_confidence" in c), c.name + ": no per-coin analytical_confidence");
    assert.ok("heat_magnitude" in c && "direction" in c && "data_quality" in c,
      c.name + ": the three D4 fields are served");
  });
  // Belt and braces against a nested reintroduction: the serialized payload
  // must not contain the token anywhere.
  assert.strictEqual(JSON.stringify(out).indexOf("\"priority\""), -1,
    "priority must not appear anywhere in the served JSON");
  // selectionRank is still null - the repo's existing statement that no
  // validated attention ranking exists yet. heat_magnitude does not change that.
  out.coins.forEach(function (c) { assert.strictEqual(c.selectionRank, null); });
});

test("the three fields are additive: score, score_v and the components are untouched", function () {
  const out = buildApiState(stateOf([freshCoin("UP", "up", "up")]), FTFC, null, NOW);
  const c = out.coins[0];
  assert.strictEqual(out.score_v, 3, "score_v does not move for a presentation split");
  assert.strictEqual(c.score, 45);
  assert.deepStrictEqual(Object.keys(c.heatComponents).sort(),
    ["activity", "dotNetFast", "inForceNet", "momentumAbnormal"]);
  // The score still reconstructs from its own components - the derived views
  // sit beside that arithmetic, they do not participate in it.
  const h = c.heatComponents;
  assert.strictEqual(c.score, Math.round(100 * Math.max(-1, Math.min(1,
    0.45 * h.dotNetFast + 0.35 * h.momentumAbnormal + 0.20 * h.inForceNet)) * h.activity));
  // A consumer that ignores all three fields sees the identical payload it saw
  // before: everything else survives a round trip unchanged.
  const stripped = JSON.parse(JSON.stringify(c));
  delete stripped.heat_magnitude;
  delete stripped.direction;
  delete stripped.data_quality;
  assert.ok(!("heat_magnitude" in stripped));
  assert.strictEqual(stripped.score, 45);
});

// ---- NaN normalization at the serialized boundary (review MEDIUM) ----
// Candle ingestion admits unary-coerced NaN. Pre-fix, a NaN slipped past the
// strict === null checks: JSON served rvol/atr1h as null while data_quality
// reported no reason, and a NaN score serialized null with direction "flat".
// Every assertion here runs on JSON.parse(JSON.stringify(...)) - the boundary
// consumers actually see.

function servedRow(coin) {
  return JSON.parse(JSON.stringify(build([coin])[0]));
}

// The coherence invariant the fix makes structural: the three views are null
// TOGETHER or numeric/finite together, whatever poisoned the inputs.
function assertViewsCoherent(row) {
  assert.strictEqual(row.heat_magnitude === null, row.score === null,
    "heat_magnitude null iff score null");
  assert.strictEqual(row.direction === null, row.score === null,
    "direction null iff score null");
  if (row.score !== null) {
    assert.ok(Number.isFinite(row.score), "a non-null served score is finite");
    assert.strictEqual(row.heat_magnitude, Math.abs(row.score));
  }
}

test("NaN forming volume: rvol serves null WITH its reason, views stay coherent", function () {
  const coin = freshCoin("NANV", "up", "up");
  coin.tf["15m"].forming.v = NaN;
  const row = servedRow(coin);
  assert.strictEqual(row.rvol, null, "NaN rvol normalized to null, not JSON-laundered");
  assert.ok(row.data_quality.reasons.indexOf("rvol_null") >= 0,
    "the quality reason accompanies the null it explains");
  assertViewsCoherent(row);
});

test("NaN 1h tape: atr1h serves null WITH atr_null, views stay coherent", function () {
  const coin = freshCoin("NANA", "up", "up");
  coin.tf["1h"].closed.forEach(function (b) { b.h = NaN; });
  const row = servedRow(coin);
  assert.strictEqual(row.atr1h, null, "NaN atr1h normalized to null");
  assert.ok(row.data_quality.reasons.indexOf("atr_null") >= 0,
    "atr_null present exactly when atr1h is null");
  assertViewsCoherent(row);
});

test("a poisoned momentum anchor cannot desync the score's views", function () {
  // NaN in the mid tape rides into the momentum term. Whichever branch the
  // metrics take, the served row must satisfy the coherence invariant - the
  // pre-fix failure mode was score null WITH direction 'flat'.
  const coin = freshCoin("NANM", "up", "up");
  coin.hist[0].m = NaN;
  assertViewsCoherent(servedRow(coin));
});
