// src/lib/drawings.ts: the engine-agnostic user-drawing schema, its
// whitelist loader, the info-line arithmetic, time <-> logical mapping and
// the pixel geometry every chart engine shares.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clipInfiniteLine, distToSegment, drawingsStorageKey, fmtSignedPct, fmtSpan, infoStats, logicalForTime,
  MAX_DRAWINGS_PER_COIN, newDrawingId, POINTS_NEEDED, sanitizeDrawings, timeForLogical,
} from "../src/lib/drawings.ts";

const pt = (t, p) => ({ t, p });
const good = (id, kind, pts, at = 1) => ({ id, kind, pts, color: null, at });

test("storage key is per EXACT coin id, never the display symbol", () => {
  assert.equal(drawingsStorageKey("xyz:NVDA"), "tt.drawings.v1.xyz:NVDA");
  assert.notEqual(drawingsStorageKey("xyz:NVDA"), drawingsStorageKey("NVDA"));
});

test("sanitize keeps well-formed drawings of all four kinds", () => {
  const raw = [
    good("a", "hline", [pt(1700000000, 101.5)]),
    good("b", "hray", [pt(1700000900, 99)]),
    good("c", "xline", [pt(1700000000, 100), pt(1700003600, 104)]),
    good("d", "info", [pt(1700000000, 100), pt(1700007200, 95)]),
  ];
  const out = sanitizeDrawings(raw);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((d) => d.kind), ["hline", "hray", "xline", "info"]);
});

test("sanitize drops junk per item, never throws", () => {
  assert.deepEqual(sanitizeDrawings(null), []);
  assert.deepEqual(sanitizeDrawings({}), []);
  const out = sanitizeDrawings([
    null, 7, "x",
    good("k1", "fib", [pt(1, 1)]),                         // unknown kind
    good("k2", "xline", [pt(1700000000, 100)]),             // wrong point count
    good("k3", "hline", [pt(1700000000, -5)]),              // non-positive price
    good("k4", "hline", [pt(Number.NaN, 5)]),               // non-finite time
    { id: "", kind: "hline", pts: [pt(1700000000, 5)] },    // empty id
    good("ok", "hline", [pt(1700000000, 5)]),
    good("ok", "hline", [pt(1700000000, 6)]),               // duplicate id: first wins
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].pts[0].p, 5);
});

test("sanitize rejects a non-hex color and keeps a valid one", () => {
  const out = sanitizeDrawings([
    { ...good("a", "hline", [pt(1700000000, 5)]), color: "red" },
    { ...good("b", "hline", [pt(1700000000, 6)]), color: "#00ff00" },
  ]);
  assert.equal(out[0].color, null);
  assert.equal(out[1].color, "#00ff00");
});

test("sanitize caps the set, keeping the newest", () => {
  const raw = [];
  for (let i = 0; i < MAX_DRAWINGS_PER_COIN + 5; i++) raw.push(good("id" + i, "hline", [pt(1700000000, 10 + i)], i));
  const out = sanitizeDrawings(raw);
  assert.equal(out.length, MAX_DRAWINGS_PER_COIN);
  assert.ok(!out.some((d) => d.id === "id0"));
  assert.ok(out.some((d) => d.id === "id" + (MAX_DRAWINGS_PER_COIN + 4)));
});

test("points needed: one-point tools vs two-point tools", () => {
  assert.equal(POINTS_NEEDED.hline, 1);
  assert.equal(POINTS_NEEDED.hray, 1);
  assert.equal(POINTS_NEEDED.xline, 2);
  assert.equal(POINTS_NEEDED.info, 2);
});

test("ids are unique-ish and deterministic under injected randomness", () => {
  const a = newDrawingId(1700000000000, () => 0.25);
  const b = newDrawingId(1700000000000, () => 0.5);
  assert.notEqual(a, b);
  assert.equal(a, newDrawingId(1700000000000, () => 0.25));
});

test("info stats: % from the FIRST point, bars on the viewed timeframe", () => {
  const s = infoStats(pt(1700000000, 100), pt(1700000000 + 4 * 900, 103), 900);
  assert.equal(s.dPrice, 3);
  assert.equal(s.dPct, 3);
  assert.equal(s.bars, 4);
  const down = infoStats(pt(1700000000, 200), pt(1700003600, 190), 3600);
  assert.equal(down.dPct, -5);
  assert.equal(down.bars, 1);
  assert.equal(infoStats(pt(1, 0), pt(2, 1), 60).dPct, null);
});

test("signed percent and span formatting", () => {
  assert.equal(fmtSignedPct(2.345), "+2.35%");
  assert.equal(fmtSignedPct(-1.2), "-1.20%");
  assert.equal(fmtSignedPct(null), "-");
  assert.equal(fmtSpan(45 * 60), "45m");
  assert.equal(fmtSpan(6 * 3600 + 15 * 60), "6h 15m");
  assert.equal(fmtSpan(3 * 86400 + 4 * 3600), "3d 4h");
  assert.equal(fmtSpan(-3600), "1h");
});

