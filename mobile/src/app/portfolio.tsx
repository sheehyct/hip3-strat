// Portfolio tab: read-only Hyperliquid account view for the wallet(s) saved in
// Settings. Queries every perp dex (main + HIP-3 builders) because each has
// its own clearinghouse - a main-dex-only query silently hides HIP-3
// positions, which is exactly the failure mode of most trackers.
//
// Multi-wallet: every saved wallet is fetched each
// poll; with more than one, a pill row selects All (combined totals, positions
// tagged by wallet) or a single account. Addresses live only on this device.
//
// Views: a dropdown chip switches Positions /
// Performance / Trades. Performance and Trades read the wallet's fills and
// the venue's own equity history (src/lib/performance.ts); the position
// cards show the coin's CURRENT served continuity beside the position -
// display of the scanner's output, never a computation (see README).
//
// MyFundedPerps: Performance and Trades gain an MFP
// pill after the wallet pills, drawn from the account's closed positions
// (src/lib/mfp_history.ts). "All" stays Hyperliquid only - the MFP account is
// never summed into the wallets' numbers.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";

import { CloseSheet, CloseTarget } from "@/components/close-sheet";
import { MfpSection } from "@/components/mfp-section";
import { PositionChart } from "@/components/position-chart";
import { PerformanceView } from "@/components/performance-view";
import { ALL, walletName } from "@/components/trade-bits";
import { TradesView } from "@/components/trades-view";
import { Dot } from "@/components/ui";
import { PortfolioView, ViewMenu } from "@/components/view-menu";
import { agentSigningAvailable, getAgentMeta, getMfpMeta, MfpKeyMeta } from "@/lib/agent_store";
import { closeAllCharts, closeChart, openChartKey, subscribeChart, toggleChart } from "@/lib/chart_focus";
import { fmtPct, fmtPx, fmtUsd } from "@/lib/fmt";
import { fetchPortfolios, Portfolio, Position } from "@/lib/hyperliquid";
import { loadMfpPerformance, MfpPerf } from "@/lib/mfp_history";
import { addFunding, loadWalletPerformance, WalletPerf } from "@/lib/performance";
import { servedCoinSnapshot, subscribeServed } from "@/lib/state_cache";
import { getWallets, Wallet } from "@/lib/store";
import { noteOpenPositions } from "@/lib/tfc_stamps";
import { C } from "@/theme";

const PERF_REFRESH_MS = 5 * 60e3;
const NO_UNREALIZED: Record<string, number> = {}; // MFP trades are closed positions only

// The MFP history's footnote: a sync error (the cache is shown) and/or the
// balance reconciliation when closed trades do not explain the balance.
function mfpNote(mp: MfpPerf): string | null {
  const parts = [
    mp.perf.error ? "history sync: " + mp.perf.error + " (showing cached data)" : null,
    mp.reconcile,
  ].filter((x): x is string => !!x);
  return parts.length ? parts.join("; ") : null;
}

// Fills, trades and history per wallet, loaded while a history view is
// active and refreshed every five minutes - NEVER inside the 30 s position
// poll. Wallets load one after another to respect the venue's rate budget;
// funding lands in a second pass so the numbers show before it is fetched.
function usePerformance(wallets: Wallet[] | null, active: boolean) {
  const [perfs, setPerfs] = useState<Record<string, WalletPerf>>({});
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const busy = useRef(false);
  const walletsRef = useRef<Wallet[]>([]);
  walletsRef.current = wallets ?? [];
  const walletKey = (wallets ?? []).map((w) => w.address.toLowerCase()).join(",");

  const reload = useCallback(async () => {
    const ws = walletsRef.current;
    if (!ws.length || busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const now = Date.now();
      const loaded: WalletPerf[] = [];
      for (const w of ws) {
        const p = await loadWalletPerformance(w.address, now);
        loaded.push(p);
        setPerfs((m) => ({ ...m, [w.address.toLowerCase()]: p }));
      }
      const errs = loaded.filter((p) => p.error).map((p) => p.error as string);
      setNote(errs.length ? "history sync: " + errs[0] + " (showing cached data)" : null);
      for (const p of loaded) {
        const withFunding = await addFunding(p, now);
        setPerfs((m) => ({ ...m, [p.address.toLowerCase()]: withFunding }));
      }
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active || !walletKey) return;
    reload();
    const t = setInterval(reload, PERF_REFRESH_MS);
    return () => clearInterval(t);
  }, [active, walletKey, reload]);

  return { perfs, loading, note, reload };
}

