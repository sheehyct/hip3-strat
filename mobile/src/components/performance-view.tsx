// Performance view (graph first). One
// wallet = the deep view; "All" = the comparison view, wallets overlaid on
// the graph and side by side in the stats, never summed (two
// wallets may run different strategies).
//
// Everything here is display aggregation over venue fills and the venue's
// own equity history; continuity comes from stamps of the scanner's served
// state and is only ever compared with the trade's side (src/lib/trades.ts).
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { PnlChart } from "@/components/pnl-chart";
import {
  ALL, pnlColor, TfcBadge, tfcStatusOf, walletColor, walletName,
} from "@/components/trade-bits";
import { fmtPct, fmtUsd } from "@/lib/fmt";
import { fmtDateET, fmtDuration, fmtUsdShort, fmtUsdSigned } from "@/lib/perf_fmt";
import type { WalletPerf } from "@/lib/performance";
import { getPerfUnit, PerfUnit, setPerfUnit, Wallet } from "@/lib/store";
import {
  Bucket, bucketize, closedIn, computeStats, Concentration, concentrationSentence, decimate,
  Dim, lossConcentrations, makeNyTime, NyTime, pnlSeries, Series, Stats, Trade, Window, WINDOW_KEY,
} from "@/lib/trades";
import { C } from "@/theme";

const WINDOWS: { id: Window; label: string }[] = [
  { id: "day", label: "1D" }, { id: "week", label: "1W" }, { id: "month", label: "1M" }, { id: "all", label: "All" },
];
const DIM_LABEL: Record<Dim, string> = {
  side: "side", dex: "dex", coin: "coin", hour: "hour ET", weekday: "weekday", hold: "hold", tfc: "continuity", wallet: "wallet",
};
const DIMS_ONE: Dim[] = ["side", "coin", "hour", "hold", "tfc"];
const DIMS_ALL: Dim[] = ["wallet", "side", "coin", "hour", "tfc"];

// Percent view: the per-trade money metrics as
// returns on entry notional, and net as a share of the wallet's equity.
const pctOrDash = (x: number | null, digits = 2) => (x === null ? "-" : fmtPct(x, digits));
const equityOf = (perf: WalletPerf, win: Window): number | null => {
  const w = perf.history[WINDOW_KEY[win]];
  const h = w ? w.accountValueHistory : [];
  return h.length ? h[h.length - 1][1] : null;
};
const netOfEquity = (net: number, equity: number | null): string =>
  equity && equity > 0 ? fmtPct((net / equity) * 100, 2) + " of equity" : fmtUsdSigned(net);

type Props = {
  wallets: Wallet[];
  sel: number;                              // ALL or a wallet index
  perfs: Record<string, WalletPerf>;        // by lowercase address
  loading: boolean;
  note: string | null;
  onOpenTrades: () => void;
  // "mfp": the MyFundedPerps account (one pseudo-wallet built from its closed
  // positions); its equity line is realized steps, not the venue's history.
  source?: "hl" | "mfp";
};

