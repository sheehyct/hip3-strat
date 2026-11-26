// User drawings: four TradingView-style tools, named in TradingView
// terms:
//   hline  Horizontal line  - one price, infinite both ways (cost basis)
//   hray   Horizontal ray   - starts at a time/price, extends right
//                             (level to be broken)
//   xline  Extended line    - two points, extended infinitely both ways
//                             (broadening formations)
//   info   Info line        - two-point segment labelled with price change,
//                             percent change and bar count
//
// These are the USER'S annotations. They are display-only: nothing here or
// in any engine may read them into a filter, a score, an alert or any STRAT
// classification (this app never detects).
//
// The schema is OURS, not a chart library's, on purpose: drawings persist in
// AsyncStorage (drawings_store.ts) and must survive a timeframe change, a
// navigation, an app restart AND a change of chart engine. A library's own
// serialized format would lock the saved drawings to that library.
//
// Points are absolute instants and prices: t = UTC seconds (ANY instant, not
// necessarily a bar open), p = price. Engines map t to a FRACTIONAL logical
// bar position (logicalForTime) rather than snapping to a bar, so a line
// drawn on 15m keeps its slope when viewed on 4h.
//
// PURE and IMPORT-FREE: node --test loads this file straight from source
// through type stripping, so erasable syntax only (no enums, no namespaces).

export type DrawingKind = "hline" | "hray" | "xline" | "info";

export const DRAWING_KINDS: readonly DrawingKind[] = ["hline", "hray", "xline", "info"];

export const DRAWING_LABEL: Record<DrawingKind, string> = {
  hline: "Horizontal line",
  hray: "Horizontal ray",
  xline: "Extended line",
  info: "Info line",
};

// Short labels for a phone toolbar.
export const DRAWING_SHORT: Record<DrawingKind, string> = {
  hline: "H-Line",
  hray: "H-Ray",
  xline: "Ext Line",
  info: "Info",
};

export const POINTS_NEEDED: Record<DrawingKind, 1 | 2> = { hline: 1, hray: 1, xline: 2, info: 2 };

// Default stroke for user drawings. Purple carries no market meaning anywhere
// in this app (emerald/crimson/amber/gray are bar types, blue is info and
// structure), so a user line can never be mistaken for a served level.
export const DRAW_COLOR = "#C084FC";
export const DRAW_SELECTED_COLOR = "#E9D5FF";

export type DrawPoint = { t: number; p: number };

export type Drawing = {
  id: string;
  kind: DrawingKind;
  pts: DrawPoint[];      // exactly POINTS_NEEDED[kind]; hline reads pts[0].p only
  color: string | null;  // null = DRAW_COLOR
  at: number;            // last create/update, epoch ms
};

export const DRAWINGS_SCHEMA = 1;
export const MAX_DRAWINGS_PER_COIN = 100;

// AsyncStorage key per chart coin. The coin is the EXACT Hyperliquid coin id
// the chart draws ("xyz:NVDA", "BTC") - never the display symbol, so two
// markets that share a ticker can never share drawings.
export function drawingsStorageKey(coin: string): string {
  return "tt.drawings.v" + DRAWINGS_SCHEMA + "." + coin;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const finitePos = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

// Whitelist-validated load (the sanitizeFilters idiom): junk degrades per
// item - a malformed drawing is dropped, never a throw, never half-shaped.
// Ids are deduplicated (first wins) and the set is capped, newest kept.
export function sanitizeDrawings(raw: unknown): Drawing[] {
  if (!Array.isArray(raw)) return [];
  const out: Drawing[] = [];
  const ids = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const kind = o.kind;
    if (typeof kind !== "string" || DRAWING_KINDS.indexOf(kind as DrawingKind) < 0) continue;
    const k = kind as DrawingKind;
    if (typeof o.id !== "string" || !o.id || o.id.length > 64 || ids.has(o.id)) continue;
    if (!Array.isArray(o.pts) || o.pts.length !== POINTS_NEEDED[k]) continue;
    const pts: DrawPoint[] = [];
    for (const q of o.pts) {
      const pq = q as Record<string, unknown> | null;
      if (!pq || typeof pq !== "object" || !finitePos(pq.t) || !finitePos(pq.p)) break;
      pts.push({ t: pq.t, p: pq.p });
    }
    if (pts.length !== POINTS_NEEDED[k]) continue;
    const color = typeof o.color === "string" && HEX.test(o.color) ? o.color : null;
    const at = typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0;
    ids.add(o.id);
    out.push({ id: o.id, kind: k, pts, color, at });
  }
  if (out.length <= MAX_DRAWINGS_PER_COIN) return out;
  return out.slice().sort((a, b) => b.at - a.at).slice(0, MAX_DRAWINGS_PER_COIN);
}

// A fresh id. `rand` is injectable for tests.
export function newDrawingId(now: number, rand: () => number = Math.random): string {
  return "d" + now.toString(36) + Math.floor(rand() * 1e9).toString(36);
}

// What an info line prints. dPct is relative to the FIRST point (where the
// move started), the way TradingView's info line reads. bars is counted on
// the timeframe being viewed (so it changes with the timeframe, by design).
export type InfoStats = { dPrice: number; dPct: number | null; bars: number | null; seconds: number };
export function infoStats(a: DrawPoint, b: DrawPoint, tfSec: number): InfoStats {
  const dPrice = b.p - a.p;
  return {
    dPrice,
    dPct: a.p !== 0 ? (dPrice / a.p) * 100 : null,
    bars: tfSec > 0 ? Math.round((b.t - a.t) / tfSec) : null,
    seconds: b.t - a.t,
  };
}

