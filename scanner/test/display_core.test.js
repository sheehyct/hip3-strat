"use strict";

// The DISPLAY-CORE block must load as a Node module and its pure functions
// must keep the semantics consumers mirror. The dashboard's own
// use of these functions is covered by dashboard_app.test.js through the
// full inline script; this file pins the extracted module standalone.
// starSpan is deliberately not exercised: it is browser-bound (isFav reads
// favorites state) and is vendored as reference semantics only.

const test = require("node:test");
const assert = require("node:assert");

const dc = require("../src/display_core.js");

test("display_core loads standalone and exports the block roster", function () {
  ["esc", "fmtPx", "chg24", "tfPct", "magProgress", "distToTargetPct", "magRemaining",
   "sigInForce", "starSpan", "sigChips"]
    .forEach(function (n) { assert.strictEqual(typeof dc[n], "function", n); });
});

test("sigInForce: price beyond entry keeps the signal in force", function () {
  assert.strictEqual(dc.sigInForce({ dir: "up", entry: 10 }, 10.5), true);
  assert.strictEqual(dc.sigInForce({ dir: "up", entry: 10 }, 9.9), false);
  assert.strictEqual(dc.sigInForce({ dir: "down", entry: 10 }, 9.9), true);
  assert.strictEqual(dc.sigInForce({ dir: "down", entry: 10 }, 10.5), false);
});

test("sigInForce: exactly AT the entry is not in force (strictly beyond)", function () {
  assert.strictEqual(dc.sigInForce({ dir: "up", entry: 10 }, 10), false);
  assert.strictEqual(dc.sigInForce({ dir: "down", entry: 10 }, 10), false);
});

// The bearish half of this matters: the bullish null case passes even with a
// coercing isFinite, because 10.5 > null evaluates 10.5 > 0 and happens to
// return the intended answer. Only the bearish direction exposes the hole
// (10 < null -> 10 < 0 -> false), which is how a coercion bug survived review
// with a green test. Both directions are pinned for every falsy-but-coercible
// entry (code review 2026-08-07).
test("sigInForce: unknown inputs count as in force, in BOTH directions", function () {
  assert.strictEqual(dc.sigInForce({ dir: "up", entry: 10 }, null), true);
  assert.strictEqual(dc.sigInForce({ dir: "up", entry: 10 }, 0), true);
  [null, undefined, "", false, NaN].forEach(function (entry) {
    assert.strictEqual(dc.sigInForce({ dir: "up", entry: entry }, 10.5), true,
      "up/" + String(entry));
    assert.strictEqual(dc.sigInForce({ dir: "down", entry: entry }, 10), true,
      "down/" + String(entry));
  });
});

// A numeric STRING is not a finite number under Number.isFinite, so it takes
// the unknown-input path rather than being silently coerced into a comparison.
// STRAT-CORE only ever emits numeric entries; this pins which way the
// ambiguity resolves if a serialized payload ever reaches the predicate.
test("sigInForce: a string entry is treated as unknown, not coerced", function () {
  assert.strictEqual(dc.sigInForce({ dir: "down", entry: "10" }, 9.9), true);
  assert.strictEqual(dc.sigInForce({ dir: "up", entry: "10" }, 10.5), true);
});

test("magProgress: no target -> null (3-1-2 continuations by design)", function () {
  // Design decision 2026-08-06: same-colour 3-1-2 continuations keep target null,
  // so their chips never show a magnitude bar. Intended, not missing data.
  assert.strictEqual(dc.magProgress({ dir: "up", entry: 10, target: null, stop: 9 }, 10.5), null);
});

test("magProgress: positive leg scales to target, negative leg to stop", function () {
  const sig = { dir: "up", entry: 10, target: 12, stop: 9 };
  assert.strictEqual(dc.magProgress(sig, 11), 50);
  assert.strictEqual(dc.magProgress(sig, 9.5), -50);
});

// --- To Target ranker math (display_v d9cb6247159c52f8) ---------------------
// Design decision 2026-08-16: rank in-force signals by remaining distance to target.
// Two metrics, both vendored: distToTargetPct is % of CURRENT price (the
// cross-coin comparable read), magRemaining is the untraveled % of the
// trigger-to-target span. Status/in-force gating is the CALLER's job - these
// stay pure level math, so the vectors here are levels only.

test("distToTargetPct: direction-aware % of current price", function () {
  // up: target 110, mid 104 -> (110-104)/104 = +5.769...%
  assert.ok(Math.abs(dc.distToTargetPct({ dir: "up", entry: 100, target: 110 }, 104) - 5.7692) < 0.001);
  // down: target 90, mid 96 -> (96-90)/96 = +6.25%
  assert.strictEqual(dc.distToTargetPct({ dir: "down", entry: 100, target: 90 }, 96), 6.25);
});

