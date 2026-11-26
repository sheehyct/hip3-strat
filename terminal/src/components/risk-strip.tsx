// The risk strip: one line at the top of the chart screen. Total notional
// across both venues, MFP daily-loss room and drawdown room (from the
// account's risk block / trading policy), and the nearest liquidation
// distance in percent across every open position. Color carries meaning:
// a liquidation inside 5 percent and a room under 10 percent of equity
// read amber, exhausted room reads crimson.
import { useSyncExternalStore } from "react";
import { StyleSheet, Text, View } from "react-native";

import { fmtPct, fmtUsd } from "@/lib/fmt";
import { subscribeVenues, venueState } from "@/lib/venue_store";
import { C, F, T } from "@/theme";

export function RiskStrip({ phone }: { phone?: boolean }) {
  const v = useSyncExternalStore(subscribeVenues, venueState);
  const notional = v.positions.reduce((a, p) => a + p.notional, 0);
  const hlNotional = v.positions.filter((p) => p.venue === "hl").reduce((a, p) => a + p.notional, 0);
  const mfpNotional = notional - hlNotional;
  const upnl = v.positions.reduce((a, p) => a + (p.pnl ?? 0), 0);
  const mfp = v.balances.mfp;
  let nearest: { symbol: string; pct: number } | null = null;
  for (const p of v.positions) {
    if (p.liq === null || p.mark === null || !(p.mark > 0)) continue;
    const pct = Math.abs((p.liq - p.mark) / p.mark) * 100;
    if (!nearest || pct < nearest.pct) nearest = { symbol: (p.venue === "hl" ? "HL " : "MFP ") + p.symbol, pct };
  }
  const roomColor = (room: number | null) => (room === null ? C.faint : room <= 0 ? C.bear : mfp?.equity && room < mfp.equity * 0.1 ? C.warn : C.text);
  const liqColor = nearest === null ? C.faint : nearest.pct < 5 ? C.bear : nearest.pct < 10 ? C.warn : C.text;
  return (
    <View style={[s.strip, phone && s.stripPhone]}>
      <Item label="notional" value={fmtUsd(notional)} sub={phone ? undefined : "HL " + fmtUsd(hlNotional) + "  MFP " + fmtUsd(mfpNotional)} />
      <Item label="uPnL" value={fmtUsd(upnl, true)} color={upnl >= 0 ? C.bull : C.bear} />
      <Item label="MFP daily room" value={mfp ? fmtUsd(mfp.dailyLossRoom) : "-"} color={roomColor(mfp?.dailyLossRoom ?? null)} />
      <Item label="MFP drawdown room" value={mfp ? fmtUsd(mfp.drawdownRoom) : "-"} color={roomColor(mfp?.drawdownRoom ?? null)} />
      <Item label="nearest liq" value={nearest ? fmtPct(nearest.pct, false, 1) : "-"} sub={nearest?.symbol} color={liqColor} />
    </View>
  );
}

function Item({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <View style={s.item}>
      <Text style={s.label}>{label}</Text>
      <Text style={[s.value, color ? { color } : null]}>{value}</Text>
      {sub ? <Text style={s.sub} numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  strip: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 18, rowGap: 2, paddingHorizontal: 12, minHeight: 26, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.card },
  stripPhone: { columnGap: 12, paddingHorizontal: 10 },
  item: { flexDirection: "row", alignItems: "baseline", gap: 5 },
  label: { ...F.regular, color: C.faint, fontSize: T.micro },
  value: { ...F.semibold, color: C.text, fontSize: T.micro, fontVariant: ["tabular-nums"] },
  sub: { ...F.regular, color: C.faint, fontSize: T.micro, fontVariant: ["tabular-nums"], flexShrink: 1 },
});
