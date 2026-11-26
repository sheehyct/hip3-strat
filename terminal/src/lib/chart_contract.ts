// The chart ENGINE contract: candles and drawings, plus what a trading
// terminal needs - position tags, TP / SL exit lines, the strong magnet
// and the hide-drawings toggle. One engine implements it today
// (src/components/engines/lwc-engine.tsx, Lightweight Charts); another
// engine can drop in behind the same props.
//
// The native side (src/components/market-chart.tsx) owns ALL data -
// candles, the live stream, positions, orders, drawings persistence - and
// never knows which engine renders. An engine only DRAWS what it is given
// and reports user actions back. No network, no keys, no storage inside an
// engine.
//
// Bridge discipline (Android re-sends EVERY prop on every parent render):
// - live ticks arrive through the imperative handle (pushLive), never props;
// - history redraws only when histRev / seriesKey change, drawings only when
//   drawingsRev / drawingsKey change, lines / tags / exits only when their
//   JSON content changes - never on array identity;
// - each mounted engine gets its OWN ref (see market-chart MountedChart).
import type { Ref } from "react";
import type { DOMImperativeFactory, DOMProps } from "expo/dom";

import type { ChartLine, WireBar } from "./candles";
import type { Drawing, DrawingKind } from "./drawings";

// A position on this chart's coin: one tag at its entry price.
export type ChartTag = {
  id: string;             // the position key ("hl:BTC", "mfp:binance|ETHUSDT")
  venue: "hl" | "mfp";
  side: "long" | "short";
  entry: number;
  size: number;
  pnl: number | null;     // unrealized USD
  pnlPct: number | null;  // return on margin, percent
  pending: string | null; // text while a write on this position is in flight (dimmed tag)
  // An earlier write on this market is not settled: TP, SL and Rev wait (the
  // store refuses them); X never does.
  locked: boolean;
  hasTp: boolean;
  hasSl: boolean;
};

// A TP / SL line: draggable; dashed while pending.
export type ChartExit = {
  id: string;             // order key, or "draft:<posId>:<kind>" for a line being placed
  tagId: string;          // the position it belongs to
  venue: "hl" | "mfp";
  kind: "tp" | "sl";
  price: number;
  pnl: number | null;     // dollar PnL of the position at this level
  pending: boolean;
  draft: boolean;         // placed by a tag tap, not sent until released
  locked: boolean;        // not draggable now (an unsettled write on the market); its x still cancels
};

export type TagAction = "tp" | "sl" | "reverse" | "close";

// Native -> engine commands (bridge arguments arrive as untyped JSON; the
// engine validates). Unknown commands are ignored.
export type EngineCommand =
  | { type: "deleteSelected" }   // remove the selected drawing (then onDrawingsChange)
  | { type: "cancelTool" }       // abandon a half-placed drawing (then onToolDone)
  | { type: "resetView" }        // latest bars, autoscale on
  | { type: "cancelDraft" };     // drop a TP / SL line that was being placed

export interface ChartEngineHandle extends DOMImperativeFactory {
  // One WireBar [t, o, h, l, c, v]: the forming bar (replace when t equals
  // the last bar's time, append when newer, ignore when older).
  pushLive: (...args: unknown[]) => void;
  // Live mark for the tags' PnL between polls: pushMark(markPx).
  pushMark: (...args: unknown[]) => void;
  command: (...args: unknown[]) => void;
}

export type ChartEngineProps = {
  ref?: Ref<ChartEngineHandle>;

  // ---- data ----
  seriesKey: string;        // coin|tf; a change resets the view to the latest bars
  histRev: number;          // bumped by native whenever `bars` changes
  bars: WireBar[];          // ascending, one per bar-open time (UTC seconds)
  lines: ChartLine[];       // liquidation lines and the like (display only)
  intraday: boolean;        // tick labels: ET clock for intraday, UTC date for daily
  tfSec: number;            // bar length in seconds
  height: number;

  // ---- positions and exits ----
  tags: ChartTag[];
  exits: ChartExit[];
  canTrade: boolean;        // false = tags show no action buttons (no key / read-only)

  // ---- drawings (src/lib/drawings.ts schema; display-only user annotations) ----
  drawingsKey: string;      // exact chart coin id ("xyz:NVDA"); one set per coin, shared across TFs
  drawingsRev: number;      // bumped by native when the set changes from OUTSIDE the engine
  drawings: Drawing[];      // the authoritative set as of drawingsRev
  tool: DrawingKind | null; // armed tool from the native toolbar; null = navigate / select
  magnet: boolean;          // strong magnet: every point snaps to the nearest O/H/L/C
  hideDrawings: boolean;    // hide every drawing (and ignore drawing gestures)

  // ---- engine -> native (async native actions; top-level function props only) ----
  onDrawingsChange: (drawingsKey: string, drawings: Drawing[]) => Promise<void>;
  onToolDone: () => Promise<void>;
  onSelect: (id: string | null) => Promise<void>;
  onNeedOlder: (oldestSec: number, seriesKey: string) => Promise<boolean>;
  onOpenLink: (href: string) => Promise<void>;
  // A tag button: tp / sl (drop a draft line), reverse, close (X = full close).
  onTagAction: (tagId: string, action: TagAction) => Promise<void>;
  // A TP / SL line released at a price: a draft becomes an order, an
  // existing line a modify. The engine shows it dashed until the venue
  // confirms (the native side re-sends `exits`).
  onExitRelease: (exitId: string, tagId: string, kind: "tp" | "sl", price: number) => Promise<void>;
  // The small X on an existing exit line.
  onExitCancel: (exitId: string) => Promise<void>;

  dom?: DOMProps;
};