test("distToTargetPct: zero at target, negative beyond it, in BOTH directions", function () {
  assert.strictEqual(dc.distToTargetPct({ dir: "up", target: 110 }, 110), 0);
  assert.ok(dc.distToTargetPct({ dir: "up", target: 110 }, 112) < 0);
  assert.strictEqual(dc.distToTargetPct({ dir: "down", target: 90 }, 90), 0);
  assert.ok(dc.distToTargetPct({ dir: "down", target: 90 }, 88) < 0);
});

test("distToTargetPct: null without a finite target or mid (no coercion)", function () {
  assert.strictEqual(dc.distToTargetPct({ dir: "up", target: null }, 104), null);
  assert.strictEqual(dc.distToTargetPct({ dir: "up", target: "110" }, 104), null);
  assert.strictEqual(dc.distToTargetPct({ dir: "up", target: 110 }, null), null);
  assert.strictEqual(dc.distToTargetPct({ dir: "up", target: 110 }, 0), null);
  assert.strictEqual(dc.distToTargetPct(null, 104), null);
});

test("magRemaining: complement of magProgress on the positive leg only", function () {
  const sig = { dir: "up", entry: 100, target: 110, stop: 95 };
  assert.strictEqual(dc.magRemaining(sig, 104), 60);   // 40% traveled -> 60% left
  assert.strictEqual(dc.magRemaining(sig, 110), 0);    // at target
  assert.strictEqual(dc.magRemaining(sig, 112), -20);  // beyond target: overshoot is honest
  // negative leg is scaled to the STOP distance - a complement would mix
  // units, so it is null by design, not 100-plus-something
  assert.strictEqual(dc.magRemaining(sig, 97.5), null);
  // no target -> magProgress null -> null (3-1-2 continuations by design)
  assert.strictEqual(dc.magRemaining({ dir: "up", entry: 100, target: null }, 104), null);
});

// --- sigChips pattern scoping (display_v d9cb6247159c52f8) ------------------
// `allow` is an optional (tf, sig) predicate. Absent = render everything
// (two-argument callers unchanged). Scoping applies BEFORE the dedup ledger
// and both overflow counts, so no count advertises a suppressed chip.

test("sigChips: omitted allow renders everything (back-compat)", function () {
  const sum = chipSum(
    [{ tf: "D", sig: { name: "3-2U", dir: "up", entry: 100, stop: 99, target: 110, kind: "rev" }, invalidated: false }],
    [{ tf: "W", sig: { name: "2D-2U", dir: "up", trigger: 1, stop: 0.9, target: 2, kind: "rev" } }]
  );
  assert.strictEqual(dc.sigChips(sum, 104), dc.sigChips(sum, 104, null));
});

test("sigChips: allow scopes live AND setup chips by pattern", function () {
  const html = dc.sigChips(chipSum(
    [{ tf: "D", sig: { name: "3-2U", dir: "up", entry: 100, stop: 99, target: 110, kind: "rev" }, invalidated: false },
     { tf: "1H", sig: { name: "2-1-2U", dir: "up", entry: 50, stop: 49, target: 55, kind: "rev" }, invalidated: false }],
    [{ tf: "W", sig: { name: "2-1-2D", dir: "down", trigger: 1, stop: 1.1, target: 0.5, kind: "rev" } }]
  ), 104, function (tf, sig) { return sig.name.indexOf("2-1-2") === 0; });
  assert.ok(html.indexOf("2-1-2U") >= 0, "allowed live chip renders: " + html);
  assert.ok(html.indexOf("2-1-2D") >= 0, "allowed setup chip renders: " + html);
  assert.ok(html.indexOf("3-2U") < 0, "scoped-out pattern never renders");
});

test("sigChips: overflow counts see only ALLOWED items", function () {
  // Six live signals, three allowed: no "+2" from the raw list may appear.
  const live = ["A", "B", "C", "D", "E", "F"].map(function (n, i) {
    return { tf: "D", sig: { name: "P" + n, dir: "up", entry: 100 + i, stop: 99, target: 120, kind: "rev" },
             invalidated: false };
  });
  const html = dc.sigChips(chipSum(live, []), 104,
    function (tf, sig) { return "PA PB PC".indexOf(sig.name) >= 0; });
  assert.ok(html.indexOf("PA") >= 0 && html.indexOf("PC") >= 0, "allowed chips render");
  assert.ok(html.indexOf("+") < 0, "no overflow chip from the unscoped count: " + html);
});

