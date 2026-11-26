// The chart panel, engine-agnostic. It owns everything AROUND the engine:
// - data: candles + the live forming bar (chart-data.ts), the live mark
//   pushed to the engine for tag PnL between polls;
// - positions on this coin from BOTH venues as tags, their TP / SL as exit
//   lines, their liquidation prices and every other working order on the
//   coin as price lines (venue_store);
// - the user's drawings: read from drawings_store, written back from the
//   engine's reports, cleared from the toolbar; the magnet and hide
//   toggles (settings);
// - the timeframe chips and the toolbar placement (left edge on desktop,
//   below the chart on the phone).
//
// Tag actions and exit drags go straight to venue_store's write path (X =
// full close, reverse, tp / sl). The one-click panel sits beside it; the
// draft exit lines live here (draftExits).
//
// Bridge discipline: the engine element is memoized on stable props, live
// bars and marks go through the imperative handle, `bars` changes only on
// a history snapshot (histRev), drawings only on a drawingsRev bump, tags /
// exits / lines only when their JSON content changes. One engine mounted
// per panel, with its own ref (MountedChart).
import * as WebBrowser from "expo-web-browser";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useChartData } from "@/components/chart-data";
import { ChartToolbar } from "@/components/chart-toolbar";
import LwcEngine from "@/components/engines/lwc-engine";
import { IconButton } from "@/components/kit";
import { CHART_TFS, ChartLine, dedupeLines, liquidationLine, orderLine, tfSpec, WireBar } from "@/lib/candles";
import type { ChartEngineHandle, ChartEngineProps, ChartExit, ChartTag, EngineCommand, TagAction } from "@/lib/chart_contract";
import type { Drawing, DrawingKind } from "@/lib/drawings";
import { clearDrawings, drawingsSnapshot, replaceDrawings, saveFromEngine, subscribeDrawings } from "@/lib/drawings_store";
import { fmtTimeET } from "@/lib/fmt";
import { defaultExitLevel, pnlAt } from "@/lib/order_policy";
import { getSettings, subscribeSettings, updateSettings } from "@/lib/settings_store";
import { midOf, subscribeTicker, tickerState } from "@/lib/ticker_store";
import type { Position } from "@/lib/types";
import { cancelExit, closePosition, exitsFor, marketLocks, reversePosition, setExit, subscribeVenues, venueState } from "@/lib/venue_store";
import { C, F, T } from "@/theme";

const NO_LINES: ChartLine[] = [];
const EngineView = memo(LwcEngine);
type EngineViewProps = Omit<ChartEngineProps, "ref">;

// One mounted chart with a ref of its own. Expo's native DOM wrapper binds
// an object ref to the WebView that first renders with it and never
// rebinds it (seen on a device, 2026-10-25): a shared ref sends every
// live tick to a dead WebView after a remount. The caller keys each
// MountedChart by placement, so a remount always gets a fresh ref.
function MountedChart({ onMount, ...props }: EngineViewProps & { onMount: (h: ChartEngineHandle | null) => () => void }) {
  const ref = useRef<ChartEngineHandle>(null);
  useEffect(() => onMount(ref.current), [onMount]);
  return <EngineView ref={ref} {...props} />;
}

