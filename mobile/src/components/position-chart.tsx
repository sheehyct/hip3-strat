// The chart panel under an open position (Portfolio; Hyperliquid and
// MyFundedPerps). Owns the data: Hyperliquid candles for the chosen
// timeframe (300 bars, older pages on demand, the gap refilled after a
// reconnect), the live forming bar over the shared candle WebSocket, and the
// overlay - the position's entry and liquidation plus the scanner's SERVED
// levels and bar types for that timeframe (display only: this app
// never detects). Drawing is price-chart.tsx (Lightweight Charts in a DOM
// component).
//
// Bridge discipline: on Android every prop of a DOM component is re-sent on
// every render, so the chart element is memoized on stable props, live bars
// go through its imperative handle (no React render per tick), and `bars`
// changes only on a new history snapshot (histRev).
//
// One chart is open app-wide (chart_focus); the timeframe is remembered.
// Fullscreen moves the same data into a modal with Close / Reverse beside
// it; only one PriceChart is mounted at a time, each mount with its own
// handle (MountedChart).
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentProps } from "react";
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import PriceChart, { PriceChartHandle } from "@/components/price-chart";
import { sigInForce } from "@/lib/api";
import {
  applyLive, Bar, candleWindow, CHART_TFS, ChartMarker, ChartTf, dedupeLines, HISTORY_BARS, mergeBars, OLDER_BARS, parseHlCandles,
  positionLines, servedOverlay, tfSpec, toWire, WireBar,
} from "@/lib/candles";
import { chartLevels, chartTf, setChartLevels, setChartTf, subscribeChart } from "@/lib/chart_focus";
import { restartCandles, streamCandles } from "@/lib/hl_stream";
import { fetchCandlesRaw } from "@/lib/hyperliquid";
import { fmtTimeET } from "@/lib/perf_fmt";
import { servedCoinSnapshot, subscribeServed } from "@/lib/state_cache";
import { C } from "@/theme";

const INLINE_HEIGHT = 280;
const NO_BARS: WireBar[] = [];
const NO_MARKERS: ChartMarker[] = [];
const STREAM_QUIET_MS = 30_000;   // no streamed bar for this long -> check REST for a stalled stream
const WATCH_EVERY_MS = 10_000;
const ChartView = memo(PriceChart);

// One mounted chart with a ref of its own. Expo's native DOM wrapper binds
// an object ref to the WebView that first renders with it (it fills
// ref.current during render, only while it is null) and never clears or
// rebinds it. The inline and fullscreen charts once shared one ref, so after
// the first fullscreen every live tick went to the unmounted WebView and was
// dropped without a sign: the chart froze on its last snapshot until a
// background / foreground refetch. Web never showed it -
// React manages the ref there. `onMount` gets this chart's handle and returns
// the detach.
function MountedChart({ onMount, ...props }: Omit<ComponentProps<typeof ChartView>, "ref"> & {
  onMount: (h: PriceChartHandle | null) => () => void;
}) {
  const ref = useRef<PriceChartHandle>(null);
  useEffect(() => onMount(ref.current), [onMount]);
  return <ChartView ref={ref} {...props} />;
}

