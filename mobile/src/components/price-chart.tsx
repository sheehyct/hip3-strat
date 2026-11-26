"use dom";

// The position chart: TradingView Lightweight Charts (Apache-2.0; the
// TradingView attribution logo stays on, as its NOTICE asks - see
// THIRD_PARTY_NOTICES.md) inside an Expo DOM component - a WebView on
// Android (@expo/dom-webview, already in the v1.0.4 binary), plain DOM on
// web. It only DRAWS what it is given: no network, no keys, and the Expo
// modules bridge stays off, so nothing in this WebView can reach the secure
// store. Links (the attribution logo) open in the browser, never in here.
//
// Bridge discipline (Android re-sends EVERY prop on every parent render):
// - live ticks arrive through the imperative handle (pushLive), one bar per
//   call, never as a prop;
// - history redraws only when `histRev` (or the series) changes; lines and
//   markers only when their content changes - never on array identity.
//
// Times: intraday labels in America/New_York; daily bars keep their own
// UTC date (a 00:00 UTC bar is "Oct 18", not "Oct 17 8 PM").
import {
  CandlestickSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, HistogramSeries, LineStyle,
  TickMarkType,
} from "lightweight-charts";
import type {
  CandlestickData, HistogramData, IChartApi, IPriceLine, ISeriesApi, ISeriesMarkersPluginApi, MouseEventParams,
  SeriesMarker, Time, UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";
import type { DOMImperativeFactory, DOMProps } from "expo/dom";
import { IS_DOM, useDOMImperativeHandle } from "expo/dom";

import type { ChartLine, ChartMarker, Tone, WireBar } from "@/lib/candles";
import { C } from "@/theme";

// Bridge arguments arrive as untyped JSON; pushLive validates its bar.
export interface PriceChartHandle extends DOMImperativeFactory {
  pushLive: (...args: unknown[]) => void;
}

type Props = {
  ref?: Ref<PriceChartHandle>;
  seriesKey: string;        // coin|tf: a change resets the view to the latest bars
  histRev: number;          // bumped by the native side whenever `bars` changes
  bars: WireBar[];
  lines: ChartLine[];
  markers: ChartMarker[];
  intraday: boolean;
  height: number;
  // Asks for history before `oldestSec` for `seriesKey`; resolves false when
  // the venue has no more.
  onNeedOlder: (oldestSec: number, seriesKey: string) => Promise<boolean>;
  onOpenLink: (href: string) => Promise<void>;
  dom?: DOMProps;
};

const TONE: Record<Tone, string> = {
  bull: C.bull, bear: C.bear, warn: C.warn, muted: C.neutral, info: C.info, text: C.text, faint: C.faint,
};
const STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted } as const;
const VISIBLE_BARS = 70;      // first view: the latest ~70 bars
const OLDER_AT = 12;          // ask for older history when this close to the left edge
const OLDER_RETRY_MS = 5000;  // after a failed page
const AUTO_CORNER_W = 56;     // the price axis is never narrower, so the AUTO button fits under it

const ET = "America/New_York";
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(t: number, opts: Intl.DateTimeFormatOptions, tz: string): string {
  const k = tz + JSON.stringify(opts);
  let f = fmtCache.get(k);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }); fmtCache.set(k, f); }
  return f.format(new Date(t * 1000));
}

// Price precision from magnitude, so 0.0000123 and 81,000 both read right.
function decimalsFor(p: number): number {
  if (!(p > 0)) return 2;
  if (p >= 10000) return 1;
  if (p >= 100) return 2;
  if (p >= 1) return 3;
  return Math.min(8, 3 - Math.floor(Math.log10(p)));
}

const candle = (b: WireBar): CandlestickData<Time> => ({ time: b[0] as UTCTimestamp, open: b[1], high: b[2], low: b[3], close: b[4] });
const volume = (b: WireBar): HistogramData<Time> => ({
  time: b[0] as UTCTimestamp, value: b[5], color: b[4] >= b[1] ? "rgba(0,220,130,0.30)" : "rgba(255,59,92,0.30)",
});