async function openLink(href: string): Promise<void> {
  if (typeof href === "string" && /^https:\/\//.test(href)) await WebBrowser.openBrowserAsync(href);
}

export type MarketChartProps = {
  coin: string | null;            // EXACT Hyperliquid coin id to chart; null = no source
  sourceNote: string | null;
  height: number;
  phone: boolean;                 // phone layout: toolbar below the chart, bigger targets
  canTrade: boolean;
  onConfirmClose?: (p: Position) => void;   // phone / one-click-off: ask before a full close? (closing is always one tap: unused today)
};

export function MarketChart({ coin, sourceNote, height, phone, canTrade }: MarketChartProps) {
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const venues = useSyncExternalStore(subscribeVenues, venueState);
  const ticker = useSyncExternalStore(subscribeTicker, tickerState);
  const tf = settings.tf;
  const spec = tfSpec(tf);
  const tfSec = spec.ms / 1000;
  const chartRef = useRef<ChartEngineHandle | null>(null);
  const pushLive = useCallback((b: WireBar) => { chartRef.current?.pushLive?.(b); }, []);
  const { key, bars, rev, status, error, live, reconnectedAt, loadOlder, retry, resend } = useChartData(coin, tf, pushLive);
  const mountChart = useCallback((h: ChartEngineHandle | null) => {
    chartRef.current = h;
    resend();
    return () => { if (chartRef.current === h) chartRef.current = null; };
  }, [resend]);
  const command = useCallback((type: EngineCommand["type"]) => { chartRef.current?.command?.({ type }); }, []);

  // The live mark for tag PnL between venue polls.
  const mark = midOf(coin);
  useEffect(() => { if (mark !== null) chartRef.current?.pushMark?.(mark); }, [mark]);

  // ---- positions on this coin -> tags, exits, liquidation lines ----
  const positions = useMemo(() => (coin ? venues.positions.filter((p) => p.chartCoin === coin) : []), [venues.positions, coin]);
  const [drafts, setDrafts] = useState<ChartExit[]>([]);   // TP / SL lines being placed
  const tags = useMemo<ChartTag[]>(() => positions.map((p) => {
    // The tag dims (and its X waits) only while a write is IN FLIGHT: one
    // the venue has not settled yet must not lock the close.
    const pend = venues.pending.find((x) => x.state === "working" && x.venue === p.venue && x.marketId === p.marketId);
    const ex = exitsFor(p);
    return {
      id: p.key, venue: p.venue, side: p.side, entry: p.entry, size: p.size, pnl: p.pnl,
      pnlPct: p.pnl !== null && p.marginUsed ? (p.pnl / p.marginUsed) * 100 : null,
      pending: pend ? pend.text : null, hasTp: !!ex.tp, hasSl: !!ex.sl,
      // The store refuses TP / SL / Rev while an earlier write on the market
      // is unsettled; the tag shows it instead of taking a tap that does nothing.
      locked: marketLocks(venues.pending, p.venue, p.marketId).open,
    };
  }), [positions, venues.pending, venues.orders]); // eslint-disable-line react-hooks/exhaustive-deps
  const exits = useMemo<ChartExit[]>(() => {
    const out: ChartExit[] = [];
    for (const p of positions) {
      const ex = exitsFor(p);
      const px = p.mark ?? p.entry;
      const locked = marketLocks(venues.pending, p.venue, p.marketId).open;
      for (const kind of ["tp", "sl"] as const) {
        const o = ex[kind];
        if (!o) continue;
        const pend = venues.pending.some((x) => x.orderKey === o.key);
        out.push({ id: o.key, tagId: p.key, venue: p.venue, kind, price: o.price, pnl: pnlAt(p.side, p.size, p.entry, o.price), pending: pend, draft: false, locked });
      }
      void px;
    }
    // A pending placement (no order on the venue yet) shows as a dashed line at its price.
    for (const pd of venues.pending) {
      if ((pd.kind !== "tp" && pd.kind !== "sl") || pd.orderKey || pd.price === null || !pd.posKey) continue;
      const p = positions.find((x) => x.key === pd.posKey);
      if (!p) continue;
      out.push({ id: "pending:" + pd.id, tagId: p.key, venue: p.venue, kind: pd.kind, price: pd.price, pnl: pnlAt(p.side, p.size, p.entry, pd.price), pending: true, draft: false, locked: true });
    }
    return [...out, ...drafts.filter((d) => positions.some((p) => p.key === d.tagId))];
  }, [positions, venues.orders, venues.pending, drafts]); // eslint-disable-line react-hooks/exhaustive-deps
  // Price lines: each position's liquidation, and every working order on
  // this coin that is not already an exit line above (a resting limit was
  // on the venue's chart and not on this one: live MFP, 2026-11-17).
  const lines = useMemo(() => {
    const label = (v: "hl" | "mfp") => (v === "hl" ? "HL" : "MFP");
    const out = positions.flatMap((p) => liquidationLine(p.liq, label(p.venue) + " liq"));
    if (coin) {
      const drawn = new Set(exits.map((e) => e.id));
      for (const o of venues.orders) {
        if (drawn.has(o.key)) continue;
        const mk = venues.markets.find((x) => x.venue === o.venue && x.id === o.marketId);
        if (!mk || mk.chartCoin !== coin) continue;
        out.push(...orderLine(o, label(o.venue), o.status === "pending" || venues.pending.some((x) => x.orderKey === o.key)));
      }
    }
    return dedupeLines(out);
  }, [positions, exits, venues.orders, venues.markets, venues.pending, coin]);

  const onTagAction = useCallback(async (tagId: string, action: TagAction) => {
    if (typeof tagId !== "string") return;
    const p = venueState().positions.find((x) => x.key === tagId);
    if (!p) return;
    if (action === "close") { closePosition(tagId, 1); return; }
    if (action === "reverse") { reversePosition(tagId); return; }
    if (action === "tp" || action === "sl") {
      const existing = exitsFor(p)[action];
      if (existing) return;   // the line is already on the chart: drag it
      const price = defaultExitLevel(action, p.side, p.entry);
      const id = "draft:" + tagId + ":" + action;
      setDrafts((d) => [...d.filter((x) => x.id !== id), { id, tagId, venue: p.venue, kind: action, price, pnl: pnlAt(p.side, p.size, p.entry, price), pending: false, draft: true, locked: false }]);
    }
  }, []);
  const onExitRelease = useCallback(async (exitId: string, tagId: string, kind: "tp" | "sl", price: number) => {
    if (typeof exitId !== "string" || typeof tagId !== "string" || (kind !== "tp" && kind !== "sl") || typeof price !== "number" || !(price > 0)) return;
    setDrafts((d) => d.filter((x) => x.id !== exitId));
    setExit(tagId, kind, price);
  }, []);
  const onExitCancel = useCallback(async (exitId: string) => {
    if (typeof exitId !== "string") return;
    if (exitId.startsWith("draft:")) { setDrafts((d) => d.filter((x) => x.id !== exitId)); return; }
    const o = venueState().orders.find((x) => x.key === exitId);
    if (!o) return;
    const p = venueState().positions.find((x) => x.venue === o.venue && x.marketId === o.marketId);
    if (!p || (o.kind !== "tp" && o.kind !== "sl")) return;
    cancelExit(p.key, o.kind);
  }, []);
  const cancelDrafts = useCallback(() => { setDrafts([]); command("cancelDraft"); }, [command]);

  // ---- drawings ----
  const dr = useSyncExternalStore(subscribeDrawings, () => drawingsSnapshot(coin));
  const ctx = (coin ?? "") + "|" + (phone ? "phone" : "desk");
  const [toolCtx, setToolCtx] = useState(ctx);
  const [tool, setTool] = useState<DrawingKind | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  if (toolCtx !== ctx) { setToolCtx(ctx); setTool(null); setSelected(null); }
  const ctxRef = useRef(ctx);
  useEffect(() => { ctxRef.current = ctx; }, [ctx]);
  const onDrawingsChange = useCallback(async (k: string, list: Drawing[]) => {
    if (typeof k !== "string" || !k || k.length > 64) return;
    if (ctxRef.current === ctx) saveFromEngine(k, list);
    else replaceDrawings(k, list);
  }, [ctx]);
  const onToolDone = useCallback(async () => { setTool(null); }, []);
  const onSelect = useCallback(async (id: string | null) => { setSelected(typeof id === "string" && id ? id : null); }, []);
  const pickTool = useCallback((next: DrawingKind | null) => {
    if (next === null) command("cancelTool");
    setTool(next);
  }, [command]);
  const deleteSelected = useCallback(() => command("deleteSelected"), [command]);
  const clearAll = useCallback(() => { if (coin) { clearDrawings(coin); setSelected(null); } }, [coin]);

  const intraday = tf !== "1d";
  const dom = useMemo(() => ({ style: { height, width: "100%" as const }, scrollEnabled: false }), [height]);

  const chips = (
    <View style={m.tfRow}>
      {CHART_TFS.map((x) => {
        const on = x.id === tf;
        return (
          <Pressable key={x.id} onPress={() => updateSettings({ tf: x.id })} hitSlop={4} style={({ pressed }) => [m.chip, phone && m.chipPhone, on && m.chipOn, pressed && { opacity: 0.75 }]} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={x.label + " chart"}>
            <Text style={[m.chipText, on && m.chipTextOn]}>{x.label}</Text>
          </Pressable>
        );
      })}
      <View style={{ flex: 1 }} />
      {drafts.length ? <Pressable onPress={cancelDrafts} hitSlop={6} style={m.draftBtn}><Text style={m.draftText}>cancel TP/SL draft</Text></Pressable> : null}
      <IconButton name="refresh-outline" onPress={() => command("resetView")} label="Reset the chart view" size={15} />
    </View>
  );

  const notes: { text: string; warn?: boolean }[] = [
    status === "loading" && coin ? { text: "loading " + spec.label + " candles..." } : null,
    status === "ready" && coin && bars.length === 0 ? { text: "no " + spec.label + " candles yet - waiting for trades" } : null,
    status === "ready" && coin && !live && !ticker.live ? { text: "live feed reconnecting - the last bar is not live", warn: true } : null,
    status === "ready" && coin && live && reconnectedAt !== null ? { text: "live feed reconnected " + fmtTimeET(reconnectedAt) + " ET" } : null,
    sourceNote ? { text: sourceNote } : null,
    status === "error" ? { text: "chart: " + error, warn: true } : null,
  ].filter((x): x is { text: string; warn?: boolean } => !!x);

  const toolbar = (
    <ChartToolbar
      vertical={!phone}
      tool={dr.loaded ? tool : null}
      onTool={pickTool}
      enabled={dr.loaded && !!coin}
      selected={selected !== null}
      onDelete={deleteSelected}
      count={dr.drawings.length}
      onClear={clearAll}
      magnet={settings.magnet}
      onMagnet={() => updateSettings({ magnet: !settings.magnet })}
      hidden={settings.hideDrawings}
      onHidden={() => updateSettings({ hideDrawings: !settings.hideDrawings })}
    />
  );

  const chart = coin ? (
    <MountedChart
      key={coin + ":" + (phone ? "phone" : "desk")}
      onMount={mountChart}
      seriesKey={key}
      histRev={rev}
      bars={bars}
      lines={lines.length ? lines : NO_LINES}
      intraday={intraday}
      tfSec={tfSec}
      height={height}
      tags={tags}
      exits={exits}
      canTrade={canTrade}
      drawingsKey={coin}
      drawingsRev={dr.rev}
      drawings={dr.drawings}
      tool={dr.loaded ? tool : null}
      magnet={settings.magnet}
      hideDrawings={settings.hideDrawings}
      onDrawingsChange={onDrawingsChange}
      onToolDone={onToolDone}
      onSelect={onSelect}
      onNeedOlder={loadOlder}
      onOpenLink={openLink}
      onTagAction={onTagAction}
      onExitRelease={onExitRelease}
      onExitCancel={onExitCancel}
      dom={dom}
    />
  ) : (
    <View style={[m.empty, { height }]}><Text style={m.note}>{sourceNote ?? "no chart source for this market"}</Text></View>
  );

  return (
    <View style={m.panel}>
      {chips}
      <View style={phone ? m.bodyPhone : m.bodyDesk}>
        {!phone ? toolbar : null}
        <View style={{ flex: 1, minWidth: 0 }}>{chart}</View>
      </View>
      {phone ? toolbar : null}
      <View style={m.notes}>
        {notes.map((n, i) => <Text key={i} style={[m.note, n.warn ? { color: C.warn } : null]} numberOfLines={1}>{n.text}</Text>)}
        {status === "error" ? (
          <Pressable onPress={retry} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retry loading the chart"><Text style={m.retry}>Retry</Text></Pressable>
        ) : null}
      </View>
    </View>
  );
}

const m = StyleSheet.create({
  panel: { gap: 0 },
  tfRow: { flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 6, paddingVertical: 4, flexWrap: "wrap" },
  chip: { borderRadius: 6, paddingHorizontal: 7, minWidth: 34, minHeight: 28, alignItems: "center", justifyContent: "center" },
  chipPhone: { minHeight: 40, minWidth: 40 },
  chipOn: { backgroundColor: C.accentBg },
  chipText: { ...F.medium, color: C.muted, fontSize: T.caption, fontVariant: ["tabular-nums"] },
  chipTextOn: { color: C.accentText },
  bodyDesk: { flexDirection: "row", alignItems: "stretch" },
  bodyPhone: { flexDirection: "column" },
  empty: { alignItems: "center", justifyContent: "center", backgroundColor: C.bg },
  notes: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingHorizontal: 8, minHeight: 18, alignItems: "center" },
  note: { ...F.regular, color: C.faint, fontSize: T.micro, lineHeight: 15, flexShrink: 1 },
  retry: { ...F.semibold, color: C.accent, fontSize: T.caption },
  draftBtn: { paddingHorizontal: 8, minHeight: 28, justifyContent: "center", borderRadius: 6, borderWidth: 1, borderColor: C.border },
  draftText: { ...F.medium, color: C.muted, fontSize: T.micro },
});
