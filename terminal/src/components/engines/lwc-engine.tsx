"use dom";

// The chart engine: TradingView Lightweight Charts 5.2.1 (Apache-2.0; the
// TradingView attribution logo stays on, as its NOTICE asks) inside an Expo
// DOM component - a WebView on Android, plain DOM on web. Contract:
// src/lib/chart_contract.ts. It carries the fixes found on a real device:
// autoscale read-back after the gesture ends, link
// interception, the ET tick formatter, decimalsFor, the live tail kept
// across setData, capture-phase drawing input that never pans the chart.
//
// New here: position TAGS and TP / SL EXIT lines as HTML overlays, placed
// with series.priceToCoordinate and re-placed every animation frame while
// anything on the chart moves (scroll, zoom, price-scale drag, autoscale,
// a live tick); the strong MAGNET (drawings.ts snapToBar) and the
// hide-drawings toggle. Tags and exits live OUTSIDE the chart box element,
// so a tap on a tag or a drag of an exit never reaches the drawing input
// layer or the library's pan - and an armed drawing tool never touches a
// tag (separate layers, separate elements).
//
// It only DRAWS what it is given: no network, no storage, no keys.
//
// Bridge discipline (Android re-sends EVERY prop on every parent render):
// - live ticks arrive through the imperative handle (pushLive / pushMark);
// - history redraws only when histRev / seriesKey change; drawings only when
//   drawingsRev / drawingsKey change; lines / tags / exits only when their
//   JSON content changes - never on array identity.
import {
  CandlestickSeries, ColorType, createChart, CrosshairMode, HistogramSeries, LineStyle, TickMarkType,
} from "lightweight-charts";
import type {
  CandlestickData, HandleScrollOptions, HistogramData, IChartApi, IPriceLine, ISeriesApi, MouseEventParams, Time, UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { IS_DOM, useDOMImperativeHandle } from "expo/dom";

import type { Tone, WireBar } from "@/lib/candles";
import type { ChartEngineProps, ChartExit, ChartTag } from "@/lib/chart_contract";
import { DRAWING_KINDS, DRAWING_LABEL, MAX_DRAWINGS_PER_COIN, newDrawingId, POINTS_NEEDED, sanitizeDrawings, snapToBar } from "@/lib/drawings";
import type { Drawing, DrawingKind, DrawPoint, OhlcBar } from "@/lib/drawings";
import { C } from "@/theme";

import { decimalsFor, DrawingLayer } from "./lwc/drawing-layer";
import type { Grab, LayerState } from "./lwc/drawing-layer";

const TONE: Record<Tone, string> = {
  bull: C.bull, bear: C.bear, warn: C.warn, muted: C.neutral, info: C.info, text: C.text, faint: C.faint,
};
const STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted } as const;
const VISIBLE_BARS = 90;
const OLDER_AT = 12;
const OLDER_RETRY_MS = 5000;
const AUTO_CORNER_W = 60;
const TAP_SLOP = 10;
const TAP_MS = 600;
const DRAG_SLOP = 3;
const MIN_LINE_PX = 6;
const FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

const SCROLL_ON: HandleScrollOptions = { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true };
const SCROLL_ARMED: HandleScrollOptions = { mouseWheel: true, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false };

const ET = "America/New_York";
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(t: number, opts: Intl.DateTimeFormatOptions, tz: string): string {
  const id = tz + JSON.stringify(opts);
  let f = fmtCache.get(id);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }); fmtCache.set(id, f); }
  return f.format(new Date(t * 1000));
}
function timeText(t: number, intraday: boolean): string {
  return intraday
    ? fmt(t, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }, ET) + " ET"
    : fmt(t, { month: "short", day: "numeric", year: "numeric" }, "UTC");
}

const candle = (b: WireBar): CandlestickData<Time> => ({ time: b[0] as UTCTimestamp, open: b[1], high: b[2], low: b[3], close: b[4] });
const volume = (b: WireBar): HistogramData<Time> => ({
  time: b[0] as UTCTimestamp, value: b[5], color: b[4] >= b[1] ? "rgba(0,220,130,0.30)" : "rgba(255,59,92,0.30)",
});
const usd = (x: number | null): string => (x === null || !Number.isFinite(x) ? "-" : (x < 0 ? "-" : "+") + "$" + Math.abs(x).toFixed(2));

// Native actions return promises over the bridge; a failure there must never
// surface as an unhandled rejection inside the WebView.
function fire(call: () => unknown): void {
  try {
    const p = call();
    if (p && typeof (p as Promise<unknown>).catch === "function") (p as Promise<unknown>).catch(() => undefined);
  } catch {
    // the native side is gone (unmount race)
  }
}

const isKind = (x: unknown): x is DrawingKind => typeof x === "string" && DRAWING_KINDS.indexOf(x as DrawingKind) >= 0;
const copyDrawing = (d: Drawing): Drawing => ({ id: d.id, kind: d.kind, pts: d.pts.map((q) => ({ t: q.t, p: q.p })), color: d.color, at: d.at });

type Gesture =
  | { mode: "place"; pid: number; x0: number; y0: number; moved: boolean; t0: number }
  | { mode: "drag"; pid: number; x0: number; y0: number; moved: boolean; t0: number; part: Grab; orig: Drawing; Y: (number | null)[] }
  | { mode: "tap"; pid: number; x0: number; y0: number; moved: boolean; t0: number };

type Ink = {
  work: Drawing[];
  key: string;
  sel: string | null;
  armed: DrawingKind | null;
  first: DrawPoint | null;
  hover: DrawPoint | null;
  snap: DrawPoint | null;
  gesture: Gesture | null;
  pointers: Set<number>;
  block: boolean;
  tailEnd: boolean;
  magnet: boolean;
  hidden: boolean;
};

