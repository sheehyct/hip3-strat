// The user-drawing layer for the Lightweight Charts engine: ONE series
// primitive whose pane view draws every drawing (hline, hray, xline, info),
// the selection handles, the half-placed draft, the placement guide and the
// magnet's snap dot on the canvas, and offers the coordinate mapper and the
// hit tests the engine's input layer needs.
//
// Everything is derived from absolute (t, p) points through
// logicalForTime + timeScale().logicalToCoordinate (timeToCoordinate returns
// null for a non-bar time). logicalToCoordinate answers for integer
// logicals only (a fractional logical returns 0 - undocumented), so x is
// derived from the integer probe plus the bar spacing.
//
// No network, no storage, no keys. Display only.
import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneRenderer, IPrimitivePaneView, SeriesAttachedParameter, SeriesType, Time } from "lightweight-charts";

import { decimalsFor } from "@/lib/candles";
import {
  clipInfiniteLine, distToSegment, DRAW_COLOR, DRAW_SELECTED_COLOR, fmtSignedPct, fmtSpan, HIT_PX, infoStats, logicalForTime,
  POINTS_NEEDED, timeForLogical,
} from "@/lib/drawings";
import type { Drawing, DrawingKind, DrawPoint } from "@/lib/drawings";
import { C } from "@/theme";

export { decimalsFor };

export type Grab = "body" | number;

export type LayerState = {
  drawings: Drawing[];
  selected: string | null;
  draft: { kind: DrawingKind; pts: DrawPoint[] } | null;   // the half-placed drawing (A, maybe a hover B)
  guide: DrawPoint | null;                                 // where the next point would land
  snap: DrawPoint | null;                                  // the magnet's grabbed OHLC point (a dot)
  hidden: boolean;
  times: number[];
  tfSec: number;
  fmtTime: (t: number) => string;
};

export type Mapper = {
  bs: number;                                  // bar spacing, px per logical
  lOfT: (t: number) => number | null;
  tOfL: (l: number) => number | null;
  xOfL: (l: number) => number | null;
  lOfX: (x: number) => number | null;
  xOfT: (t: number) => number | null;
  tOfX: (x: number) => number | null;
  yOfP: (p: number) => number | null;
  pOfY: (y: number) => number | null;
};

type Scope = { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } };
type Target = { useMediaCoordinateSpace: (f: (scope: Scope) => void) => void };

const HANDLE_R = 6;
const LABEL_BG = "rgba(20,24,30,0.92)";
const FONT = "10.5px system-ui, sans-serif";

