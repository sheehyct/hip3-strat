// Open orders (both venues): venue, market, kind, side, price, size,
// reduce-only, with Cancel and an inline price edit (modify). Pending
// writes on an order dim its row.
import { useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { MiniInput } from "@/components/field";
import { VenueBadge } from "@/components/positions-table";
import { fmtDateTimeET, fmtPx, fmtSize } from "@/lib/fmt";
import type { OpenOrder } from "@/lib/types";
import { cancelOrder, marketLocks, modifyOrder, subscribeVenues, venueState } from "@/lib/venue_store";
import { C, F, S, T } from "@/theme";

const KIND_LABEL: Record<OpenOrder["kind"], string> = { limit: "limit", tp: "take profit", sl: "stop loss", market: "market", other: "order" };

export function OrdersTable({ compact, onOpen }: { compact?: boolean; onOpen?: (o: OpenOrder) => void }) {
  const v = useSyncExternalStore(subscribeVenues, venueState);
  const [edit, setEdit] = useState<{ key: string; price: string } | null>(null);
  if (!v.orders.length) return <View style={s.empty}><Text style={s.note}>no open orders</Text></View>;
  // Only a write IN FLIGHT replaces the row's buttons with its text; one
  // the venue has not settled yet leaves Cancel available.
  const pendingOn = (o: OpenOrder) => v.pending.find((x) => x.state === "working" && (x.orderKey === o.key || (x.kind === "flat" && x.venue === o.venue && x.marketId === o.marketId))) ?? null;
  const commit = (o: OpenOrder) => {
    if (!edit || edit.key !== o.key) return;
    const px = parseFloat(edit.price);
    setEdit(null);
    if (Number.isFinite(px) && px > 0 && Math.abs(px - o.price) > 1e-12) modifyOrder(o.key, px, null);
  };
  return (
    <ScrollView>
      {!compact ? (
        <View style={[s.row, s.head]}>
          <Text style={[s.cell, s.c1, s.h]}>Market</Text>
          <Text style={[s.cell, s.c2, s.h]}>Type</Text>
          <Text style={[s.cell, s.c2, s.h]}>Side</Text>
          <Text style={[s.cell, s.num, s.h]}>Price</Text>
          <Text style={[s.cell, s.num, s.h]}>Size</Text>
          <Text style={[s.cell, s.c2, s.h]}>Placed</Text>
          <View style={[s.cell, s.acts]} />
        </View>
      ) : null}
      {v.orders.map((o) => {
        const pend = pendingOn(o);
        // A move re-arranges orders: it waits for any unsettled write on the
        // market, exactly as the store does. Cancel never does.
        const moveLocked = marketLocks(v.pending, o.venue, o.marketId).open;
        const editing = edit?.key === o.key && !moveLocked;
        const sideColor = o.side === "buy" ? C.bull : C.bear;
        const acts = pend ? <Text style={s.pending} numberOfLines={2}>{pend.text}</Text> : (
          <View style={s.actRow}>
            {editing ? (
              <>
                <MiniInput value={edit.price} onChange={(t) => setEdit({ key: o.key, price: t })} width={96} />
                <Pressable onPress={() => commit(o)} style={s.act}><Text style={[s.actText, { color: C.accentText }]}>Send</Text></Pressable>
                <Pressable onPress={() => setEdit(null)} style={s.act}><Text style={s.actText}>Esc</Text></Pressable>
              </>
            ) : (
              <>
                <Pressable onPress={() => setEdit({ key: o.key, price: String(o.price) })} disabled={moveLocked} style={[s.act, moveLocked && { opacity: 0.4 }]} accessibilityRole="button" accessibilityLabel={"Move " + KIND_LABEL[o.kind] + " on " + o.symbol + (moveLocked ? " (waiting for an unsettled write)" : "")}><Text style={s.actText}>Move</Text></Pressable>
                <Pressable onPress={() => cancelOrder(o.key)} style={[s.act, s.actDanger]} accessibilityRole="button" accessibilityLabel={"Cancel " + KIND_LABEL[o.kind] + " on " + o.symbol}><Text style={[s.actText, { color: C.bear }]}>Cancel</Text></Pressable>
              </>
            )}
          </View>
        );
        if (compact) {
          return (
            <Pressable key={o.key} onPress={() => onOpen?.(o)} style={[s.card, pend && s.dim]}>
              <View style={s.cardHead}>
                <VenueBadge venue={o.venue} />
                <Text style={s.sym}>{o.symbol}</Text>
                <Text style={s.kind}>{KIND_LABEL[o.kind] + (o.reduceOnly ? " reduce-only" : "")}</Text>
                <View style={{ flex: 1 }} />
                <Text style={[s.side, { color: sideColor }]}>{o.side}</Text>
              </View>
              <View style={s.cardKv}>
                <Text style={s.kv}>{"price " + fmtPx(o.price)}</Text>
                <Text style={s.kv}>{"size " + fmtSize(o.size)}</Text>
                {o.createdAt ? <Text style={s.kv}>{fmtDateTimeET(o.createdAt) + " ET"}</Text> : null}
              </View>
              {acts}
            </Pressable>
          );
        }
        return (
          <View key={o.key} style={[s.row, pend && s.dim]}>
            <View style={[s.cell, s.c1, s.mk]}>
              <VenueBadge venue={o.venue} />
              <Text style={s.sym}>{o.symbol}</Text>
            </View>
            <Text style={[s.cell, s.c2, s.v]}>{KIND_LABEL[o.kind] + (o.reduceOnly ? " (ro)" : "")}</Text>
            <Text style={[s.cell, s.c2, s.v, { color: sideColor }]}>{o.side}</Text>
            <Text style={[s.cell, s.num, s.v]}>{fmtPx(o.price)}</Text>
            <Text style={[s.cell, s.num, s.v]}>{fmtSize(o.size)}</Text>
            <Text style={[s.cell, s.c2, s.v, { color: C.faint }]}>{o.createdAt ? fmtDateTimeET(o.createdAt) : "-"}</Text>
            <View style={[s.cell, s.acts]}>{acts}</View>
          </View>
        );
      })}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  empty: { padding: 14 },
  note: { ...F.regular, color: C.faint, fontSize: T.caption },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, minHeight: 40, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, gap: 4 },
  head: { minHeight: 26, backgroundColor: C.card },
  h: { ...F.medium, color: C.faint, fontSize: T.micro },
  cell: { paddingVertical: 4 },
  c1: { minWidth: 130, flexGrow: 1.2, flexBasis: 0 },
  c2: { minWidth: 90, flexGrow: 0.9, flexBasis: 0 },
  num: { minWidth: 90, flexGrow: 1, flexBasis: 0, textAlign: "right" },
  acts: { minWidth: 220, flexGrow: 1.4, flexBasis: 0, alignItems: "flex-end" },
  mk: { flexDirection: "row", alignItems: "center", gap: 6 },
  sym: { ...F.semibold, color: C.text, fontSize: T.body },
  kind: { ...F.regular, color: C.muted, fontSize: T.micro },
  side: { ...F.medium, fontSize: T.caption, textTransform: "capitalize" },
  v: { ...F.medium, color: C.text, fontSize: T.caption, fontVariant: ["tabular-nums"] },
  actRow: { flexDirection: "row", gap: 4, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" },
  act: { minHeight: 30, minWidth: 44, paddingHorizontal: 8, borderRadius: S.radiusSm, borderWidth: 1, borderColor: C.border, backgroundColor: C.card, alignItems: "center", justifyContent: "center" },
  actDanger: { borderColor: "rgba(255,59,92,0.4)" },
  actText: { ...F.semibold, color: C.muted, fontSize: T.caption },
  pending: { ...F.regular, color: C.warn, fontSize: T.micro, flexShrink: 1 },
  dim: { opacity: 0.6 },
  card: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, padding: 12, gap: 6 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  cardKv: { flexDirection: "row", flexWrap: "wrap", columnGap: 12 },
  kv: { ...F.regular, color: C.muted, fontSize: T.caption, fontVariant: ["tabular-nums"] },
});