// The attribution logo (the only link in the chart) opens in the browser.
async function openLink(href: string): Promise<void> {
  if (/^https:\/\//.test(href)) await WebBrowser.openBrowserAsync(href);
}

type Status = "loading" | "ready" | "error";

function useChartData(coin: string | null, tf: ChartTf, pushLive: (b: WireBar) => void) {
  const key = (coin ?? "") + "|" + tf;
  // The snapshot is tagged with the series it belongs to: during a TF or
  // coin switch the previous series' bars are never paired with the new key.
  const [snap, setSnap] = useState<{ key: string; bars: WireBar[]; rev: number }>({ key: "", bars: NO_BARS, rev: 0 });
  const [newest, setNewest] = useState(0);   // newest bar open (s), for the lag note; changes once per bar
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);    // false while the candle socket is down or reconnecting
  // When the stream last came back after a drop or a stall: shown so a heal
  // is visible (a freeze WITHOUT this line has some other cause).
  const [reconnectedAt, setReconnectedAt] = useState<number | null>(null);
  const liveNow = useRef(true);
  const [nonce, setNonce] = useState(0);
  const barsRef = useRef<Bar[]>([]);        // history + folded live bars: older pages and gap refills merge into THIS
  const gen = useRef(0);
  const olderBusy = useRef(false);
  const olderDone = useRef(false);
  const liveRef = useRef(pushLive);
  useEffect(() => { liveRef.current = pushLive; }, [pushLive]);

  const publish = useCallback((k: string) => {
    const bars = barsRef.current;
    setSnap((s) => ({ key: k, bars: bars.map(toWire), rev: s.rev + 1 }));
    setNewest(bars.at(-1)?.time ?? 0);
  }, []);
  // A chart that mounts mid-stream (fullscreen opened or left) starts from
  // the last snapshot, which lacks every live bar folded in since: hand it
  // the current bars. The snapshot keeps its own key - a series switch
  // empties barsRef before any of its bars land.
  const resend = useCallback(() => {
    const wire = barsRef.current.map(toWire);
    if (!wire.length) return;
    setSnap((s) => ({ ...s, bars: wire, rev: s.rev + 1 }));
  }, []);

  useEffect(() => {
    if (!coin) return;
    const mine = ++gen.current;
    barsRef.current = [];
    olderBusy.current = false;
    olderDone.current = false;
    setSnap((s) => ({ key, bars: NO_BARS, rev: s.rev + 1 }));
    setNewest(0); setStatus("loading"); setError(null); setLive(true); setReconnectedAt(null);
    liveNow.current = true;
    const w = candleWindow(tf, Date.now(), HISTORY_BARS);
    fetchCandlesRaw(coin, tf, w.startTime, w.endTime).then((raw) => {
      if (mine !== gen.current) return;
      const b = parseHlCandles(raw);
      if (!b) { setStatus("error"); setError("the candle answer was unreadable"); return; }
      // Keep any live bars that already arrived past this history.
      barsRef.current = mergeBars(b, barsRef.current.filter((x) => x.time >= (b.at(-1)?.time ?? 0)));
      publish(key);
      setStatus("ready");
    }).catch((e) => {
      if (mine !== gen.current) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : "candles unavailable");
    });
    const refill = () => {
      // Bars traded while the socket was down never arrive by themselves.
      const lastT = barsRef.current.at(-1)?.time;
      if (lastT === undefined) return;
      fetchCandlesRaw(coin, tf, lastT * 1000, Date.now()).then((raw) => {
        if (mine !== gen.current) return;
        const b = parseHlCandles(raw);
        if (!b || !b.length) return;
        barsRef.current = mergeBars(barsRef.current, b);
        publish(key);
      }).catch(() => undefined);
    };
    // Data-level watchdog (seen on a device: seven charts, BTC included,
    // froze while their history loaded fine). A socket can stall while it
    // still answers pings, so after STREAM_QUIET_MS without a streamed bar
    // ask REST whether the market moved. Moved = the stream is dead: fold in
    // what REST has and reconnect. Unmoved = a quiet market: ask again after
    // another quiet spell.
    let lastLive = Date.now();
    let probing = false;
    const watch = setInterval(() => {
      if (probing || Date.now() - lastLive < STREAM_QUIET_MS) return;
      const ours = barsRef.current.at(-1);
      if (!ours) return;
      probing = true;
      fetchCandlesRaw(coin, tf, ours.time * 1000, Date.now()).then((raw) => {
        if (mine !== gen.current) return;
        const b = parseHlCandles(raw);
        const theirs = b?.at(-1);
        if (!b || !theirs) return;
        const now = barsRef.current.at(-1) ?? ours;
        const moved = theirs.time > now.time ||
          (theirs.time === now.time && (theirs.close !== now.close || theirs.high !== now.high || theirs.low !== now.low));
        if (!moved) return;
        barsRef.current = mergeBars(barsRef.current, b);
        publish(key);
        restartCandles();
      }).catch(() => undefined).finally(() => {
        probing = false;
        lastLive = Date.now();   // asked (answered or failed): wait out another quiet spell
      });
    }, WATCH_EVERY_MS);
    const stop = streamCandles(coin, tf, (bar) => {
      if (mine !== gen.current) return;
      lastLive = Date.now();
      const before = barsRef.current.at(-1)?.time;
      barsRef.current = applyLive(barsRef.current, bar);
      liveRef.current(toWire(bar));
      if (before !== undefined && bar.time > before) setNewest(bar.time);
    }, refill, (on) => {
      if (mine !== gen.current) return;
      if (on && !liveNow.current) setReconnectedAt(Date.now());
      liveNow.current = on;
      setLive(on);
    });
    return () => { clearInterval(watch); stop(); };
  }, [coin, tf, key, nonce, publish]);

  // History before `oldestSec`; true = there may be more. A request for a
  // series that is no longer shown is ignored.
  const loadOlder = useCallback(async (oldestSec: number, forKey: string): Promise<boolean> => {
    if (!coin || forKey !== key || olderDone.current) return !olderDone.current;
    if (olderBusy.current) return true;
    olderBusy.current = true;
    const mine = gen.current;
    try {
      const w = candleWindow(tf, oldestSec * 1000 - 1, OLDER_BARS);
      const older = parseHlCandles(await fetchCandlesRaw(coin, tf, w.startTime, w.endTime)) ?? [];
      if (mine !== gen.current) return true;
      const fresh = older.filter((b) => b.time < oldestSec);
      if (!fresh.length) { olderDone.current = true; return false; } // the venue's history ends here
      barsRef.current = mergeBars(fresh, barsRef.current);
      publish(key);
      return true;
    } finally {
      if (mine === gen.current) olderBusy.current = false;
    }
  }, [coin, tf, key, publish]);

  const bars = snap.key === key ? snap.bars : NO_BARS;
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { key, bars, rev: snap.rev, newest, status, error, live, reconnectedAt, loadOlder, retry, resend };
}

