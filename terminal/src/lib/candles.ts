// Chart data: Hyperliquid candles, the live candle stream, the MFP ->
// Hyperliquid chart-source mapping and the chart's line / marker shapes.
// PURE and IMPORT-FREE: node --test loads this file straight from source.
//
// Candles are plain OHLC; their up/down color is close vs open. There is no
// STRAT or any other classification in this app.

export type ChartTf = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

export const CHART_TFS: { id: ChartTf; label: string; ms: number }[] = [
  { id: "1m", label: "1m", ms: 60e3 },
  { id: "3m", label: "3m", ms: 180e3 },
  { id: "5m", label: "5m", ms: 300e3 },
  { id: "15m", label: "15m", ms: 900e3 },
  { id: "30m", label: "30m", ms: 1800e3 },
  { id: "1h", label: "1h", ms: 3600e3 },
  { id: "4h", label: "4h", ms: 14400e3 },
  { id: "1d", label: "1D", ms: 86400e3 },
];

export const DEFAULT_TF: ChartTf = "15m";
export const HISTORY_BARS = 300;    // first load per TF
export const OLDER_BARS = 300;      // each page when the chart is scrolled back

export const tfSpec = (tf: ChartTf) => CHART_TFS.find((t) => t.id === tf) ?? CHART_TFS[3];
export const isChartTf = (x: unknown): x is ChartTf => CHART_TFS.some((t) => t.id === x);

// time = bar open, UTC SECONDS (the chart library's time unit).
export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN);

function toBar(r: unknown): Bar | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const t = num(o.t), op = num(o.o), h = num(o.h), l = num(o.l), c = num(o.c), v = num(o.v);
  if (![t, op, h, l, c].every(Number.isFinite) || !(h >= l) || t <= 0) return null;
  return { time: Math.floor(t / 1000), open: op, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 };
}

// candleSnapshot -> bars, ascending, one per time. A malformed row is
// dropped (this is display; a gap is visible and harmless). null = the
// answer is not a list at all.
export function parseHlCandles(json: unknown): Bar[] | null {
  if (!Array.isArray(json)) return null;
  const out: Bar[] = [];
  for (const r of json) {
    const b = toBar(r);
    if (b) out.push(b);
  }
  return mergeBars([], out);
}

// Union by time, `b` winning on a clash; ascending.
export function mergeBars(a: Bar[], b: Bar[]): Bar[] {
  const m = new Map<number, Bar>();
  for (const x of a) m.set(x.time, x);
  for (const x of b) m.set(x.time, x);
  return [...m.values()].sort((x, y) => x.time - y.time);
}

// Fold one live bar into a series: replace the bar with the same time,
// append a newer one, ignore anything older than the last bar.
export function applyLive(bars: Bar[], live: Bar): Bar[] {
  if (!bars.length) return [live];
  const last = bars[bars.length - 1];
  if (live.time === last.time) return [...bars.slice(0, -1), live];
  if (live.time > last.time) return [...bars, live];
  return bars;
}

// The WebSocket "candle" channel: {channel: "candle", data: {t, T, s, i,
// o, c, h, l, v, n}}. null for anything else (pong, subscriptionResponse).
export function parseHlWsCandle(msg: unknown): { coin: string; interval: string; bar: Bar } | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m.channel !== "candle" || !m.data || typeof m.data !== "object") return null;
  const d = m.data as Record<string, unknown>;
  const bar = toBar(d);
  if (!bar || typeof d.s !== "string" || typeof d.i !== "string") return null;
  return { coin: d.s, interval: d.i, bar };
}

// The WebSocket "allMids" channel: {channel: "allMids", data: {mids: {coin: "px"}}}.
export function parseHlWsMids(msg: unknown): Record<string, number> | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m.channel !== "allMids" || !m.data || typeof m.data !== "object") return null;
  const mids = (m.data as Record<string, unknown>).mids;
  if (!mids || typeof mids !== "object") return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(mids as Record<string, unknown>)) {
    const p = num(v);
    if (Number.isFinite(p) && p > 0) out[k] = p;
  }
  return out;
}

// The WebSocket "bbo" channel: {channel: "bbo", data: {coin, time, bbo: [bid|null, ask|null]}}
// where each level is {px, sz, n}.
export function parseHlWsBbo(msg: unknown): { coin: string; bid: number | null; ask: number | null } | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m.channel !== "bbo" || !m.data || typeof m.data !== "object") return null;
  const d = m.data as Record<string, unknown>;
  if (typeof d.coin !== "string" || !Array.isArray(d.bbo)) return null;
  const lvl = (x: unknown): number | null => {
    if (!x || typeof x !== "object") return null;
    const p = num((x as Record<string, unknown>).px);
    return Number.isFinite(p) && p > 0 ? p : null;
  };
  return { coin: d.coin, bid: lvl(d.bbo[0]), ask: lvl(d.bbo[1]) };
}

