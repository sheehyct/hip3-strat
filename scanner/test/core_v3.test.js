"use strict";

// STRAT-CORE tests against methodology v3 (2026-07-06):
// R10 equality vectors (mandatory), 3-1-2 color routing, 3-2 measured-move
// fallback (1.5x stop distance), the 1-3 Rev Strat (path-dependent via the
// firstBreak param), and the 2-1-2 sequence vector. Decisions
// recorded 2026-07-06 (3-2 target = 1.5R fallback; 3-2-2 stop = swing
// extreme). TARGETS are rules v2 since 2026-10-31: the first prior
// level not yet taken out, ATH/ATL null, entry +/- 1.5% fallback - the
// 1.5x stop-distance and k=2 swing-pivot vectors below were rewritten.

const test = require("node:test");
const assert = require("node:assert");
const core = require("../src/strat_core.js");

function bar(o, h, l, c, t) {
  return { t: t || 0, T: (t || 0) + 1, o: o, h: h, l: l, c: c };
}

test("R10 equality vectors: equality never breaks; one tick is a break", () => {
  // prev bar H=105.00 L=98.00
  const cases = [
    [105.00, 99.00, "1"], [104.00, 98.00, "1"], [105.00, 98.00, "1"],
    [105.01, 98.50, "2U"], [104.00, 97.99, "2D"], [105.01, 97.99, "3"],
    [104.50, 99.10, "1"]
  ];
  for (const [h, l, exp] of cases) {
    assert.equal(core.classify(h, l, 105.00, 98.00), exp, "H" + h + " L" + l);
  }
});

test("2-1-2 bullish reversal vector: trigger inside H, stop bar0 low, target bar0 HIGH", () => {
  const closed = [
    bar(104, 106, 100, 101, 0),  // reference
    bar(101, 105, 97, 98, 1),    // 2D
    bar(98, 103, 97.5, 100, 2)   // inside
  ];
  const forming = bar(100, 103.5, 99, 103.2, 3); // broke inside H
  const an = core.analyzeTF(closed, forming);
  const live = an.live.find((s) => s.dir === "up");
  assert.ok(live && live.name === "2D-1-2U");
  assert.equal(live.entry, 103);   // inside bar high
  assert.equal(live.stop, 97);     // 2D bar low, NOT the inside bar low
  assert.equal(live.target, 105);  // 2D bar HIGH (wick)
});

test("3-1-2 color routing: green 3 makes 3-1-2U a continuation, red a reversal", () => {
  // green 3 (c > o), then inside
  const green = [
    bar(100, 104, 96, 100, 0),
    bar(99, 106, 94, 105, 1),    // Type 3, closes GREEN
    bar(103, 104.5, 102, 103, 2) // inside
  ];
  const gAn = core.analyzeTF(green, null);
  const gUp = gAn.setups.find((s) => s.name === "3-1-2U");
  const gDn = gAn.setups.find((s) => s.name === "3-1-2D");
  assert.equal(gUp.kind, "cont");   // same direction as the green 3
  // rules v2: the 3's far extreme (R14; design decision 2026-09-23) - v1 served 120.25
  assert.equal(gUp.target, 106);
  assert.equal(gUp.tgt_rule, "structural");
  assert.equal(gDn.kind, "rev");    // against the green 3
  assert.equal(gDn.target, 94);     // the 3's low (wick)

  // red 3 (c < o): mirrored
  const red = [
    bar(100, 104, 96, 100, 0),
    bar(101, 106, 94, 95, 1),    // Type 3, closes RED
    bar(96, 97.5, 95.5, 96.5, 2) // inside
  ];
  const rAn = core.analyzeTF(red, null);
  assert.equal(rAn.setups.find((s) => s.name === "3-1-2U").kind, "rev");
  assert.equal(rAn.setups.find((s) => s.name === "3-1-2U").target, 106);
  assert.equal(rAn.setups.find((s) => s.name === "3-1-2D").kind, "cont");
  // rules v2: the 3's low - v1 served 79.75 (95.5 - 1.5 x stop distance)
  assert.equal(rAn.setups.find((s) => s.name === "3-1-2D").target, 94);
});

