// The combined positions list (both venues): venue badge, side, size,
// entry, mark, PnL, liquidation, TP / SL, with Close 25 / 50 / 100, Flat
// and Reverse. Rows are pressable (open that market's chart). A write in
// flight on the row's market dims it and shows what is happening; a write
// the venue has not settled yet keeps Close and Flat available (only
// Reverse waits) and is listed in the unsettled strip.
import { useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { fmtPct, fmtPx, fmtSize, fmtUsd } from "@/lib/fmt";
import { getSettings, subscribeSettings } from "@/lib/settings_store";
import type { Position } from "@/lib/types";
import { VENUE_LABEL } from "@/lib/types";
import { closePosition, exitsFor, flatPosition, marketLocks, reversePosition, subscribeVenues, venueState } from "@/lib/venue_store";
import { C, F, S, T } from "@/theme";

export function VenueBadge({ venue, dim }: { venue: "hl" | "mfp"; dim?: boolean }) {
  return (
    <View style={[b.badge, venue === "mfp" && b.badgeMfp, dim && { opacity: 0.5 }]}>
      <Text style={[b.badgeText, venue === "mfp" && b.badgeTextMfp]}>{VENUE_LABEL[venue]}</Text>
    </View>
  );
}
const b = StyleSheet.create({
  badge: { borderWidth: 1, borderColor: C.accentBorder, backgroundColor: C.accentBg, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  badgeMfp: { borderColor: "rgba(255,184,0,0.45)", backgroundColor: C.warnBg },
  badgeText: { ...F.semibold, color: C.accentText, fontSize: T.micro, letterSpacing: 0.4 },
  badgeTextMfp: { color: C.warn },
});

export function PositionsTable({ onOpen, compact }: { onOpen: (p: Position) => void; compact?: boolean }) {
  const v = useSyncExternalStore(subscribeVenues, venueState);
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  // Only a write IN FLIGHT replaces the row's buttons with its text.
  const pendingOn = (p: Position) => v.pending.find((x) => x.state === "working" && x.venue === p.venue && x.marketId === p.marketId) ?? null;
  if (!v.positions.length) {
    return (
      <View style={s.empty}>
        <Text style={s.note}>{v.status.hl.state === "nokey" && v.status.mfp.state === "nokey" ? "no venue configured - add a wallet address or MFP keys in Settings, or turn on Demo mode" : "no open positions"}</Text>
      </View>
    );
  }
  const pcts = settings.closePcts;
  return (
    <ScrollView horizontal={!compact} showsHorizontalScrollIndicator={false} contentContainerStyle={{ minWidth: compact ? undefined : "100%" }}>
      <View style={{ flex: 1 }}>
        {!compact ? (
          <View style={[s.row, s.head]}>
            <Text style={[s.cell, s.c1, s.h]}>Market</Text>
            <Text style={[s.cell, s.c2, s.h]}>Side</Text>
            <Text style={[s.cell, s.num, s.h]}>Size</Text>
            <Text style={[s.cell, s.num, s.h]}>Entry</Text>
            <Text style={[s.cell, s.num, s.h]}>Mark</Text>
            <Text style={[s.cell, s.num, s.h]}>PnL</Text>
            <Text style={[s.cell, s.num, s.h]}>Liq</Text>
            <Text style={[s.cell, s.num, s.h]}>TP / SL</Text>
            <View style={[s.cell, s.acts]} />
          </View>
        ) : null}
        {v.positions.map((p) => {
          const pend = pendingOn(p);
          const locks = marketLocks(v.pending, p.venue, p.marketId);
          const ex = exitsFor(p);
          const pnlColor = p.pnl === null ? C.muted : p.pnl >= 0 ? C.bull : C.bear;
          const liqPct = p.liq !== null && p.mark ? ((p.liq - p.mark) / p.mark) * 100 : null;
          const roe = p.pnl !== null && p.marginUsed ? (p.pnl / p.marginUsed) * 100 : p.pnl !== null && p.notional ? (p.pnl / (p.notional / (p.leverage ?? 1))) * 100 : null;
          const actions = (
            <View style={s.actRow}>
              {pcts.map((pct) => (
                <Pressable key={pct} onPress={() => closePosition(p.key, pct / 100)} disabled={locks.reduce} style={({ pressed }) => [s.act, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={"Close " + pct + "% of " + p.symbol}>
                  <Text style={s.actText}>{pct === 100 ? "X" : pct + "%"}</Text>
                </Pressable>
              ))}
              <Pressable onPress={() => flatPosition(p.key)} disabled={locks.reduce} style={({ pressed }) => [s.act, s.actFlat, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={"Flat " + p.symbol}>
                <Text style={[s.actText, { color: C.bear }]}>Flat</Text>
              </Pressable>
              <Pressable onPress={() => reversePosition(p.key)} disabled={locks.open} style={({ pressed }) => [s.act, s.actRev, locks.open && { opacity: 0.4 }, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={"Reverse " + p.symbol}>
                <Text style={[s.actText, { color: C.info }]}>Rev</Text>
              </Pressable>
            </View>
          );
          if (compact) {
            return (
              <Pressable key={p.key} onPress={() => onOpen(p)} style={({ pressed }) => [s.card, pend && s.dim, pressed && { backgroundColor: C.cardActive }]}>
                <View style={s.cardHead}>
                  <VenueBadge venue={p.venue} />
                  <Text style={s.sym}>{p.symbol}</Text>
                  <Text style={[s.side, { color: p.side === "long" ? C.bull : C.bear }]}>{p.side + " " + fmtSize(p.size)}</Text>
                  <View style={{ flex: 1 }} />
                  <Text style={[s.pnl, { color: pnlColor }]}>{fmtUsd(p.pnl, true)}</Text>
                  {roe !== null ? <Text style={[s.roe, { color: pnlColor }]}>{fmtPct(roe)}</Text> : null}
                </View>
                <View style={s.cardKv}>
                  <KV label="entry" value={fmtPx(p.entry)} />
                  <KV label="mark" value={fmtPx(p.mark)} />
                  <KV label="liq" value={fmtPx(p.liq)} color={liqPct !== null && Math.abs(liqPct) < 5 ? C.warn : undefined} />
                  <KV label="tp" value={ex.tp ? fmtPx(ex.tp.price) : "-"} color={ex.tp ? C.bull : undefined} />
                  <KV label="sl" value={ex.sl ? fmtPx(ex.sl.price) : "-"} color={ex.sl ? C.bear : undefined} />
                  <KV label="lev" value={(p.leverage ?? "-") + "x " + (p.marginMode ?? "")} />
                </View>
                {pend ? <Text style={s.pending}>{pend.text}</Text> : actions}
              </Pressable>
            );
          }
          return (
            <Pressable key={p.key} onPress={() => onOpen(p)} style={({ pressed }) => [s.row, pend && s.dim, pressed && { backgroundColor: C.cardActive }]}>
              <View style={[s.cell, s.c1, s.mk]}>
                <VenueBadge venue={p.venue} />
                <Text style={s.sym}>{p.symbol}</Text>
                <Text style={s.lev}>{(p.leverage ?? "-") + "x " + (p.marginMode === "isolated" ? "iso" : p.marginMode === "cross" ? "cross" : "")}</Text>
              </View>
              <Text style={[s.cell, s.c2, s.side, { color: p.side === "long" ? C.bull : C.bear }]}>{p.side}</Text>
              <Text style={[s.cell, s.num, s.v]}>{fmtSize(p.size)}</Text>
              <Text style={[s.cell, s.num, s.v]}>{fmtPx(p.entry)}</Text>
              <Text style={[s.cell, s.num, s.v]}>{fmtPx(p.mark)}</Text>
              <View style={[s.cell, s.num]}>
                <Text style={[s.v, { color: pnlColor, textAlign: "right" }]}>{fmtUsd(p.pnl, true)}</Text>
                {roe !== null ? <Text style={[s.roe, { color: pnlColor, textAlign: "right" }]}>{fmtPct(roe)}</Text> : null}
              </View>
              <View style={[s.cell, s.num]}>
                <Text style={[s.v, { textAlign: "right" }]}>{fmtPx(p.liq)}</Text>
                {liqPct !== null ? <Text style={[s.roe, { textAlign: "right", color: Math.abs(liqPct) < 5 ? C.warn : C.faint }]}>{fmtPct(liqPct, true, 1)}</Text> : null}
              </View>
              <View style={[s.cell, s.num]}>
                <Text style={[s.v, { textAlign: "right", color: ex.tp ? C.bull : C.faint }]}>{ex.tp ? fmtPx(ex.tp.price) : "-"}</Text>
                <Text style={[s.v, { textAlign: "right", color: ex.sl ? C.bear : C.faint }]}>{ex.sl ? fmtPx(ex.sl.price) : "-"}</Text>
              </View>
              <View style={[s.cell, s.acts]}>{pend ? <Text style={s.pending} numberOfLines={2}>{pend.text}</Text> : actions}</View>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

function KV({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={s.kv}>
      <Text style={s.kvLabel}>{label}</Text>
      <Text style={[s.kvValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  empty: { padding: 14 },
  note: { ...F.regular, color: C.faint, fontSize: T.caption, lineHeight: 16, flexShrink: 1 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, minHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, gap: 4 },
  head: { minHeight: 26, backgroundColor: C.card },
  h: { ...F.medium, color: C.faint, fontSize: T.micro },
  cell: { paddingVertical: 4 },
  c1: { minWidth: 150, flexGrow: 1.2, flexBasis: 0 },
  c2: { minWidth: 56, flexBasis: 0, flexGrow: 0.6 },
  num: { minWidth: 92, flexGrow: 1, flexBasis: 0, textAlign: "right", alignItems: "flex-end" },
  acts: { minWidth: 250, flexGrow: 1.6, flexBasis: 0, alignItems: "flex-end" },
  mk: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  sym: { ...F.semibold, color: C.text, fontSize: T.body },
  lev: { ...F.regular, color: C.faint, fontSize: T.micro },
  side: { ...F.medium, fontSize: T.caption, textTransform: "capitalize" },
  v: { ...F.medium, color: C.text, fontSize: T.caption, fontVariant: ["tabular-nums"] },
  roe: { ...F.regular, fontSize: T.micro, fontVariant: ["tabular-nums"] },
  pnl: { ...F.semibold, fontSize: T.body, fontVariant: ["tabular-nums"] },
  actRow: { flexDirection: "row", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" },
  act: { minHeight: 30, minWidth: 40, paddingHorizontal: 8, borderRadius: S.radiusSm, borderWidth: 1, borderColor: C.border, backgroundColor: C.card, alignItems: "center", justifyContent: "center" },
  actFlat: { borderColor: "rgba(255,59,92,0.4)" },
  actRev: { borderColor: "rgba(59,130,246,0.4)" },
  actText: { ...F.semibold, color: C.muted, fontSize: T.caption },
  pending: { ...F.regular, color: C.warn, fontSize: T.micro, flexShrink: 1, textAlign: "right" },
  dim: { opacity: 0.6 },
  card: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, padding: 12, gap: 8 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  cardKv: { flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4 },
  kv: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  kvLabel: { ...F.regular, color: C.faint, fontSize: T.micro },
  kvValue: { ...F.medium, color: C.text, fontSize: T.caption, fontVariant: ["tabular-nums"] },
});
