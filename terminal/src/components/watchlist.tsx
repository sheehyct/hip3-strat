// The watchlist column: symbol, live price, 24h change, which venues list
// it. Editable: a row's x removes it; the symbol picker's star adds one.
// Tapping a row makes it the active market.
import Ionicons from "@expo/vector-icons/Ionicons";
import { useMemo, useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { fmtPct, fmtPx } from "@/lib/fmt";
import { getSettings, subscribeSettings, toggleWatch } from "@/lib/settings_store";
import { midOf, subscribeTicker, tickerState } from "@/lib/ticker_store";
import type { Market } from "@/lib/types";
import { subscribeVenues, venueState } from "@/lib/venue_store";
import { C, F, T } from "@/theme";

export type WatchRow = { key: string; symbol: string; chartCoin: string | null; venues: ("hl" | "mfp")[]; price: number | null; chg: number | null; market: Market | null };

// One row per watched market key, with the live price of its chart coin.
export function useWatchRows(): WatchRow[] {
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const venues = useSyncExternalStore(subscribeVenues, venueState);
  useSyncExternalStore(subscribeTicker, tickerState);
  return useMemo(() => settings.watchlist.map((key) => {
    const m = venues.markets.find((x) => x.key === key) ?? null;
    const symbol = m?.symbol ?? key.slice(key.indexOf(":") + 1).replace(/^xyz:/, "");
    const chartCoin = m?.chartCoin ?? null;
    const vs = venues.markets.filter((x) => x.chartCoin && x.chartCoin === chartCoin).map((x) => x.venue);
    const price = midOf(chartCoin) ?? (m ? venues.mids[m.key] ?? null : null);
    const chg = (chartCoin ? venues.chg24["hl:" + chartCoin] : undefined) ?? (m ? venues.chg24[m.key] : undefined) ?? null;
    return { key, symbol, chartCoin, venues: [...new Set(vs)], price, chg, market: m };
  }), [settings.watchlist, venues.markets, venues.mids, venues.chg24]);
}

export function Watchlist({ active, onPick, onAdd, phone }: { active: string | null; onPick: (m: Market) => void; onAdd: () => void; phone?: boolean }) {
  const rows = useWatchRows();
  return (
    <View style={w.col}>
      <View style={w.head}>
        <Text style={w.title}>Watchlist</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={onAdd} hitSlop={8} style={w.add} accessibilityRole="button" accessibilityLabel="Add a market to the watchlist">
          <Ionicons name="add" size={18} color={C.muted} />
        </Pressable>
      </View>
      <ScrollView>
        {rows.map((r) => {
          const on = r.market ? r.market.key === active || (active?.endsWith(":" + (r.chartCoin ?? "")) ?? false) : false;
          const chgColor = r.chg === null ? C.faint : r.chg >= 0 ? C.bull : C.bear;
          return (
            <Pressable key={r.key} onPress={() => { if (r.market) onPick(r.market); }} style={({ pressed }) => [w.row, phone && w.rowPhone, on && w.rowOn, pressed && { backgroundColor: C.cardActive }]} accessibilityRole="button" accessibilityLabel={"Chart " + r.symbol}>
              <View style={w.left}>
                <Text style={[w.sym, on && { color: C.text }]}>{r.symbol}</Text>
                <View style={w.badges}>
                  {r.venues.map((v) => <Text key={v} style={[w.badge, v === "mfp" && w.badgeMfp]}>{v === "hl" ? "HL" : "MFP"}</Text>)}
                </View>
              </View>
              <View style={w.right}>
                <Text style={w.px}>{fmtPx(r.price)}</Text>
                <Text style={[w.chg, { color: chgColor }]}>{fmtPct(r.chg)}</Text>
              </View>
              <Pressable onPress={() => toggleWatch(r.key)} hitSlop={6} style={w.x} accessibilityRole="button" accessibilityLabel={"Remove " + r.symbol + " from the watchlist"}>
                <Ionicons name="close" size={13} color={C.faint} />
              </Pressable>
            </Pressable>
          );
        })}
        {!rows.length ? <Text style={w.note}>empty - tap + to add markets</Text> : null}
      </ScrollView>
    </View>
  );
}

const w = StyleSheet.create({
  col: { flex: 1, borderLeftWidth: 1, borderLeftColor: C.border, backgroundColor: C.bg },
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, minHeight: 34, borderBottomWidth: 1, borderBottomColor: C.border },
  title: { ...F.semibold, color: C.muted, fontSize: T.caption },
  add: { minWidth: 30, minHeight: 30, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", paddingLeft: 10, paddingRight: 4, minHeight: 38, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  rowPhone: { minHeight: 46 },
  rowOn: { backgroundColor: C.card },
  left: { flex: 1, minWidth: 0, gap: 1 },
  sym: { ...F.semibold, color: C.muted, fontSize: T.body },
  badges: { flexDirection: "row", gap: 4 },
  badge: { ...F.medium, color: C.accentText, fontSize: 10.5, letterSpacing: 0.3 },
  badgeMfp: { color: C.warn },
  right: { alignItems: "flex-end", gap: 1 },
  px: { ...F.medium, color: C.text, fontSize: T.caption, fontVariant: ["tabular-nums"] },
  chg: { ...F.regular, fontSize: T.micro, fontVariant: ["tabular-nums"] },
  x: { minWidth: 24, minHeight: 30, alignItems: "center", justifyContent: "center" },
  note: { ...F.regular, color: C.faint, fontSize: T.micro, padding: 10 },
});
