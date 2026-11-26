// The confirm sheet for an OPENING order when one-click is off (or the
// order is over the market's cap): what will be sent, in plain words, and
// one Send button. Closing never comes through here.
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { fmtPct, fmtPx, fmtUsd } from "@/lib/fmt";
import type { OrderIntent } from "@/lib/order_policy";
import type { Market } from "@/lib/types";
import { C, F, S, T } from "@/theme";

export function ConfirmSheet({ visible, intent, market, notional, onCancel, onSend }: {
  visible: boolean; intent: OrderIntent | null; market: Market | null; notional: number; onCancel: () => void; onSend: () => void;
}) {
  if (!intent || !market) return null;
  const sideColor = intent.side === "buy" ? C.bull : C.bear;
  const rows: [string, string][] = [
    ["Venue", market.venue === "hl" ? "Hyperliquid" : "MyFundedPerps" + (market.provider && market.provider !== "hyperliquid" ? " (" + market.provider + ")" : "")],
    ["Order", intent.type === "market" ? "market (IoC, slippage cap " + fmtPct(intent.slippage * 100, false) + ")" : "limit " + fmtPx(intent.price) + (intent.postOnly ? " post-only" : "")],
    ["Size", intent.size + " " + market.symbol + " = " + fmtUsd(notional)],
    ["Leverage", (intent.leverage ?? "-") + "x " + (intent.marginMode ?? "")],
  ];
  if (intent.reduceOnly) rows.push(["Reduce only", "yes"]);
  if (intent.tp !== null) rows.push(["Take profit", fmtPx(intent.tp)]);
  if (intent.sl !== null) rows.push(["Stop loss", fmtPx(intent.sl)]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={s.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} accessibilityLabel="Cancel" />
        <View style={s.card}>
          <Text style={[s.title, { color: sideColor }]}>{(intent.side === "buy" ? "Buy / Long " : "Sell / Short ") + market.symbol}</Text>
          {rows.map(([k, v]) => (
            <View key={k} style={s.row}>
              <Text style={s.k}>{k}</Text>
              <Text style={s.v}>{v}</Text>
            </View>
          ))}
          <Text style={s.note}>Sent once. The chart shows it pending until the venue confirms.</Text>
          <View style={s.btns}>
            <Pressable onPress={onCancel} style={s.cancel} accessibilityRole="button"><Text style={s.cancelText}>Cancel</Text></Pressable>
            <Pressable onPress={onSend} style={[s.send, { backgroundColor: intent.side === "buy" ? "rgba(0,220,130,0.6)" : "rgba(255,59,92,0.6)" }]} accessibilityRole="button" accessibilityLabel="Send the order">
              <Text style={s.sendText}>Send</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.6)", padding: 16 },
  card: { width: "100%", maxWidth: 420, backgroundColor: C.raised, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 16, gap: 8 },
  title: { ...F.semibold, fontSize: T.h2, marginBottom: 4 },
  row: { flexDirection: "row", gap: 10, alignItems: "flex-start", flexWrap: "wrap" },
  k: { ...F.regular, color: C.faint, fontSize: T.caption, minWidth: 90 },
  v: { ...F.medium, color: C.text, fontSize: T.caption, flexShrink: 1, fontVariant: ["tabular-nums"] },
  note: { ...F.regular, color: C.faint, fontSize: T.micro, lineHeight: 15, marginTop: 4 },
  btns: { flexDirection: "row", gap: 10, marginTop: 6 },
  cancel: { flex: 1, minHeight: S.hit, borderRadius: S.radiusMd, borderWidth: 1, borderColor: C.borderStrong, alignItems: "center", justifyContent: "center" },
  cancelText: { ...F.semibold, color: C.text, fontSize: T.body },
  send: { flex: 1.4, minHeight: S.hit, borderRadius: S.radiusMd, alignItems: "center", justifyContent: "center" },
  sendText: { ...F.semibold, color: C.text, fontSize: T.body },
});

// A generic confirm for a store-initiated opening write (the reverse with
// one-click off): one sentence of what will happen, Cancel / Send.
export function ActionConfirm({ request, onCancel, onSend }: { request: { kind: "reverse"; text: string } | null; onCancel: () => void; onSend: () => void }) {
  if (!request) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <View style={s.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} accessibilityLabel="Cancel" />
        <View style={s.card}>
          <Text style={[s.title, { color: C.info }]}>Reverse</Text>
          <Text style={s.v}>{request.text}</Text>
          <Text style={s.note}>Two writes, each sent once: the close first, the opening order only after the venue reads flat and the market's orders are cleared.</Text>
          <View style={s.btns}>
            <Pressable onPress={onCancel} style={s.cancel} accessibilityRole="button"><Text style={s.cancelText}>Cancel</Text></Pressable>
            <Pressable onPress={onSend} style={[s.send, { backgroundColor: "rgba(59,130,246,0.6)" }]} accessibilityRole="button" accessibilityLabel="Send the reverse">
              <Text style={s.sendText}>Reverse</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