export function PerformanceView({ wallets, sel, perfs, loading, note, onOpenTrades, source = "hl" }: Props) {
  const [win, setWin] = useState<Window>("week");
  const [dim, setDim] = useState<Dim | null>(null);
  const [unit, setUnit] = useState<PerfUnit>("usd");
  useEffect(() => { getPerfUnit().then(setUnit).catch(() => undefined); }, []);
  const pickUnit = (u: PerfUnit) => { setUnit(u); setPerfUnit(u).catch(() => undefined); };
  const ny = useMemo(() => makeNyTime(), []);
  const now = useMemo(() => Date.now(), [perfs, win]); // eslint-disable-line react-hooks/exhaustive-deps

  const idx = sel === ALL ? wallets.map((_, i) => i) : [sel];
  const rows = idx
    .map((i) => ({ i, w: wallets[i], perf: perfs[wallets[i].address.toLowerCase()] ?? null }))
    .filter((r): r is { i: number; w: Wallet; perf: WalletPerf } => r.perf !== null);
  const many = sel === ALL && wallets.length > 1;
  const label = (addr: string) => {
    const w = wallets.find((x) => x.address.toLowerCase() === addr.toLowerCase());
    return w ? walletName(w) : addr.slice(0, 6);
  };
  const winLabel = WINDOWS.find((x) => x.id === win)?.label ?? "";

  const closedBy = rows.map((r) => ({ ...r, closed: closedIn(r.perf.trades, win, now) }));
  const closedAll: Trade[] = closedBy.flatMap((r) => r.closed);
  const stats = computeStats(closedAll);
  const dims = many ? DIMS_ALL : DIMS_ONE;
  const conc = lossConcentrations(closedAll, { ny, walletLabel: label }, dims);
  const activeDim: Dim = dim && dims.includes(dim) ? dim : (conc[0]?.dim ?? "side");
  const bars = bucketize(closedAll, activeDim, { ny, walletLabel: label });
  const unknownList = closedAll.filter((t) => tfcStatusOf(t) === "unknown");
  const unknownTfc = unknownList.length;
  const ledgerSince = rows.find((r) => r.perf.ledgerSince !== null)?.perf.ledgerSince ?? null;
  const preLedger = ledgerSince === null ? 0 : unknownList.filter((t) => t.openTime !== null && t.openTime < ledgerSince).length;

  if (!rows.length) {
    return (
      <View style={s.card}>
        <Text style={s.hint}>{loading ? "loading trade history..." : note || "no history loaded yet - pull to refresh"}</Text>
      </View>
    );
  }

  return (
    <View>
      <View style={s.windowRow}>
        <Text style={s.windowLabel}>WINDOW</Text>
        {WINDOWS.map((w) => {
          const on = w.id === win;
          return (
            <Pressable key={w.id} onPress={() => setWin(w.id)} style={[s.pill, on && s.pillOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
              <Text style={[s.pillText, on && s.pillTextOn]}>{w.label}</Text>
            </Pressable>
          );
        })}
        <View style={s.unitGroup}>
          {loading ? <Text style={s.loading}>syncing...</Text> : null}
          {(["usd", "pct"] as PerfUnit[]).map((u) => {
            const on = u === unit;
            return (
              <Pressable
                key={u}
                onPress={() => pickUnit(u)}
                style={[s.pill, on && s.pillOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={u === "usd" ? "show metrics in dollars" : "show metrics as percent of entry notional"}
              >
                <Text style={[s.pillText, on && s.pillTextOn]}>{u === "usd" ? "$" : "%"}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <EquityCard rows={rows} win={win} winLabel={winLabel} many={many} source={source} />

      {many ? <StatsTable rows={closedBy.map((r) => ({ name: walletName(r.w), color: walletColor(r.i), stats: computeStats(r.closed), equity: equityOf(r.perf, win) }))} winLabel={winLabel} unit={unit} />
            : <StatsGrid stats={stats} winLabel={winLabel} unit={unit} equity={equityOf(rows[0].perf, win)} />}

      <BestWorst stats={stats} winLabel={winLabel} many={many} label={label} onOpenTrades={onOpenTrades} unit={unit} />

      <View style={s.card}>
        <Text style={s.cardLabel}>Where the losses came from</Text>
        {conc.length ? (
          <View style={s.sentences}>
            {conc.map((c) => <Sentence key={c.dim + c.key} c={c} />)}
          </View>
        ) : (
          <Text style={s.hint}>{stats.losses ? "no bucket carries a clear share of the losses" : "no losing trades in this window"}</Text>
        )}
        <View style={s.dimRow}>
          <Text style={s.windowLabel}>NET BY</Text>
          {dims.map((d) => {
            const on = d === activeDim;
            return (
              <Pressable key={d} onPress={() => setDim(d)} style={[s.pill, on && s.pillOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
                <Text style={[s.pillText, on && s.pillTextOn]}>{DIM_LABEL[d]}</Text>
              </Pressable>
            );
          })}
        </View>
        <BarList bars={bars} dim={activeDim} unit={unit} />
        {unknownTfc ? (
          <Text style={s.foot}>
            {"Continuity unknown for " + unknownTfc + " of " + closedAll.length + " trades" +
              (preLedger ? " (" + preLedger + " opened before the scanner's continuity ledger started " + fmtDateET(ledgerSince as number) + ")" : "") +
              (source === "mfp"
                ? ". MyFundedPerps trades read it from that ledger on the Hyperliquid market with the same base asset; a trade with no such market, opened before the ledger, or while the scanner restarted has none."
                : ". It comes from that ledger, or from this app's stamp when it saw a position open; a trade opened before the ledger, on an unserved dex, or while the scanner restarted cannot be recovered.")}
          </Text>
        ) : null}
        {stats.fundingUnknown ? <Text style={s.foot}>{"Funding unknown for " + stats.fundingUnknown + " trades (not fetched yet)."}</Text> : null}
        {note ? <Text style={s.foot}>{note}</Text> : null}
      </View>
    </View>
  );
}

function EquityCard({ rows, win, winLabel, many, source }: { rows: { i: number; w: Wallet; perf: WalletPerf }[]; win: Window; winLabel: string; many: boolean; source: "hl" | "mfp" }) {
  const [width, setWidth] = useState(0);
  const key = WINDOW_KEY[win];
  const per = rows.map((r) => {
    const w = r.perf.history[key];
    const series: Series = decimate(pnlSeries(w));
    const last = series.length ? series[series.length - 1][1] : 0;
    const av = w && w.accountValueHistory.length ? w.accountValueHistory[w.accountValueHistory.length - 1][1] : null;
    return { ...r, series, last, value: av, vlm: w ? w.vlm : 0 };
  });
  const all = per.flatMap((p) => p.series);
  const startLabel = all.length ? fmtDateET(Math.min(...all.map((p) => p[0]))) : "";
  const endLabel = all.length ? fmtDateET(Math.max(...all.map((p) => p[0]))) : "";
  const total = per.reduce((a, p) => a + p.last, 0);
  const one = per[0];
  const ret = one && one.value !== null && one.value - one.last > 0 ? (one.last / (one.value - one.last)) * 100 : null;

  return (
    <View style={s.card} onLayout={(e) => setWidth(e.nativeEvent.layout.width - 24)}>
      <View style={s.equityHead}>
        <View style={{ flex: 1 }}>
          <Text style={s.cardLabel}>{"PnL " + winLabel + (many ? ", all wallets" : "")}</Text>
          <Text style={[s.equityValue, { color: pnlColor(total) }]}>{fmtUsdSigned(total)}</Text>
          <Text style={s.equitySub}>
            {many ? "sum of the wallets; lines drawn per wallet, never merged"
              : source === "mfp" ? (win === "all" ? "closed trades, plus open PnL now" : "closed trades in this window (open PnL under All)")
              : "mark-to-market, incl. unrealized"}
          </Text>
        </View>
        <View style={s.equityRight}>
          {many ? per.map((p) => (
            <KV key={p.i} label={walletName(p.w)} value={p.value === null ? "-" : fmtUsd(p.value)} />
          )) : (
            <>
              <KV label="Value" value={one.value === null ? "-" : fmtUsd(one.value)} />
              <KV label="Vol" value={fmtUsdShort(one.vlm)} />
              <KV label="Ret" value={ret === null ? "-" : fmtPct(ret, 1)} color={pnlColor(ret)} />
            </>
          )}
        </View>
      </View>
      <View style={s.chart}>
        <PnlChart
          width={width}
          height={many ? 124 : 132}
          padRight={many ? 16 : 58}
          series={per.map((p) => many
            ? { data: p.series, color: walletColor(p.i), label: null } // the legend carries name + value
            : { data: p.series, fill: true })}
          startLabel={startLabel}
          endLabel={endLabel}
          fmt={fmtUsdSigned}
        />
      </View>
      {many ? (
        <View style={s.legend}>
          {per.map((p) => (
            <View key={p.i} style={s.legendItem}>
              <View style={[s.legendSwatch, { backgroundColor: walletColor(p.i) }]} />
              <Text style={s.legendText}>{walletName(p.w)}</Text>
              <Text style={[s.legendText, s.kvValue, { marginLeft: 4 }]}>{fmtUsdSigned(p.last)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// A label / value pair as SEPARATE Text nodes. Nesting the value inside the
// label's Text dropped the value on an Android build (a device
// screenshot: "Value / Vol / Ret" with no numbers, "net +" cut after one
// character); the Positions grid, which never nests, renders fine there.
function KV({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={s.kvRow}>
      <Text style={s.kv}>{label}</Text>
      <Text style={[s.kv, s.kvValue, color ? { color } : null]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function Cell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={s.cell}>
      <Text style={s.cellLabel}>{label}</Text>
      <Text style={[s.cellValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

function StatsGrid({ stats: st, winLabel, unit, equity }: { stats: Stats; winLabel: string; unit: PerfUnit; equity: number | null }) {
  const pct = unit === "pct";
  return (
    <View style={s.card}>
      <View style={s.cardHead}>
        <Text style={s.cardLabel}>{"Closed trades, " + winLabel + (pct ? " \u00b7 %" : "")}</Text>
        <View style={s.kvRow}>
          <Text style={s.cardMeta}>net</Text>
          <Text style={[s.cardMeta, { color: pnlColor(st.netPnl), fontWeight: "600" }]} numberOfLines={1}>
            {pct ? netOfEquity(st.netPnl, equity) : fmtUsdSigned(st.netPnl)}
          </Text>
        </View>
      </View>
      {pct ? <Text style={[s.foot, { marginTop: 0, marginBottom: 6 }]}>% = return on entry notional per trade; net = share of current equity</Text> : null}
      <View style={s.grid}>
        <Cell label="Trades" value={String(st.count) + (pct && st.count ? " (" + st.wins + "W " + st.losses + "L)" : "")} />
        <Cell label="Win rate" value={st.winRate === null ? "-" : Math.round(st.winRate * 100) + "%"} />
        <Cell label="Profit factor" value={st.profitFactor === null ? "-" : st.profitFactor.toFixed(2)} />
        <Cell label="Expectancy" value={pct ? pctOrDash(st.expectancyPct) : fmtUsdSigned(st.expectancy)} color={pnlColor(pct ? st.expectancyPct : st.expectancy)} />
        <Cell label="Avg win" value={pct ? pctOrDash(st.avgWinPct) : fmtUsdSigned(st.avgWin)} color={st.wins ? C.bull : undefined} />
        <Cell label="Avg loss" value={pct ? pctOrDash(st.avgLossPct) : fmtUsdSigned(st.avgLoss)} color={st.losses ? C.bear : undefined} />
        <Cell label="Avg hold" value={fmtDuration(st.avgDurationMs)} />
        <Cell label="Fees" value={fmtUsd(st.fees)} />
        <Cell label="Funding" value={fmtUsdSigned(st.funding)} color={pnlColor(st.funding)} />
        <Cell label="Long W-L" value={st.longWins + "-" + st.longLosses} />
        <Cell label="Short W-L" value={st.shortWins + "-" + st.shortLosses} />
        <Cell label="Largest" value={pct ? pctOrDash(st.largestWinPct, 1) + " / " + pctOrDash(st.largestLossPct, 1) : fmtUsdSigned(st.largestWin) + " / " + fmtUsdSigned(st.largestLoss)} />
      </View>
    </View>
  );
}

type TableRow = { name: string; color: string; stats: Stats; equity: number | null };

function StatsTable({ rows, winLabel, unit }: { rows: TableRow[]; winLabel: string; unit: PerfUnit }) {
  const pct = unit === "pct";
  const lines: [string, (r: TableRow) => string, ((r: TableRow) => string | undefined)?][] = pct ? [
    ["Trades", (r) => String(r.stats.count) + (r.stats.count ? " (" + r.stats.wins + "W " + r.stats.losses + "L)" : "")],
    ["Win rate", (r) => (r.stats.winRate === null ? "-" : Math.round(r.stats.winRate * 100) + "%")],
    ["Profit factor", (r) => (r.stats.profitFactor === null ? "-" : r.stats.profitFactor.toFixed(2))],
    ["Net of equity", (r) => (r.equity && r.equity > 0 ? fmtPct((r.stats.netPnl / r.equity) * 100, 2) : "-"), (r) => pnlColor(r.stats.netPnl)],
    ["Expectancy", (r) => pctOrDash(r.stats.expectancyPct), (r) => pnlColor(r.stats.expectancyPct)],
    ["Avg win", (r) => pctOrDash(r.stats.avgWinPct), (r) => (r.stats.wins ? C.bull : undefined)],
    ["Avg loss", (r) => pctOrDash(r.stats.avgLossPct), (r) => (r.stats.losses ? C.bear : undefined)],
    ["Avg hold", (r) => fmtDuration(r.stats.avgDurationMs)],
  ] : [
    ["Trades", (r) => String(r.stats.count)],
    ["Win rate", (r) => (r.stats.winRate === null ? "-" : Math.round(r.stats.winRate * 100) + "%")],
    ["Profit factor", (r) => (r.stats.profitFactor === null ? "-" : r.stats.profitFactor.toFixed(2))],
    ["Net PnL", (r) => fmtUsdSigned(r.stats.netPnl), (r) => pnlColor(r.stats.netPnl)],
    ["Expectancy", (r) => fmtUsdSigned(r.stats.expectancy), (r) => pnlColor(r.stats.expectancy)],
    ["Avg hold", (r) => fmtDuration(r.stats.avgDurationMs)],
    ["Fees", (r) => fmtUsd(r.stats.fees)],
    ["Funding", (r) => fmtUsdSigned(r.stats.funding), (r) => pnlColor(r.stats.funding)],
  ];
  return (
    <View style={s.card}>
      <View style={s.tableRow}>
        <Text style={[s.cardLabel, { flex: 1 }]}>{"Closed trades, " + winLabel + (pct ? " \u00b7 %" : "")}</Text>
        {rows.map((r) => <Text key={r.name} style={[s.cardLabel, s.tableCol, { color: r.color }]} numberOfLines={1}>{r.name}</Text>)}
      </View>
      {lines.map(([k, f, col]) => (
        <View key={k} style={[s.tableRow, s.tableLine]}>
          <Text style={s.tableKey}>{k}</Text>
          {rows.map((r) => <Text key={r.name} style={[s.tableVal, col ? { color: col(r) } : null]}>{f(r)}</Text>)}
        </View>
      ))}
    </View>
  );
}

function BestWorst({ stats: st, winLabel, many, label, onOpenTrades, unit }: { stats: Stats; winLabel: string; many: boolean; label: (a: string) => string; onOpenTrades: () => void; unit: PerfUnit }) {
  const pct = unit === "pct";
  const col = (title: string, list: Trade[], color: string) => (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={[s.cardLabel, { color, marginBottom: 2 }]}>{title}</Text>
      {list.length === 0 ? <Text style={s.hint}>-</Text> : null}
      {list.slice(0, 3).map((t) => (
        <View key={t.id} style={s.bwRow}>
          <View style={s.bwTop}>
            <Text style={s.bwSym}>{t.sym}</Text>
            <Text style={[s.bwSide, { color: t.side === "long" ? C.bull : C.bear }]}>{t.side === "long" ? "L" : "S"}</Text>
            <Text style={[s.bwNet, { color: pnlColor(t.netPnl) }]}>{pct ? pctOrDash(t.returnPct, 1) : fmtUsdSigned(t.netPnl)}</Text>
          </View>
          <View style={s.bwSub}>
            <Text style={s.bwMeta}>{(pct ? fmtUsdSigned(t.netPnl) + " \u00b7 " : "") + fmtDuration(t.durationMs) + (many ? " \u00b7 " + label(t.wallet) : "")}</Text>
            <View style={{ marginLeft: "auto" }}><TfcBadge status={tfcStatusOf(t)} /></View>
          </View>
        </View>
      ))}
    </View>
  );
  return (
    <View style={s.card}>
      <View style={s.cardHead}>
        <Text style={s.cardLabel}>{"Best and worst, " + winLabel}</Text>
        <Pressable onPress={onOpenTrades} hitSlop={8} accessibilityRole="button">
          <Text style={s.link}>all in Trades</Text>
        </Pressable>
      </View>
      <View style={s.bwCols}>
        {col("Best", st.best.filter((t) => t.netPnl > 0), C.bull)}
        {col("Worst", st.worst.filter((t) => t.netPnl < 0), C.bear)}
      </View>
    </View>
  );
}

function Sentence({ c }: { c: Concentration }) {
  const text = concentrationSentence(c, fmtUsdSigned);
  const head = c.label + ":";
  return (
    <Text style={s.sentence}>
      <Text style={s.sentenceHead}>{head}</Text>
      {text.slice(head.length)}
    </Text>
  );
}

function BarList({ bars, dim, unit }: { bars: Bucket[]; dim: Dim; unit: PerfUnit }) {
  // Money mode ranks buckets by net PnL; percent mode by the average
  // per-trade return in the bucket (where a bucket's trades have one).
  const pct = unit === "pct";
  const value = (b: Bucket): number | null => (pct ? b.avgReturnPct : b.netPnl);
  const v0 = (b: Bucket) => value(b) ?? 0;
  let list = [...bars].sort((a, b) => v0(a) - v0(b));
  if (dim === "coin" && list.length > 8) list = [...list.slice(0, 5), ...list.slice(-3)];
  if (dim === "hour" || dim === "weekday") list = [...bars].sort((a, b) => Number(a.key) - Number(b.key));
  const max = Math.max(pct ? 0.01 : 1, ...list.map((b) => Math.abs(v0(b))));
  if (!list.length) return <Text style={s.hint}>-</Text>;
  return (
    <View>
      {list.map((b) => (
        <View key={b.key} style={s.barRow}>
          <Text style={s.barLabel} numberOfLines={1}>{b.label + " \u00b7 " + b.count}</Text>
          <View style={s.barTrack}>
            <View style={[s.barFill, { width: (Math.round((Math.abs(v0(b)) / max) * 100) + "%") as `${number}%`, backgroundColor: pnlColor(v0(b)) }]} />
          </View>
          <Text style={[s.barValue, { color: pnlColor(v0(b)) }]}>{pct ? pctOrDash(value(b)) : fmtUsdSigned(b.netPnl)}</Text>
        </View>
      ))}
      {pct ? <Text style={s.foot}>avg return on entry notional per trade in the bucket</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border,
    borderRadius: 10, padding: 12, marginBottom: 8,
  },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 6 },
  cardLabel: {
    fontSize: 10, fontWeight: "500", textTransform: "uppercase",
    letterSpacing: 0.7, color: C.muted, flexShrink: 1,
  },
  cardMeta: { fontSize: 10.5, color: C.faint, fontVariant: ["tabular-nums"] },
  hint: { color: C.muted, fontSize: 13, lineHeight: 19 },
  loading: { color: C.faint, fontSize: 10.5, marginRight: 4 },
  unitGroup: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6 },
  windowRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 10 },
  windowLabel: { color: C.faint, fontSize: 10, fontWeight: "500", letterSpacing: 0.7, marginRight: 2 },
  pill: {
    borderWidth: 1, borderColor: C.border, borderRadius: 6,
    paddingHorizontal: 9, paddingVertical: 3, minHeight: 24, justifyContent: "center",
  },
  pillOn: { borderColor: "rgba(0,220,130,0.35)", backgroundColor: C.bullBg },
  pillText: { color: C.muted, fontSize: 11, fontWeight: "500", fontVariant: ["tabular-nums"] },
  pillTextOn: { color: C.bull },
  // Android clips text that overflows its box (overflow hidden by default) and
  // a phone may run a large font scale: every row here may wrap, and
  // every Text beside a sibling may shrink, so nothing is ever cut mid-word.
  equityHead: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  equityValue: { fontSize: 20, fontWeight: "600", marginTop: 3, fontVariant: ["tabular-nums"] },
  equitySub: { fontSize: 10.5, color: C.faint, marginTop: 1 },
  equityRight: { alignItems: "flex-end", gap: 2, flexShrink: 1, minWidth: 0 },
  kvRow: { flexDirection: "row", alignItems: "baseline", gap: 4, flexShrink: 1, minWidth: 0 },
  kv: { fontSize: 10.5, color: C.muted, fontVariant: ["tabular-nums"] },
  kvValue: { color: C.text, fontWeight: "600", flexShrink: 1 },
  chart: { marginTop: 8 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 2 },
  legendItem: { flexDirection: "row", alignItems: "baseline", flexShrink: 1, minWidth: 0 },
  legendSwatch: { width: 10, height: 2, borderRadius: 1, marginRight: 5 },
  legendText: { fontSize: 10.5, color: C.muted, fontVariant: ["tabular-nums"] },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: "33.33%", paddingVertical: 3 },
  cellLabel: { color: C.faint, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  cellValue: { color: C.text, fontSize: 12.5, marginTop: 1, fontVariant: ["tabular-nums"] },
  tableRow: { flexDirection: "row", alignItems: "center", paddingVertical: 4 },
  tableLine: { borderTopWidth: 1, borderTopColor: C.border },
  tableCol: { minWidth: 78, textAlign: "right" },
  tableKey: { flex: 1, color: C.muted, fontSize: 11.5, flexShrink: 1 },
  tableVal: { minWidth: 78, textAlign: "right", color: C.text, fontSize: 11.5, fontWeight: "600", fontVariant: ["tabular-nums"] },
  link: { color: C.info, fontSize: 10.5, fontWeight: "600" },
  bwCols: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  bwRow: { paddingVertical: 5, borderTopWidth: 1, borderTopColor: C.border },
  bwTop: { flexDirection: "row", alignItems: "center", gap: 5 },
  bwSym: { color: C.text, fontSize: 12.5, fontWeight: "600" },
  bwSide: { fontSize: 10, fontWeight: "600" },
  bwNet: { marginLeft: "auto", fontSize: 12.5, fontWeight: "600", fontVariant: ["tabular-nums"] },
  bwSub: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2, flexWrap: "wrap" },
  bwMeta: { color: C.faint, fontSize: 10, fontVariant: ["tabular-nums"], flexShrink: 1 },
  sentences: { gap: 4, marginTop: 6, marginBottom: 8 },
  sentence: { fontSize: 11.5, lineHeight: 16, color: C.muted },
  sentenceHead: { color: C.text, fontWeight: "600" },
  dimRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 6 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3 },
  barLabel: { minWidth: 96, maxWidth: 140, flexShrink: 1, color: C.muted, fontSize: 11 },
  barTrack: { flex: 1, minWidth: 40, height: 5, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.06)", overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 3 },
  barValue: { minWidth: 68, textAlign: "right", fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"] },
  foot: { color: C.faint, fontSize: 10, lineHeight: 14, marginTop: 6 },
});
