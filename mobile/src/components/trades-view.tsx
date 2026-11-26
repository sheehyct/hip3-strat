// Trades ledger: every reconstructed round trip for the selected wallet(s),
// filterable and sortable, one expandable at a time (legs, fees, funding,
// the continuity stamp, and the TradingView handoff through the same
// tvHref rule the screener uses).
import { useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { ALL, pnlColor, TradeRow, walletName } from "@/components/trade-bits";
import { Dot } from "@/components/ui";
import type { Coin } from "@/lib/api";
import { fmtPx, fmtUsd } from "@/lib/fmt";
import { fmtDateTimeET, fmtDuration, fmtSize, fmtTimeET, fmtUsdSigned } from "@/lib/perf_fmt";
import type { WalletPerf } from "@/lib/performance";
import type { Wallet } from "@/lib/store";
import { classifyTfc, stampLag, Trade } from "@/lib/trades";
import { tvHref, tvSymbol } from "@/lib/tv";
import { C } from "@/theme";

type Filter = "all" | "wins" | "losses" | "open";
type Sort = "recent" | "net";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" }, { id: "wins", label: "Wins" }, { id: "losses", label: "Losses" }, { id: "open", label: "Open" },
];

type Props = {
  wallets: Wallet[];
  sel: number;
  perfs: Record<string, WalletPerf>;
  loading: boolean;
  note: string | null;
  unrealized: Record<string, number>;   // "<wallet>|<coin>" -> live unrealized PnL
};

// The TV rule reads name / sym / uni; a trade carries exactly those. A
// MyFundedPerps trade links the Hyperliquid market it maps to, whose symbol
// can differ from MFP's (Binance 1000PEPE = Hyperliquid kPEPE).
function coinLike(t: Trade): Coin {
  const sym = t.id.startsWith("mfp:") && !t.coin.startsWith("mfp:") ? t.coin.slice(t.coin.indexOf(":") + 1) : t.sym;
  return { name: t.coin, sym, uni: t.dex === "xyz" ? "xyz" : "perps" } as unknown as Coin;
}

