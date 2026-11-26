// Portfolio: the MyFundedPerps account (see SECURITY.md).
// Its own block, never summed into the Hyperliquid totals (paper vs real
// money). Polls every 30 s on the Read Only VIEW key
// (no fingerprint); Close / Reverse open MfpSheet, which unlocks the trade
// key for one run. Renders nothing until a view key is stored in Settings.
//
// Reads (MFP's per-key GET limit; see SECURITY.md): one
// reading at a time, through src/lib/read_gate.ts - a request made while
// one is in flight is run once after it, never beside it; the timer only
// ticks while the app is in the foreground; the account stream (src/lib/mfp_stream.ts) asks for a reading
// the moment the venue says something changed. The stream is a signal only:
// everything shown here still comes from the REST reading.
//
// Per-position PnL here is an estimate from the polled mid (display
// arithmetic, not a venue figure); the account's equity and uPnL are MFP's
// own risk snapshot.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";

import { MfpSheet } from "@/components/mfp-sheet";
import { PositionChart } from "@/components/position-chart";
import { agentSigningAvailable, getMfpKey, getMfpMeta, MfpKeyMeta } from "@/lib/agent_store";
import { chartSourceForMfp } from "@/lib/candles";
import { closeChart, openChartKey, subscribeChart, toggleChart } from "@/lib/chart_focus";
import { fetchHlCoinNames } from "@/lib/hyperliquid";
import { fmtPx, fmtUsd } from "@/lib/fmt";
import { fetchMfpView, mfpLimitedWaitMs, MfpView } from "@/lib/mfp_exchange";
import { mfpOpeningBlocked, MfpPosition } from "@/lib/mfp_orders";
import { mfpRateWarning, subscribeMfpRate } from "@/lib/mfp_rate";
import { makeReadGate } from "@/lib/read_gate";
import { mfpStreamStatus, subscribeMfpStream, watchMfpAccount } from "@/lib/mfp_stream";
import { MFP_SIGNAL_MIN_GAP_MS } from "@/lib/mfp_stream_core";
import { fmtSize } from "@/lib/perf_fmt";
import { C } from "@/theme";

const POLL_MS = 30_000;
const WARNING_SHOWN_MS = 10 * 60e3; // a rate warning older than this is no longer shown

const pnlColor = (x: number | null | undefined) => (x == null ? C.text : x > 0 ? C.bull : x < 0 ? C.bear : C.text);

