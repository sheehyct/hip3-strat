// Small pieces shared by the Performance and Trades views: side and
// continuity badges, the trade row, wallet identity colours and names.
import { Pressable, StyleSheet, Text, View } from "react-native";

import { fmtPct, fmtPx } from "@/lib/fmt";
import { fmtDateTimeET, fmtDuration, fmtSize, fmtUsdSigned } from "@/lib/perf_fmt";
import type { Wallet } from "@/lib/store";
import { classifyTfc, Trade, TfcStatus } from "@/lib/trades";
import { C } from "@/theme";

export const ALL = -1;

export function walletName(w: Wallet): string {
  return w.label || w.address.slice(0, 6) + "..." + w.address.slice(-4);
}

// Identity colours for the All-wallets overlay, assigned in wallet order and
// never re-cycled. The first pair (the app's info blue and a darker step of
// its amber) was validated against the card surface with the dataviz
// palette script; later slots are for a third or fourth wallet.
export const WALLET_COLORS = ["#3B82F6", "#D97706", "#A855F7", "#14B8A6"];
export const walletColor = (i: number) => WALLET_COLORS[i % WALLET_COLORS.length];

export const pnlColor = (x: number | null | undefined): string =>
  x === null || x === undefined || x === 0 ? C.muted : x > 0 ? C.bull : C.bear;

export function tfcStatusOf(t: Trade): TfcStatus {
  return classifyTfc(t, t.tfc);
}

export function SideBadge({ side, lev }: { side: "long" | "short"; lev?: number | null }) {
  const long = side === "long";
  return (
    <View style={[s.sideBadge, { backgroundColor: long ? C.bullBg : C.bearBg }]}>
      <Text style={[s.sideBadgeText, { color: long ? C.bull : C.bear }]}>
        {(long ? "LONG" : "SHORT") + (lev ? " " + lev + "x" : "")}
      </Text>
    </View>
  );
}

const TFC_BADGE: Record<TfcStatus, { fg: string; bg: string; label: string }> = {
  with: { fg: C.bull, bg: C.bullBg, label: "with TFC" },
  against: { fg: C.bear, bg: C.bearBg, label: "against TFC" },
  mixed: { fg: C.warn, bg: C.warnBg, label: "mixed TFC" },
  unknown: { fg: C.faint, bg: "rgba(255,255,255,0.03)", label: "TFC n/a" },
};

export function TfcBadge({ status }: { status: TfcStatus }) {
  const m = TFC_BADGE[status];
  return (
    <View style={[s.tfcBadge, { backgroundColor: m.bg }]}>
      <Text style={[s.tfcBadgeText, { color: m.fg }]}>{m.label}</Text>
    </View>
  );
}

export function Tag({ label }: { label: string }) {
  return (
    <View style={s.tag}><Text style={s.tagText}>{label}</Text></View>
  );
}

// One trade line: symbol, side, tags, net and return on the right; the
// opening time, hold and size/price path underneath.
export function TradeRow({
  t, walletTag, onPress, dim, unrealized, children,
}: {
  t: Trade;
  walletTag?: string | null;
  onPress?: () => void;
  dim?: boolean;
  unrealized?: number | null;   // live PnL for an OPEN trade (from the position poll)
  children?: React.ReactNode;
}) {
  // An open trade's fills only know the fees so far; the venue's unrealized
  // PnL is the honest number to print, marked as such.
  const showUnrealized = t.status === "open" && unrealized !== null && unrealized !== undefined;
  const headline = showUnrealized ? (unrealized as number) : t.netPnl;
  const sub = t.truncated
    ? "partial history - excluded from stats"
    : (t.openTime !== null ? fmtDateTimeET(t.openTime) : "-") +
      (t.durationMs !== null ? " \u00b7 " + fmtDuration(t.durationMs) : " \u00b7 open") +
      " \u00b7 " + fmtSize(t.maxSize) + (t.entryAvgPx !== null ? " @ " + fmtPx(t.entryAvgPx) : "") +
      (t.exitAvgPx !== null ? " \u2192 " + fmtPx(t.exitAvgPx) : "");
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={[s.row, dim && s.rowDim]} accessibilityRole={onPress ? "button" : undefined}>
      <View style={s.rowTop}>
        {/* identity group wraps; the money group never splits (a stray "-3.6%" on
            its own line was seen under All, where the wallet tag joins the row) */}
        <View style={s.rowIdentity}>
          <Text style={s.sym}>{t.sym}</Text>
          <SideBadge side={t.side} />
          {t.dex ? <Tag label={t.dex} /> : null}
          {walletTag ? <Tag label={walletTag} /> : null}
          {t.truncated ? <Tag label="partial history" /> : <TfcBadge status={tfcStatusOf(t)} />}
        </View>
        <View style={s.rowMoney}>
          <Text style={[s.net, { color: pnlColor(headline) }]}>{fmtUsdSigned(headline)}</Text>
          {t.returnPct !== null && !t.truncated && t.status === "closed" ? (
            <Text style={[s.ret, { color: pnlColor(t.netPnl) }]}>{fmtPct(t.returnPct, 1)}</Text>
          ) : showUnrealized ? (
            <Text style={s.ret}>unreal.</Text>
          ) : null}
        </View>
      </View>
      <Text style={s.sub} numberOfLines={1}>{sub}</Text>
      {children}
    </Pressable>
  );
}

const s = StyleSheet.create({
  sideBadge: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 },
  sideBadgeText: { fontSize: 10.5, fontWeight: "600" },
  tfcBadge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  tfcBadgeText: { fontSize: 10, fontWeight: "500" },
  tag: {
    borderWidth: 1, borderColor: C.border, borderRadius: 999,
    paddingHorizontal: 8, paddingVertical: 2, backgroundColor: C.card,
  },
  tagText: { color: C.muted, fontSize: 10.5, fontVariant: ["tabular-nums"] },
  row: { paddingVertical: 6, borderTopWidth: 1, borderTopColor: C.border, gap: 2 },
  rowDim: { opacity: 0.7 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowIdentity: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  rowMoney: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
  sym: { color: C.text, fontSize: 13, fontWeight: "600" },
  net: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
  ret: { fontSize: 10.5, fontVariant: ["tabular-nums"], minWidth: 40, textAlign: "right" },
  sub: { color: C.muted, fontSize: 10.5, fontVariant: ["tabular-nums"] },
});