export function TradesView({ wallets, sel, perfs, loading, note, unrealized }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [open, setOpen] = useState<string | null>(null);

  const idx = sel === ALL ? wallets.map((_, i) => i) : [sel];
  const many = sel === ALL && wallets.length > 1;
  const rows = useMemo(() => {
    const out: { t: Trade; tag: string | null }[] = [];
    for (const i of idx) {
      const w = wallets[i];
      const p = perfs[w.address.toLowerCase()];
      if (!p) continue;
      for (const t of p.trades) out.push({ t, tag: many ? walletName(w) : null });
    }
    return out;
  }, [idx.join(","), wallets, perfs, many]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = {
    closed: rows.filter((r) => r.t.status === "closed" && !r.t.truncated).length,
    open: rows.filter((r) => r.t.status === "open").length,
    partial: rows.filter((r) => r.t.truncated).length,
  };
  let list = rows.filter((r) => {
    if (filter === "wins") return r.t.status === "closed" && !r.t.truncated && r.t.netPnl > 0;
    if (filter === "losses") return r.t.status === "closed" && !r.t.truncated && r.t.netPnl < 0;
    if (filter === "open") return r.t.status === "open";
    return true;
  });
  list = [...list].sort((a, b) => {
    if (a.t.truncated !== b.t.truncated) return a.t.truncated ? 1 : -1; // partial history sinks
    if (sort === "net") return b.t.netPnl - a.t.netPnl;
    return (b.t.closeTime ?? b.t.openTime ?? 0) - (a.t.closeTime ?? a.t.openTime ?? 0);
  });

  return (
    <View>
      <View style={s.controls}>
        {FILTERS.map((f) => {
          const on = f.id === filter;
          return (
            <Pressable key={f.id} onPress={() => setFilter(f.id)} style={[s.fpill, on && s.fpillOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
              <Text style={[s.fpillText, on && s.fpillTextOn]}>{f.label}</Text>
            </Pressable>
          );
        })}
        <View style={{ marginLeft: "auto", flexDirection: "row", gap: 6 }}>
          {(["recent", "net"] as Sort[]).map((k) => {
            const on = k === sort;
            return (
              <Pressable key={k} onPress={() => setSort(k)} style={[s.pill, on && s.pillOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
                <Text style={[s.pillText, on && s.pillTextOn]}>{k === "recent" ? "Recent" : "Net"}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <Text style={s.counts}>
        {counts.closed + " closed \u00b7 " + counts.open + " open" + (counts.partial ? " \u00b7 " + counts.partial + " partial history" : "") + (loading ? " \u00b7 syncing..." : "")}
      </Text>
      {note ? <Text style={s.note}>{note}</Text> : null}
      <View style={s.card}>
        {!list.length ? (
          <Text style={s.hint}>{rows.length ? "nothing matches this filter" : loading ? "loading trade history..." : "no trades in the cached history"}</Text>
        ) : null}
        {list.map(({ t, tag }) => (
          <TradeRow
            key={t.id}
            t={t}
            walletTag={tag}
            dim={t.truncated}
            unrealized={t.status === "open" ? unrealized[t.wallet.toLowerCase() + "|" + t.coin] ?? null : null}
            onPress={() => setOpen(open === t.id ? null : t.id)}
          >
            {open === t.id ? <TradeDetail t={t} /> : null}
          </TradeRow>
        ))}
      </View>
    </View>
  );
}

function TradeDetail({ t }: { t: Trade }) {
  const legs = t.legs.slice(0, 12);
  const more = t.legs.length - legs.length;
  const stamp = t.tfc;
  const status = classifyTfc(t, stamp);
  const lag = stamp ? stampLag(stamp) : null;
  const fromLedger = stamp?.source === "worker";
  const relation = status === "with" ? "with this " + t.side : status === "against" ? "against this " + t.side : status === "mixed" ? "mixed"
    : fromLedger ? "not ready at entry" : "not stamped at entry";
  const relColor = status === "with" ? C.bull : status === "against" ? C.bear : status === "mixed" ? C.warn : C.faint;
  const dwmDots = stamp && stamp.dwm ? ["1d", "1w", "1M"].map((k) => stamp.dwm?.dots[k] ?? "flat") : null;
  const coin = coinLike(t);
  // A MyFundedPerps trade (src/lib/trades.ts tradesFromMfp): its coin is the
  // Hyperliquid market on the same base asset, or "mfp:<symbol>" when none.
  const mfp = t.id.startsWith("mfp:");
  const noHl = t.coin.startsWith("mfp:");
  // Legs of a trade that spans more than a day carry their date; a same-day
  // trade reads cleaner with times alone.
  const multiDay = t.legs.length > 1 && t.legs[t.legs.length - 1].time - t.legs[0].time > 86400e3;
  const legTime = (ms: number) => (multiDay ? fmtDateTimeET(ms) : fmtTimeET(ms));
  return (
    <View style={s.detail}>
      <View style={s.legBox}>
        {legs.map((l, i) => (
          <View key={l.tid + ":" + i} style={s.legRow}>
            <Text style={[s.legTime, multiDay && { minWidth: 84 }]}>{legTime(l.time)}</Text>
            <Text style={[s.legKind, l.kind === "open" && { color: C.text }]}>{l.kind}</Text>
            <Text style={s.legText}>{fmtSize(l.size) + " @ " + fmtPx(l.px)}</Text>
            <Text style={[s.legRight, l.kind === "close" ? { color: pnlColor(l.pnl) } : null]}>
              {l.kind === "close" ? fmtUsdSigned(l.pnl) : "fee " + fmtUsd(l.fee)}
            </Text>
          </View>
        ))}
        {more > 0 ? <Text style={s.legMore}>{"+" + more + " more fills"}</Text> : null}
        <View style={s.totals}>
          {/* separate Text nodes per pair: nested values vanished on an Android build at a large font scale */}
          <View style={s.totalPair}><Text style={s.totalKey}>gross</Text><Text style={s.totalVal}>{fmtUsdSigned(t.grossPnl)}</Text></View>
          <View style={s.totalPair}><Text style={s.totalKey}>fees</Text><Text style={s.totalVal}>{fmtUsd(t.fees)}</Text></View>
          <View style={s.totalPair}><Text style={s.totalKey}>funding</Text><Text style={s.totalVal}>{t.funding === null ? "n/a" : fmtUsdSigned(t.funding)}</Text></View>
          {t.closeReason === "liquidation" || t.closeReason === "adl" ? (
            <Text style={[s.totalKey, { color: C.bear }]}>{t.closeReason === "adl" ? "auto-deleveraged" : "liquidated"}</Text>
          ) : null}
        </View>
        {stamp ? (
          <>
            <View style={s.tfcRow}>
              <View style={s.dots}>{stamp.dots.map((d, i) => <Dot key={i} dir={d} />)}</View>
              <Text style={[s.ftfc, { color: stamp.ftfc === "up" ? C.bull : stamp.ftfc === "down" ? C.bear : C.muted }]}>
                {stamp.ftfc === "up" || stamp.ftfc === "down" ? stamp.ftfc.toUpperCase() : stamp.ftfc === "mixed" ? "MIXED" : "-"}
              </Text>
              {dwmDots ? (
                <>
                  <View style={[s.dots, { marginLeft: 6 }]}>{dwmDots.map((d, i) => <Dot key={i} dir={d} size={6} />)}</View>
                  <Text style={s.dwmText}>{"D/W/M " + dwmDots.filter((d) => d === "up").length + "/3 up"}</Text>
                </>
              ) : null}
              <Text style={[s.relation, { color: relColor }]}>{relation}</Text>
            </View>
            <Text style={s.stampNote}>
              {fromLedger
                ? status === "unknown"
                  ? "from the scanner's continuity ledger: the coin was still loading at entry"
                  : "from the scanner's continuity ledger, as served " + (lag === null || lag < 1000 ? "at" : Math.round(lag / 1000) + " s before") + " the opening fill"
                : lag === null
                ? "continuity copied from the scanner's served state"
                : status === "unknown"
                  ? "continuity observed " + fmtDuration(lag) + " after entry - too late to count"
                  : "continuity stamped at entry (observed " + (lag < 60e3 ? Math.round(lag / 1000) + " s" : fmtDuration(lag)) + " after the opening fill)"}
            </Text>
          </>
        ) : (
          <Text style={s.stampNote}>
            {noHl
              ? "no continuity for this trade: Hyperliquid has no market on the same asset"
              : "no continuity for this trade (opened before the scanner's continuity ledger, on an unserved dex, or while the scanner restarted)"}
          </Text>
        )}
        {mfp && !noHl ? <Text style={s.stampNote}>{"continuity and chart read on Hyperliquid " + t.coin + " (same base asset)"}</Text> : null}
      </View>
      {noHl ? null : (
        <Pressable onPress={() => Linking.openURL(tvHref(coin))} style={({ pressed }) => [s.tvLink, pressed && { opacity: 0.7 }]} accessibilityRole="link">
          <Text style={s.tvLinkText}>Open in TradingView</Text>
          <Text style={s.tvLinkSym}>{tvSymbol(coin)}</Text>
        </Pressable>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  controls: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 },
  fpill: {
    borderWidth: 1, borderColor: C.border, borderRadius: 999,
    paddingHorizontal: 12, paddingVertical: 5, minHeight: 28, justifyContent: "center", backgroundColor: C.card,
  },
  fpillOn: { borderColor: "rgba(59,130,246,0.35)", backgroundColor: C.infoBg },
  fpillText: { color: C.muted, fontSize: 12, fontWeight: "500" },
  fpillTextOn: { color: C.info },
  pill: {
    borderWidth: 1, borderColor: C.border, borderRadius: 6,
    paddingHorizontal: 9, paddingVertical: 3, minHeight: 24, justifyContent: "center",
  },
  pillOn: { borderColor: "rgba(0,220,130,0.35)", backgroundColor: C.bullBg },
  pillText: { color: C.muted, fontSize: 11, fontWeight: "500" },
  pillTextOn: { color: C.bull },
  counts: { color: C.faint, fontSize: 10.5, marginBottom: 6, fontVariant: ["tabular-nums"] },
  note: { color: C.faint, fontSize: 10.5, marginBottom: 6 },
  card: {
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    borderRadius: 10, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 2, marginBottom: 8,
  },
  hint: { color: C.muted, fontSize: 13, lineHeight: 19, paddingVertical: 8 },
  detail: { marginTop: 8, gap: 8 },
  legBox: {
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8, gap: 4,
  },
  legRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  legTime: { color: C.faint, fontSize: 11, minWidth: 44, fontVariant: ["tabular-nums"] },
  legKind: { color: C.muted, fontSize: 11, minWidth: 40 },
  legText: { color: C.text, fontSize: 11, fontVariant: ["tabular-nums"] },
  legRight: { marginLeft: "auto", color: C.faint, fontSize: 11, fontVariant: ["tabular-nums"] },
  legMore: { color: C.faint, fontSize: 10.5 },
  totals: { flexDirection: "row", flexWrap: "wrap", gap: 10, borderTopWidth: 1, borderTopColor: C.border, paddingTop: 4, marginTop: 2 },
  totalPair: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  totalKey: { color: C.muted, fontSize: 11, fontVariant: ["tabular-nums"] },
  totalVal: { color: C.text, fontSize: 11, fontVariant: ["tabular-nums"] },
  tfcRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4, flexWrap: "wrap" },
  dots: { flexDirection: "row", alignItems: "center" },
  ftfc: { fontSize: 11, fontWeight: "600", marginLeft: 2 },
  dwmText: { fontSize: 10, color: C.faint, marginLeft: 2 },
  relation: { marginLeft: "auto", fontSize: 10.5, fontWeight: "600" },
  stampNote: { color: C.faint, fontSize: 10 },
  tvLink: {
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border,
    borderRadius: 8, paddingVertical: 8, alignItems: "center", gap: 1,
  },
  tvLinkText: { color: C.info, fontSize: 12, fontWeight: "600" },
  tvLinkSym: { color: C.faint, fontSize: 10, fontVariant: ["tabular-nums"] },
});