// The MyFundedPerps account's history, on the same five-minute schedule and
// only while a history view is open. A failed load keeps the last result.
// accountId is the stored view key's account: a key swapped in Settings
// reloads at once, and a result for another account is never kept (the
// screen also renders only a result whose account matches).
function useMfpPerformance(active: boolean, accountId: string | null) {
  const [mp, setMp] = useState<MfpPerf | null>(null);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const want = useRef<string | null>(accountId);
  useEffect(() => { want.current = accountId; }, [accountId]);

  const reload = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      // A key swapped while this loaded answers for the old account: one
      // more pass picks up the new one.
      for (let pass = 0; pass < 2; pass++) {
        const r = await loadMfpPerformance();
        if (r === null || r.meta.accountId === want.current) { setMp(r); break; }
      }
    } catch {
      // keeps the last result; loadMfpPerformance reports sync errors itself
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active || accountId === null) return;
    reload();
    const t = setInterval(reload, PERF_REFRESH_MS);
    return () => clearInterval(t);
  }, [active, accountId, reload]);

  return { mp, loading, reload };
}

export default function PortfolioScreen() {
  const insets = useSafeAreaInsets();
  const [wallets, setWallets] = useState<Wallet[] | null>(null); // null = not loaded yet
  const [pfs, setPfs] = useState<(Portfolio | null)[]>([]);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [sel, setSel] = useState<number>(ALL); // ALL or a wallet index
  const [view, setView] = useState<PortfolioView>("positions");
  const hist = view !== "positions";
  const perf = usePerformance(wallets, hist);
  // The MFP pill: shown in the history views once an MFP view key is stored.
  const [mfpMeta, setMfpMeta] = useState<MfpKeyMeta | null>(null);
  const [mfpSel, setMfpSel] = useState(false);
  const mfp = useMfpPerformance(hist, mfpMeta?.accountId ?? null);
  const showMfp = hist && mfpMeta !== null && mfpSel;
  const mfpData = mfp.mp && mfpMeta && mfp.mp.meta.accountId === mfpMeta.accountId ? mfp.mp : null;
  // Close / flatten controls exist only for wallets with an agent key on
  // this device, and only where the secure store exists (never on web).
  const [signing, setSigning] = useState(false);
  const [keyed, setKeyed] = useState<Record<string, boolean>>({});
  const [sheet, setSheet] = useState<{ mode: "one" | "all" | "reverse"; targets: CloseTarget[] } | null>(null);
  // MyFundedPerps polls itself; a pull-to-refresh bumps this to re-poll it too.
  const [mfpRefresh, setMfpRefresh] = useState(0);
  // Tabs stay mounted: leaving Portfolio closes the open chart (its WebView
  // and live candle stream).
  useFocusEffect(useCallback(() => () => closeAllCharts(), []));

  useEffect(() => { agentSigningAvailable().then(setSigning).catch(() => setSigning(false)); }, []);

  const load = useCallback(async () => {
    const ws = await getWallets();
    setWallets(ws);
    setSel((s) => (s !== ALL && s >= ws.length ? ALL : s));
    const metas = await Promise.all(ws.map((w) => getAgentMeta(w.address).catch(() => null)));
    setKeyed(Object.fromEntries(ws.map((w, i) => [w.address.toLowerCase(), metas[i] !== null])));
    setMfpMeta(await getMfpMeta("view").catch(() => null));
    if (!ws.length) { setPfs([]); return; }
    try {
      // Every wallet fetches each poll - the All view needs them anyway and a
      // pill switch should be instant, not a fresh network round-trip.
      const next = await fetchPortfolios(ws.map((w) => w.address));
      setPfs(next);
      setError("");
      // Continuity stamps: a coin newly present for a wallet gets a copy of
      // its served continuity now, while the entry is fresh. The fetch this
      // triggers also fills the served-state cache the cards subscribe to.
      next.forEach((pf, i) => {
        if (pf) noteOpenPositions(ws[i].address, pf.positions.map((p) => p.coin)).catch(() => undefined);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setMfpRefresh((n) => n + 1);
    await load();
    if (view !== "positions") await Promise.all([perf.reload(), mfpMeta ? mfp.reload() : Promise.resolve()]);
    setRefreshing(false);
  }, [load, view, perf, mfp, mfpMeta]);

  const many = (wallets?.length ?? 0) > 1;
  const viewIdx =
    wallets === null ? [] :
    sel === ALL ? wallets.map((_, i) => i) : [sel];
  const viewPfs = viewIdx
    .map((i) => ({ i, pf: pfs[i] ?? null }))
    .filter((x): x is { i: number; pf: Portfolio } => x.pf !== null);
  const offline = wallets
    ? viewIdx.filter((i) => pfs.length > i && pfs[i] === null).map((i) => walletName(wallets[i]))
    : [];

  const totalValue = viewPfs.reduce((acc, x) => acc + x.pf.totalValue, 0);
  const totalPnl = viewPfs.reduce(
    (acc, x) => acc + x.pf.positions.reduce((a, p) => a + p.unrealizedPnl, 0),
    0,
  );
  // One flat list across the viewed wallets, the same sort fetchPortfolio uses
  // per wallet (abs notional desc). Tags render only when the view mixes
  // wallets - a single account already says whose positions these are.
  const rows = viewPfs
    .flatMap((x) => x.pf.positions.map((p) => ({ p, wi: x.i })))
    .sort((a, b) => b.p.positionValue - a.p.positionValue);
  const loaded = viewPfs.length > 0;
  const canClose = (wi: number) => signing && wallets !== null && keyed[wallets[wi].address.toLowerCase()] === true;
  // Flatten targets: every viewed wallet that has a key and open positions.
  const flattenTargets: CloseTarget[] = wallets
    ? viewPfs.filter((x) => canClose(x.i) && x.pf.positions.length > 0).map((x) => ({ wallet: wallets[x.i], positions: x.pf.positions }))
    : [];
  // Live unrealized PnL per open position (wallet|coin), joined onto open
  // trades in the ledger - fills alone only know the fees paid so far.
  const unrealized: Record<string, number> = {};
  if (wallets) {
    pfs.forEach((pf, i) => {
      if (!pf) return;
      for (const p of pf.positions) unrealized[wallets[i].address.toLowerCase() + "|" + p.coin] = p.unrealizedPnl;
    });
  }

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={[
        s.content,
        { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 90 },
      ]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.muted} />
      }
    >
      <View style={s.titleRow}>
        <Text style={s.title}>Portfolio</Text>
        {wallets && wallets.length ? <ViewMenu value={view} onChange={setView} /> : null}
      </View>

      {wallets === null ? (
        <Text style={s.hint}>loading...</Text>
      ) : wallets.length === 0 ? (
        <View style={s.card}>
          <Text style={s.hint}>
            No wallet address set. Add your Hyperliquid address in the Settings
            tab - it is stored only on this device and used read-only against
            the public info API.
          </Text>
        </View>
      ) : (
        <>
          {(many || (hist && mfpMeta !== null)) && (
            <View style={s.walletRow}>
              {/* With one wallet the row exists only for the MFP pill, so the
                  wallet's own pill stands in for "All". */}
              {(many ? [ALL, ...wallets.map((_, i) => i)] : [ALL]).map((i) => {
                // The lone wallet's pill is lit whenever MFP is not (sel can
                // still be 0 after a second wallet was removed).
                const on = !showMfp && (many ? sel === i : true);
                return (
                  <Pressable
                    key={i}
                    onPress={() => { setSel(i); setMfpSel(false); }}
                    style={[s.walletBtn, on && s.walletBtnOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                  >
                    <Text style={[s.walletBtnText, on && s.walletBtnTextOn]}>
                      {i === ALL ? (many ? "All" : walletName(wallets[0])) : walletName(wallets[i])}
                    </Text>
                  </Pressable>
                );
              })}
              {hist && mfpMeta !== null ? (
                <Pressable
                  onPress={() => setMfpSel(true)}
                  style={[s.walletBtn, showMfp && s.walletBtnOn]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: showMfp }}
                  accessibilityLabel="MyFundedPerps account"
                >
                  <Text style={[s.walletBtnText, showMfp && s.walletBtnTextOn]}>MFP</Text>
                </Pressable>
              ) : null}
            </View>
          )}

          {showMfp && mfpMeta ? (
            <Text style={s.addr}>
              {"MyFundedPerps " + (mfpMeta.name || "account") + (mfpMeta.accountNumber ? " #" + mfpMeta.accountNumber : "") +
                (mfpMeta.env === "sandbox" ? " (sandbox)" : "")}
            </Text>
          ) : (
            <Text style={s.addr}>
              {sel === ALL
                ? wallets.length === 1
                  ? wallets[0].address.slice(0, 6) + "..." + wallets[0].address.slice(-4)
                  : wallets.length + " accounts"
                : wallets[sel].address.slice(0, 6) + "..." + wallets[sel].address.slice(-4)}
              {error ? "  (offline - " + error + ")" : ""}
              {!error && offline.length ? "  (" + offline.join(", ") + " unreachable)" : ""}
            </Text>
          )}

          {showMfp ? (
            mfpData ? (
              view === "performance" ? (
                <PerformanceView
                  wallets={[{ label: "MFP", address: mfpData.perf.address }]}
                  sel={0}
                  perfs={{ [mfpData.perf.address.toLowerCase()]: mfpData.perf }}
                  loading={mfp.loading}
                  note={mfpNote(mfpData)}
                  onOpenTrades={() => setView("trades")}
                  source="mfp"
                />
              ) : (
                <TradesView
                  wallets={[{ label: "MFP", address: mfpData.perf.address }]}
                  sel={0}
                  perfs={{ [mfpData.perf.address.toLowerCase()]: mfpData.perf }}
                  loading={mfp.loading}
                  note={mfpNote(mfpData)}
                  unrealized={NO_UNREALIZED}
                />
              )
            ) : (
              <View style={s.card}>
                <Text style={s.hint}>{mfp.loading ? "loading MyFundedPerps history..." : "no MyFundedPerps history loaded yet - pull to refresh"}</Text>
              </View>
            )
          ) : view === "performance" ? (
            <PerformanceView
              wallets={wallets}
              sel={sel}
              perfs={perf.perfs}
              loading={perf.loading}
              note={perf.note}
              onOpenTrades={() => setView("trades")}
            />
          ) : view === "trades" ? (
            <TradesView wallets={wallets} sel={sel} perfs={perf.perfs} loading={perf.loading} note={perf.note} unrealized={unrealized} />
          ) : (
            <>
              <View style={s.summaryCard}>
                <View style={s.summaryCell}>
                  <Text style={s.summaryLabel}>Account value</Text>
                  <Text style={s.summaryValue}>{loaded ? fmtUsd(totalValue) : "-"}</Text>
                </View>
                <View style={s.summaryCell}>
                  <Text style={s.summaryLabel}>Unrealized PnL</Text>
                  <Text style={[
                    s.summaryValue,
                    { color: totalPnl > 0 ? C.bull : totalPnl < 0 ? C.bear : C.text },
                  ]}>
                    {loaded ? fmtUsd(totalPnl) : "-"}
                  </Text>
                </View>
              </View>

              {sel === ALL && many && loaded && (
                <View style={s.dexRow}>
                  {viewPfs.map((x) => (
                    <View key={x.i} style={s.dexPill}>
                      <Text style={s.dexPillText}>
                        {walletName(wallets[x.i]) + " " + fmtUsd(x.pf.totalValue)}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
              {sel !== ALL && viewPfs.length === 1 && viewPfs[0].pf.dexes.length > 1 && (
                <View style={s.dexRow}>
                  {viewPfs[0].pf.dexes.map((d) => (
                    <View key={d.dex || "main"} style={s.dexPill}>
                      <Text style={s.dexPillText}>
                        {(d.dex || "main") + " " + fmtUsd(d.accountValue)}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              <View style={s.sectionRow}>
                <Text style={s.section}>
                  Positions{loaded ? " (" + rows.length + ")" : ""}
                </Text>
                {flattenTargets.length ? (
                  <Pressable
                    onPress={() => setSheet({ mode: "all", targets: flattenTargets })}
                    hitSlop={8}
                    style={({ pressed }) => [s.dangerBtn, pressed && { opacity: 0.7 }]}
                    accessibilityRole="button"
                  >
                    <Text style={s.dangerBtnText}>
                      {"Flatten " + (sel === ALL && many ? "all" : walletName(wallets[sel === ALL ? 0 : sel]))}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              {loaded && rows.length === 0 && (
                <Text style={s.hint}>no open perp positions</Text>
              )}
              {rows.map(({ p, wi }) => (
                <PositionCard
                  key={wi + ":" + p.dex + ":" + p.coin}
                  p={p}
                  chartKey={"hl|" + wallets[wi].address.toLowerCase() + "|" + p.coin}
                  walletTag={sel === ALL && many ? walletName(wallets[wi]) : null}
                  onClose={canClose(wi) ? () => setSheet({ mode: "one", targets: [{ wallet: wallets[wi], positions: [p] }] }) : undefined}
                  // Not on an automated wallet: opening a position under
                  // another trading process is not the venue-level exit a close is.
                  onReverse={canClose(wi) && !wallets[wi].automated ? () => setSheet({ mode: "reverse", targets: [{ wallet: wallets[wi], positions: [p] }] }) : undefined}
                />
              ))}
            </>
          )}
        </>
      )}
      {/* Its own block, never summed into the Hyperliquid totals above
          (design decision); renders nothing until an MFP view key is stored. */}
      {wallets !== null && (view === "positions" || wallets.length === 0) ? (
        <MfpSection refreshSignal={mfpRefresh} />
      ) : null}
      <CloseSheet
        visible={sheet !== null}
        mode={sheet?.mode ?? "one"}
        targets={sheet?.targets ?? []}
        onClose={() => setSheet(null)}
        onFinished={() => { load(); }}
      />
    </ScrollView>
  );
}

// The coin's CURRENT served continuity beside the position: the fast FTFC
// dots and reading, the D/W/M slow layer, and how they sit against the
// position's side. Subscribes to the scanner's last served row
// (state_cache) so the line appears when the payload lands; a coin the
// worker does not serve shows nothing.
function ContinuityLine({ p, onClose, onReverse, chartOpen, onChart }: {
  p: Position; onClose?: () => void; onReverse?: () => void; chartOpen: boolean; onChart: () => void;
}) {
  const c = useSyncExternalStore(subscribeServed, () => servedCoinSnapshot(p.coin));
  // Chart, then Reverse, then Close (Reverse sits
  // before Close by design; both open the same confirm sheet - hold, then
  // fingerprint). Chart needs no key, so it is always there.
  const closeBtn = (
    <View style={s.actBtns}>
      <Pressable onPress={onChart} hitSlop={8} style={({ pressed }) => [s.closeBtn, s.chartBtn, chartOpen && s.chartBtnOn, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityState={{ expanded: chartOpen }} accessibilityLabel={(chartOpen ? "Hide" : "Show") + " the " + p.coin + " chart"}>
        <Text style={[s.closeBtnText, s.chartBtnText, chartOpen && { color: C.bull }]}>{chartOpen ? "Chart -" : "Chart +"}</Text>
      </Pressable>
      {onReverse ? (
        <Pressable onPress={onReverse} hitSlop={8} style={({ pressed }) => [s.closeBtn, s.revBtn, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={"Reverse " + p.coin}>
          <Text style={[s.closeBtnText, s.revBtnText]}>Reverse</Text>
        </Pressable>
      ) : null}
      {onClose ? (
        <Pressable onPress={onClose} hitSlop={8} style={({ pressed }) => [s.closeBtn, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={"Close " + p.coin}>
          <Text style={s.closeBtnText}>Close</Text>
        </Pressable>
      ) : null}
    </View>
  );
  if (!c) {
    // Unserved coin: no continuity to show, but the controls still need their row.
    return <View style={s.contRow}><View style={{ flex: 1 }} />{closeBtn}</View>;
  }
  const long = p.szi > 0;
  const rel = c.ftfc === "mixed" ? "mixed"
    : c.ftfc === "up" ? (long ? "with" : "against")
    : c.ftfc === "down" ? (long ? "against" : "with")
    : null;
  const relColor = rel === "with" ? C.bull : rel === "against" ? C.bear : rel === "mixed" ? C.warn : C.faint;
  const dwm = c.dwmContinuity ? ["1d", "1w", "1M"].map((k) => c.dwmContinuity?.dots[k] ?? "flat") : null;
  return (
    <View style={s.contRow}>
      <View style={s.dots}>{c.dots.map((d, i) => <Dot key={i} dir={d} />)}</View>
      <Text style={[s.ftfcText, { color: c.ftfc === "up" ? C.bull : c.ftfc === "down" ? C.bear : C.muted }]}>
        {c.ftfc === "up" || c.ftfc === "down" ? c.ftfc.toUpperCase() : c.ftfc === "mixed" ? "MIXED" : "-"}
      </Text>
      {dwm ? (
        <>
          <View style={[s.dots, { marginLeft: 6 }]}>{dwm.map((d, i) => <Dot key={i} dir={d} size={6} />)}</View>
          <Text style={s.dwmText}>{"D/W/M " + dwm.filter((d) => d === "up").length + "/3 up"}</Text>
        </>
      ) : null}
      {rel ? <Text style={[s.relation, { color: relColor }]}>{rel + " position"}</Text> : null}
      {closeBtn}
    </View>
  );
}

function PositionCard({ p, walletTag, chartKey, onClose, onReverse }: {
  p: Position; walletTag: string | null; chartKey: string; onClose?: () => void; onReverse?: () => void;
}) {
  const chartOpen = useSyncExternalStore(subscribeChart, openChartKey) === chartKey;
  // A position that closes takes its chart with it (no surprise re-open).
  useEffect(() => () => closeChart(chartKey), [chartKey]);
  const long = p.szi > 0;
  const sideColor = long ? C.bull : C.bear;
  const pnlColor = p.unrealizedPnl > 0 ? C.bull : p.unrealizedPnl < 0 ? C.bear : C.muted;
  const sym = p.coin.includes(":") ? p.coin.split(":")[1] : p.coin;
  return (
    <View style={s.card}>
      <View style={s.posTop}>
        <Text style={s.posSym}>{sym}</Text>
        <View style={[s.sideBadge, { backgroundColor: long ? C.bullBg : C.bearBg }]}>
          <Text style={[s.sideBadgeText, { color: sideColor }]}>
            {(long ? "LONG" : "SHORT") + (p.leverage ? " " + p.leverage + "x" : "")}
          </Text>
        </View>
        {p.dex ? (
          <View style={s.dexPill}><Text style={s.dexPillText}>{p.dex}</Text></View>
        ) : null}
        {walletTag ? (
          <View style={s.dexPill}><Text style={s.dexPillText}>{walletTag}</Text></View>
        ) : null}
        <Text style={[s.posPnl, { color: pnlColor }]}>{fmtUsd(p.unrealizedPnl)}</Text>
      </View>
      <View style={s.posGrid}>
        <PosCell label="Size" value={Math.abs(p.szi).toString()} />
        <PosCell label="Notional" value={fmtUsd(p.positionValue)} />
        <PosCell label="Entry" value={fmtPx(p.entryPx)} />
        <PosCell label="Liq" value={fmtPx(p.liquidationPx)} />
        <PosCell
          label="ROE"
          value={fmtPct(p.returnOnEquity * 100)}
          color={p.returnOnEquity > 0 ? C.bull : p.returnOnEquity < 0 ? C.bear : undefined}
        />
        <PosCell label="Margin" value={fmtUsd(p.marginUsed)} />
      </View>
      {chartOpen ? (
        <PositionChart
          title={sym + " " + (long ? "long" : "short")}
          coin={p.coin}
          sourceNote={null}
          servedCoinId={p.coin}
          entry={p.entryPx}
          liq={p.liquidationPx}
          onClosePos={onClose}
          onReversePos={onReverse}
        />
      ) : null}
      <ContinuityLine p={p} onClose={onClose} onReverse={onReverse} chartOpen={chartOpen} onChart={() => toggleChart(chartKey)} />
    </View>
  );
}

function PosCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={s.posCell}>
      <Text style={s.posCellLabel}>{label}</Text>
      <Text style={[s.posCellValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: { paddingHorizontal: 14 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  title: { color: C.text, fontSize: 17, fontWeight: "600" },
  addr: { color: C.faint, fontSize: 12, marginBottom: 10, fontVariant: ["tabular-nums"] },
  hint: { color: C.muted, fontSize: 13, lineHeight: 19 },
  walletRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 10 },
  walletBtn: {
    borderWidth: 1, borderColor: C.border, borderRadius: 999,
    paddingHorizontal: 12, paddingVertical: 5, backgroundColor: C.card,
  },
  walletBtnOn: { borderColor: "rgba(0,220,130,0.35)", backgroundColor: C.bullBg },
  walletBtnText: { color: C.muted, fontSize: 12, fontWeight: "500" },
  walletBtnTextOn: { color: C.bull },
  card: {
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    borderRadius: 10, padding: 12, marginBottom: 8,
  },
  summaryCard: {
    flexDirection: "row", backgroundColor: C.card, borderWidth: 1,
    borderColor: C.border, borderRadius: 10, marginBottom: 10,
  },
  summaryCell: { flex: 1, padding: 12 },
  summaryLabel: {
    fontSize: 10, fontWeight: "500", textTransform: "uppercase",
    letterSpacing: 0.7, color: C.muted,
  },
  summaryValue: {
    fontSize: 20, fontWeight: "600", color: C.text, marginTop: 3,
    fontVariant: ["tabular-nums"],
  },
  dexRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 12 },
  dexPill: {
    borderWidth: 1, borderColor: C.border, borderRadius: 999,
    paddingHorizontal: 8, paddingVertical: 2, backgroundColor: C.card,
  },
  dexPillText: { color: C.muted, fontSize: 10.5, fontVariant: ["tabular-nums"] },
  section: {
    color: C.muted, fontSize: 11, fontWeight: "500", textTransform: "uppercase",
    letterSpacing: 0.7, marginTop: 6, marginBottom: 8,
  },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  dangerBtn: {
    borderWidth: 1, borderColor: "rgba(255,59,92,0.35)", borderRadius: 6,
    paddingHorizontal: 9, paddingVertical: 3, marginBottom: 8, minHeight: 28, justifyContent: "center",
  },
  dangerBtnText: { color: C.bear, fontSize: 11, fontWeight: "600" },
  closeBtn: {
    borderWidth: 1, borderColor: "rgba(255,59,92,0.35)", borderRadius: 6,
    paddingHorizontal: 9, paddingVertical: 3, marginLeft: 8, minHeight: 26, justifyContent: "center",
  },
  closeBtnText: { color: C.bear, fontSize: 11, fontWeight: "600" },
  actBtns: { flexDirection: "row", alignItems: "center" },
  revBtn: { borderColor: "rgba(59,130,246,0.35)" },
  revBtnText: { color: C.info },
  chartBtn: { borderColor: C.border },
  chartBtnOn: { borderColor: "rgba(0,220,130,0.35)" },
  chartBtnText: { color: C.muted },
  posTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  posSym: { color: C.text, fontSize: 15, fontWeight: "600" },
  sideBadge: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 },
  sideBadgeText: { fontSize: 10.5, fontWeight: "600" },
  posPnl: { marginLeft: "auto", fontSize: 14, fontWeight: "600", fontVariant: ["tabular-nums"] },
  posGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 9 },
  posCell: { width: "33.33%", paddingVertical: 3 },
  posCellLabel: { color: C.faint, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  posCellValue: { color: C.text, fontSize: 12.5, marginTop: 1, fontVariant: ["tabular-nums"] },
  contRow: {
    flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap",
    marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border,
  },
  dots: { flexDirection: "row", alignItems: "center" },
  ftfcText: { fontSize: 11, fontWeight: "600", marginLeft: 2 },
  dwmText: { fontSize: 10, color: C.faint, marginLeft: 2 },
  relation: { marginLeft: "auto", fontSize: 10.5, fontWeight: "600" },
});
