"use strict";

// score_v 2 (design review 2026-07-20 D1): the heat score's live-signal term
// counts IN-FORCE signals only. Preregistered unit vectors: contribution
// goes to 0 immediately on recross/invalidation, rev3 stays counted, cont
// stays skipped, unevaluable (no mid / no finite entry) stays counted.
// node builtins only.

const test = require("node:test");
const assert = require("node:assert");
const { coinSummary, heatScore, heatComponents, SCORE_V } = require("../src/metrics.js");

// coinSummary-shaped input, built directly: 4 fast TFs, 3 up dots 1 down
// -> ftfcNet 0.5. r60 1.5 -> momNorm 1. rv null -> act 2/3.
function sumWith(liveItems) {
  return { live: liveItems, setups: 0, dots: ["up", "up", "up", "down"],
           ftfc: "mixed", inval: false, count: 4 };
}
const MOM = { r5: null, r15: null, r30: null, r60: 1.5 };
function sig(dir, entry, kind, rev3) {
  const s = { name: "t", dir: dir, entry: entry, stop: 1, target: 200, kind: kind || "rev" };
  if (rev3) s.rev3 = true;
  return s;
}
// baseline (no counted signals): dir = 0.45*0.5 + 0.35*1 = 0.575 -> score 38
const BASE = Math.round(100 * 0.575 * (0.5 + 0.5 / 3));
// one net up signal: dir = 0.575 + 0.20*0.5 = 0.675 -> score 45
const ONE_UP = Math.round(100 * 0.675 * (0.5 + 0.5 / 3));

test("score_v 2: in-force signal counts, recrossed signal contributes zero", function () {
  const item = { tf: "1d", sig: sig("up", 100), invalidated: false };
  assert.strictEqual(heatScore(sumWith([item]), MOM, null, 101), ONE_UP, "mid beyond entry: counted");
  assert.strictEqual(heatScore(sumWith([item]), MOM, null, 99), BASE, "recrossed: zero contribution");
  assert.strictEqual(heatScore(sumWith([item]), MOM, null, 100), BASE, "AT the entry is not beyond it");
  const dn = { tf: "1d", sig: sig("down", 100), invalidated: false };
  assert.strictEqual(heatScore(sumWith([dn]), MOM, null, 101), BASE, "down recrossed: zero");
});

test("score_v 2: invalidated signal contributes zero even while price is beyond entry", function () {
  const item = { tf: "1d", sig: sig("up", 100), invalidated: true };
  assert.strictEqual(heatScore(sumWith([item]), MOM, null, 101), BASE);
});

test("score_v 2: cont signals stay excluded, unevaluable signals stay counted", function () {
  const cont = { tf: "1d", sig: sig("up", 100, "cont"), invalidated: false };
  assert.strictEqual(heatScore(sumWith([cont]), MOM, null, 101), BASE);
  const item = { tf: "1d", sig: sig("up", 100), invalidated: false };
  assert.strictEqual(heatScore(sumWith([item]), MOM, null, null), ONE_UP, "no mid: predicate unevaluable");
  const noEntry = { tf: "1d", sig: sig("up", null), invalidated: false };
  assert.strictEqual(heatScore(sumWith([noEntry]), MOM, null, 99), ONE_UP, "no finite entry: unevaluable");
});

test("score_v 2: rev3 survives TF invalidation through coinSummary, still honors recross", function () {
  // real coin fixture: invalidated TF carrying a rev3 and a plain rev signal
  const coin = {
    name: "xyz:T", sym: "T", mid: 101, hist: [], ctx: {},
    tf: {
      "1d": {
        closed: [{ t: 1, o: 99, h: 101, l: 98, c: 100 }],
        forming: { t: 2, T: 3, o: 100, h: 103, l: 97, c: 101, v: 1 },
        an: { types: ["2U"], formingType: "3", formingDir: "up", completed: null,
              setups: [], invalidated: true,
              live: [Object.assign(sig("up", 100), { rev3: true }), sig("up", 100.5)] }
      }
    }
  };
  const sum = coinSummary(coin, ["1d"]);
  assert.strictEqual(sum.live[0].invalidated, false, "rev3: invalidation is its birth event");
  assert.strictEqual(sum.live[1].invalidated, true, "plain signal dies with the TF");
  // only the rev3 counts; and it counts only while in force
  const hcInForce = heatComponents(sum, MOM, null, 101);
  assert.strictEqual(hcInForce.inForceNet, 0.5, "rev3 in force: counted; invalidated sibling: not");
  const hcRecrossed = heatComponents(sum, MOM, null, 99.5);
  assert.strictEqual(hcRecrossed.inForceNet, 0, "rev3 recrossed: zero like any other signal");
});

