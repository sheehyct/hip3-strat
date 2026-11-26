// Position chart data: Hyperliquid candles, the live candle stream, the MFP
// -> Hyperliquid chart-source mapping, and the SERVED STRAT overlay. PURE
// and IMPORT-FREE: node --test loads this file straight from source.
//
// Contract: this app never detects. Candles are plain OHLC;
// their up/down color is close vs open, not a STRAT type. Every STRAT
// element on the chart - bar-type labels, live signal entry/stop/target,
// setup triggers - is the worker's served output for that timeframe, placed
// at the worker's own bar times. In-force dimming takes the vendored
// DISPLAY-CORE sigInForce as a parameter (never re-derived here).

export type ChartTf = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

// `served` names the worker's TF key when it serves that timeframe
// (/api/state coin.tf); 1m and 5m are chart-only.
export const CHART_TFS: { id: ChartTf; label: string; ms: number; served: string | null }[] = [
  { id: "1m", label: "1m", ms: 60e3, served: null },
  { id: "5m", label: "5m", ms: 300e3, served: null },
  { id: "15m", label: "15m", ms: 900e3, served: "15m" },
  { id: "30m", label: "30m", ms: 1800e3, served: "30m" },
  { id: "1h", label: "1h", ms: 3600e3, served: "1h" },
  { id: "4h", label: "4h", ms: 14400e3, served: "4h" },
  { id: "1d", label: "1D", ms: 86400e3, served: "1d" },
];

export const DEFAULT_TF: ChartTf = "15m";
export const HISTORY_BARS = 300;    // first load per TF
export const OLDER_BARS = 300;      // each page when the chart is scrolled back

export const tfSpec = (tf: ChartTf) => CHART_TFS.find((t) => t.id === tf) ?? CHART_TFS[2];
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

// The candleSnapshot window ending at `endMs` that holds `count` bars.
export function candleWindow(tf: ChartTf, endMs: number, count: number): { startTime: number; endTime: number } {
  const ms = tfSpec(tf).ms;
  return { startTime: Math.max(0, Math.floor(endMs - count * ms)), endTime: Math.floor(endMs) };
}

// ---- chart source for a MyFundedPerps position -----------------------------

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
  const candidates = [sym, k ? "k" + k[1] : null, "xyz:" + sym].filter((x): x is string => !!x);
  for (const c of candidates) {
    if (hlCoins.has(c)) return { coin: c, note: "chart: Hyperliquid " + c + " - MFP fills on " + (p.provider || "its venue") };
  }
  return null;
}

// ---- served STRAT overlay (display of /api/state, never computed here) -----

export type Tone = "bull" | "bear" | "warn" | "muted" | "info" | "text" | "faint";
export type ChartLine = { price: number; tone: Tone; title: string; style: "solid" | "dashed" | "dotted"; width: 1 | 2 };
export type ChartMarker = { time: number; text: string; tone: Tone; forming: boolean };

// The served TF shape this module reads (a structural subset of api.ts
// TFState, so the module stays import-free).
export type ServedTf = {
  types: (string | null)[];
  formingType: string | null;
  forming: { t: number; T: number } | null;
  invalidated: boolean;
  live: { name: string; dir: "up" | "down"; entry: number; stop: number; target: number | null; rev3?: boolean }[];
  setups: { name: string; dir: "up" | "down"; trigger: number; stop: number; target: number | null; kind: string }[];
};

const TYPE_TONE: Record<string, Tone> = { "2U": "bull", "2D": "bear", "3": "warn", "1": "muted" };
const dirTone = (d: "up" | "down"): Tone => (d === "up" ? "bull" : "bear");
const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export const MAX_SETUP_LINES = 2;