test("logicalForTime interpolates inside the data and extrapolates outside", () => {
  const times = [1000, 1900, 2800, 3700]; // 900 s bars
  assert.equal(logicalForTime([], 1000, 900), null);
  assert.equal(logicalForTime(times, 1000, 900), 0);
  assert.equal(logicalForTime(times, 2800, 900), 2);
  assert.equal(logicalForTime(times, 2350, 900), 1.5);   // half way through bar 1
  assert.equal(logicalForTime(times, 3700 + 1800, 900), 5); // two bars past the last
  assert.equal(logicalForTime(times, 100, 900), -1);        // one bar before the first
});

test("logicalForTime respects a gap in the series", () => {
  const times = [0, 900, 9000, 9900]; // gap between index 1 and 2
  assert.equal(logicalForTime(times, 4950, 900), 1.5);
});

test("timeForLogical inverts logicalForTime", () => {
  const times = [1000, 1900, 2800, 3700];
  for (const t of [400, 1000, 1450, 2800, 3000, 3700, 6000]) {
    assert.equal(timeForLogical(times, logicalForTime(times, t, 900), 900), t);
  }
});

test("a line drawn on 15m keeps its slope on 1h (fractional, not snapped)", () => {
  const m15 = [], h1 = [];
  for (let i = 0; i < 16; i++) m15.push(i * 900);
  for (let i = 0; i < 4; i++) h1.push(i * 3600);
  const a = 900 * 2, b = 900 * 10; // 8 bars apart on 15m
  const span15 = logicalForTime(m15, b, 900) - logicalForTime(m15, a, 900);
  const span1h = logicalForTime(h1, b, 3600) - logicalForTime(h1, a, 3600);
  assert.equal(span15, 8);
  assert.equal(span1h, 2);
});

test("clipInfiniteLine extends to the rectangle edges", () => {
  // horizontal through y=50 in a 200x100 box
  assert.deepEqual(clipInfiniteLine(10, 50, 20, 50, 200, 100), [0, 50, 200, 50]);
  // diagonal from (0,0) direction (1,1) in a 100x100 box
  assert.deepEqual(clipInfiniteLine(10, 10, 20, 20, 100, 100), [0, 0, 100, 100]);
  // coincident points
  assert.equal(clipInfiniteLine(5, 5, 5, 5, 100, 100), null);
  // misses the box entirely
  assert.equal(clipInfiniteLine(0, 200, 10, 200, 100, 100), null);
});

test("distToSegment measures to the nearest point on the segment", () => {
  assert.equal(distToSegment(5, 5, 0, 0, 10, 0), 5);
  assert.equal(distToSegment(-3, 4, 0, 0, 10, 0), 5); // beyond the end -> endpoint distance
});

// ---- strong magnet ---------------------------------------------------------
import { snapToBar } from "../src/lib/drawings.ts";

const bars = [
  { t: 1000, o: 10, h: 12, l: 9, c: 11 },
  { t: 1900, o: 11, h: 14, l: 10.5, c: 13 },
  { t: 2800, o: 13, h: 13.5, l: 11, c: 11.5 },
];

test("magnet: snaps to the nearest of O/H/L/C of the bar under the pointer, x to its time", () => {
  assert.deepEqual(snapToBar(bars, 1.1, 13.9, true), { t: 1900, p: 14, level: "h" });
  assert.deepEqual(snapToBar(bars, 0.8, 10.6, true), { t: 1900, p: 10.5, level: "l" });
  assert.deepEqual(snapToBar(bars, 0.2, 10.9, true), { t: 1000, p: 11, level: "c" });
  assert.deepEqual(snapToBar(bars, 2, 12.9, true), { t: 2800, p: 13, level: "o" });
});

test("magnet is strong: it snaps with no distance threshold", () => {
  assert.deepEqual(snapToBar(bars, 0, 1000, true), { t: 1000, p: 12, level: "h" });
  assert.deepEqual(snapToBar(bars, 0, -5, true), { t: 1000, p: 9, level: "l" });
});

test("magnet ties go to the first of O, H, L, C", () => {
  // bar 0: o 10, l 9 -> price 9.5 is equidistant from o and l: o wins
  assert.deepEqual(snapToBar(bars, 0, 9.5, true), { t: 1000, p: 10, level: "o" });
  // o 11 and l 10.5 vs 10.75 -> o wins; c 13 vs h 14 at 13.5 -> h is checked before c
  assert.equal(snapToBar(bars, 1, 10.75, true).level, "o");
  assert.equal(snapToBar(bars, 1, 13.5, true).level, "h");
});

test("magnet: a point past the last bar or before the first is not snapped", () => {
  assert.equal(snapToBar(bars, 2.6, 12, true), null);
  assert.equal(snapToBar(bars, 5, 12, true), null);
  assert.equal(snapToBar(bars, -0.6, 12, true), null);
  assert.deepEqual(snapToBar(bars, 2.4, 12, true), { t: 2800, p: 11.5, level: "c" }, "rounds to the nearest bar inside the data");
});

test("magnet off: free placement (null), and empty data never snaps", () => {
  assert.equal(snapToBar(bars, 1, 13.9, false), null);
  assert.equal(snapToBar([], 0, 10, true), null);
  assert.equal(snapToBar(bars, NaN, 10, true), null);
});