test("heatComponents reconstructs the served score exactly", function () {
  const items = [
    { tf: "1d", sig: sig("up", 100), invalidated: false },
    { tf: "1h", sig: sig("down", 102), invalidated: false },
    { tf: "4h", sig: sig("up", 100, "cont"), invalidated: false }
  ];
  const hc = heatComponents(sumWith(items), MOM, 2.1, 101);
  const dir = Math.max(-1, Math.min(1,
    0.45 * hc.dotNetFast + 0.35 * hc.momentumAbnormal + 0.20 * hc.inForceNet));
  assert.strictEqual(Math.round(100 * dir * hc.activity), hc.score);
  assert.strictEqual(heatScore(sumWith(items), MOM, 2.1, 101), hc.score);
  // empty TF set stays null
  assert.strictEqual(heatComponents({ live: [], dots: [], count: 0 }, MOM, null, 101), null);
});

// Review 2026-07-25 test gap 6: the reconstruction above omits the fifth
// argument, so it verifies only the fixed-1.5 fallback branch. The identity
// must also hold through the v3 ATR-NORMALIZED branch, and the term must
// actually be the yardstick-scaled one.
test("heatComponents reconstructs through the ATR-normalized branch (non-null yardstick)", function () {
  const items = [{ tf: "1d", sig: sig("up", 100), invalidated: false }];
  const y = 1.5; // r60 1.5 / (2 * 1.5) = 0.5 - distinct from the fallback's 1.0
  const hc = heatComponents(sumWith(items), MOM, 2.1, 101, y);
  assert.strictEqual(hc.momentumAbnormal, 0.5, "yardstick-scaled, not fixed-1.5");
  const dir = Math.max(-1, Math.min(1,
    0.45 * hc.dotNetFast + 0.35 * hc.momentumAbnormal + 0.20 * hc.inForceNet));
  assert.strictEqual(Math.round(100 * dir * hc.activity), hc.score);
  assert.strictEqual(heatScore(sumWith(items), MOM, 2.1, 101, y), hc.score);
  assert.notStrictEqual(hc.score, heatComponents(sumWith(items), MOM, 2.1, 101).score,
    "the two branches genuinely diverge on this vector");
});

// score_v 3 (design review 2026-07-20 D5): the momentum term is normalized by
// the coin's own hourly true range, saturating at 2.0x it; the fixed 1.5%
// scale survives only as the missing-yardstick fallback. Preregistered unit
// vectors: same r60 saturates a typical-vol coin and not a high-vol one, a
// low-vol coin can finally register, and null r60 mutes the term regardless.
test("score_v 3: momentum normalized by the hourly yardstick, fixed 1.5 fallback", function () {
  const s = sumWith([]);
  // r60 1.5 at atr1h 0.75 -> 1.5/(2*0.75) = 1: same saturation point as the
  // old fixed scale for the typical-vol coin (deliberate centering)
  assert.strictEqual(heatComponents(s, MOM, null, 101, 0.75).momentumAbnormal, 1);
  // same move on a high-vol coin (atr1h 1.5) -> 0.5: no longer saturates
  assert.strictEqual(heatComponents(s, MOM, null, 101, 1.5).momentumAbnormal, 0.5);
  // low-vol coin: 0.3% on atr1h 0.15 -> saturated (registers at last)
  const lowMom = { r5: null, r15: null, r30: null, r60: 0.3 };
  assert.strictEqual(heatComponents(s, lowMom, null, 101, 0.15).momentumAbnormal, 1);
  // clamp holds on the down side
  const dnMom = { r5: null, r15: null, r30: null, r60: -9 };
  assert.strictEqual(heatComponents(s, dnMom, null, 101, 0.5).momentumAbnormal, -1);
  // missing yardstick (null / 0 / absent) -> old fixed 1.5% scale, not muted
  assert.strictEqual(heatComponents(s, MOM, null, 101, null).momentumAbnormal, 1);
  assert.strictEqual(heatComponents(s, MOM, null, 101, 0).momentumAbnormal, 1);
  assert.strictEqual(heatComponents(s, MOM, null, 101).momentumAbnormal, 1);
  const half = { r5: null, r15: null, r30: null, r60: 0.75 };
  assert.strictEqual(heatComponents(s, half, null, 101, null).momentumAbnormal, 0.5);
  // no r60 -> term 0 regardless of the yardstick
  const noMom = { r5: null, r15: null, r30: null, r60: null };
  assert.strictEqual(heatComponents(s, noMom, null, 101, 0.75).momentumAbnormal, 0);
});

test("SCORE_V is 3 (ATR-normalized exact-horizon momentum)", function () {
  assert.strictEqual(SCORE_V, 3);
});