// "+2.35%" style, sign always shown, null -> "-".
export function fmtSignedPct(x: number | null, digits = 2): string {
  if (x === null || !Number.isFinite(x)) return "-";
  return (x > 0 ? "+" : x < 0 ? "" : "+") + x.toFixed(digits) + "%";
}

// Compact span for the info label: 45m, 6h 15m, 3d 4h, 12w.
export function fmtSpan(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 70) return Math.round(d / 7) + "w";
  if (d >= 1) return d + "d" + (h % 24 ? " " + (h % 24) + "h" : "");
  if (h >= 1) return h + "h" + (m % 60 ? " " + (m % 60) + "m" : "");
  return m + "m";
}

// ---- time <-> logical bar position ----------------------------------------
//
// `times` = the ascending bar-open times (UTC seconds) the engine is drawing.
// Inside the data: interpolate between the two bars around t (gaps in the
// series are respected). Before the first / after the last bar: extrapolate
// at one bar per tfSec. Returns null only for an empty series.

function upperIndex(times: readonly number[], t: number): number {
  // first index whose time is > t
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function logicalForTime(times: readonly number[], t: number, tfSec: number): number | null {
  const n = times.length;
  if (!n || !(tfSec > 0)) return null;
  if (t <= times[0]) return (t - times[0]) / tfSec;
  if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / tfSec;
  const i = upperIndex(times, t) - 1; // times[i] <= t < times[i+1]
  const span = times[i + 1] - times[i];
  return i + (span > 0 ? (t - times[i]) / span : 0);
}

export function timeForLogical(times: readonly number[], logical: number, tfSec: number): number | null {
  const n = times.length;
  if (!n || !(tfSec > 0) || !Number.isFinite(logical)) return null;
  if (logical <= 0) return times[0] + logical * tfSec;
  if (logical >= n - 1) return times[n - 1] + (logical - (n - 1)) * tfSec;
  const i = Math.floor(logical);
  return times[i] + (logical - i) * (times[i + 1] - times[i]);
}

// ---- pixel geometry (engines draw in pane coordinates) ---------------------

// The infinite line through (x1,y1)-(x2,y2), clipped to [0,w] x [0,h].
// null when the two points coincide or the line misses the rectangle.
export function clipInfiniteLine(
  x1: number, y1: number, x2: number, y2: number, w: number, h: number,
): [number, number, number, number] | null {
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return null;
  let tmin = -Infinity, tmax = Infinity;
  const axis = (p: number, d: number, max: number): boolean => {
    if (d === 0) return p >= 0 && p <= max;
    const a = (0 - p) / d, b = (max - p) / d;
    tmin = Math.max(tmin, Math.min(a, b));
    tmax = Math.min(tmax, Math.max(a, b));
    return true;
  };
  if (!axis(x1, dx, w) || !axis(y1, dy, h) || tmin > tmax) return null;
  return [x1 + tmin * dx, y1 + tmin * dy, x1 + tmax * dx, y1 + tmax * dy];
}

// Distance from a point to a segment (hit-testing a tap against a drawing).
export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let u = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  u = Math.max(0, Math.min(1, u));
  const cx = x1 + u * dx, cy = y1 + u * dy;
  return Math.hypot(px - cx, py - cy);
}

// Finger-sized hit tolerance in CSS px (a fingertip is ~7-10 mm).
export const HIT_PX = 14;

// ---- strong magnet ------------------------------------------------------
//
// TradingView's strong magnet: a drawing point snaps to the nearest of the
// open, high, low or close of the bar under the pointer - x to that bar's
// time, y to whichever of its O/H/L/C is closest to the pointer's price.
// Strong = it ALWAYS snaps, no distance threshold. A point past the last bar
// (or before the first) is not snapped. Ties go to the earlier of O, H, L,
// C in that order (deterministic, so a point exactly between two levels
// never flickers). Applies to every tool, both points of two-point tools,
// the live preview and handle drags; the engine calls this with the bar
// under the pointer's logical position.

export type OhlcBar = { t: number; o: number; h: number; l: number; c: number };

// `bars` ascending by t; `logical` the pointer's fractional bar position
// (0 = the first bar). Returns the snapped point plus which level it took,
// or null when the pointer is past the ends (the caller keeps the free
// point) or there are no bars.
export function snapToBar(
  bars: readonly OhlcBar[], logical: number, price: number, magnet: boolean,
): { t: number; p: number; level: "o" | "h" | "l" | "c" } | null {
  if (!magnet || !bars.length || !Number.isFinite(logical) || !Number.isFinite(price)) return null;
  const i = Math.round(logical);
  if (i < 0 || i > bars.length - 1) return null;
  const b = bars[i];
  const levels: ["o" | "h" | "l" | "c", number][] = [["o", b.o], ["h", b.h], ["l", b.l], ["c", b.c]];
  let best = levels[0];
  let bestD = Math.abs(price - best[1]);
  for (let k = 1; k < levels.length; k++) {
    const d = Math.abs(price - levels[k][1]);
    if (d < bestD) { best = levels[k]; bestD = d; }
  }
  return { t: b.t, p: best[1], level: best[0] };
}