test("2U-1-2U continuation targets bar 0's far extreme (rules v2), not an older swing pivot", () => {
  // v1 served the k=2 swing high 108 (b2). Design decision 2026-09-23: T1 = bar 0's
  // far extreme - the 2U before the inside bar (b4, high 97).
  const closed = [
    bar(95, 100, 90, 96, 0),    // reference
    bar(96, 99, 91, 97, 1),     // inside
    bar(93, 108, 92, 107, 2),   // 2U - the future pivot high
    bar(95, 96, 88, 90, 3),     // 2D
    bar(90, 97, 89, 96, 4),     // 2U
    bar(94, 95, 90, 92, 5)      // inside
  ];
  const an = core.analyzeTF(closed, null);
  const cont = an.setups.find((s) => s.name === "2U-1-2U");
  assert.ok(cont && cont.kind === "cont");
  assert.equal(cont.trigger, 95);   // inside bar high
  assert.equal(cont.stop, 89);      // min(prior 2U low, inside low)
  assert.equal(cont.target, 97);    // bar 0's high
  assert.equal(cont.tgt_rule, "structural");
});

// The two "price-NEAREST of two qualifying k=2 pivots" vectors (review
// LOW-2) pinned the v1 swing-pivot search, which rules v2 removed: bar 0 is
// now always the first candidate. Their replacement - bar 0 equal to the
// trigger, and a taken-out level skipped - lives in test/target_rules_v2.test.js.

test("completed 3-1-2 routes cont by the 3's close color", () => {
  const types = [null, "3", "1", "2U"];
  const closedGreen = [bar(0, 1, 0, 0), bar(99, 106, 94, 105), bar(103, 104.5, 102, 103), bar(103, 105, 102.5, 104.8)];
  const cGreen = core.detectCompleted(types, closedGreen);
  assert.equal(cGreen.name, "3-1-2U");
  assert.equal(cGreen.cont, true);   // green 3 + 2U = same direction
  const closedRed = [bar(0, 1, 0, 0), bar(105, 106, 94, 95), bar(96, 97.5, 95.5, 96.5), bar(96.5, 98, 96, 97.9)];
  const cRed = core.detectCompleted(types, closedRed);
  assert.equal(cRed.cont, false);    // red 3 + 2U = reversal
});

test("3-2 with no prior level and an unknown history: entry +/- 1.5% (rules v2), never the 1.5x stop distance", () => {
  const closed = [
    bar(100, 104, 96, 100, 0),
    bar(101, 106, 94, 105, 1)    // Type 3, range 12
  ];
  const an = core.analyzeTF(closed, null);
  const up = an.setups.find((s) => s.name === "3-2U");
  const dn = an.setups.find((s) => s.name === "3-2D");
  // design decision 2026-09-23: "always 1.5 percent away from entry" - v1 served 124 / 76
  assert.equal(up.target, 106 * 1.015);
  assert.equal(dn.target, 94 * 0.985);
  assert.equal(up.tgt_rule, "fallback");
  assert.equal(dn.tgt_rule, "fallback");
});