export type PositionChartProps = {
  title: string;                  // symbol, for the fullscreen header
  coin: string | null;            // Hyperliquid coin to chart; null = no source
  sourceNote: string | null;      // e.g. "chart: Hyperliquid BTC - MFP fills on binance"
  servedCoinId: string | null;    // the scanner's coin id for the overlay (null = none)
  entry: number | null;
  liq: number | null;
  onClosePos?: () => void;
  onReversePos?: () => void;
};

export function PositionChart({ title, coin, sourceNote, servedCoinId, entry, liq, onClosePos, onReversePos }: PositionChartProps) {
  const tf = useSyncExternalStore(subscribeChart, chartTf);
  const levels = useSyncExternalStore(subscribeChart, chartLevels);
  const spec = tfSpec(tf);
  const chartRef = useRef<PriceChartHandle | null>(null);   // the handle of whichever chart is mounted
  const pushLive = useCallback((b: WireBar) => { chartRef.current?.pushLive?.(b); }, []);
  const { key, bars, rev, newest, status, error, live, reconnectedAt, loadOlder, retry, resend } = useChartData(coin, tf, pushLive);
  const mountChart = useCallback((h: PriceChartHandle | null) => {
    chartRef.current = h;
    resend();
    return () => { if (chartRef.current === h) chartRef.current = null; };
  }, [resend]);
  const served = useSyncExternalStore(subscribeServed, () => (servedCoinId ? servedCoinSnapshot(servedCoinId) : null));
  const [full, setFull] = useState(false);
  const [fullH, setFullH] = useState(0);
  const { height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const tfState = served && spec.served ? served.tf[spec.served] ?? null : null;
  const mid = served?.mid ?? null;
  // Lines and labels depend only on the served row and the position, never
  // on the live tick: stable across renders, so the chart is not re-sent.
  const ov = useMemo(
    () => servedOverlay(tfState, spec.ms, newest * 1000, (sig) => sigInForce(sig, mid)),
    [tfState, spec.ms, newest, mid],
  );
  // Hiding the scanner's levels keeps the position's own entry / liq lines.
  const lines = useMemo(
    () => dedupeLines([...positionLines(entry, liq), ...(levels ? ov.lines : [])]),
    [entry, liq, ov.lines, levels],
  );
  const markers = levels ? ov.markers : NO_MARKERS;
  const hasOverlay = ov.lines.length > 0 || ov.markers.length > 0;
  const intraday = tf !== "1d";
  const inlineDom = useMemo(() => ({ style: { height: INLINE_HEIGHT, width: "100%" as const }, scrollEnabled: false }), []);
  const fullDom = useMemo(() => ({ style: { height: fullH, width: "100%" as const }, scrollEnabled: false }), [fullH]);

  // `grow` only beside the expand icon (a row). In the fullscreen column a
  // flex: 1 chip row took half the height and squeezed the chart below it.
  const chips = (grow: boolean) => (
    <View style={[s.tfRow, grow && s.tfGrow]}>
      {CHART_TFS.map((t) => {
        const on = t.id === tf;
        return (
          <Pressable key={t.id} onPress={() => setChartTf(t.id)} hitSlop={4} style={[s.chip, on && s.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={t.label + " chart"}>
            <Text style={[s.chipText, on && s.chipTextOn]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  const notes: { text: string; warn?: boolean }[] = [
    status === "loading" && coin ? { text: "loading " + spec.label + " candles..." } : null,
    status === "ready" && coin && bars.length === 0 ? { text: "no " + spec.label + " candles yet - waiting for trades" } : null,
    status === "ready" && coin && !live ? { text: "live feed reconnecting - the last bar is not live", warn: true } : null,
    status === "ready" && coin && live && reconnectedAt !== null ? { text: "live feed reconnected " + fmtTimeET(reconnectedAt) + " ET" } : null,
    sourceNote ? { text: sourceNote } : null,
    levels && ov.lagBars > 0 ? { text: "scanner " + spec.label + " levels are " + ov.lagBars + " bar" + (ov.lagBars > 1 ? "s" : "") + " behind", warn: true } : null,
    spec.served === null && coin ? { text: "no scanner levels on " + spec.label } : null,
  ].filter((x): x is { text: string; warn?: boolean } => !!x);
  const noteView = (
    <>
      {status === "error" ? (
        <View style={s.errRow}>
          <Text style={[s.note, { color: C.bear }]}>{"chart: " + error}</Text>
          <Pressable onPress={retry} hitSlop={8} accessibilityRole="button"><Text style={s.retry}>Retry</Text></Pressable>
        </View>
      ) : null}
      {notes.map((n, i) => <Text key={i} style={[s.note, n.warn ? { color: C.warn } : null]}>{n.text}</Text>)}
      {hasOverlay ? (
        <View style={s.errRow}>
          <Text style={s.note}>
            {!levels ? "scanner levels hidden" : markers.length ? "labels: scanner bar types, * = forming" : "lines: scanner levels"}
          </Text>
          <Pressable onPress={() => setChartLevels(!levels)} hitSlop={8} accessibilityRole="switch" accessibilityState={{ checked: levels }} accessibilityLabel="Scanner levels on the chart">
            <Text style={s.retry}>{levels ? "Hide levels" : "Show levels"}</Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );

  const chart = (height: number, dom: typeof inlineDom) => (
    coin ? (
      <MountedChart
        onMount={mountChart}
        seriesKey={key}
        histRev={rev}
        bars={bars}
        lines={lines}
        markers={markers}
        intraday={intraday}
        height={height}
        onNeedOlder={loadOlder}
        onOpenLink={openLink}
        dom={dom}
      />
    ) : (
      <View style={[s.empty, { height: 90 }]}><Text style={s.note}>{sourceNote ?? "no chart source for this market"}</Text></View>
    )
  );

  return (
    <View style={s.panel}>
      <View style={s.headRow}>
        {chips(true)}
        {coin ? (
          <Pressable onPress={() => setFull(true)} hitSlop={8} style={s.iconBtn} accessibilityRole="button" accessibilityLabel={"Open the " + title + " chart full screen"}>
            <Ionicons name="expand-outline" size={16} color={C.muted} />
          </Pressable>
        ) : null}
      </View>
      {full ? <View style={[s.empty, { height: 60 }]}><Text style={s.note}>open full screen</Text></View> : chart(INLINE_HEIGHT, inlineDom)}
      {noteView}

      <Modal visible={full} animationType="fade" onRequestClose={() => setFull(false)} statusBarTranslucent>
        <View style={[s.full, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 10 }]}>
          <View style={s.fullHead}>
            <Text style={s.fullTitle} numberOfLines={1}>{title}</Text>
            <Pressable onPress={() => setFull(false)} hitSlop={10} style={s.iconBtn} accessibilityRole="button" accessibilityLabel="Leave full screen">
              <Ionicons name="contract-outline" size={18} color={C.muted} />
            </Pressable>
          </View>
          {chips(false)}
          {/* The chart takes whatever the header, notes and buttons leave -
              measured, so a large font scale never pushes Close off screen. */}
          <View style={s.fullChart} onLayout={(e) => setFullH(Math.max(0, Math.floor(e.nativeEvent.layout.height)))}>
            {full && fullH > 120 ? chart(fullH, fullDom) : null}
          </View>
          {noteView}
          {onClosePos || onReversePos ? (
            <View style={s.fullActs}>
              {onReversePos ? (
                <Pressable onPress={() => { setFull(false); onReversePos(); }} style={({ pressed }) => [s.actBtn, s.revBtn, pressed && { opacity: 0.7 }]} accessibilityRole="button">
                  <Text style={[s.actText, { color: C.info }]}>Reverse</Text>
                </Pressable>
              ) : null}
              {onClosePos ? (
                <Pressable onPress={() => { setFull(false); onClosePos(); }} style={({ pressed }) => [s.actBtn, pressed && { opacity: 0.7 }]} accessibilityRole="button">
                  <Text style={[s.actText, { color: C.bear }]}>Close</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  panel: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border, gap: 6 },
  headRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  tfRow: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  tfGrow: { flex: 1 },
  chip: {
    borderWidth: 1, borderColor: C.border, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3,
    minWidth: 34, alignItems: "center", backgroundColor: C.card,
  },
  chipOn: { borderColor: "rgba(0,220,130,0.35)", backgroundColor: C.bullBg },
  chipText: { color: C.muted, fontSize: 11, fontWeight: "500", fontVariant: ["tabular-nums"] },
  chipTextOn: { color: C.bull },
  iconBtn: { padding: 4, minHeight: 28, minWidth: 28, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", justifyContent: "center", borderRadius: 8, backgroundColor: C.bg },
  note: { color: C.faint, fontSize: 10.5, lineHeight: 14, flexShrink: 1 },
  errRow: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  retry: { color: C.info, fontSize: 11, fontWeight: "600" },
  full: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 10, gap: 8 },
  fullHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  fullTitle: { color: C.text, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  fullChart: { flex: 1, minHeight: 0 },
  fullActs: { flexDirection: "row", gap: 10 },
  actBtn: {
    flex: 1, minHeight: 44, borderWidth: 1, borderColor: "rgba(255,59,92,0.35)", borderRadius: 8,
    alignItems: "center", justifyContent: "center",
  },
  revBtn: { borderColor: "rgba(59,130,246,0.35)" },
  actText: { fontSize: 13, fontWeight: "600" },
});