// Lines and labels for one served timeframe.
// - Live signals (skipped when the TF is invalidated, except a 1-3 Rev
//   Strat, mirroring the worker's `an.invalidated && !l.rev3`): entry, stop
//   and target (the magnitude level), each titled with the signal's name.
//   Out of force -> muted.
// - Setups (not yet triggered, so never "in force"): the trigger only,
//   dashed. The screener's own echo filter applies - a setup whose name is
//   already live is that signal, not a pending one (index.tsx). Reversal
//   setups take the MAX_SETUP_LINES slots before continuations, which are
//   labelled "(cont)"; "info" setups (no valid reference bar, "(no ref)" on
//   the screener) draw no line.
// - Bar types: the served closed types and the forming type, at the
//   worker's bar times (forming.t, stepping back one TF per bar), so they
//   sit on the bars they describe even when the worker lags.
// lagBars = how many bars the worker's forming bar is behind `nowMs`.
export function servedOverlay(
  tf: ServedTf | null | undefined, tfMs: number, nowMs: number, inForce: (sig: { dir: "up" | "down"; entry: number }) => boolean,
): { lines: ChartLine[]; markers: ChartMarker[]; lagBars: number } {
  const lines: ChartLine[] = [];
  const markers: ChartMarker[] = [];
  if (!tf) return { lines, markers, lagBars: 0 };
  for (const s of tf.live || []) {
    if (tf.invalidated && !s.rev3) continue;
    if (!fin(s.entry)) continue;
    const on = inForce(s);
    const tone: Tone = on ? dirTone(s.dir) : "muted";
    lines.push({ price: s.entry, tone, title: s.name + " entry", style: "solid", width: 2 });
    if (fin(s.stop)) lines.push({ price: s.stop, tone: on ? "warn" : "muted", title: s.name + " stop", style: "dashed", width: 1 });
    if (fin(s.target)) lines.push({ price: s.target, tone, title: s.name + " tgt", style: "dotted", width: 1 });
  }
  const liveNames = new Set((tf.live || []).map((l) => l.name));
  const pending = (tf.setups || [])
    .filter((s) => s.kind !== "info" && fin(s.trigger) && !liveNames.has(s.name))
    .sort((a, b) => (a.kind === "cont" ? 1 : 0) - (b.kind === "cont" ? 1 : 0)) // stable: rev first, served order kept
    .slice(0, MAX_SETUP_LINES);
  for (const s of pending) {
    lines.push({ price: s.trigger, tone: dirTone(s.dir), title: s.name + (s.kind === "cont" ? " (cont)" : "") + " trig", style: "dashed", width: 1 });
  }
  let lagBars = 0;
  const f = tf.forming;
  if (f && fin(f.t) && tfMs > 0) {
    const types = (tf.types || []).filter((x): x is string => typeof x === "string");
    types.forEach((ty, i) => {
      const t = f.t - (types.length - i) * tfMs;
      markers.push({ time: Math.floor(t / 1000), text: ty, tone: TYPE_TONE[ty] ?? "muted", forming: false });
    });
    if (tf.formingType) markers.push({ time: Math.floor(f.t / 1000), text: tf.formingType + "*", tone: TYPE_TONE[tf.formingType] ?? "muted", forming: true });
    if (fin(f.T) && nowMs > f.T) lagBars = Math.max(1, Math.floor((nowMs - f.t) / tfMs));
  }
  return { lines: dedupeLines(lines), markers, lagBars };
}

// Two lines at one price collapse into one title ("2D-2U trig / stop").
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

// The position's own levels.
export function positionLines(entry: number | null, liq: number | null): ChartLine[] {
  const out: ChartLine[] = [];
  if (fin(entry) && entry > 0) out.push({ price: entry, tone: "info", title: "your entry", style: "solid", width: 1 });
  if (fin(liq) && liq > 0) out.push({ price: liq, tone: "bear", title: "liq", style: "dashed", width: 1 });
  return out;
}

// Compact wire for the chart component's props: [t, o, h, l, c, v].
export type WireBar = [number, number, number, number, number, number];
export const toWire = (b: Bar): WireBar => [b.time, b.open, b.high, b.low, b.close, b.volume];