type Engine = {
  setTool: (t: DrawingKind | null) => void;
  setMagnet: (on: boolean) => void;
  setHidden: (on: boolean) => void;
  command: (type: string) => void;
  syncDrawings: (list: Drawing[], key: string) => void;
};

// An exit line being dragged (or a fresh draft that follows the finger).
type ExitDrag = { id: string; pid: number; y: number; price: number };

const coarse = (): boolean => {
  try { return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches; } catch { return false; }
};

export default function LwcEngine({
  ref, seriesKey, histRev, bars, lines, intraday, tfSec, height, tags, exits, canTrade,
  drawingsKey, drawingsRev, drawings, tool, magnet, hideDrawings,
  onDrawingsChange, onToolDone, onSelect, onNeedOlder, onOpenLink, onTagAction, onExitRelease, onExitCancel,
}: ChartEngineProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const layerRef = useRef<DrawingLayer | null>(null);
  const lineRefs = useRef<IPriceLine[]>([]);
  const shown = useRef({ key: "", first: 0, last: 0, histLast: 0, count: 0, rev: -1, provisional: false });
  const times = useRef<number[]>([]);
  const ohlc = useRef<OhlcBar[]>([]);          // the drawn bars, for the magnet (index = logical)
  const tail = useRef<WireBar[]>([]);
  const older = useRef({ asked: false, done: false });
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const eng = useRef<Engine | null>(null);
  const ink = useRef<Ink>({
    work: [], key: "", sel: null, armed: null, first: null, hover: null, snap: null, gesture: null, pointers: new Set(), block: false, tailEnd: false, magnet: true, hidden: false,
  });
  const cb = useRef({ onNeedOlder, onOpenLink, onDrawingsChange, onToolDone, onSelect, onTagAction, onExitRelease, onExitCancel, intraday, tfSec });
  useEffect(() => {
    cb.current = { onNeedOlder, onOpenLink, onDrawingsChange, onToolDone, onSelect, onTagAction, onExitRelease, onExitCancel, intraday, tfSec };
  }, [onNeedOlder, onOpenLink, onDrawingsChange, onToolDone, onSelect, onTagAction, onExitRelease, onExitCancel, intraday, tfSec]);
  const [legend, setLegend] = useState<WireBar | null>(null);
  const [last, setLast] = useState<WireBar | null>(null);
  const [auto, setAuto] = useState(true);
  const [hint, setHint] = useState<string | null>(null);
  const [mark, setMark] = useState<number | null>(null);        // live mark for tag PnL
  const [exitDrag, setExitDrag] = useState<ExitDrag | null>(null);
  const [layoutTick, setLayoutTick] = useState(0);              // bumps when overlay positions change
  const posRef = useRef<Map<string, number>>(new Map());         // overlay id -> y (css px in the pane)
  const touch = useRef(coarse());

  // ---- create once ---------------------------------------------------------
  useEffect(() => {
    const later = (fn: () => void, ms: number) => {
      const id = setTimeout(() => { timers.current.delete(id); fn(); }, ms);
      timers.current.add(id);
    };
    let unhookLinks: (() => void) | null = null;
    if (IS_DOM) {
      document.body.style.margin = "0";
      document.body.style.background = C.bg;
      document.body.style.overflow = "hidden";
      const onClick = (e: MouseEvent) => {
        const a = (e.target as Element | null)?.closest?.("a");
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();
        const href = a.getAttribute("href");
        if (href && /^https:\/\//.test(href)) fire(() => cb.current.onOpenLink(href));
      };
      document.addEventListener("click", onClick, true);
      const prevOpen = window.open;
      window.open = ((url?: string | URL) => {
        const href = url === undefined ? "" : String(url);
        if (/^https:\/\//.test(href)) fire(() => cb.current.onOpenLink(href));
        return null;
      }) as typeof window.open;
      unhookLinks = () => {
        document.removeEventListener("click", onClick, true);
        window.open = prevOpen;
      };
    }
    const el = box.current;
    if (!el) return unhookLinks ?? undefined;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: C.bg }, textColor: C.muted, fontSize: 11,
        fontFamily: FONT, attributionLogo: true,
      },
      grid: { vertLines: { color: "rgba(255,255,255,0.04)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.08, bottom: 0.22 }, minimumWidth: AUTO_CORNER_W },
      timeScale: {
        borderColor: C.border, rightOffset: 6, timeVisible: true, secondsVisible: false,
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
      localization: { timeFormatter: (time: Time) => timeText(time as number, cb.current.intraday) },
      handleScroll: SCROLL_ON,
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
      kineticScroll: { touch: true, mouse: false },
    });
    const cs = chart.addSeries(CandlestickSeries, {
      upColor: C.bull, downColor: C.bear, borderVisible: false, wickUpColor: C.bull, wickDownColor: C.bear,
      priceLineColor: "rgba(255,255,255,0.35)",
    });
    const vs = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.subscribeCrosshairMove((p: MouseEventParams<Time>) => {
      const d = p.seriesData.get(cs) as CandlestickData<Time> | undefined;
      if (!p.time || !d) { setLegend(null); return; }
      setLegend([p.time as number, d.open, d.high, d.low, d.close, 0]);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((rg) => {
      const o = older.current;
      if (!rg || o.asked || o.done || shown.current.count === 0 || rg.from >= OLDER_AT) return;
      o.asked = true;
      const sk = shown.current.key;
      Promise.resolve()
        .then(() => cb.current.onNeedOlder(shown.current.first, sk))
        .then((more) => {
          if (shown.current.key !== sk) return;
          if (!more) o.done = true;
          else if (o.asked) o.asked = false;
        })
        .catch(() => {
          later(() => { if (shown.current.key === sk) o.asked = false; }, OLDER_RETRY_MS);
        });
    });

    // ---- user drawings -----------------------------------------------------
    const k = ink.current;
    const layerState = (): LayerState => {
      const kind = k.armed;
      let draft: LayerState["draft"] = null;
      if (kind && k.first) draft = { kind, pts: k.hover ? [k.first, k.hover] : [k.first] };
      else if (kind && k.hover) draft = { kind, pts: [k.hover] };
      return {
        drawings: k.work, selected: k.sel, draft, guide: kind ? k.hover : null, snap: kind ? k.snap : null, hidden: k.hidden,
        times: times.current, tfSec: cb.current.tfSec, fmtTime: (t) => timeText(t, cb.current.intraday),
      };
    };
    const layer = new DrawingLayer(layerState);
    cs.attachPrimitive(layer);
    const repaint = () => layer.invalidate();

    const refreshHint = () => {
      const kind = k.armed;
      if (!kind) { setHint(null); return; }
      const mag = k.magnet ? " (magnet on)" : "";
      if (POINTS_NEEDED[kind] === 1) setHint(DRAWING_LABEL[kind] + ": tap to place" + mag);
      else setHint(DRAWING_LABEL[kind] + ": tap point " + (k.first ? "2" : "1") + " of 2" + mag);
    };
    const applyScroll = () => chart.applyOptions({ handleScroll: k.armed ? SCROLL_ARMED : SCROLL_ON });
    const report = () => {
      const list = k.work.map(copyDrawing);
      const dk = k.key;
      fire(() => cb.current.onDrawingsChange(dk, list));
    };
    const select = (id: string | null) => {
      if (k.sel === id) return;
      k.sel = id;
      fire(() => cb.current.onSelect(id));
    };

    const local = (e: PointerEvent) => {
      const rc = el.getBoundingClientRect();
      return { x: e.clientX - rc.left - chart.priceScale("left").width(), y: e.clientY - rc.top };
    };
    const paneDims = () => chart.paneSize(0);
    const inPane = (q: { x: number; y: number }) => {
      const sz = paneDims();
      return q.x >= 0 && q.y >= 0 && q.x < sz.width && q.y < sz.height;
    };
    // Pane pixel -> drawing point. With the magnet on, the point snaps to
    // the nearest O/H/L/C of the bar under the pointer (never past the last
    // bar); the snapped level is remembered for the dot.
    const pointAt = (q: { x: number; y: number }): DrawPoint | null => {
      const sz = paneDims();
      const m = layer.mapper();
      if (!m) return null;
      const x = Math.max(0, Math.min(q.x, sz.width - 1)), y = Math.max(0, Math.min(q.y, sz.height - 1));
      const l = m.lOfX(x), p = m.pOfY(y);
      if (l === null || p === null || !Number.isFinite(l) || !Number.isFinite(p) || !(p > 0)) return null;
      const snapped = snapToBar(ohlc.current, l, p, k.magnet);
      if (snapped) { k.snap = { t: snapped.t, p: snapped.p }; return { t: snapped.t, p: +snapped.p.toPrecision(10) }; }
      k.snap = null;
      const t = m.tOfL(l);
      if (t === null || !Number.isFinite(t) || !(t > 0)) return null;
      return { t: Math.round(t), p: +p.toPrecision(10) };
    };

    const abortGesture = () => {
      const g = k.gesture;
      if (!g) return;
      k.gesture = null;
      k.block = false;
      if (g.mode === "drag") k.work = k.work.map((d) => (d.id === g.orig.id ? g.orig : d));
      if (g.mode === "place") { k.hover = null; k.snap = null; }
      repaint();
    };

    const finish = (kind: DrawingKind, pts: DrawPoint[]) => {
      const now = Date.now();
      const d: Drawing = { id: newDrawingId(now), kind, pts, color: null, at: now };
      let next = [...k.work, d];
      if (next.length > MAX_DRAWINGS_PER_COIN) {
        let oldest = next[0];
        for (const x of next) if (x.at < oldest.at) oldest = x;
        next = next.filter((x) => x !== oldest);
      }
      k.work = next;
      k.first = null;
      k.hover = null;
      k.snap = null;
      k.armed = null;
      applyScroll();
      refreshHint();
      report();
      select(d.id);
      fire(() => cb.current.onToolDone());
      repaint();
    };

    const commitPoint = () => {
      const kind = k.armed, P = k.hover;
      if (!kind) return;
      if (!P) { repaint(); return; }
      if (POINTS_NEEDED[kind] === 1) { finish(kind, [P]); return; }
      if (!k.first) {
        k.first = P;
        k.hover = null;
        refreshHint();
        repaint();
        return;
      }
      const gap = layer.pixelGap(k.first, P);
      if (gap !== null && gap < MIN_LINE_PX) { k.hover = null; repaint(); return; }
      finish(kind, [k.first, P]);
    };

    const applyDrag = (g: Extract<Gesture, { mode: "drag" }>, q: { x: number; y: number }) => {
      const m = layer.mapper();
      if (!m) return;
      const sz = paneDims();
      const dL = g.orig.kind === "hline" ? 0 : (q.x - g.x0) / m.bs, dy = q.y - g.y0;
      const pts: DrawPoint[] = [];
      for (let i = 0; i < g.orig.pts.length; i++) {
        const o = g.orig.pts[i];
        const L0 = m.lOfT(o.t), y0 = g.Y[i];
        if ((g.part !== "body" && g.part !== i) || L0 === null || y0 === null) { pts.push(o); continue; }
        let t: number | null, p: number | null;
        if (g.part === i && k.magnet) {
          // A handle drag with the magnet on snaps like a placement.
          const x = Math.max(0, Math.min(q.x, sz.width - 1)), y = Math.max(0, Math.min(q.y, sz.height - 1));
          const l = m.lOfX(x), pp = m.pOfY(y);
          const snapped = l !== null && pp !== null ? snapToBar(ohlc.current, l, pp, true) : null;
          if (snapped) { t = snapped.t; p = snapped.p; k.snap = { t, p }; }
          else { t = m.tOfL(L0 + dL); p = m.pOfY(y0 + dy); k.snap = null; }
        } else {
          t = m.tOfL(L0 + dL); p = m.pOfY(y0 + dy);
        }
        if (t === null || p === null || !Number.isFinite(t) || !Number.isFinite(p) || !(t > 0) || !(p > 0)) return;
        pts.push({ t: Math.round(t), p: +p.toPrecision(10) });
      }
      k.work = k.work.map((d) => (d.id === g.orig.id ? { ...d, pts } : d));
      repaint();
    };

    const startBlocking = (e: PointerEvent) => {
      k.block = true;
      k.tailEnd = false;
      try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      e.preventDefault();
    };

    const onDown = (e: PointerEvent) => {
      k.tailEnd = false;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.isPrimary) k.pointers.clear();
      k.pointers.add(e.pointerId);
      if (k.pointers.size > 1) { abortGesture(); return; }
      if ((e.target as Element | null)?.closest?.("a")) return;
      const q = local(e);
      if (!inPane(q)) return;
      const base = { pid: e.pointerId, x0: q.x, y0: q.y, moved: false, t0: e.timeStamp };
      if (k.armed && !k.hidden) {
        k.gesture = { mode: "place", ...base };
        k.hover = pointAt(q);
        startBlocking(e);
        repaint();
        return;
      }
      const s = k.sel && !k.hidden ? k.work.find((d) => d.id === k.sel) : undefined;
      if (s) {
        const part = layer.grab(s, q.x, q.y);
        const m = part !== null ? layer.mapper() : null;
        if (part !== null && m) {
          k.gesture = { mode: "drag", ...base, part, orig: s, Y: s.pts.map((pt) => m.yOfP(pt.p)) };
          startBlocking(e);
          return;
        }
      }
      k.gesture = { mode: "tap", ...base };
    };

    const onMove = (e: PointerEvent) => {
      const g = k.gesture;
      if (!g || g.pid !== e.pointerId) {
        if (!g && k.armed && !k.hidden && k.pointers.size === 0 && e.pointerType !== "touch") {
          const q = local(e);
          k.hover = inPane(q) ? pointAt(q) : null;
          if (!k.hover) k.snap = null;
          repaint();
        }
        return;
      }
      const q = local(e);
      if (!g.moved && Math.hypot(q.x - g.x0, q.y - g.y0) > (g.mode === "tap" ? TAP_SLOP : DRAG_SLOP)) g.moved = true;
      if (g.mode === "place") {
        const P = pointAt(q);
        if (P) k.hover = P;
        repaint();
      } else if (g.mode === "drag" && g.moved) {
        applyDrag(g, q);
      }
    };

    const onUp = (e: PointerEvent) => {
      k.pointers.delete(e.pointerId);
      const g = k.gesture;
      if (!g || g.pid !== e.pointerId) return;
      k.gesture = null;
      if (k.block) { k.block = false; k.tailEnd = true; }
      if (g.mode === "place") {
        const P = pointAt(local(e));
        if (P) k.hover = P;
        commitPoint();
      } else if (g.mode === "drag") {
        k.snap = null;
        if (g.moved) {
          const now = Date.now();
          k.work = k.work.map((d) => (d.id === g.orig.id ? { ...d, at: now } : d));
          report();
        }
        repaint();
      } else if (!g.moved && e.timeStamp - g.t0 < TAP_MS) {
        const q = local(e);
        if (inPane(q)) { select(k.hidden ? null : layer.pick(q.x, q.y)); repaint(); }
      }
    };

    const onCancel = (e: PointerEvent) => {
      k.pointers.delete(e.pointerId);
      if (k.gesture && k.gesture.pid === e.pointerId) abortGesture();
    };
    const onWindowUp = (e: PointerEvent) => {
      k.pointers.delete(e.pointerId);
      if (k.gesture && k.gesture.mode === "tap" && k.gesture.pid === e.pointerId) k.gesture = null;
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== "touch" && !k.gesture && k.hover && !k.pointers.size) { k.hover = null; k.snap = null; repaint(); }
    };
    const swallow = (e: Event) => {
      const isEnd = e.type === "touchend" || e.type === "touchcancel" || e.type === "mouseup";
      if (!k.block && !(k.tailEnd && isEnd)) return;
      e.stopPropagation();
      if (e.type === "touchmove" && e.cancelable) e.preventDefault();
      if (!k.block && isEnd && (e.type === "mouseup" || (e as TouchEvent).touches.length === 0)) k.tailEnd = false;
    };
    const noMenu = (e: Event) => e.preventDefault();

    const pointerTypes: [string, (e: PointerEvent) => void][] = [
      ["pointerdown", onDown], ["pointermove", onMove], ["pointerup", onUp], ["pointercancel", onCancel],
    ];
    for (const [type, fn] of pointerTypes) el.addEventListener(type, fn as EventListener, true);
    el.addEventListener("pointerleave", onLeave as EventListener);
    window.addEventListener("pointerup", onWindowUp);
    window.addEventListener("pointercancel", onWindowUp);
    const legacy = ["touchstart", "touchmove", "touchend", "touchcancel", "mousedown", "mousemove", "mouseup"];
    for (const type of legacy) el.addEventListener(type, swallow, { capture: true, passive: false });
    el.addEventListener("contextmenu", noMenu, true);

    eng.current = {
      setTool: (t) => {
        if (k.gesture && k.gesture.mode === "place") abortGesture();
        k.armed = k.hidden ? null : t;
        k.first = null;
        k.hover = null;
        k.snap = null;
        if (t) select(null);
        applyScroll();
        refreshHint();
        repaint();
      },
      setMagnet: (on) => { k.magnet = on; refreshHint(); repaint(); },
      setHidden: (on) => {
        k.hidden = on;
        if (on) {
          if (k.gesture && (k.gesture.mode === "place" || k.gesture.mode === "drag")) abortGesture();
          if (k.armed) { k.armed = null; k.first = null; k.hover = null; k.snap = null; applyScroll(); refreshHint(); fire(() => cb.current.onToolDone()); }
          select(null);
        }
        repaint();
      },
      command: (type) => {
        if (type === "deleteSelected") {
          const id = k.sel;
          if (!id) return;
          if (k.gesture && k.gesture.mode === "drag") abortGesture();
          k.work = k.work.filter((d) => d.id !== id);
          report();
          select(null);
          repaint();
        } else if (type === "cancelTool") {
          if (k.gesture && k.gesture.mode === "place") abortGesture();
          k.armed = null;
          k.first = null;
          k.hover = null;
          k.snap = null;
          applyScroll();
          refreshHint();
          fire(() => cb.current.onToolDone());
          repaint();
        } else if (type === "resetView") {
          const n = times.current.length;
          if (!n) return;
          chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - VISIBLE_BARS), to: n + 5 });
          chart.priceScale("right").setAutoScale(true);
          setAuto(true);
        } else if (type === "cancelDraft") {
          setExitDrag(null);
        }
      },
      syncDrawings: (list, dk) => {
        const keyChanged = dk !== k.key;
        if (k.gesture && k.gesture.mode === "drag") abortGesture();
        k.work = list;
        k.key = dk;
        if (keyChanged) {
          if (k.gesture && k.gesture.mode === "place") abortGesture();
          k.first = null;
          k.hover = null;
          k.snap = null;
          refreshHint();
        }
        if (k.sel && (keyChanged || !list.some((d) => d.id === k.sel))) select(null);
        repaint();
      },
    };

    chartRef.current = chart;
    candleRef.current = cs;
    volRef.current = vs;
    layerRef.current = layer;
    const syncAuto = () => later(() => {
      const c = chartRef.current;
      if (c) setAuto(c.priceScale("right").options().autoScale);
    }, 0);
    const gestureEnds = ["touchend", "mouseup", "dblclick"] as const;
    for (const t of gestureEnds) el.addEventListener(t, syncAuto, true);

    // Overlay placement: every frame, read each tag's / exit's y and bump
    // the render only when something moved. Cheap (a handful of overlays)
    // and covers scroll, zoom, axis drags, autoscale and live ticks alike,
    // none of which the library reports as a price-scale event.
    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      const series = candleRef.current;
      if (!series) return;
      let changed = false;
      const next = new Map<string, number>();
      const want = overlayPrices.current;
      for (const [id, price] of want) {
        const y = series.priceToCoordinate(price);
        const v = y === null ? NaN : Math.round((y as number) * 2) / 2;
        next.set(id, v);
        const prev = posRef.current.get(id);
        if (prev === undefined || (prev !== v && !(Number.isNaN(prev) && Number.isNaN(v)))) changed = true;
      }
      if (next.size !== posRef.current.size) changed = true;
      if (changed) { posRef.current = next; setLayoutTick((n) => n + 1); }
    };
    raf = requestAnimationFrame(place);

    const timerSet = timers.current;
    return () => {
      cancelAnimationFrame(raf);
      if (unhookLinks) unhookLinks();
      for (const t of gestureEnds) el.removeEventListener(t, syncAuto, true);
      for (const [type, fn] of pointerTypes) el.removeEventListener(type, fn as EventListener, true);
      el.removeEventListener("pointerleave", onLeave as EventListener);
      window.removeEventListener("pointerup", onWindowUp);
      window.removeEventListener("pointercancel", onWindowUp);
      for (const type of legacy) el.removeEventListener(type, swallow, { capture: true });
      el.removeEventListener("contextmenu", noMenu, true);
      for (const id of timerSet) clearTimeout(id);
      timerSet.clear();
      chart.remove();
      eng.current = null;
      chartRef.current = null; candleRef.current = null; volRef.current = null; layerRef.current = null;
      lineRefs.current = [];
      shown.current = { key: "", first: 0, last: 0, histLast: 0, count: 0, rev: -1, provisional: false };
      times.current = [];
      ohlc.current = [];
      tail.current = [];
      k.gesture = null; k.block = false; k.tailEnd = false; k.pointers.clear();
    };
  }, []);

  // The prices every overlay sits at (tags at entry, exits at their price,
  // a dragged exit at its live price): the RAF above maps them to y.
  const overlayPrices = useRef<Map<string, number>>(new Map());
  {
    const m = new Map<string, number>();
    for (const t of tags) m.set("tag:" + t.id, t.entry);
    for (const x of exits) m.set("exit:" + x.id, exitDrag && exitDrag.id === x.id ? exitDrag.price : x.price);
    overlayPrices.current = m;
  }

  // ---- imperative handle ------------------------------------------------------
  useDOMImperativeHandle(ref ?? null, () => ({
    pushLive: (...args: unknown[]) => {
      const raw = args[0];
      const cs = candleRef.current, vs = volRef.current;
      if (!cs || !vs || !Array.isArray(raw) || raw.length < 6) return;
      const six = raw.slice(0, 6);
      if (!six.every((x) => typeof x === "number" && Number.isFinite(x))) return;
      const b = six as WireBar;
      const sh = shown.current;
      if (sh.count === 0) {
        cs.setData([candle(b)]); vs.setData([volume(b)]);
        sh.first = b[0]; sh.last = b[0]; sh.histLast = 0;
        times.current = []; ohlc.current = []; tail.current = [];
      } else if (b[0] < sh.last) {
        return;
      } else {
        cs.update(candle(b));
        vs.update(volume(b));
      }
      if (b[0] > sh.histLast) {
        const tl = tail.current;
        if (tl.length && tl[tl.length - 1][0] === b[0]) tl[tl.length - 1] = b; else tl.push(b);
      }
      const bar: OhlcBar = { t: b[0], o: b[1], h: b[2], l: b[3], c: b[4] };
      const n = times.current.length;
      if (n && times.current[n - 1] === b[0]) ohlc.current[n - 1] = bar;
      else { times.current.push(b[0]); ohlc.current.push(bar); }
      sh.count = times.current.length;
      sh.last = b[0];
      setLast(b);
      setMark(b[4]);
    },
    pushMark: (...args: unknown[]) => {
      const m = args[0];
      if (typeof m === "number" && Number.isFinite(m) && m > 0) setMark(m);
    },
    command: (...args: unknown[]) => {
      const c = args[0] as { type?: unknown } | null;
      const type = c && typeof c === "object" ? c.type : null;
      if (type === "deleteSelected" || type === "cancelTool" || type === "resetView" || type === "cancelDraft") eng.current?.command(type);
    },
  }), []);

  // ---- history ------------------------------------------------------------------
  useEffect(() => {
    const chart = chartRef.current, cs = candleRef.current, vs = volRef.current;
    if (!chart || !cs || !vs) return;
    const prev = shown.current;
    const keyChanged = prev.key !== seriesKey;
    if (!bars.length) {
      cs.setData([]); vs.setData([]);
      shown.current = { key: seriesKey, first: 0, last: 0, histLast: 0, count: 0, rev: histRev, provisional: false };
      times.current = [];
      ohlc.current = [];
      tail.current = [];
      older.current = { asked: false, done: false };
      setLast(null);
      layerRef.current?.invalidate();
      return;
    }
    const d = decimalsFor(bars[bars.length - 1][4]);
    cs.applyOptions({ priceFormat: { type: "price", precision: d, minMove: Math.pow(10, -d) } });
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    const histLast = bars[bars.length - 1][0];
    const keep = keyChanged ? [] : tail.current.filter((b) => b[0] > histLast);
    cs.setData(bars.map(candle));
    vs.setData(bars.map(volume));
    for (const b of keep) { cs.update(candle(b)); vs.update(volume(b)); }
    const all = bars.map((b) => b[0]);
    const allBars: OhlcBar[] = bars.map((b) => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4] }));
    for (const b of keep) { all.push(b[0]); allBars.push({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4] }); }
    const newSeries = keyChanged || prev.count === 0 || prev.histLast === 0 || prev.provisional;
    if (newSeries) {
      older.current = { asked: false, done: false };
      ts.setVisibleLogicalRange({ from: Math.max(0, all.length - VISIBLE_BARS), to: all.length + 5 });
      chart.priceScale("right").setAutoScale(true);
      setAuto(true);
    } else if (bars[0][0] < prev.first && range) {
      const added = bars.findIndex((b) => b[0] >= prev.first);
      if (added > 0) ts.setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
    }
    times.current = all;
    ohlc.current = allBars;
    tail.current = keep;
    shown.current = {
      key: seriesKey, first: bars[0][0], last: all[all.length - 1], histLast, count: all.length, rev: histRev,
      provisional: keyChanged && prev.rev === histRev,
    };
    older.current.asked = false;
    const lastBar = keep.length ? keep[keep.length - 1] : bars[bars.length - 1];
    setLast(lastBar);
    setMark(lastBar[4]);
    layerRef.current?.invalidate();
  }, [seriesKey, histRev]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- price lines (liquidation etc.) ---------------------------------------
  const linesSig = JSON.stringify(lines);
  useEffect(() => {
    const cs = candleRef.current;
    if (!cs) return;
    for (const l of lineRefs.current) cs.removePriceLine(l);
    lineRefs.current = lines.map((l) => cs.createPriceLine({
      price: l.price, color: TONE[l.tone], lineWidth: l.width, lineStyle: STYLE[l.style], axisLabelVisible: true, title: l.title,
    }));
  }, [linesSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- drawings -------------------------------------------------------------------
  useEffect(() => {
    eng.current?.syncDrawings(sanitizeDrawings(drawings), drawingsKey);
  }, [drawingsRev, drawingsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { eng.current?.setTool(isKind(tool) ? tool : null); }, [tool]);
  useEffect(() => { eng.current?.setMagnet(magnet !== false); }, [magnet]);
  useEffect(() => { eng.current?.setHidden(hideDrawings === true); }, [hideDrawings]);
  useEffect(() => { layerRef.current?.invalidate(); }, [tfSec, intraday]);

  // A dragged exit that no longer exists (confirmed and re-keyed, or
  // cancelled) ends its drag.
  const exitsSig = JSON.stringify(exits);
  useEffect(() => {
    if (exitDrag && !exits.some((x) => x.id === exitDrag.id)) setExitDrag(null);
  }, [exitsSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleAuto = () => {
    const c = chartRef.current;
    if (!c) return;
    const next = !c.priceScale("right").options().autoScale;
    c.priceScale("right").setAutoScale(next);
    setAuto(next);
  };

  // ---- exit line drag (HTML overlay, outside the chart box) -----------------
  const paneTop = (): number => {
    const rc = box.current?.getBoundingClientRect();
    return rc ? rc.top : 0;
  };
  const priceAtClientY = (clientY: number): number | null => {
    const cs = candleRef.current, chart = chartRef.current;
    if (!cs || !chart) return null;
    const sz = chart.paneSize(0);
    const y = Math.max(0, Math.min(clientY - paneTop(), sz.height - 1));
    const p = cs.coordinateToPrice(y);
    return p === null ? null : (p as number);
  };
  const startExitDrag = (x: ChartExit, e: React.PointerEvent<HTMLDivElement>) => {
    if (x.locked || x.pending) return;   // the store would refuse the move: do not start one
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try { (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); } catch { /* fine */ }
    setExitDrag({ id: x.id, pid: e.pointerId, y: e.clientY, price: x.price });
  };
  const moveExitDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!exitDrag || e.pointerId !== exitDrag.pid) return;
    const p = priceAtClientY(e.clientY);
    if (p !== null && p > 0) setExitDrag({ ...exitDrag, y: e.clientY, price: p });
  };
  const endExitDrag = (x: ChartExit, e: React.PointerEvent<HTMLDivElement>) => {
    if (!exitDrag || e.pointerId !== exitDrag.pid) return;
    const p = priceAtClientY(e.clientY) ?? exitDrag.price;
    const moved = Math.abs(e.clientY - exitDrag.y) > DRAG_SLOP || x.draft;
    setExitDrag(null);
    // A draft is sent on release wherever it lands; an existing line only
    // when it actually moved.
    // Six significant digits: enough for every venue tick, never a float tail.
    if (moved && p > 0) fire(() => cb.current.onExitRelease(x.id, x.tagId, x.kind, +p.toPrecision(6)));
  };

  // ---- render -------------------------------------------------------------------
  void layoutTick;
  const L = legend ?? last;
  const chg = L ? (L[4] - L[1]) / L[1] * 100 : null;
  const dp = L ? decimalsFor(L[4]) : 2;
  const sz = chartRef.current?.paneSize(0);
  const paneW = sz?.width ?? 0;
  const paneH = sz?.height ?? height;
  // Overlays sit inside the pane, left of the price axis.
  const axisW = chartRef.current ? chartRef.current.priceScale("right").width() : AUTO_CORNER_W;
  const rightEdge = axisW + 4;
  const yOf = (id: string): number | null => { const y = posRef.current.get(id); return y === undefined || Number.isNaN(y) ? null : y; };
  const big = touch.current;
  const tagH = big ? 40 : 28;
  const btnW = big ? 40 : 30;

  // Tags that would overlap stack downward in entry order.
  const tagRows: { tag: ChartTag; y: number }[] = [];
  for (const t of [...tags].sort((a, b) => b.entry - a.entry)) {
    const y0 = yOf("tag:" + t.id);
    if (y0 === null) continue;
    let y = Math.max(tagH / 2, Math.min(paneH - tagH / 2, y0));
    for (const r of tagRows) if (Math.abs(r.y - y) < tagH + 2) y = r.y + tagH + 2;
    tagRows.push({ tag: t, y });
  }

  return (
    <div ref={wrap} style={{ position: "relative", width: "100%", height, background: C.bg, overflow: "hidden", touchAction: "none", userSelect: "none", WebkitUserSelect: "none", fontFamily: FONT }}>
      <div ref={box} style={{ position: "absolute", inset: 0, touchAction: "none" }} />
      {L ? (
        <div style={{ position: "absolute", top: 4, left: 6, zIndex: 3, pointerEvents: "none", fontSize: 11, color: C.muted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {"O " + L[1].toFixed(dp) + "  H " + L[2].toFixed(dp) + "  L " + L[3].toFixed(dp) + "  C "}
          <span style={{ color: L[4] >= L[1] ? C.bull : C.bear }}>{L[4].toFixed(dp) + (chg !== null && Number.isFinite(chg) ? "  " + (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%" : "")}</span>
        </div>
      ) : null}
      {hint ? (
        <div style={{ position: "absolute", top: 22, left: 6, zIndex: 3, pointerEvents: "none", fontSize: 11, color: C.accentText, background: C.accentBg, border: "1px solid " + C.accentBorder, borderRadius: 5, padding: "2px 6px", whiteSpace: "nowrap" }}>
          {hint}
        </div>
      ) : null}

      {/* Exit lines: a full-width line with a label handle at the right.
          Dashed while pending or a draft; drag anywhere on the handle. */}
      {exits.map((x) => {
        const dragging = exitDrag && exitDrag.id === x.id;
        const y = yOf("exit:" + x.id);
        if (y === null) return null;
        const color = x.kind === "tp" ? C.bull : C.bear;
        const price = dragging ? exitDrag.price : x.price;
        const tag = tags.find((t) => t.id === x.tagId);
        const pnl = tag && mark !== null ? ((price - tag.entry) * (tag.side === "long" ? 1 : -1) * tag.size) : x.pnl;
        const dashed = x.pending || x.draft || !!dragging;
        return (
          <div key={x.id} style={{ position: "absolute", left: 0, top: y, width: paneW || "100%", height: 0, zIndex: 7, pointerEvents: "none" }}>
            <div style={{ position: "absolute", left: 0, right: 0, top: -0.5, borderTop: (dashed ? "1px dashed " : "1px solid ") + color, opacity: dashed ? 0.7 : 0.9 }} />
            <div
              onPointerDown={(e) => startExitDrag(x, e)}
              onPointerMove={moveExitDrag}
              onPointerUp={(e) => endExitDrag(x, e)}
              onPointerCancel={() => setExitDrag(null)}
              style={{
                position: "absolute", left: 8, top: -(big ? 20 : 12), height: big ? 40 : 24, display: "flex", alignItems: "center", gap: 6, padding: "0 8px",
                background: "rgba(20,24,30,0.86)", border: (dashed ? "1px dashed " : "1px solid ") + color, borderRadius: 6, color, fontSize: 11,
                fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", pointerEvents: "auto", cursor: x.locked || x.pending ? "default" : "ns-resize", touchAction: "none", opacity: x.pending ? 0.65 : 1,
              }}
            >
              <span style={{ fontWeight: 600 }}>{x.kind.toUpperCase()}</span>
              <span>{price.toFixed(decimalsFor(price))}</span>
              <span style={{ color: pnl !== null && pnl >= 0 ? C.bull : C.bear }}>{usd(pnl)}</span>
              {x.pending ? <span style={{ color: C.muted }}>pending</span> : null}
              {x.locked && !x.pending && !x.draft ? <span style={{ color: C.muted }}>waiting</span> : null}
              {x.draft ? <span style={{ color: C.muted }}>drag, release to send</span> : null}
              {!x.draft && !x.pending ? (
                <button
                  type="button"
                  aria-label={"Cancel " + x.kind}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); fire(() => cb.current.onExitCancel(x.id)); }}
                  style={{ border: "none", background: "transparent", color: C.muted, fontSize: 13, cursor: "pointer", padding: big ? "8px 6px" : "0 2px", lineHeight: 1 }}
                >
                  x
                </button>
              ) : null}
            </div>
          </div>
        );
      })}

      {/* Position tags at the entry price: [venue | side size | PnL | TP | SL | reverse | X] */}
      {tagRows.map(({ tag: t, y }) => {
        const dir = t.side === "long" ? 1 : -1;
        const pnl = mark !== null ? (mark - t.entry) * dir * t.size : t.pnl;
        const pnlColor = pnl === null ? C.muted : pnl >= 0 ? C.bull : C.bear;
        const sideColor = t.side === "long" ? C.bull : C.bear;
        const dim = t.pending !== null;
        const btn = (label: string, action: "tp" | "sl" | "reverse" | "close", color: string, aria: string) => {
          // TP / SL / Rev wait for an unsettled write on the market; X never does.
          const waits = t.locked && action !== "close";
          const off = dim || !canTrade || waits;
          return (
            <button
              type="button"
              aria-label={aria + (waits ? " (waiting for an unsettled write)" : "")}
              disabled={off}
              onClick={(e) => { e.stopPropagation(); fire(() => cb.current.onTagAction(t.id, action)); }}
              style={{
                minWidth: btnW, height: tagH - 2, border: "none", borderLeft: "1px solid " + C.border, background: "transparent", color,
                fontSize: 11, fontWeight: 600, cursor: off ? "default" : "pointer", padding: "0 6px", opacity: !canTrade || waits ? 0.4 : 1,
              }}
            >
              {label}
            </button>
          );
        };
        return (
          <div
            key={t.id}
            style={{
              position: "absolute", right: rightEdge, top: y - tagH / 2, height: tagH, zIndex: 6, display: "flex", alignItems: "center",
              background: "rgba(20,24,30,0.86)", border: (dim ? "1px dashed " : "1px solid ") + sideColor, borderRadius: 7,
              color: C.text, fontSize: 11, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", opacity: dim ? 0.6 : 1, pointerEvents: "auto",
            }}
          >
            <div style={{ position: "absolute", right: "100%", top: tagH / 2 - 0.5, width: 4000, borderTop: (dim ? "1px dashed " : "1px solid ") + sideColor, opacity: 0.45, pointerEvents: "none" }} />
            <span style={{ padding: "0 7px", fontWeight: 600, color: t.venue === "hl" ? C.accentText : C.warn }}>{t.venue === "hl" ? "HL" : "MFP"}</span>
            <span style={{ padding: "0 6px 0 0", color: sideColor, fontWeight: 600 }}>{(t.side === "long" ? "L " : "S ") + t.size}</span>
            <span style={{ padding: "0 7px", borderLeft: "1px solid " + C.border, color: pnlColor, fontWeight: 600 }}>{usd(pnl)}</span>
            {dim ? <span style={{ padding: "0 7px", borderLeft: "1px solid " + C.border, color: C.warn }}>{t.pending}</span> : null}
            {btn("TP", "tp", t.hasTp ? C.bull : C.muted, "Take profit for " + t.id)}
            {btn("SL", "sl", t.hasSl ? C.bear : C.muted, "Stop loss for " + t.id)}
            {btn("Rev", "reverse", C.info, "Reverse " + t.id)}
            {btn("X", "close", C.bear, "Close " + t.id)}
          </div>
        );
      })}

      {last ? (
        <button
          type="button"
          onClick={toggleAuto}
          aria-pressed={auto}
          aria-label={auto ? "Price scale: auto fit on" : "Price scale: manual, tap to auto fit"}
          style={{
            position: "absolute", right: 3, bottom: 3, zIndex: 3, width: AUTO_CORNER_W - 6, height: 19, padding: 0,
            borderRadius: 5, border: "1px solid " + (auto ? "rgba(0,220,130,0.35)" : C.border),
            background: auto ? C.bullBg : C.card, color: auto ? C.bull : C.muted, fontFamily: FONT,
            fontSize: 10.5, fontWeight: 600, letterSpacing: 0.6, cursor: "pointer", WebkitTapHighlightColor: "transparent",
          }}
        >
          AUTO
        </button>
      ) : null}
    </div>
  );
}
