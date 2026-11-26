// The trade screen: one chart-first screen in two layouts from the same
// components.
// - Desktop (wide): drawing toolbar on the left edge of the chart, the chart
//   in the center, the watchlist column beside it, the order panel on the
//   right, bottom tabs for Positions / Open Orders / Order History, and a
//   thin status bar.
// - Phone (narrow): the chart fills the screen; positions, orders, history
//   and the order panel open as sheets from a bottom bar. Touch targets at
//   least 40 px tall.
// There is no full-screen mode that hides controls: the position tags and
// their X are on the chart in every view.
import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ActionConfirm } from "@/components/confirm-sheet";
import { HistoryTable } from "@/components/history-table";
import { Sheet } from "@/components/kit";
import { MarketChart } from "@/components/market-chart";
import { OrderPanel } from "@/components/order-panel";
import { OrdersTable } from "@/components/orders-table";
import { PositionsTable, VenueBadge } from "@/components/positions-table";
import { RiskStrip } from "@/components/risk-strip";
import { StatusBar } from "@/components/status-bar";
import { SymbolPicker } from "@/components/symbol-picker";
import { UnsettledStrip } from "@/components/unsettled-strip";
import { Watchlist } from "@/components/watchlist";
import { fmtPct, fmtPx } from "@/lib/fmt";
import { getSettings, subscribeSettings, updateSettings } from "@/lib/settings_store";
import { midOf, subscribeTicker, tickerState, watchBbo } from "@/lib/ticker_store";
import type { Market, Position } from "@/lib/types";
import { confirmReverse, dismissConfirm, marketByKey, startVenues, subscribeVenues, tradeBlocked, venueState } from "@/lib/venue_store";
import { C, F, S, T } from "@/theme";

const DESKTOP_MIN_W = 1000;
const WATCH_W = 210;
const PANEL_W = 300;
const BOTTOM_H = 230;
const CHROME_H = 36 + 18;   // tf chips + notes under the chart

type Tab = "positions" | "orders" | "history";
type PhoneSheet = null | "trade" | "positions" | "orders" | "history";