test("sigChips: everything scoped out falls back to the dash", function () {
  const html = dc.sigChips(chipSum(
    [{ tf: "D", sig: { name: "3-2U", dir: "up", entry: 100, stop: 99, target: 110, kind: "rev" }, invalidated: false }],
    []
  ), 104, function () { return false; });
  assert.strictEqual(html, '<span class="neu">-</span>');
});

test("fmtPx: one decimal above 10,000 (a named cross-surface divergence)", function () {
  assert.strictEqual(dc.fmtPx(12345.67), "12,345.7");
  assert.strictEqual(dc.fmtPx(1234.567), "1,234.57");
  assert.strictEqual(dc.fmtPx(0.123456), "0.12346");
  assert.strictEqual(dc.fmtPx(null), "-");
});

test("esc escapes all five HTML metacharacters (attribute-context complete)", function () {
  // Quotes included since 2026-08-15 (display_v 3de75d3e8c0a97ae): esc() is
  // interpolated into double-quoted attributes (data-coin, data-star, title),
  // where & < > alone left attribute breakout open (code review).
  assert.strictEqual(dc.esc('<a "&\'">'), "&lt;a &quot;&amp;&#39;&quot;&gt;");
});

// --- sigChips echo dedup (display_v 3de75d3e8c0a97ae) ----------------------
// A fired setup appears in BOTH sum.live and sum.setupList (analyzeTF keeps
// the setup when it goes live). detailHTML, simpleItems and the domino
// builder always suppressed the echo; sigChips was the one consumer that
// rendered both - 69 duplicate live/setup pairs on production (code review
// 2026-08-14). Keys carry dir because 1-2-2 and PMG share a name across
// directions.

function chipSum(live, setupList) {
  return { live: live, setupList: setupList, setups: setupList.length,
           dots: [], ftfc: "mixed", inval: false };
}

test("sigChips: a fired setup renders only as its live chip, never twice", function () {
  const sig = { name: "3-2U", dir: "up", entry: 100, stop: 99, target: 110, kind: "rev" };
  const html = dc.sigChips(chipSum(
    [{ tf: "D", sig: sig, invalidated: false }],
    [{ tf: "D", sig: { name: "3-2U", dir: "up", trigger: 100, stop: 99, target: 110, kind: "rev" } },
     { tf: "D", sig: { name: "3-2D", dir: "down", trigger: 99, stop: 110, target: 95, kind: "rev" } }]
  ), 104);
  assert.ok(html.indexOf("D 3-2U LIVE") >= 0, "live chip renders");
  assert.strictEqual((html.match(/3-2U/g) || []).length, 1, "the echo setup chip is suppressed");
  assert.ok(html.indexOf("D 3-2D") >= 0, "a NON-fired setup still renders");
});

test("sigChips: +N setups counts the echo-FILTERED list, not the raw one", function () {
  // One echoed setup + four real ones: 3 named chips + "+1 setups", where the
  // raw arithmetic would have advertised "+2 setups" including the suppressed
  // echo.
  const live = [{ tf: "D", sig: { name: "3-2U", dir: "up", entry: 100, stop: 99, target: 110, kind: "rev" }, invalidated: false }];
  const setups = [
    { tf: "D", sig: { name: "3-2U", dir: "up", trigger: 100, stop: 99, target: 110, kind: "rev" } },  // echo
    { tf: "15m", sig: { name: "2D-2U", dir: "up", trigger: 1, stop: 0.9, target: 2, kind: "rev" } },
    { tf: "1H", sig: { name: "2U-2D", dir: "down", trigger: 1, stop: 1.1, target: 0.5, kind: "rev" } },
    { tf: "4H", sig: { name: "3-2D", dir: "down", trigger: 1, stop: 1.1, target: 0.5, kind: "rev" } },
    { tf: "W", sig: { name: "1-2-2", dir: "up", trigger: 1, stop: 0.9, target: 2, kind: "rev" } }
  ];
  const html = dc.sigChips(chipSum(live, setups), 104);
  assert.ok(html.indexOf("+1 setups") >= 0, "overflow counts filtered list: " + html);
  assert.strictEqual((html.match(/3-2U/g) || []).length, 1, "echo suppressed");
});

test("sigChips: same name opposite dir (1-2-2 class) is NOT collapsed", function () {
  // The dedup key carries dir: a 1-2-2 up live must not swallow a 1-2-2 down
  // setup - same name, different signal.
  const html = dc.sigChips(chipSum(
    [{ tf: "D", sig: { name: "1-2-2", dir: "up", entry: 100, stop: 99, target: 110, kind: "rev" }, invalidated: false }],
    [{ tf: "D", sig: { name: "1-2-2", dir: "down", trigger: 99, stop: 110, target: 95, kind: "rev" } }]
  ), 104);
  assert.strictEqual((html.match(/1-2-2/g) || []).length, 2, "both directions render: " + html);
});
