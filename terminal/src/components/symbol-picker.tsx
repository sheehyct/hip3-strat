// The symbol picker: a searchable list of every market on both venues,
// grouped by chart coin (one row per instrument, with the venues that list
// it). Tap a row to chart it; the star adds / removes it from the
// watchlist. A sheet on the phone, a modal panel on desktop.
import Ionicons from "@expo/vector-icons/Ionicons";
import { useMemo, useState, useSyncExternalStore } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { fmtPct, fmtPx } from "@/lib/fmt";
import { getSettings, subscribeSettings, toggleWatch } from "@/lib/settings_store";
import { midOf, subscribeTicker, tickerState } from "@/lib/ticker_store";
import type { Market } from "@/lib/types";
import { subscribeVenues, venueState } from "@/lib/venue_store";
import { C, F, S, T } from "@/theme";

type Row = { id: string; symbol: string; chartCoin: string | null; markets: Market[]; price: number | null; chg: number | null };

export function SymbolPicker({ visible, onClose, onPick, phone }: { visible: boolean; onClose: () => void; onPick: (m: Market) => void; phone: boolean }) {
  const venues = useSyncExternalStore(subscribeVenues, venueState);
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  useSyncExternalStore(subscribeTicker, tickerState);
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState("");

  const rows = useMemo<Row[]>(() => {
    const groups = new Map<string, Row>();
    for (const m of venues.markets) {
      const id = m.chartCoin ?? m.key;
      let r = groups.get(id);
      if (!r) { r = { id, symbol: m.symbol, chartCoin: m.chartCoin, markets: [], price: null, chg: null }; groups.set(id, r); }
      r.markets.push(m);
      if (m.venue === "hl") r.symbol = m.symbol;
    }
    const list = [...groups.values()];
    for (const r of list) {
      r.price = midOf(r.chartCoin) ?? (r.markets[0] ? venues.mids[r.markets[0].key] ?? null : null);
      r.chg = (r.chartCoin ? venues.chg24["hl:" + r.chartCoin] : undefined) ?? (r.markets[0] ? venues.chg24[r.markets[0].key] : undefined) ?? null;
    }
    const needle = q.trim().toLowerCase();
    const out = needle ? list.filter((r) => r.symbol.toLowerCase().includes(needle) || r.id.toLowerCase().includes(needle) || r.markets.some((m) => m.id.toLowerCase().includes(needle))) : list;
    out.sort((a, b) => {
      const aw = a.markets.some((m) => settings.watchlist.includes(m.key)) ? 0 : 1;
      const bw = b.markets.some((m) => settings.watchlist.includes(m.key)) ? 0 : 1;
      return aw - bw || a.symbol.localeCompare(b.symbol);
    });
    return out.slice(0, 400);
  }, [venues.markets, venues.mids, venues.chg24, q, settings.watchlist]);

  const pick = (r: Row) => {
    const m = r.markets.find((x) => x.venue === "hl") ?? r.markets[0];
    if (m) { onPick(m); onClose(); }
  };
  const starKey = (r: Row) => (r.markets.find((x) => x.venue === "hl") ?? r.markets[0]).key;

  return (
    <Modal visible={visible} transparent animationType={phone ? "slide" : "fade"} onRequestClose={onClose} statusBarTranslucent>
      <View style={[p.backdrop, !phone && p.backdropDesk]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
        <View style={[p.sheet, phone ? { paddingBottom: insets.bottom + 8, maxHeight: "85%" } : p.sheetDesk]}>
          <View style={p.head}>
            <Ionicons name="search" size={16} color={C.faint} />
            <TextInput value={q} onChangeText={setQ} placeholder="Search markets (BTC, NVDA, SP500...)" placeholderTextColor={C.faint} autoFocus={!phone} autoCapitalize="characters" autoCorrect={false} style={p.input} />
            <Pressable onPress={onClose} hitSlop={8} style={p.close} accessibilityRole="button" accessibilityLabel="Close"><Ionicons name="close" size={20} color={C.muted} /></Pressable>
          </View>
          <FlatList
            data={rows}
            keyExtractor={(r) => r.id}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item: r }) => {
              const starred = r.markets.some((m) => settings.watchlist.includes(m.key));
              const chgColor = r.chg === null ? C.faint : r.chg >= 0 ? C.bull : C.bear;
              return (
                <Pressable onPress={() => pick(r)} style={({ pressed }) => [p.row, pressed && { backgroundColor: C.cardActive }]} accessibilityRole="button" accessibilityLabel={"Chart " + r.symbol}>
                  <Pressable onPress={() => toggleWatch(starKey(r))} hitSlop={8} style={p.star} accessibilityRole="button" accessibilityLabel={(starred ? "Remove " : "Add ") + r.symbol + (starred ? " from" : " to") + " the watchlist"}>
                    <Ionicons name={starred ? "star" : "star-outline"} size={16} color={starred ? C.warn : C.faint} />
                  </Pressable>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={p.sym}>{r.symbol}</Text>
                    <View style={p.badges}>
                      {r.markets.map((m) => <Text key={m.key} style={[p.badge, m.venue === "mfp" && p.badgeMfp]}>{(m.venue === "hl" ? "HL " : "MFP ") + (m.venue === "mfp" && m.provider && m.provider !== "hyperliquid" ? m.provider : m.id.replace(/^hyperliquid\|/, ""))}</Text>)}
                      {!r.chartCoin ? <Text style={p.nochart}>no chart source</Text> : null}
                    </View>
                  </View>
                  <View style={p.right}>
                    <Text style={p.px}>{fmtPx(r.price)}</Text>
                    <Text style={[p.chg, { color: chgColor }]}>{fmtPct(r.chg)}</Text>
                  </View>
                </Pressable>
              );
            }}
            ListEmptyComponent={<Text style={p.note}>{venues.markets.length ? "no match" : "markets loading..."}</Text>}
          />
        </View>
      </View>
    </Modal>
  );
}

const p = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.55)" },
  backdropDesk: { justifyContent: "center", alignItems: "center" },
  sheet: { backgroundColor: C.raised, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderColor: C.border },
  sheetDesk: { width: 520, maxWidth: "92%", height: 600, maxHeight: "85%", borderRadius: 14 },
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  input: { ...F.regular, flex: 1, minWidth: 0, color: C.text, fontSize: T.bodyL, minHeight: 40 },
  close: { minWidth: 36, minHeight: 36, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  star: { minWidth: 32, minHeight: 40, alignItems: "center", justifyContent: "center" },
  sym: { ...F.semibold, color: C.text, fontSize: T.body },
  badges: { flexDirection: "row", flexWrap: "wrap", columnGap: 8 },
  badge: { ...F.regular, color: C.accentText, fontSize: T.micro },
  badgeMfp: { color: C.warn },
  nochart: { ...F.regular, color: C.faint, fontSize: T.micro },
  right: { alignItems: "flex-end", gap: 1, minWidth: 80 },
  px: { ...F.medium, color: C.text, fontSize: T.caption, fontVariant: ["tabular-nums"] },
  chg: { ...F.regular, fontSize: T.micro, fontVariant: ["tabular-nums"] },
  note: { ...F.regular, color: C.faint, fontSize: T.caption, padding: S.gutter },
});