export function MfpSection({ refreshSignal }: { refreshSignal: number }) {
  const [viewMeta, setViewMeta] = useState<MfpKeyMeta | null | undefined>(undefined); // undefined = loading
  const [tradeMeta, setTradeMeta] = useState<MfpKeyMeta | null>(null);
  const [signing, setSigning] = useState(false);
  const [view, setView] = useState<MfpView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limited, setLimited] = useState<string | null>(null); // a reading held back by the key's GET limit
  const [sheet, setSheet] = useState<{ mode: "close" | "reverse"; position: MfpPosition } | null>(null);

  useEffect(() => { agentSigningAvailable().then(setSigning).catch(() => setSigning(false)); }, []);

  // Hyperliquid's coin list, for the chart-source mapping (session cache).
  const [hlCoins, setHlCoins] = useState<Set<string> | null>(null);
  const anyPositions = (view?.positions.length ?? 0) > 0;
  const viewAt = view?.at ?? 0;
  useEffect(() => {
    if (!anyPositions || hlCoins) return;
    fetchHlCoinNames().then(setHlCoins).catch(() => undefined); // a failure retries on the next poll (viewAt)
  }, [anyPositions, hlCoins, viewAt]);

  // One reading of the venue. markets is the last reading's market count:
  // the client admits or refuses the whole cycle (3 GETs + one quote each)
  // against the key's GET budget. A reading the budget holds back keeps the
  // last one on screen, says so, and is asked for again at the time the
  // budget names (not left to the next 30 s tick).
  const markets = useRef(0);
  const ask = useRef<() => void>(() => undefined);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const read = useCallback(async () => {
    const [vm, tm] = await Promise.all([getMfpMeta("view"), getMfpMeta("trade")]);
    setViewMeta(vm);
    setTradeMeta(tm);
    if (!vm) { setView(null); return; }
    try {
      const key = await getMfpKey("view"); // ungated: no prompt
      if (!key) { setLimited(null); setError("view key missing on this device - add it again in Settings"); return; }
      const v = await fetchMfpView(key, vm.accountId, markets.current);
      markets.current = new Set(v.positions.map((p) => p.marketId)).size;
      setView(v);
      setError(null);
      setLimited(null);
    } catch (e) {
      const wait = mfpLimitedWaitMs(e);
      if (wait === null) { setLimited(null); setError(e instanceof Error ? e.message : "fetch failed"); return; }
      setLimited(e instanceof Error ? e.message : "MFP rate limit");
      if (retry.current) clearTimeout(retry.current);
      retry.current = setTimeout(() => {
        retry.current = null;
        if (AppState.currentState === "active") ask.current();
      }, Math.max(1000, wait) + 50);
    }
  }, []);

  // Readings never overlap and never start closer together than
  // MFP_SIGNAL_MIN_GAP_MS; a request made meanwhile (the timer, a
  // pull-to-refresh, a finished trade, a stream signal) is served by ONE
  // reading that starts after it (src/lib/read_gate.ts).
  const [gate] = useState(() => makeReadGate(read, MFP_SIGNAL_MIN_GAP_MS));
  const load = gate.request;
  useEffect(() => {
    gate.open();
    ask.current = gate.request;
    return () => {
      gate.close();
      if (retry.current) { clearTimeout(retry.current); retry.current = null; }
    };
  }, [gate]);

  // The timer ticks only in the foreground (a backgrounded app spends none
  // of the key's budget), skips a tick while a reading is in flight, and one
  // reading is taken on the way back in.
  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (AppState.currentState === "active" && !gate.busy()) load();
    }, POLL_MS);
    const sub = AppState.addEventListener("change", (state) => { if (state === "active") load(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [load, gate]);

  // Pull-to-refresh. Only a CHANGE re-reads: the signal is never reset, so
  // a remount after an earlier pull must not read twice.
  const seenRefresh = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === seenRefresh.current) return;
    seenRefresh.current = refreshSignal;
    load();
  }, [refreshSignal, load]);

  // The account stream: any signal means "read the venue again". Keyed on
  // the view key's fingerprint as well as the account, so a key replaced in
  // Settings drops the old socket (and a refusal of the old key).
  const streamAccount = viewMeta?.accountId ?? null;
  const streamKeyFp = viewMeta?.keyFp ?? null;
  useEffect(() => {
    if (streamAccount === null) return;
    return watchMfpAccount(streamAccount, () => load());
  }, [streamAccount, streamKeyFp, load]);
  const streamStatus = useSyncExternalStore(subscribeMfpStream, () => mfpStreamStatus(streamAccount));
  const warning = useSyncExternalStore(subscribeMfpRate, mfpRateWarning);
  const warningFresh = warning !== null && viewAt - warning.at < WARNING_SHOWN_MS && warning.env === viewMeta?.env;

  if (!viewMeta) return null;

  const acct = view?.account ?? null;
  const risk = acct?.risk ?? null;
  const canTrade = signing && tradeMeta !== null && view !== null && tradeMeta.accountId === view.account.id && view.account.status === "active";
  const openBlock = view ? mfpOpeningBlocked(view.policy) : "not loaded";
  const canReverse = canTrade && openBlock === null;

  return (
    <View style={s.wrap}>
      <View style={s.headRow}>
        <Text style={s.section}>MyFundedPerps</Text>
        {viewMeta.env === "sandbox" ? <Pill label="SANDBOX" color={C.warn} bg={C.warnBg} /> : null}
        {acct?.stage ? <Pill label={acct.stage} color={C.info} bg={C.infoBg} /> : null}
        {acct && acct.status !== "active" ? <Pill label={acct.status} color={C.bear} bg={C.bearBg} /> : null}
        {streamStatus === "live" ? <Pill label="streaming" color={C.bull} bg={C.bullBg} /> : null}
        {streamStatus === "delayed" ? <Pill label="stream delayed" color={C.warn} bg={C.warnBg} /> : null}
      </View>
      <Text style={s.sub}>
        {(acct?.name || viewMeta.name || "account") + (acct?.accountNumber || viewMeta.accountNumber ? " #" + (acct?.accountNumber || viewMeta.accountNumber) : "")}
        {error ? "  (offline - " + error + ")" : ""}
      </Text>
      {limited ? <Text style={s.note}>{limited + "; showing the last reading"}</Text> : null}
      {warningFresh ? <Text style={s.note}>MFP reports a key on this device is reading above its coming rate limit.</Text> : null}

      <View style={s.summaryCard}>
        <Cell label="Equity" value={risk?.equity != null ? fmtUsd(risk.equity) : "-"} big />
        <Cell label="Unrealized PnL" value={risk?.unrealizedPnl != null ? fmtUsd(risk.unrealizedPnl) : "-"} color={pnlColor(risk?.unrealizedPnl)} big />
      </View>
      <View style={s.riskCard}>
        <Cell label="Daily loss room" value={risk?.dailyLossRoom != null ? fmtUsd(risk.dailyLossRoom) : "-"} color={risk?.dailyLossRoom != null && risk.dailyLossRoom <= 0 ? C.bear : undefined} />
        <Cell label="Drawdown room" value={risk?.maxDrawdownRoom != null ? fmtUsd(risk.maxDrawdownRoom) : "-"} color={risk?.maxDrawdownRoom != null && risk.maxDrawdownRoom <= 0 ? C.bear : undefined} />
        <Cell label="To target" value={risk?.remainingProfitEquity != null ? fmtUsd(risk.remainingProfitEquity) : "-"} />
      </View>
      {risk && !risk.marksComplete ? <Text style={s.note}>some marks were stale on MFP - equity may lag</Text> : null}

      <Text style={s.section}>{"Positions" + (view ? " (" + view.positions.length + ")" : "")}</Text>
      {view && view.positions.length === 0 ? <Text style={s.hint}>no open positions</Text> : null}
      {view?.positions.map((p) => (
        <MfpPositionCard
          key={p.id}
          p={p}
          mid={view.mids[p.marketId] ?? null}
          hlCoins={hlCoins}
          onClose={canTrade ? () => setSheet({ mode: "close", position: p }) : undefined}
          onReverse={canReverse ? () => setSheet({ mode: "reverse", position: p }) : undefined}
        />
      ))}
      {view && view.positions.length > 0 && canTrade && !canReverse && openBlock ? (
        <Text style={s.note}>{"Reverse unavailable: " + openBlock}</Text>
      ) : null}
      {view && view.positions.length > 0 && !tradeMeta ? (
        <Text style={s.note}>View only - add a Read And Trade key in Settings to close or reverse here.</Text>
      ) : null}

      <MfpSheet
        visible={sheet !== null}
        mode={sheet?.mode ?? "close"}
        position={sheet?.position ?? null}
        mid={sheet && view ? view.mids[sheet.position.marketId] ?? null : null}
        onClose={() => setSheet(null)}
        onFinished={() => { load(); }}
      />
    </View>
  );
}

