// Order history (both venues): fills, cancels, rejections, newest first.
// A rejected order reads "rejected: <venue text>", never pending.
import { useSyncExternalStore } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { VenueBadge } from "@/components/positions-table";
import { fmtDateTimeET, fmtPx, fmtSize, fmtUsd } from "@/lib/fmt";
import { subscribeVenues, venueState } from "@/lib/venue_store";
import { C, F, T } from "@/theme";

export function HistoryTable({ compact }: { compact?: boolean }) {
  const v = useSyncExternalStore(subscribeVenues, venueState);
  if (!v.history.length) return <View style={s.empty}><Text style={s.note}>no history yet</Text></View>;
  return (
    <ScrollView>
      {!compact ? (
        <View style={[s.row, s.head]}>
          <Text style={[s.cell, s.c2, s.h]}>Time (ET)</Text>
          <Text style={[s.cell, s.c1, s.h]}>Market</Text>
          <Text style={[s.cell, s.c2, s.h]}>Side</Text>
          <Text style={[s.cell, s.num, s.h]}>Size</Text>
          <Text style={[s.cell, s.num, s.h]}>Price</Text>
          <Text style={[s.cell, s.num, s.h]}>PnL</Text>
          <Text style={[s.cell, s.num, s.h]}>Fee</Text>
          <Text style={[s.cell, s.c3, s.h]}>Status</Text>
        </View>
      ) : null}
      {v.history.map((h) => {
        const stColor = h.status === "rejected" ? C.bear : h.status === "canceled" ? C.faint : h.status === "filled" ? C.text : C.muted;
        const sideColor = h.side === "buy" ? C.bull : h.side === "sell" ? C.bear : C.muted;
        if (compact) {
          return (
            <View key={h.key} style={s.card}>
              <View style={s.cardHead}>
                <VenueBadge venue={h.venue} />
                <Text style={s.sym}>{h.symbol}</Text>
                <Text style={[s.side, { color: sideColor }]}>{h.side ?? ""}</Text>
                <View style={{ flex: 1 }} />
                <Text style={s.time}>{fmtDateTimeET(h.time)}</Text>
              </View>
              <View style={s.cardKv}>
                <Text style={s.kv}>{fmtSize(h.size) + " @ " + fmtPx(h.price)}</Text>
                {h.pnl !== null ? <Text style={[s.kv, { color: h.pnl >= 0 ? C.bull : C.bear }]}>{fmtUsd(h.pnl, true)}</Text> : null}
                <Text style={[s.kv, { color: stColor }]} numberOfLines={2}>{h.text}</Text>
              </View>
            </View>
          );
        }
        return (
          <View key={h.key} style={s.row}>
            <Text style={[s.cell, s.c2, s.v, { color: C.faint }]}>{fmtDateTimeET(h.time)}</Text>
            <View style={[s.cell, s.c1, s.mk]}>
              <VenueBadge venue={h.venue} />
              <Text style={s.sym}>{h.symbol}</Text>
            </View>
            <Text style={[s.cell, s.c2, s.v, { color: sideColor }]}>{h.side ?? "-"}</Text>
            <Text style={[s.cell, s.num, s.v]}>{fmtSize(h.size)}</Text>
            <Text style={[s.cell, s.num, s.v]}>{fmtPx(h.price)}</Text>
            <Text style={[s.cell, s.num, s.v, h.pnl !== null ? { color: h.pnl >= 0 ? C.bull : C.bear } : { color: C.faint }]}>{h.pnl !== null ? fmtUsd(h.pnl, true) : "-"}</Text>
            <Text style={[s.cell, s.num, s.v, { color: C.faint }]}>{h.fee !== null ? fmtUsd(h.fee) : "-"}</Text>
            <Text style={[s.cell, s.c3, s.v, { color: stColor }]} numberOfLines={2}>{h.text}</Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  empty: { padding: 14 },
  note: { ...F.regular, color: C.faint, fontSize: T.caption },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, minHeight: 34, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, gap: 4 },
  head: { minHeight: 26, backgroundColor: C.card },
  h: { ...F.medium, color: C.faint, fontSize: T.micro },
  cell: { paddingVertical: 3 },
  c1: { minWidth: 120, flexGrow: 1.1, flexBasis: 0 },
  c2: { minWidth: 80, flexGrow: 0.8, flexBasis: 0 },
  c3: { minWidth: 160, flexGrow: 1.8, flexBasis: 0 },
  num: { minWidth: 80, flexGrow: 0.9, flexBasis: 0, textAlign: "right" },
  mk: { flexDirection: "row", alignItems: "center", gap: 6 },
  sym: { ...F.semibold, color: C.text, fontSize: T.caption },
  side: { ...F.medium, fontSize: T.caption, textTransform: "capitalize" },
  v: { ...F.regular, color: C.text, fontSize: T.caption, fontVariant: ["tabular-nums"] },
  time: { ...F.regular, color: C.faint, fontSize: T.micro, fontVariant: ["tabular-nums"] },
  card: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, padding: 12, gap: 4 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  cardKv: { flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 2 },
  kv: { ...F.regular, color: C.muted, fontSize: T.caption, fontVariant: ["tabular-nums"], flexShrink: 1 },
});
