// The one-click panel behind the lightning toggle: Sell at the bid, a size
// stepper, Buy at the ask, Close 25 / 50 / 100 percent and Flat. Bid and
// ask update live (the bbo stream on Hyperliquid; the mock's quote in demo).
//
// An opening tap sends with no confirm ONLY when One-click trading is on
// and the order is under the market's max notional; otherwise the tap is
// refused with the reason. Closes are always one tap.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { fmtPx } from "@/lib/fmt";
import { checkIntent, oneClickAllowed } from "@/lib/order_policy";
import type { OrderIntent } from "@/lib/order_policy";
import { getSettings, marketSettings, subscribeSettings } from "@/lib/settings_store";
import { subscribeTicker, tickerState } from "@/lib/ticker_store";
import type { Market } from "@/lib/types";
import { closePosition, flatPosition, intentReduces, markFor, marketLocks, placeOrder, subscribeVenues, venueState } from "@/lib/venue_store";
import { C, F, S, T } from "@/theme";

export function OneClickPanel({ market, leverage, cross }: { market: Market; leverage: number; cross: boolean }) {
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const venues = useSyncExternalStore(subscribeVenues, venueState);
  const t = useSyncExternalStore(subscribeTicker, tickerState);
  const ms = marketSettings(market.key);
  const pos = venues.positions.find((p) => p.venue === market.venue && p.marketId === market.id) ?? null;
  const mark = markFor(market);
  const bbo = t.bbo && t.bbo.coin === market.chartCoin ? t.bbo : null;
  const bid = bbo?.bid ?? mark;
  const ask = bbo?.ask ?? mark;
  const step = market.szDecimals !== null ? Math.pow(10, -market.szDecimals) : 0.01;
  const [size, setSize] = useState<number>(ms.presets?.[0] ?? step * 10);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { setSize(ms.presets?.[0] ?? step * 10); setMsg(null); }, [market.key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Buy / Sell wait for any unsettled write on this market; closing waits
  // only for a write that is in flight this instant.
  const locks = marketLocks(venues.pending, market.venue, market.id);
  const intentFor = (side: "buy" | "sell"): OrderIntent => ({
    venue: market.venue, marketId: market.id, side, type: "market", size, price: null, reduceOnly: false, postOnly: false,
    slippage: ms.slippage, tp: null, sl: null, leverage, marginMode: cross ? "cross" : "isolated",
  });
  // A side that only reduces the position is an exit: like Close, it waits
  // only for a write in flight, never for an unsettled one (the store sends
  // it reduce-only and gates it the same way).
  const sideLocked = (side: "buy" | "sell"): boolean => (intentReduces(intentFor(side), market) ? locks.reduce : locks.open);

  const fire = async (side: "buy" | "sell") => {
    const intent = intentFor(side);
    const check = checkIntent(intent, { mark, position: pos ? { side: pos.side, size: pos.size } : null, settings: ms, szDecimals: market.szDecimals });
    if (!check.ok) { setMsg(check.reason); return; }
    const reduces = intentReduces(intent, market);
    if (!oneClickAllowed(settings.oneClick, reduces, check.notional, ms)) {
      setMsg(settings.oneClick ? "over this market's max notional - use the order panel" : "One-click trading is off in Settings - use the order panel");
      return;
    }
    setMsg(null);
    const r = await placeOrder(intent, market);
    setMsg(r.message ?? r.state);
  };
  const bump = (dir: 1 | -1) => {
    const next = Math.max(step, +(size + dir * step * 10).toFixed(Math.max(0, market.szDecimals ?? 2)));
    setSize(next);
  };

  return (
    <View style={s.panel}>
      <View style={s.head}>
        <Text style={s.title}>One-click</Text>
        <Text style={[s.state, { color: settings.oneClick ? C.bull : C.warn }]}>{settings.oneClick ? "on" : "off (closes only)"}</Text>
      </View>
      <View style={s.row}>
        <Pressable onPress={() => fire("sell")} disabled={sideLocked("sell")} style={[s.big, { backgroundColor: C.bearBg, borderColor: "rgba(255,59,92,0.45)" }]} accessibilityRole="button" accessibilityLabel="Sell at the bid">
          <Text style={[s.bigLabel, { color: C.bear }]}>Sell</Text>
          <Text style={[s.bigPx, { color: C.bear }]}>{fmtPx(bid)}</Text>
        </Pressable>
        <View style={s.stepper}>
          <Pressable onPress={() => bump(-1)} hitSlop={6} style={s.stepBtn} accessibilityLabel="Smaller size"><Text style={s.stepText}>-</Text></Pressable>
          <View style={{ alignItems: "center", flex: 1 }}>
            <Text style={s.size}>{size}</Text>
            <Text style={s.sizeSym}>{market.symbol}</Text>
          </View>
          <Pressable onPress={() => bump(1)} hitSlop={6} style={s.stepBtn} accessibilityLabel="Larger size"><Text style={s.stepText}>+</Text></Pressable>
        </View>
        <Pressable onPress={() => fire("buy")} disabled={sideLocked("buy")} style={[s.big, { backgroundColor: C.bullBg, borderColor: "rgba(0,220,130,0.45)" }]} accessibilityRole="button" accessibilityLabel="Buy at the ask">
          <Text style={[s.bigLabel, { color: C.bull }]}>Buy</Text>
          <Text style={[s.bigPx, { color: C.bull }]}>{fmtPx(ask)}</Text>
        </Pressable>
      </View>
      <View style={s.row}>
        <Text style={s.closeLabel}>Close</Text>
        {settings.closePcts.map((p) => (
          <Pressable key={p} onPress={() => { if (pos) closePosition(pos.key, p / 100); }} disabled={!pos || locks.reduce} style={[s.closeBtn, !pos && { opacity: 0.4 }]} accessibilityRole="button" accessibilityLabel={"Close " + p + " percent"}>
            <Text style={s.closeText}>{p + "%"}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable onPress={() => { if (pos) flatPosition(pos.key); }} disabled={!pos || locks.reduce} style={[s.flat, !pos && { opacity: 0.4 }]} accessibilityRole="button" accessibilityLabel={"Flat " + market.symbol}>
        <Text style={s.flatText}>{"Flat" + (pos ? " (" + pos.side + " " + pos.size + ")" : "")}</Text>
      </Pressable>
      {msg ? <Text style={s.msg}>{msg}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  panel: { borderWidth: 1, borderColor: C.accentBorder, borderRadius: S.radiusMd, padding: 8, gap: 8, backgroundColor: C.card },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { ...F.semibold, color: C.text, fontSize: T.caption },
  state: { ...F.regular, fontSize: T.micro },
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  big: { flex: 1, minHeight: 50, borderRadius: S.radiusSm, borderWidth: 1, alignItems: "center", justifyContent: "center", gap: 1 },
  bigLabel: { ...F.semibold, fontSize: T.body },
  bigPx: { ...F.regular, fontSize: T.micro, fontVariant: ["tabular-nums"] },
  stepper: { flexDirection: "row", alignItems: "center", minWidth: 96, minHeight: 50, borderRadius: S.radiusSm, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg },
  stepBtn: { minWidth: 28, minHeight: 44, alignItems: "center", justifyContent: "center" },
  stepText: { ...F.semibold, color: C.muted, fontSize: T.bodyL },
  size: { ...F.semibold, color: C.text, fontSize: T.body, fontVariant: ["tabular-nums"] },
  sizeSym: { ...F.regular, color: C.faint, fontSize: 10.5 },
  closeLabel: { ...F.regular, color: C.faint, fontSize: T.caption, minWidth: 40 },
  closeBtn: { flex: 1, minHeight: 36, borderRadius: S.radiusSm, borderWidth: 1, borderColor: C.border, alignItems: "center", justifyContent: "center" },
  closeText: { ...F.semibold, color: C.text, fontSize: T.caption },
  flat: { minHeight: 38, borderRadius: S.radiusSm, borderWidth: 1, borderColor: "rgba(255,59,92,0.4)", alignItems: "center", justifyContent: "center" },
  flatText: { ...F.semibold, color: C.bear, fontSize: T.caption },
  msg: { ...F.regular, color: C.muted, fontSize: T.micro, lineHeight: 15, flexShrink: 1 },
});