test("1-3 Rev Strat: fires on the SECOND break with bar0 wick target; null order emits nothing", () => {
  const closed = [
    bar(100, 108, 99, 102, 0),   // reference so bar 0 classifies
    bar(102, 110, 95, 105, 1),   // bar 0 (Type 3; the bar the inside bar sits inside)
    bar(104, 107, 101, 103, 2)   // inside bar
  ];
  // forming took BOTH sides of the inside bar (a 3)
  const forming = bar(103, 108, 100, 107.5, 3);
  // downside broke first -> bullish 1-3
  const anUp = core.analyzeTF(closed, forming, "down");
  const rev = anUp.live.find((s) => s.name === "1-3");
  assert.ok(rev, "1-3 present");
  assert.equal(rev.dir, "up");
  assert.equal(rev.entry, 107);    // inside bar high (the second break)
  assert.equal(rev.stop, 101);     // inside bar low
  assert.equal(rev.target, 110);   // bar 0 HIGH (wick)
  assert.equal(rev.rev3, true);
  assert.equal(anUp.invalidated, true);  // the directional entries ARE invalidated

  // upside broke first -> bearish 1-3
  const anDn = core.analyzeTF(closed, forming, "up");
  const revDn = anDn.live.find((s) => s.name === "1-3");
  assert.equal(revDn.dir, "down");
  assert.equal(revDn.entry, 101);
  assert.equal(revDn.target, 95);  // bar 0 LOW

  // unknown order -> no 1-3 (honest: path not observed)
  const anNull = core.analyzeTF(closed, forming, null);
  assert.equal(anNull.live.find((s) => s.name === "1-3"), undefined);

  // forming NOT a 3 -> no 1-3 even with firstBreak
  const forming2U = bar(103, 108, 102, 107.5, 2);
  const an2U = core.analyzeTF(closed, forming2U, "down");
  assert.equal(an2U.live.find((s) => s.name === "1-3"), undefined);
});

test("1-2-2 Rev Strat reference vector: trigger = trap bar high, target = bar0 wick exactly", () => {
  const closed = [
    bar(100, 109, 101, 105, 0),  // reference so bar0 classifies
    bar(105, 110, 100, 108, 1),  // bar 0: H110 / L100
    bar(107, 108, 103, 104, 2),  // bar 1: inside (108/103)
    bar(104, 106, 101, 102, 3)   // bar 2: 2D trap (L101 < 103, H106 <= 108)
  ];
  const an = core.analyzeTF(closed, null);
  const s = an.setups.find((x) => x.name === "1-2-2");
  assert.ok(s, "1-2-2 setup present");
  assert.equal(s.dir, "up");
  assert.equal(s.trigger, 106);   // trap bar HIGH
  assert.equal(s.stop, 101);      // trap bar extreme
  assert.equal(s.target, 110);    // bar 0 wick, exactly
  assert.equal(s.kind, "rev");
  // fires live on the break of the trap high
  const forming = bar(102, 106.5, 101.5, 106.2, 4);
  const anL = core.analyzeTF(closed, forming);
  assert.ok(anL.live.find((x) => x.name === "1-2-2" && x.dir === "up"));
  // bear mirror: inside then 2U trap
  const closedBear = [
    bar(100, 109, 101, 105, 0),
    bar(105, 110, 100, 102, 1),          // bar 0
    bar(103, 107, 102, 104, 2),          // inside (107/102)
    bar(104, 109.5, 103, 108, 3)         // 2U trap (H109.5 > 107, L103 >= 102)
  ];
  const anB = core.analyzeTF(closedBear, null);
  const sb = anB.setups.find((x) => x.name === "1-2-2");
  assert.equal(sb.dir, "down");
  assert.equal(sb.trigger, 103);  // trap bar LOW
  assert.equal(sb.target, 100);   // bar 0 low wick
  // completed form registers
  const cTypes = [null, "1", "2D", "2U"];
  assert.equal(core.detectCompleted(cTypes, closed).name, "1-2-2");
});

test("3-2 targets the first prior level not yet taken out (rules v2), entry +/- 1.5% only as fallback", () => {
  const closed = [
    bar(100, 110, 98, 105, 0),
    bar(105, 115, 104, 112, 1),
    bar(112, 120, 110, 118, 2),  // swing pivot HIGH 120 (2 lower highs each side)
    bar(115, 116, 100, 102, 3),
    bar(102, 108, 90, 95, 4),    // swing pivot LOW 90 (2 higher lows each side)
    bar(95, 104, 92, 100, 5),
    bar(98, 107, 91, 100, 6)     // Type 3 (107 > 104, 91 < 92)
  ];
  const an = core.analyzeTF(closed, null);
  const up = an.setups.find((s) => s.name === "3-2U");
  const dn = an.setups.find((s) => s.name === "3-2D");
  // b4's high 108 stands (b5 104 and the 3's 107 never took it): v1's k=2
  // swing search skipped it for 120
  assert.equal(up.target, 108);
  assert.equal(dn.target, 90);   // b4's low: b5 92 and the 3's 91 never took it
  assert.equal(up.tgt_rule, "level");
  // no prior level and no history -> the fallback
  const short = [
    bar(100, 104, 96, 100, 0),
    bar(101, 106, 94, 105, 1)    // Type 3, range 12
  ];
  const anS = core.analyzeTF(short, null);
  assert.equal(anS.setups.find((s) => s.name === "3-2U").target, 106 * 1.015);
  assert.equal(anS.setups.find((s) => s.name === "3-2D").target, 94 * 0.985);
});