function MfpPositionCard({ p, mid, hlCoins, onClose, onReverse }: {
  p: MfpPosition; mid: number | null; hlCoins: Set<string> | null; onClose?: () => void; onReverse?: () => void;
}) {
  const chartKey = "mfp|" + p.id;
  const chartOpen = useSyncExternalStore(subscribeChart, openChartKey) === chartKey;
  useEffect(() => () => closeChart(chartKey), [chartKey]); // a closed position takes its chart with it
  const long = p.side === "long";
  const estPnl = mid !== null ? (mid - p.entryPrice) * p.size * (long ? 1 : -1) : null;
  // Charts read Hyperliquid (Binance refuses US IPs): the market itself, or
  // the same base asset there, labelled; never a guessed symbol.
  const src = hlCoins ? chartSourceForMfp(p, hlCoins) : null;
  return (
    <View style={s.card}>
      <View style={s.posTop}>
        <Text style={s.posSym}>{p.symbol}</Text>
        <View style={[s.sideBadge, { backgroundColor: long ? C.bullBg : C.bearBg }]}>
          <Text style={[s.sideBadgeText, { color: long ? C.bull : C.bear }]}>{(long ? "LONG" : "SHORT") + " " + p.leverage + "x"}</Text>
        </View>
        {p.provider ? <View style={s.pill}><Text style={s.pillText}>{p.provider}</Text></View> : null}
        <Text style={[s.posPnl, { color: pnlColor(estPnl) }]}>{estPnl !== null ? fmtUsd(estPnl) : "-"}</Text>
      </View>
      <View style={s.posGrid}>
        <PosCell label="Size" value={fmtSize(p.size)} />
        <PosCell label="Notional" value={mid !== null ? fmtUsd(mid * p.size) : "-"} />
        <PosCell label="Entry" value={fmtPx(p.entryPrice)} />
        <PosCell label="Mark" value={mid !== null ? fmtPx(mid) : "-"} />
        <PosCell label="Liq" value={p.liquidationPrice !== null ? fmtPx(p.liquidationPrice) : "-"} />
        <PosCell label="Margin" value={p.marginMode} />
      </View>
      {chartOpen ? (
        <PositionChart
          title={p.symbol + " " + p.side + " (MFP)"}
          coin={src ? src.coin : null}
          sourceNote={src ? src.note : hlCoins ? "no Hyperliquid market to chart " + p.symbol + " from" : "loading the chart source..."}
          servedCoinId={src ? src.coin : null}
          entry={p.entryPrice}
          liq={p.liquidationPrice}
          onClosePos={onClose}
          onReversePos={onReverse}
        />
      ) : null}
      <View style={s.actRow}>
          <Text style={s.estNote}>PnL est. from mid</Text>
          <Pressable onPress={() => toggleChart(chartKey)} hitSlop={8} style={({ pressed }) => [s.btn, s.chartBtn, chartOpen && s.chartBtnOn, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityState={{ expanded: chartOpen }} accessibilityLabel={(chartOpen ? "Hide" : "Show") + " the " + p.symbol + " chart"}>
            <Text style={[s.btnText, { color: chartOpen ? C.bull : C.muted }]}>{chartOpen ? "Chart -" : "Chart +"}</Text>
          </Pressable>
          {onReverse ? (
            <Pressable onPress={onReverse} hitSlop={8} style={({ pressed }) => [s.btn, s.revBtn, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={"Reverse " + p.symbol + " on MyFundedPerps"}>
              <Text style={[s.btnText, s.revBtnText]}>Reverse</Text>
            </Pressable>
          ) : null}
          {onClose ? (
            <Pressable onPress={onClose} hitSlop={8} style={({ pressed }) => [s.btn, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={"Close " + p.symbol + " on MyFundedPerps"}>
              <Text style={s.btnText}>Close</Text>
            </Pressable>
          ) : null}
      </View>
    </View>
  );
}

function Pill({ label, color, bg }: { label: string; color: string; bg: string }) {
  return <View style={[s.pill, { backgroundColor: bg, borderColor: "transparent" }]}><Text style={[s.pillText, { color }]}>{label}</Text></View>;
}

function Cell({ label, value, color, big }: { label: string; value: string; color?: string; big?: boolean }) {
  return (
    <View style={s.cell}>
      <Text style={s.cellLabel}>{label}</Text>
      <Text style={[big ? s.cellBig : s.cellValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

function PosCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.posCell}>
      <Text style={s.posCellLabel}>{label}</Text>
      <Text style={s.posCellValue}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.border },
  headRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  section: {
    color: C.muted, fontSize: 11, fontWeight: "500", textTransform: "uppercase",
    letterSpacing: 0.7, marginTop: 6, marginBottom: 8,
  },
  sub: { color: C.faint, fontSize: 12, marginBottom: 10, fontVariant: ["tabular-nums"], flexShrink: 1 },
  hint: { color: C.muted, fontSize: 13, lineHeight: 19 },
  note: { color: C.faint, fontSize: 11, lineHeight: 15, marginBottom: 8, flexShrink: 1 },
  summaryCard: {
    flexDirection: "row", backgroundColor: C.card, borderWidth: 1,
    borderColor: C.border, borderRadius: 10, marginBottom: 8,
  },
  riskCard: {
    flexDirection: "row", flexWrap: "wrap", backgroundColor: C.card, borderWidth: 1,
    borderColor: C.border, borderRadius: 10, marginBottom: 10,
  },
  cell: { flex: 1, minWidth: 100, padding: 10 },
  cellLabel: { fontSize: 10, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.7, color: C.muted },
  cellBig: { fontSize: 20, fontWeight: "600", color: C.text, marginTop: 3, fontVariant: ["tabular-nums"] },
  cellValue: { fontSize: 13.5, fontWeight: "600", color: C.text, marginTop: 3, fontVariant: ["tabular-nums"] },
  pill: {
    borderWidth: 1, borderColor: C.border, borderRadius: 999,
    paddingHorizontal: 8, paddingVertical: 2, backgroundColor: C.card, marginBottom: 2,
  },
  pillText: { color: C.muted, fontSize: 10.5, fontWeight: "500" },
  card: {
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    borderRadius: 10, padding: 12, marginBottom: 8,
  },
  posTop: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  posSym: { color: C.text, fontSize: 15, fontWeight: "600" },
  sideBadge: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 },
  sideBadgeText: { fontSize: 10.5, fontWeight: "600" },
  posPnl: { marginLeft: "auto", fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  posGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 9 },
  posCell: { width: "33.33%", paddingVertical: 3 },
  posCellLabel: { color: C.faint, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  posCellValue: { color: C.text, fontSize: 12.5, marginTop: 1, fontVariant: ["tabular-nums"] },
  actRow: {
    flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap",
    marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border,
  },
  estNote: { color: C.faint, fontSize: 10, flex: 1, flexShrink: 1 },
  btn: {
    borderWidth: 1, borderColor: "rgba(255,59,92,0.35)", borderRadius: 6,
    paddingHorizontal: 9, paddingVertical: 3, marginLeft: 8, minHeight: 26, justifyContent: "center",
  },
  btnText: { color: C.bear, fontSize: 11, fontWeight: "600" },
  revBtn: { borderColor: "rgba(59,130,246,0.35)" },
  revBtnText: { color: C.info },
  chartBtn: { borderColor: C.border },
  chartBtnOn: { borderColor: "rgba(0,220,130,0.35)" },
});