export class DrawingLayer implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private view: IPrimitivePaneView;

  constructor(private readonly state: () => LayerState) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target as unknown as Target) };
    this.view = { zOrder: () => "top", renderer: () => renderer };
  }

  attached(p: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = p.chart as unknown as IChartApi;
    this.series = p.series;
    this.requestUpdate = p.requestUpdate;
  }
  detached(): void {
    this.chart = null; this.series = null; this.requestUpdate = null;
  }
  paneViews(): readonly IPrimitivePaneView[] { return [this.view]; }
  updateAllViews(): void { /* state is read at draw time */ }
  invalidate(): void { this.requestUpdate?.(); }

  mapper(): Mapper | null {
    const chart = this.chart, series = this.series;
    if (!chart || !series) return null;
    const s = this.state();
    const ts = chart.timeScale();
    const bs = ts.options().barSpacing;
    const times = s.times, tfSec = s.tfSec;
    const xOfL = (l: number): number | null => {
      if (!Number.isFinite(l)) return null;
      const i = Math.floor(l);
      const x0 = ts.logicalToCoordinate(i as never);
      if (x0 === null) return null;
      return (x0 as number) + (l - i) * bs;
    };
    const lOfX = (x: number): number | null => {
      const l = ts.coordinateToLogical(x);
      return l === null ? null : (l as number);
    };
    const lOfT = (t: number) => logicalForTime(times, t, tfSec);
    const tOfL = (l: number) => timeForLogical(times, l, tfSec);
    return {
      bs, lOfT, tOfL, xOfL, lOfX,
      xOfT: (t) => { const l = lOfT(t); return l === null ? null : xOfL(l); },
      tOfX: (x) => { const l = lOfX(x); return l === null ? null : tOfL(l); },
      yOfP: (p) => { const y = series.priceToCoordinate(p); return y === null ? null : (y as number); },
      pOfY: (y) => { const p = series.coordinateToPrice(y); return p === null ? null : (p as number); },
    };
  }

  // Pixel distance between two drawing points (a two-point tool refuses B
  // on top of A).
  pixelGap(a: DrawPoint, b: DrawPoint): number | null {
    const m = this.mapper();
    if (!m) return null;
    const ax = m.xOfT(a.t), ay = m.yOfP(a.p), bx = m.xOfT(b.t), by = m.yOfP(b.p);
    if (ax === null || ay === null || bx === null || by === null) return null;
    return Math.hypot(ax - bx, ay - by);
  }

  // Segments (in pane px) a drawing occupies, for hit tests and drawing.
  private geometry(d: { kind: DrawingKind; pts: DrawPoint[] }, m: Mapper, w: number, h: number): { segs: [number, number, number, number][]; pts: [number, number][] } | null {
    const pts: [number, number][] = [];
    for (const q of d.pts) {
      const x = m.xOfT(q.t), y = m.yOfP(q.p);
      if (x === null || y === null) return null;
      pts.push([x, y]);
    }
    if (!pts.length) return null;
    const segs: [number, number, number, number][] = [];
    if (d.kind === "hline") segs.push([0, pts[0][1], w, pts[0][1]]);
    else if (d.kind === "hray") segs.push([pts[0][0], pts[0][1], w, pts[0][1]]);
    else if (pts.length === 2) {
      if (d.kind === "xline") {
        const c = clipInfiniteLine(pts[0][0], pts[0][1], pts[1][0], pts[1][1], w, h);
        if (c) segs.push(c);
      } else {
        segs.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1]]);
      }
    }
    return { segs, pts };
  }

  private size(): { w: number; h: number } {
    const sz = this.chart?.paneSize(0);
    return { w: sz?.width ?? 0, h: sz?.height ?? 0 };
  }

  // The drawing under (x, y), newest on top.
  pick(x: number, y: number): string | null {
    const s = this.state();
    if (s.hidden) return null;
    const m = this.mapper();
    if (!m) return null;
    const { w, h } = this.size();
    for (let i = s.drawings.length - 1; i >= 0; i--) {
      const d = s.drawings[i];
      const g = this.geometry(d, m, w, h);
      if (!g) continue;
      for (const q of g.pts) if (Math.hypot(x - q[0], y - q[1]) <= HIT_PX) return d.id;
      for (const seg of g.segs) if (distToSegment(x, y, seg[0], seg[1], seg[2], seg[3]) <= HIT_PX) return d.id;
    }
    return null;
  }

  // What part of a selected drawing a press grabs: a handle (point index)
  // or the body.
  grab(d: Drawing, x: number, y: number): Grab | null {
    const m = this.mapper();
    if (!m) return null;
    const { w, h } = this.size();
    const g = this.geometry(d, m, w, h);
    if (!g) return null;
    for (let i = 0; i < g.pts.length; i++) if (Math.hypot(x - g.pts[i][0], y - g.pts[i][1]) <= HIT_PX) return i;
    for (const seg of g.segs) if (distToSegment(x, y, seg[0], seg[1], seg[2], seg[3]) <= HIT_PX) return "body";
    return null;
  }

  private draw(target: Target): void {
    const s = this.state();
    if (s.hidden) return;
    const m = this.mapper();
    if (!m) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const w = mediaSize.width, h = mediaSize.height;
      ctx.save();
      ctx.lineCap = "round";
      ctx.font = FONT;
      for (const d of s.drawings) this.drawOne(ctx, d, d.id === s.selected, false, m, w, h, s);
      if (s.draft) this.drawOne(ctx, { id: "draft", kind: s.draft.kind, pts: s.draft.pts, color: null, at: 0 }, false, true, m, w, h, s);
      if (s.guide) {
        const x = m.xOfT(s.guide.t), y = m.yOfP(s.guide.p);
        if (x !== null && y !== null) {
          ctx.strokeStyle = "rgba(255,255,255,0.35)";
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      if (s.snap) {
        // The magnet's grabbed OHLC point: a small filled dot with a ring.
        const x = m.xOfT(s.snap.t), y = m.yOfP(s.snap.p);
        if (x !== null && y !== null) {
          ctx.fillStyle = DRAW_SELECTED_COLOR;
          ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = DRAW_COLOR; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
        }
      }
      ctx.restore();
    });
  }

  private drawOne(ctx: CanvasRenderingContext2D, d: Drawing, selected: boolean, draft: boolean, m: Mapper, w: number, h: number, s: LayerState): void {
    const g = this.geometry(d, m, w, h);
    if (!g) return;
    const color = selected ? DRAW_SELECTED_COLOR : d.color ?? DRAW_COLOR;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(draft ? [5, 4] : []);
    for (const seg of g.segs) { ctx.beginPath(); ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]); ctx.stroke(); }
    ctx.setLineDash([]);
    // A one-point draft or the first point of a two-point tool: a dot.
    if (draft && g.pts.length < POINTS_NEEDED[d.kind] || (draft && (d.kind === "hline" || d.kind === "hray"))) {
      ctx.beginPath(); ctx.arc(g.pts[0][0], g.pts[0][1], 3, 0, Math.PI * 2); ctx.fill();
    }
    // Price label at the right edge for horizontal tools.
    if (d.kind === "hline" || d.kind === "hray") {
      const p = d.pts[0].p;
      const text = p.toFixed(decimalsFor(p));
      this.label(ctx, text, w - 4, g.pts[0][1], "right", color);
    }
    if (d.kind === "info" && d.pts.length === 2) {
      const st = infoStats(d.pts[0], d.pts[1], s.tfSec);
      const dp = decimalsFor(Math.max(d.pts[0].p, d.pts[1].p));
      const pct = fmtSignedPct(st.dPct);
      const text = (st.dPrice >= 0 ? "+" : "") + st.dPrice.toFixed(dp) + " (" + pct + ")  " + (st.bars ?? "-") + " bars, " + fmtSpan(st.seconds);
      const tone = st.dPct === null || st.dPct === 0 ? C.muted : st.dPct > 0 ? C.bull : C.bear;
      const bx = g.pts[1][0], by = g.pts[1][1];
      this.label(ctx, text, Math.min(w - 4, bx + 8), by - 10, "left", tone);
    }
    if (selected) {
      for (const q of g.pts) {
        ctx.beginPath(); ctx.arc(q[0], q[1], HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle = C.bg; ctx.fill();
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = color;
      }
    }
  }

  private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: "left" | "right", color: string): void {
    const padX = 5, hgt = 16;
    const tw = ctx.measureText(text).width;
    const bw = tw + padX * 2;
    const bx = align === "right" ? x - bw : x;
    const by = y - hgt / 2;
    ctx.fillStyle = LABEL_BG;
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(bx, by, bw, hgt);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(text, bx + padX, y);
  }
}