test("3-2-2 stop stays at the swing extreme (adjudicated 2026-07-06, F12)", () => {
  const closed = [
    bar(100, 103, 97, 100, 0),   // plain reference so the 3 can classify
    bar(100, 106, 94, 95, 1),    // Type 3 (106>103, 94<97)
    bar(95, 96, 92, 93, 2)       // 2D breaking the 3's low (swing low 92)
  ];
  const an = core.analyzeTF(closed, null);
  const s = an.setups.find((x) => x.name === "3-2D-2U");
  assert.equal(s.stop, 92);      // the 2's extreme (beyond the 3's low 94)
  assert.equal(s.target, 106);   // the 3's high
});

// ---- PMG (Pivot Machine Gun) ----

test("PMG bullish: exactly 5 consecutive lower highs -> up reversal setup", () => {
  // highs strictly descending 122>120>118>116>114>112 (5 lower-high steps);
  // lows descending too so the last bar is a clean 2D, no bearish PMG.
  const closed = [
    bar(121, 122, 100, 101, 0),
    bar(119, 120, 99, 100, 1),
    bar(117, 118, 98, 99, 2),
    bar(115, 116, 97, 98, 3),
    bar(113, 114, 96, 97, 4),
    bar(111, 112, 95, 96, 5)
  ];
  const an = core.analyzeTF(closed, null);
  const pmg = an.setups.find((s) => s.name === "PMG" && s.dir === "up");
  assert.ok(pmg, "bullish PMG present");
  assert.equal(pmg.trigger, 112);   // last closed bar high (broken rung)
  assert.equal(pmg.stop, 95);       // last closed bar low
  assert.equal(pmg.target, 114);    // previous chain bar high (next rung)
  assert.equal(pmg.kind, "rev");
  assert.equal(an.setups.find((s) => s.name === "PMG" && s.dir === "down"), undefined);
});

test("PMG: 4 lower highs is NOT enough (chain breaks at the 5th)", () => {
  // 6 bars, but bar1.h (118) is not below bar0.h (117) -> run stops at 4.
  const closed = [
    bar(116, 117, 100, 101, 0),
    bar(117, 118, 99, 100, 1),
    bar(115, 116, 98, 99, 2),
    bar(113, 114, 97, 98, 3),
    bar(111, 112, 96, 97, 4),
    bar(109, 110, 95, 96, 5)
  ];
  assert.equal(core.analyzeTF(closed, null).setups.find((s) => s.name === "PMG"), undefined);
});

test("PMG: a 5-run that does NOT end at the last bar is ignored", () => {
  // lower-high run lives in bars 0..4; the last bar prints a HIGHER high.
  const closed = [
    bar(119, 120, 100, 101, 0),
    bar(117, 118, 99, 100, 1),
    bar(115, 116, 98, 99, 2),
    bar(113, 114, 97, 98, 3),
    bar(111, 112, 96, 97, 4),
    bar(112, 115, 96.5, 114, 5)   // higher high than bar4 -> chain does not end here
  ];
  assert.equal(core.analyzeTF(closed, null).setups.find((s) => s.name === "PMG"), undefined);
});

