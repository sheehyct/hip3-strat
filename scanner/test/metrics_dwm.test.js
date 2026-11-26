"use strict";

// dwmContinuity (consumer-contract split, design review 2026-07-20):
// the serialized D/W/M selection gate. Truth table over up/down/flat/missing
// per TF, the D6 missing-vs-flat distinction, and the preregistered invariance
// criterion: selection state NEVER changes because fast-TF dots, momentum
// history, RVOL inputs, or live signals changed. node builtins only.

const test = require("node:test");
const assert = require("node:assert");
const { dwmContinuity, SCORE_V } = require("../src/metrics.js");

// Build a coin whose D/W/M slots carry the given formingDir values.
// A value of undefined = no slot at all; null = slot without analysis.
function coinWith(dirs) {
  const tf = {};
  ["1d", "1w", "1M"].forEach(function (id, i) {
    const d = dirs[i];
    if (d === undefined) return;                      // slot missing entirely
    if (d === null) { tf[id] = { closed: [], forming: null, an: null }; return; }
    tf[id] = {
      closed: [{ t: 1, o: 99, h: 101, l: 98, c: 100 }],
      forming: { t: 2, T: 3, o: 100, h: 101, l: 99, c: d === "up" ? 101 : (d === "down" ? 99 : 100), v: 1 },
      an: { types: ["2U"], formingType: "2U", formingDir: d, completed: null,
            setups: [], invalidated: false, live: [] }
    };
  });
  return { name: "xyz:T", sym: "T", uni: "xyz", mid: 100, hist: [], ctx: {}, tf: tf };
}

test("dwmContinuity full alignment: all up / all down", function () {
  assert.deepStrictEqual(dwmContinuity(coinWith(["up", "up", "up"])), {
    complete: true, dir: "up", dots: { "1d": "up", "1w": "up", "1M": "up" }
  });
  assert.deepStrictEqual(dwmContinuity(coinWith(["down", "down", "down"])), {
    complete: true, dir: "down", dots: { "1d": "down", "1w": "down", "1M": "down" }
  });
});

test("dwmContinuity mixed dirs: complete but ineligible (dir null)", function () {
  const out = dwmContinuity(coinWith(["up", "down", "up"]));
  assert.strictEqual(out.complete, true);
  assert.strictEqual(out.dir, null);
});

test("dwmContinuity flat dot: evaluable (complete) but ineligible - roll boundary", function () {
  // a fresh bar right after a period roll opens with c === o -> "flat":
  // the gate must drop out mechanically, not smooth over it
  const out = dwmContinuity(coinWith(["up", "flat", "up"]));
  assert.strictEqual(out.complete, true, "flat is a real observation - coverage complete");
  assert.strictEqual(out.dir, null);
  assert.strictEqual(out.dots["1w"], "flat");
});

test("dwmContinuity missing data is null, never flat (D6), and never eligible", function () {
  // slot missing entirely (e.g. 1M not yet derived)
  let out = dwmContinuity(coinWith(["up", "up", undefined]));
  assert.deepStrictEqual(out, {
    complete: false, dir: null, dots: { "1d": "up", "1w": "up", "1M": null }
  });
  // slot present but no forming bar yet (empty slot / just rolled)
  out = dwmContinuity(coinWith(["up", null, "up"]));
  assert.strictEqual(out.dots["1w"], null);
  assert.strictEqual(out.complete, false);
  assert.strictEqual(out.dir, null);
  // analysis exists but the forming bar was dropped (formingDir alone must
  // never make a TF evaluable - the gate reads the raw bar)
  const c = coinWith(["up", "up", "up"]);
  c.tf["1M"].forming = null;
  out = dwmContinuity(c);
  assert.strictEqual(out.dots["1M"], null);
  assert.strictEqual(out.complete, false);
  assert.strictEqual(out.dir, null);
});

test("dwmContinuity evaluates young listings analyzeTF cannot (raw-bar sourcing)", function () {
  // analyzeTF returns before setting formingDir when < 2 closed bars exist
  // (strat_core.js), so an.formingDir is null for months on young 1M slots
  // while the raw forming bar is perfectly observable. Measured live
  // 2026-07-21: 38/264 coins. The gate must read the bar, not the analysis.
  const c = coinWith(["up", "up", "up"]);
  c.tf["1M"] = {
    closed: [],                                         // zero closed months
    forming: { t: 2, T: 3, o: 100, h: 101, l: 98, c: 99, v: 1 },
    an: { types: [], formingType: null, formingDir: null, completed: null,
          setups: [], invalidated: false, live: [] }
  };
  const out = dwmContinuity(c);
  assert.strictEqual(out.dots["1M"], "down");
  assert.strictEqual(out.complete, true);
  assert.strictEqual(out.dir, null, "1M disagrees with D/W - ineligible");
});

test("dwmContinuity invariance: fast-TF dots, momentum, rvol, live signals never move it", function () {
  // preregistered verify criterion: selection
  // membership never changes SOLELY because 15m/1h/4h dots, r60, RVOL, or
  // live signals changed
  const c = coinWith(["up", "up", "up"]);
  const before = dwmContinuity(c);
  // fast TF slots appear and flip around
  ["15m", "1h", "4h"].forEach(function (id) {
    c.tf[id] = {
      closed: [{ t: 1, o: 99, h: 101, l: 98, c: 100 }],
      forming: { t: 2, T: 3, o: 100, h: 101, l: 90, c: 90, v: 9 },
      an: { types: ["2D"], formingType: "2D", formingDir: "down", completed: null,
            setups: [], invalidated: true, live: [] }
    };
  });
  // momentum history and mid move
  c.hist = [{ t: 0, m: 50 }];
  c.mid = 250;
  // live signals land on the D slot (they share the TF but not the gate)
  c.tf["1d"].an.live = [{ name: "2D-2U", dir: "up", entry: 100.5, stop: 98, target: 101, kind: "rev" }];
  c.tf["1d"].an.invalidated = true;
  assert.deepStrictEqual(dwmContinuity(c), before);
});

test("SCORE_V is exported and integral", function () {
  assert.ok(Number.isInteger(SCORE_V) && SCORE_V >= 1);
});