export default function PriceChart({ ref, seriesKey, histRev, bars, lines, markers, intraday, height, onNeedOlder, onOpenLink }: Props) {
  const box = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lineRefs = useRef<IPriceLine[]>([]);
  const shown = useRef({ key: "", first: 0, last: 0, count: 0 });
  const drawn = useRef(new Set<number>());   // every bar time on the chart (history + live appends)
  const older = useRef({ asked: false, done: false });
  const cb = useRef({ onNeedOlder, onOpenLink, intraday });
  useEffect(() => { cb.current = { onNeedOlder, onOpenLink, intraday }; }, [onNeedOlder, onOpenLink, intraday]);
  const [legend, setLegend] = useState<WireBar | null>(null);  // the bar under the crosshair
  const [last, setLast] = useState<WireBar | null>(null);      // the latest bar (legend default)
  const [appended, setAppended] = useState(0);                 // live bars appended since the last setData
  const [auto, setAuto] = useState(true);                      // the price scale fits the visible bars (AUTO)

  // Create once.
  useEffect(() => {
    let unhookLinks: (() => void) | null = null;
    if (IS_DOM) {
      document.body.style.margin = "0";
      document.body.style.background = C.bg;
      document.body.style.overflow = "hidden";
      // A link followed inside this WebView would replace the chart with the
      // site and leave no way back: hand it to the native side instead.
      const onClick = (e: MouseEvent) => {
        const a = (e.target as Element | null)?.closest?.("a");
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();
        const href = a.getAttribute("href");
        if (href && /^https:\/\//.test(href)) cb.current.onOpenLink(href).catch(() => undefined);
      };
      document.addEventListener("click", onClick, true);
      unhookLinks = () => document.removeEventListener("click", onClick, true);
    }
    const el = box.current;
    if (!el) return unhookLinks ?? undefined;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: C.bg }, textColor: C.muted, fontSize: 10, attributionLogo: true },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      // minimumWidth keeps the corner under the axis wide enough for AUTO.
      rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.08, bottom: 0.22 }, minimumWidth: AUTO_CORNER_W },
      timeScale: {
        borderColor: C.border, rightOffset: 4, timeVisible: true, secondsVisible: false,
        // The library places day / month ticks at UTC midnight. On intraday
        // charts that is 20:00 or 19:00 ET, so those ticks carry the full ET
        // date and time rather than a date that reads four hours early.
        tickMarkFormatter: (time: Time, type: TickMarkType) => {
          const t = time as number;
          if (cb.current.intraday) {
            if (type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds) return fmt(t, { hour: "2-digit", minute: "2-digit", hour12: false }, ET);
            return fmt(t, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }, ET);
          }
          if (type === TickMarkType.Year) return fmt(t, { year: "numeric" }, "UTC");
          if (type === TickMarkType.Month) return fmt(t, { month: "short" }, "UTC");
          return fmt(t, { month: "short", day: "numeric" }, "UTC");
        },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(255,255,255,0.25)", labelBackgroundColor: C.card },
        horzLine: { color: "rgba(255,255,255,0.25)", labelBackgroundColor: C.card },
      },
      localization: {
        timeFormatter: (time: Time) => {
          const t = time as number;
          return cb.current.intraday
            ? fmt(t, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }, ET) + " ET"
            : fmt(t, { month: "short", day: "numeric", year: "numeric" }, "UTC");
        },
      },
      // Vertical touch drags must be on for the price axis to scale by touch:
      // the library reads this one flag for the axis and the chart alike, and
      // with it off treats an axis drag as page scroll. A vertical drag on the
      // chart only pans price once autoscale is off (the library ignores it
      // under autoscale), and on Android a touch that starts on this WebView
      // never reached the page's scroll anyway (dom-webview keeps it).
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
      kineticScroll: { touch: true, mouse: false },
    });
    const cs = chart.addSeries(CandlestickSeries, {
      upColor: C.bull, downColor: C.bear, borderVisible: false, wickUpColor: C.bull, wickDownColor: C.bear,
      priceLineColor: "rgba(255,255,255,0.35)",
    });
    const vs = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    markRef.current = createSeriesMarkers(cs, []);
    chart.subscribeCrosshairMove((p: MouseEventParams<Time>) => {
      const d = p.seriesData.get(cs) as CandlestickData<Time> | undefined;
      if (!p.time || !d) { setLegend(null); return; }
      setLegend([p.time as number, d.open, d.high, d.low, d.close, 0]);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      const o = older.current;
      if (!r || o.asked || o.done || shown.current.count === 0 || r.from >= OLDER_AT) return;
      o.asked = true;
      const key = shown.current.key;
      cb.current.onNeedOlder(shown.current.first, key).then((more) => {
        if (shown.current.key !== key) return;
        if (!more) o.done = true;
        // `asked` clears when the new history lands (histRev); an empty
        // answer without `done` clears it here.
        else if (o.asked) o.asked = false;
      }).catch(() => {
        setTimeout(() => { if (shown.current.key === key) o.asked = false; }, OLDER_RETRY_MS);
      });
    });
    chartRef.current = chart;
    candleRef.current = cs;
    volRef.current = vs;
    // Dragging the price axis turns autoscale off and a double tap on it turns
    // it back on. The library has no event for either, so the AUTO button
    // reads the scale after every gesture ends.
    const syncAuto = () => setTimeout(() => {
      const c = chartRef.current;
      if (c) setAuto(c.priceScale("right").options().autoScale);
    }, 0);
    const gestureEnds = ["touchend", "mouseup", "dblclick"] as const;
    for (const t of gestureEnds) el.addEventListener(t, syncAuto, true);
    return () => {
      if (unhookLinks) unhookLinks();
      for (const t of gestureEnds) el.removeEventListener(t, syncAuto, true);
      chart.remove();
      chartRef.current = null; candleRef.current = null; volRef.current = null; markRef.current = null;
      lineRefs.current = [];
      shown.current = { key: "", first: 0, last: 0, count: 0 };
      drawn.current = new Set();
    };
  }, []);

  // The forming bar, pushed by the native side one bar at a time.
  useDOMImperativeHandle(ref ?? null, () => ({
    pushLive: (...args: unknown[]) => {
      const raw = args[0];
      const cs = candleRef.current, vs = volRef.current;
      if (!cs || !vs || !Array.isArray(raw) || raw.length < 6 || !raw.every((x) => typeof x === "number" && Number.isFinite(x))) return;
      const b = raw as WireBar;
      if (shown.current.count === 0) {
        // Empty history (a quiet market): start the series from the stream.
        cs.setData([candle(b)]); vs.setData([volume(b)]);
        shown.current = { ...shown.current, first: b[0], last: b[0], count: 1 };
      } else if (b[0] < shown.current.last) {
        return; // older than the last drawn bar: the library would throw
      } else {
        cs.update(candle(b));
        vs.update(volume(b));
      }
      if (!drawn.current.has(b[0])) {
        drawn.current.add(b[0]);
        setAppended((n) => n + 1);
      }
      shown.current.last = b[0];
      setLast(b);
    },
  }), []);

  // History: a new series resets the view; older bars prepended keep the
  // view where it was; otherwise a refresh (new bar folded in, gap refill).
  useEffect(() => {
    const chart = chartRef.current, cs = candleRef.current, vs = volRef.current;
    if (!chart || !cs || !vs) return;
    const prev = shown.current;
    if (!bars.length) {
      cs.setData([]); vs.setData([]);
      shown.current = { key: seriesKey, first: 0, last: 0, count: 0 };
      drawn.current = new Set();
      older.current = { asked: false, done: false };
      setLast(null);
      return;
    }
    const d = decimalsFor(bars[bars.length - 1][4]);
    cs.applyOptions({ priceFormat: { type: "price", precision: d, minMove: Math.pow(10, -d) } });
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    // Bars the stream drew past the end of this history stay drawn.
    const tail = prev.key === seriesKey && prev.last > bars[bars.length - 1][0] ? prev.last : null;
    cs.setData(bars.map(candle));
    vs.setData(bars.map(volume));
    const newSeries = prev.key !== seriesKey || prev.count === 0;
    if (newSeries) {
      older.current = { asked: false, done: false };
      ts.setVisibleLogicalRange({ from: Math.max(0, bars.length - VISIBLE_BARS), to: bars.length + 3 });
      // A manual price range belongs to the series it was set on.
      chart.priceScale("right").setAutoScale(true);
      setAuto(true);
    } else if (bars[0][0] < prev.first && range) {
      const added = bars.findIndex((b) => b[0] >= prev.first);
      if (added > 0) ts.setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
    }
    drawn.current = new Set(bars.map((b) => b[0]));
    shown.current = { key: seriesKey, first: bars[0][0], last: bars[bars.length - 1][0], count: bars.length };
    if (tail !== null) shown.current.last = Math.max(shown.current.last, tail);
    older.current.asked = false;
    setLast(bars[bars.length - 1]);
    setAppended(0);
  }, [seriesKey, histRev]); // eslint-disable-line react-hooks/exhaustive-deps

  // Price lines: position levels and the served overlay - redrawn only when
  // their content changes.
  const linesSig = JSON.stringify(lines);
  useEffect(() => {
    const cs = candleRef.current;
    if (!cs) return;
    for (const l of lineRefs.current) cs.removePriceLine(l);
    lineRefs.current = lines.map((l) => cs.createPriceLine({
      price: l.price, color: TONE[l.tone], lineWidth: l.width, lineStyle: STYLE[l.style], axisLabelVisible: true, title: l.title,
    }));
  }, [linesSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Served bar-type labels, only on bars the chart has drawn.
  const markersSig = JSON.stringify(markers);
  useEffect(() => {
    const m = markRef.current;
    if (!m) return;
    const list: SeriesMarker<Time>[] = markers
      .filter((x) => drawn.current.has(x.time))
      .sort((a, b) => a.time - b.time)
      .map((x) => ({
        time: x.time as UTCTimestamp, position: "aboveBar", shape: x.forming ? "circle" : "square",
        color: TONE[x.tone], text: x.text, size: 0.4,
      }));
    m.setMarkers(list);
  }, [markersSig, histRev, seriesKey, appended]); // eslint-disable-line react-hooks/exhaustive-deps

  // AUTO on: the scale follows the bars. Off (after an axis drag, or tapped
  // off): the range stays put and a vertical drag pans it.
  const toggleAuto = () => {
    const c = chartRef.current;
    if (!c) return;
    const next = !c.priceScale("right").options().autoScale;
    c.priceScale("right").setAutoScale(next);
    setAuto(next);
  };

  const L = legend ?? last;
  const chg = L ? (L[4] - L[1]) / L[1] * 100 : null;
  const dp = L ? decimalsFor(L[4]) : 2;
  return (
    <div style={{ position: "relative", width: "100%", height, background: C.bg, overflow: "hidden" }}>
      <div ref={box} style={{ position: "absolute", inset: 0 }} />
      {L ? (
        <div style={{
          position: "absolute", top: 4, left: 6, zIndex: 3, pointerEvents: "none", fontFamily: "system-ui, sans-serif",
          fontSize: 10.5, color: C.muted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
        }}>
          {"O " + L[1].toFixed(dp) + "  H " + L[2].toFixed(dp) + "  L " + L[3].toFixed(dp) + "  C "}
          <span style={{ color: L[4] >= L[1] ? C.bull : C.bear }}>{L[4].toFixed(dp) + (chg !== null && Number.isFinite(chg) ? "  " + (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%" : "")}</span>
        </div>
      ) : null}
      {last ? (
        // The empty corner where the price and time axes meet.
        <button
          type="button"
          onClick={toggleAuto}
          aria-pressed={auto}
          aria-label={auto ? "Price scale: auto fit on" : "Price scale: manual, tap to auto fit"}
          style={{
            position: "absolute", right: 3, bottom: 3, zIndex: 3, width: AUTO_CORNER_W - 6, height: 19, padding: 0,
            borderRadius: 5, border: "1px solid " + (auto ? "rgba(0,220,130,0.35)" : C.border),
            background: auto ? C.bullBg : C.card, color: auto ? C.bull : C.muted,
            fontFamily: "system-ui, sans-serif", fontSize: 9.5, fontWeight: 600, letterSpacing: 0.6,
            cursor: "pointer", WebkitTapHighlightColor: "transparent",
          }}
        >
          AUTO
        </button>
      ) : null}
    </div>
  );
}