test("PMG: a Type-3 last bar emits no PMG (the 3-2 branch owns it)", () => {
  // 5 lower highs in bars 0..4, then bar5 engulfs bar4 -> Type 3.
  const closed = [
    bar(119, 120, 100, 101, 0),
    bar(117, 118, 99, 100, 1),
    bar(115, 116, 98, 99, 2),
    bar(113, 114, 97, 98, 3),
    bar(111, 112, 96, 97, 4),
    bar(96, 113, 95, 112, 5)      // Type 3: 113 > 112 and 95 < 96
  ];
  const an = core.analyzeTF(closed, null);
  assert.equal(an.types[an.types.length - 1], "3");
  assert.equal(an.setups.find((s) => s.name === "PMG"), undefined);
  assert.ok(an.setups.find((s) => s.name === "3-2U"), "3-2 owns the Type-3 structure");
});

test("PMG bearish: 5 consecutive higher lows -> down reversal setup (mirror)", () => {
  // lows strictly ascending 100<101<102<103<104<105; highs ascending too.
  const closed = [
    bar(100, 110, 100, 109, 0),
    bar(101, 111, 101, 110, 1),
    bar(102, 112, 102, 111, 2),
    bar(103, 113, 103, 112, 3),
    bar(104, 114, 104, 113, 4),
    bar(105, 115, 105, 114, 5)
  ];
  const an = core.analyzeTF(closed, null);
  const pmg = an.setups.find((s) => s.name === "PMG" && s.dir === "down");
  assert.ok(pmg, "bearish PMG present");
  assert.equal(pmg.trigger, 105);   // last closed bar low
  assert.equal(pmg.stop, 115);      // last closed bar high
  assert.equal(pmg.target, 104);    // previous chain bar low
  assert.equal(pmg.kind, "rev");
  assert.equal(an.setups.find((s) => s.name === "PMG" && s.dir === "up"), undefined);
});

// ---- MoMo hammer / shooter SHAPE (display-tier) ----

test("MoMo hammer shape: small body, dominant lower wick, ascending prior closes; confirming flips with forming", () => {
  // 11 body-2 bars with ascending closes (90..100), then a small-body hammer.
  const closed = [];
  for (let i = 0; i < 11; i++) closed.push(bar(88 + i, 90.5 + i, 87.5 + i, 90 + i, i));
  closed.push(bar(100.0, 100.3, 99.0, 100.2, 11)); // body 0.2, lower wick 1.0, upper 0.1
  const noForm = core.analyzeTF(closed, null);
  assert.ok(noForm.shape, "shape present");
  assert.equal(noForm.shape.type, "hammer");
  assert.equal(noForm.shape.confirming, false);   // no forming bar -> cannot confirm
  // forming close pushes past the signal high (100.3) -> confirming
  const up = core.analyzeTF(closed, bar(100.2, 100.6, 100.0, 100.5, 12));
  assert.equal(up.shape.type, "hammer");
  assert.equal(up.shape.confirming, true);
  // forming close not beyond the high -> still not confirming
  const flat = core.analyzeTF(closed, bar(100.2, 100.4, 100.0, 100.1, 12));
  assert.equal(flat.shape.confirming, false);
});

test("MoMo shooter shape: dominant upper wick, descending prior closes; confirming flips with forming", () => {
  const closed = [];
  for (let i = 0; i < 11; i++) closed.push(bar(112 - i, 112.5 - i, 109.5 - i, 110 - i, i));
  closed.push(bar(100.0, 101.0, 99.7, 99.8, 11)); // body 0.2, upper wick 1.0, lower 0.1
  const an = core.analyzeTF(closed, null);
  assert.ok(an.shape, "shape present");
  assert.equal(an.shape.type, "shooter");
  assert.equal(an.shape.confirming, false);
  // forming close pushes below the signal low (99.7) -> confirming
  const dn = core.analyzeTF(closed, bar(99.8, 100.0, 99.4, 99.5, 12));
  assert.equal(dn.shape.type, "shooter");
  assert.equal(dn.shape.confirming, true);
});

test("MoMo: no shape when the signal body is fat", () => {
  const closed = [];
  for (let i = 0; i < 11; i++) closed.push(bar(88 + i, 90.5 + i, 87.5 + i, 90 + i, i));
  closed.push(bar(100.0, 103.0, 99.0, 102.5, 11)); // body 2.5 >> 0.30 * avgBody
  assert.equal(core.analyzeTF(closed, null).shape, null);
});