// The candleSnapshot window ending at `endMs` that holds `count` bars.
export function candleWindow(tf: ChartTf, endMs: number, count: number): { startTime: number; endTime: number } {
  const ms = tfSpec(tf).ms;
  return { startTime: Math.max(0, Math.floor(endMs - count * ms)), endTime: Math.floor(endMs) };
}

// ---- chart source for a MyFundedPerps market ------------------------------

// MFP executes on several venues; Binance's API refuses US IPs (HTTP 451,
// verified 2026-10-18), so every MFP chart reads Hyperliquid: the market
// itself when MFP routes to Hyperliquid, else Hyperliquid's perp on the
// same base asset (labelled), else no chart rather than a wrong one.
export function chartSourceForMfp(
  p: { provider: string; coin: string; symbol: string },
  hlCoins: Set<string>,
): { coin: string; note: string | null } | null {
  if (p.provider === "hyperliquid" && hlCoins.has(p.coin)) return { coin: p.coin, note: null };
  const sym = (p.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!sym) return null;
  const k = /^1000([A-Z0-9]+)$/.exec(sym); // Binance 1000PEPE = Hyperliquid kPEPE
  const alias: Record<string, string> = { XAU: "xyz:GOLD", XAG: "xyz:SILVER" };
  const candidates = [sym, k ? "k" + k[1] : null, "xyz:" + sym, alias[sym] ?? null].filter((x): x is string => !!x);
  for (const c of candidates) {
    if (hlCoins.has(c)) return { coin: c, note: "chart: Hyperliquid " + c + " - MFP fills on " + (p.provider || "its venue") };
  }
  return null;
}

// ---- chart line / marker shapes --------------------------------------------

export type Tone = "bull" | "bear" | "warn" | "muted" | "info" | "text" | "faint";
export type ChartLine = { price: number; tone: Tone; title: string; style: "solid" | "dashed" | "dotted"; width: 1 | 2 };
export type ChartMarker = { time: number; text: string; tone: Tone; forming: boolean };

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

// Two lines at one price collapse into one title ("entry / liq").
export function dedupeLines(lines: ChartLine[]): ChartLine[] {
  const out: ChartLine[] = [];
  for (const l of lines) {
    const same = out.find((o) => o.price === l.price);
    if (same) {
      if (!same.title.split(" / ").includes(l.title)) same.title += " / " + l.title;
      if (l.width > same.width) { same.width = l.width; same.style = l.style; same.tone = l.tone; }
    } else {
      out.push({ ...l });
    }
  }
  return out;
}

// A position's own liquidation line (the entry is carried by its tag).
export function liquidationLine(liq: number | null, label: string): ChartLine[] {
  if (fin(liq) && liq > 0) return [{ price: liq, tone: "bear", title: label, style: "dotted", width: 1 }];
  return [];
}

// A working order that is not a position's exit line (a resting limit, a
// stop entry, an exit whose position is not on this chart). Display only:
// it is moved and cancelled from the Open orders table. Solid while it
// rests; dashed while the venue or an unsettled write still has it pending.
export function orderLine(o: { side: "buy" | "sell"; kind: string; price: number; size: number }, venueLabel: string, pending: boolean): ChartLine[] {
  if (!fin(o.price) || !(o.price > 0) || !fin(o.size)) return [];
  const what = o.kind === "limit" || o.kind === "tp" || o.kind === "sl" ? o.kind : "order";
  return [{
    price: o.price, tone: o.side === "buy" ? "bull" : "bear",
    title: venueLabel + " " + what + " " + o.side + " " + o.size + (pending ? " (pending)" : ""),
    style: pending ? "dashed" : "solid", width: 1,
  }];
}

// Compact wire for the chart component's props: [t, o, h, l, c, v].
export type WireBar = [number, number, number, number, number, number];
export const toWire = (b: Bar): WireBar => [b.time, b.open, b.high, b.low, b.close, b.volume];

// Price precision from magnitude, so 0.0000123 and 81,000 both read right
// (price-chart.tsx:75-81, copied exactly).
export function decimalsFor(p: number): number {
  if (!(p > 0)) return 2;
  if (p >= 10000) return 1;
  if (p >= 100) return 2;
  if (p >= 1) return 3;
  return Math.min(8, 3 - Math.floor(Math.log10(p)));
}