export default function TradeScreen() {
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const venues = useSyncExternalStore(subscribeVenues, venueState);
  useSyncExternalStore(subscribeTicker, tickerState);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  useEffect(() => { startVenues(); }, []);

  const phone = settings.layout === "phone" || (settings.layout === "auto" && width < DESKTOP_MIN_W);

  // The active market: the saved key, else BTC on Hyperliquid, else the
  // first market with a chart.
  const market: Market | null = useMemo(() => {
    const saved = marketByKey(settings.symbol);
    if (saved) return saved;
    return venues.markets.find((m) => m.key === "hl:BTC") ?? venues.markets.find((m) => m.chartCoin) ?? null;
  }, [settings.symbol, venues.markets]);
  const chartCoin = market?.chartCoin ?? null;
  const siblings = useMemo(() => venues.markets.filter((m) => m.chartCoin && m.chartCoin === chartCoin), [venues.markets, chartCoin]);
  useEffect(() => { watchBbo(chartCoin); }, [chartCoin]);

  const [blocked, setBlocked] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!market) return;
    tradeBlocked(market.venue).then((b) => { if (alive) setBlocked(b); }).catch(() => undefined);
    return () => { alive = false; };
  }, [market, venues.status, venues.mock]);
  const canTrade = venues.mock || blocked === null;

  const pick = (m: Market) => updateSettings({ symbol: m.key });
  const openPosition = (p: Position) => {
    const m = venues.markets.find((x) => x.key === p.venue + ":" + p.marketId) ?? venues.markets.find((x) => x.chartCoin === p.chartCoin);
    if (m) pick(m);
    setSheet(null);
  };

  const [picker, setPicker] = useState(false);
  const [sheet, setSheet] = useState<PhoneSheet>(null);
  const tab: Tab = settings.bottomTab;
  const mid = midOf(chartCoin) ?? (market ? venues.mids[market.key] ?? null : null);
  const chg = (chartCoin ? venues.chg24["hl:" + chartCoin] : undefined) ?? (market ? venues.chg24[market.key] : undefined) ?? null;
  const posCount = venues.positions.length;
  const ordCount = venues.orders.length;

  const header = (
    <View style={[s.header, { paddingTop: insets.top + 4 }]}>
      <Pressable onPress={() => setPicker(true)} style={({ pressed }) => [s.symBtn, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel="Pick a market">
        <Text style={s.sym}>{market?.symbol ?? "Market"}</Text>
        <Ionicons name="chevron-down" size={16} color={C.muted} />
      </Pressable>
      {market ? <VenueBadge venue={market.venue} /> : null}
      {siblings.filter((m) => m.key !== market?.key).map((m) => (
        <Pressable key={m.key} onPress={() => pick(m)} hitSlop={6} accessibilityRole="button" accessibilityLabel={"Trade " + m.symbol + " on " + m.venue}>
          <VenueBadge venue={m.venue} dim />
        </Pressable>
      ))}
      <Text style={s.price}>{fmtPx(mid)}</Text>
      <Text style={[s.chg, { color: chg === null ? C.faint : chg >= 0 ? C.bull : C.bear }]}>{fmtPct(chg)}</Text>
      {!phone && market?.chartNote ? <Text style={s.note} numberOfLines={1}>{market.chartNote}</Text> : null}
      <View style={{ flex: 1 }} />
      {!canTrade && !phone ? <Text style={s.blocked} numberOfLines={1}>{blocked}</Text> : null}
      {venues.mock ? <Text style={s.demo}>demo</Text> : null}
      <Pressable onPress={() => router.push("/settings")} hitSlop={8} style={s.icon} accessibilityRole="button" accessibilityLabel="Settings">
        <Ionicons name="settings-outline" size={20} color={C.muted} />
      </Pressable>
    </View>
  );

  if (phone) {
    const headerH = 48 + insets.top;
    const barH = 56 + insets.bottom;
    const statusH = 22;
    const toolbarH = 52;
    const riskH = 48;
    const chartH = Math.max(240, height - headerH - riskH - barH - statusH - CHROME_H - toolbarH);
    const bar = (label: string, icon: React.ComponentProps<typeof Ionicons>["name"], id: PhoneSheet, count?: number) => (
      <Pressable key={label} onPress={() => setSheet(id)} style={({ pressed }) => [s.barBtn, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={label}>
        <Ionicons name={icon} size={20} color={id === "trade" ? C.accentText : C.muted} />
        <Text style={[s.barText, id === "trade" && { color: C.accentText }]}>{label + (count ? " " + count : "")}</Text>
      </Pressable>
    );
    return (
      <View style={s.screen}>
        {header}
        <RiskStrip phone />
        <MarketChart coin={chartCoin} sourceNote={market?.chartNote ?? null} height={chartH} phone canTrade={canTrade} />
        <StatusBar phone />
        <View style={[s.bar, { paddingBottom: insets.bottom }]}>
          {bar("Trade", "swap-vertical", "trade")}
          {bar("Positions", "layers-outline", "positions", posCount)}
          {bar("Orders", "list-outline", "orders", ordCount)}
          {bar("History", "time-outline", "history")}
        </View>
        <UnsettledStrip top={headerH + riskH + 4} phone />
        <SymbolPicker visible={picker} onClose={() => setPicker(false)} onPick={pick} phone />
        <ActionConfirm request={venues.confirm} onCancel={dismissConfirm} onSend={confirmReverse} />
        <Sheet visible={sheet === "trade"} onClose={() => setSheet(null)} title={"Trade " + (market?.symbol ?? "")} maxHeightPct={0.92}>
          <OrderPanel market={market} siblings={siblings} onVenue={pick} phone />
        </Sheet>
        <Sheet visible={sheet === "positions"} onClose={() => setSheet(null)} title={"Positions (" + posCount + ")"}>
          <PositionsTable onOpen={openPosition} compact />
        </Sheet>
        <Sheet visible={sheet === "orders"} onClose={() => setSheet(null)} title={"Open orders (" + ordCount + ")"}>
          <OrdersTable compact />
        </Sheet>
        <Sheet visible={sheet === "history"} onClose={() => setSheet(null)} title="Order history">
          <HistoryTable compact />
        </Sheet>
      </View>
    );
  }

  const chartH = Math.max(260, height - (48 + insets.top) - 27 - BOTTOM_H - 24 - CHROME_H - insets.bottom);
  return (
    <View style={s.screen}>
      {header}
      <RiskStrip />
      <View style={s.main}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <MarketChart coin={chartCoin} sourceNote={market?.chartNote ?? null} height={chartH} phone={false} canTrade={canTrade} />
        </View>
        <View style={{ width: WATCH_W }}>
          <Watchlist active={market?.key ?? null} onPick={pick} onAdd={() => setPicker(true)} />
        </View>
        <View style={s.panelCol}>
          <OrderPanel market={market} siblings={siblings} onVenue={pick} phone={false} />
        </View>
      </View>
      <View style={[s.bottom, { height: BOTTOM_H }]}>
        <View style={s.tabs} accessibilityRole="tablist">
          {([["positions", "Positions", posCount], ["orders", "Open orders", ordCount], ["history", "Order history", 0]] as const).map(([id, label, n]) => {
            const on = tab === id;
            return (
              <Pressable key={id} onPress={() => updateSettings({ bottomTab: id })} style={s.tab} accessibilityRole="tab" accessibilityState={{ selected: on }}>
                <Text style={[s.tabText, on && s.tabTextOn]}>{label + (n ? " (" + n + ")" : "")}</Text>
                <View style={[s.tabBar, on && s.tabBarOn]} />
              </Pressable>
            );
          })}
        </View>
        <View style={{ flex: 1, minHeight: 0 }}>
          {tab === "positions" ? <PositionsTable onOpen={openPosition} /> : tab === "orders" ? <OrdersTable /> : <HistoryTable />}
        </View>
      </View>
      <StatusBar />
      <UnsettledStrip top={48 + insets.top + 27 + 6} />
      <SymbolPicker visible={picker} onClose={() => setPicker(false)} onPick={pick} phone={false} />
      <ActionConfirm request={venues.confirm} onCancel={dismissConfirm} onSend={confirmReverse} />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, minHeight: 44, borderBottomWidth: 1, borderBottomColor: C.border },
  symBtn: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 40, paddingHorizontal: 6, borderRadius: S.radiusSm },
  sym: { ...F.semibold, color: C.text, fontSize: T.h2 },
  price: { ...F.medium, color: C.text, fontSize: T.bodyL, fontVariant: ["tabular-nums"], marginLeft: 4 },
  chg: { ...F.medium, fontSize: T.caption, fontVariant: ["tabular-nums"] },
  note: { ...F.regular, color: C.faint, fontSize: T.micro, flexShrink: 1, marginLeft: 8 },
  blocked: { ...F.regular, color: C.warn, fontSize: T.micro, flexShrink: 1 },
  demo: { ...F.medium, color: C.warn, fontSize: T.micro, borderWidth: 1, borderColor: "rgba(255,184,0,0.45)", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  icon: { minWidth: 38, minHeight: 38, alignItems: "center", justifyContent: "center" },
  main: { flex: 1, flexDirection: "row", minHeight: 0 },
  panelCol: { width: PANEL_W, borderLeftWidth: 1, borderLeftColor: C.border },
  bottom: { borderTopWidth: 1, borderTopColor: C.border },
  tabs: { flexDirection: "row", alignItems: "flex-end", gap: 20, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: C.border, minHeight: 34 },
  tab: { paddingTop: 6, minHeight: 34, justifyContent: "flex-end" },
  tabText: { ...F.medium, color: C.muted, fontSize: T.caption, paddingBottom: 7 },
  tabTextOn: { color: C.text },
  tabBar: { height: 2, borderRadius: 2, backgroundColor: "transparent" },
  tabBarOn: { backgroundColor: C.accent },
  bar: { flexDirection: "row", borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.card },
  barBtn: { flex: 1, minHeight: 56, alignItems: "center", justifyContent: "center", gap: 2 },
  barText: { ...F.medium, color: C.muted, fontSize: T.micro },
});
