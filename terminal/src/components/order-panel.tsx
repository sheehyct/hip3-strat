// Order entry: the right-hand panel on desktop, a sheet on the phone.
// Venue, margin mode and leverage at the top (the current setting; changing
// it is a separate explicit Apply), Market / Limit tabs, Buy-Long /
// Sell-Short, size in contracts or dollars with a 0-100 percent slider of
// the available balance at that leverage, quick-size presets (dollars for
// all markets or contracts for this market, editable in place), Close
// 25 / 50 / 100, reduce-only, optional TP / SL, then the info block.
//
// Every submit builds an OrderIntent and hands it to venue_store.placeOrder,
// which runs the policy (max notional, slippage cap, reduce-only, close
// cannot increase). An OPENING order shows a confirm sheet unless
// One-click trading is on AND the order is under the market's max notional;
// a reducing order is always one tap.
import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ConfirmSheet } from "@/components/confirm-sheet";
import { MiniInput, SwitchRow } from "@/components/field";
import { OneClickPanel } from "@/components/one-click";
import { fmtPct, fmtPx, fmtUsd } from "@/lib/fmt";
import { checkIntent, closeSize, MAX_SLIPPAGE, oneClickAllowed, sizeForDollars } from "@/lib/order_policy";
import type { OrderIntent } from "@/lib/order_policy";
import { getSettings, marketSettings, setMarketSettings, subscribeSettings, updateSettings } from "@/lib/settings_store";
import { midOf, subscribeTicker, tickerState } from "@/lib/ticker_store";
import type { Market } from "@/lib/types";
import { closePosition, intentReduces, markFor, marketLocks, placeOrder, setLeverage, subscribeVenues, venueState } from "@/lib/venue_store";
import { C, F, S, T } from "@/theme";

const LEV_STEPS = [1, 2, 3, 5, 10, 20, 25, 40, 50];
// Base-tier taker fees, shown as an estimate (the venue's own tier applies).
const FEE_EST: Record<"hl" | "mfp", number> = { hl: 0.00045, mfp: 0.0003 };

export function OrderPanel({ market, siblings, onVenue, phone }: { market: Market | null; siblings: Market[]; onVenue: (m: Market) => void; phone: boolean }) {
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const venues = useSyncExternalStore(subscribeVenues, venueState);
  useSyncExternalStore(subscribeTicker, tickerState);
  const ms = market ? marketSettings(market.key) : null;
  const pos = market ? venues.positions.find((p) => p.venue === market.venue && p.marketId === market.id) ?? null : null;
  const bal = market ? venues.balances[market.venue] : null;
  const mark = market ? (midOf(market.chartCoin) ?? markFor(market)) : null;

  const [type, setType] = useState<"market" | "limit">("market");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [sizeText, setSizeText] = useState("");
  const [unit, setUnit] = useState<"contracts" | "usd">("contracts");
  const [priceText, setPriceText] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [tpsl, setTpsl] = useState(false);
  const [tpText, setTpText] = useState("");
  const [slText, setSlText] = useState("");
  const [slipText, setSlipText] = useState("");
  const [lev, setLev] = useState<number | null>(null);
  const [cross, setCross] = useState(true);
  const [editPresets, setEditPresets] = useState(false);
  const [presetScope, setPresetScope] = useState<"all" | "market">("all");
  const [oneClickOpen, setOneClickOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ intent: OrderIntent; market: Market; notional: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [trackW, setTrackW] = useState(0);

  // A market switch resets the draft; the leverage control shows the
  // position's current setting when there is one.
  useEffect(() => {
    setSizeText(""); setPriceText(""); setTpText(""); setSlText(""); setTpsl(false); setReduceOnly(false); setMsg(null); setConfirm(null);
    setSlipText(ms ? String(+(ms.slippage * 100).toFixed(2)) : "");
    setLev(pos?.leverage ?? null);
    setCross(pos ? pos.marginMode !== "isolated" : true);
    setPresetScope(ms?.presets ? "market" : "all");
  }, [market?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (pos && lev === null) { setLev(pos.leverage ?? null); setCross(pos.marginMode !== "isolated"); } }, [pos?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const leverage = lev ?? pos?.leverage ?? 5;
  const price = type === "limit" ? parseFloat(priceText) : mark ?? NaN;
  const sizeNum = parseFloat(sizeText);
  const size = unit === "usd" ? sizeForDollars(Number.isFinite(sizeNum) ? sizeNum : 0, Number.isFinite(price) ? price : 0, market?.szDecimals ?? null) : Number.isFinite(sizeNum) ? sizeNum : 0;
  const notional = Number.isFinite(price) && size > 0 ? size * price : 0;
  const slippage = (() => { const v = parseFloat(slipText); return Number.isFinite(v) && v > 0 ? v / 100 : ms?.slippage ?? 0.01; })();
  const maxSize = bal && bal.available !== null && Number.isFinite(price) && price > 0 ? sizeForDollars(bal.available * leverage, price, market?.szDecimals ?? null) : 0;
  const pct = maxSize > 0 ? Math.min(100, Math.max(0, (size / maxSize) * 100)) : 0;
  const setPct = (p: number) => {
    if (maxSize <= 0) return;
    const sz = Math.floor(maxSize * (p / 100) * 1e6) / 1e6;
    setUnit("contracts");
    setSizeText(String(sz));
  };

  // Hyperliquid cannot attach TP / SL to a limit order, so the panel does
  // not offer them there (order_policy refuses them too).
  const exitsOffered = !(market?.venue === "hl" && type === "limit");
  const intent: OrderIntent | null = market ? {
    venue: market.venue, marketId: market.id, side, type, size, price: type === "limit" ? (Number.isFinite(price) ? price : null) : null,
    reduceOnly, postOnly: type === "limit" && postOnly && market.venue === "hl", slippage,
    tp: exitsOffered && tpsl && tpText ? parseFloat(tpText) : null, sl: exitsOffered && tpsl && slText ? parseFloat(slText) : null,
    leverage, marginMode: cross ? "cross" : "isolated",
  } : null;
  const check = useMemo(() => (intent && market && ms ? checkIntent(intent, { mark, position: pos ? { side: pos.side, size: pos.size } : null, settings: ms, szDecimals: market.szDecimals }) : null), [intent, market, ms, mark, pos]);
  const reduces = intent && market ? intentReduces(intent, market) : false;
  // A write in flight locks the whole market; one the venue has not
  // settled yet locks only an order that would add exposure.
  const locks = market ? marketLocks(venues.pending, market.venue, market.id) : { reduce: false, open: false };
  const lockedHere = reduces ? locks.reduce : locks.open;

  const submit = async () => {
    if (!intent || !market || !ms || !check) return;
    setMsg(null);
    if (!check.ok) { setMsg(check.reason); return; }
    if (oneClickAllowed(settings.oneClick, reduces, check.notional, ms)) {
      const r = await placeOrder(intent, market);
      setMsg(r.message ?? r.state);
      if (r.state === "confirmed") setSizeText("");
    } else {
      setConfirm({ intent, market, notional: check.notional });
    }
  };
  const sendConfirmed = async () => {
    if (!confirm) return;
    const c = confirm;
    setConfirm(null);
    const r = await placeOrder(c.intent, c.market);
    setMsg(r.message ?? r.state);
    if (r.state === "confirmed") setSizeText("");
  };

  const applyLeverage = async () => {
    if (!market || lev === null) return;
    const r = await setLeverage(market.key, lev, cross);
    setMsg(r.message ?? r.state);
  };

  const presets = presetScope === "market" && ms?.presets ? ms.presets : null;
  const fillPreset = (i: number) => {
    if (presets) { setUnit("contracts"); setSizeText(String(presets[i])); }
    else { setUnit("usd"); setSizeText(String(settings.dollarPresets[i] ?? 0)); }
  };
  const marginPct = bal && bal.equity && bal.marginUsed !== null ? (bal.marginUsed / bal.equity) * 100 : null;
  const remaining = bal?.exposureCap !== null && bal?.exposureCap !== undefined ? bal.exposureCap - (pos ? pos.notional : 0) - notional : null;

  if (!market || !ms) return <View style={s.panel}><Text style={s.note}>pick a market</Text></View>;
  const sideColor = side === "buy" ? C.bull : C.bear;
  const canSubmit = size > 0 && !lockedHere && check !== null;
  const label = (side === "buy" ? "Buy / Long " : "Sell / Short ") + market.symbol + (reduces ? " (reduce)" : "");

  return (
    <View style={s.panel}>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {/* venue + margin mode + leverage */}
        <View style={s.row}>
          {siblings.length > 1 ? siblings.map((m) => (
            <Pressable key={m.key} onPress={() => onVenue(m)} style={[s.chip, m.key === market.key && s.chipOn]} accessibilityRole="button" accessibilityState={{ selected: m.key === market.key }}>
              <Text style={[s.chipText, m.key === market.key && s.chipTextOn, m.venue === "mfp" && m.key !== market.key && { color: C.warn }]}>{m.venue === "hl" ? "HL" : "MFP" + (m.provider && m.provider !== "hyperliquid" ? " " + m.provider : "")}</Text>
            </Pressable>
          )) : <Text style={s.venueOne}>{market.venue === "hl" ? "Hyperliquid" : "MyFundedPerps"}</Text>}
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => setOneClickOpen((v) => !v)} style={[s.flash, oneClickOpen && s.flashOn]} accessibilityRole="button" accessibilityLabel="One-click panel" accessibilityState={{ selected: oneClickOpen }}>
            <Ionicons name="flash" size={15} color={oneClickOpen ? C.accentText : C.muted} />
          </Pressable>
        </View>
        <View style={s.row}>
          <Pressable onPress={() => setCross((c) => !c)} style={s.select} accessibilityRole="button" accessibilityLabel="Margin mode">
            <Text style={s.selectText}>{cross ? "Cross" : "Isolated"}</Text>
            <Ionicons name="swap-horizontal" size={13} color={C.faint} />
          </Pressable>
          <View style={[s.select, { flex: 1.4 }]}>
            <Pressable onPress={() => setLev(stepLev(leverage, -1, market.maxLeverage))} hitSlop={6} style={s.stepBtn} accessibilityLabel="Lower leverage"><Text style={s.stepText}>-</Text></Pressable>
            <Text style={[s.selectText, { flex: 1, textAlign: "center" }]}>{leverage + "x"}</Text>
            <Pressable onPress={() => setLev(stepLev(leverage, 1, market.maxLeverage))} hitSlop={6} style={s.stepBtn} accessibilityLabel="Raise leverage"><Text style={s.stepText}>+</Text></Pressable>
          </View>
          {market.venue === "hl" && (lev !== null && (lev !== pos?.leverage || cross !== (pos?.marginMode !== "isolated"))) ? (
            <Pressable onPress={applyLeverage} style={s.apply} accessibilityRole="button" accessibilityLabel="Apply leverage on the venue"><Text style={s.applyText}>Apply</Text></Pressable>
          ) : null}
        </View>
        {market.venue === "mfp" ? <Text style={s.hint}>MFP applies leverage and margin mode per order.</Text> : pos ? <Text style={s.hint}>{"position: " + (pos.leverage ?? "-") + "x " + (pos.marginMode ?? "")}</Text> : null}

        {oneClickOpen ? <OneClickPanel market={market} leverage={leverage} cross={cross} /> : null}

        {/* type + side */}
        <View style={s.tabs}>
          {(["market", "limit"] as const).map((t) => (
            <Pressable key={t} onPress={() => setType(t)} style={s.tab} accessibilityRole="tab" accessibilityState={{ selected: type === t }}>
              <Text style={[s.tabText, type === t && s.tabTextOn]}>{t === "market" ? "Market" : "Limit"}</Text>
              <View style={[s.tabBar, type === t && s.tabBarOn]} />
            </Pressable>
          ))}
        </View>
        <View style={s.sideRow}>
          <Pressable onPress={() => setSide("buy")} style={[s.sideBtn, side === "buy" && { backgroundColor: C.bull }]} accessibilityRole="button" accessibilityState={{ selected: side === "buy" }}>
            <Text style={[s.sideText, side === "buy" && { color: "#0b0e12" }]}>Buy / Long</Text>
          </Pressable>
          <Pressable onPress={() => setSide("sell")} style={[s.sideBtn, side === "sell" && { backgroundColor: C.bear }]} accessibilityRole="button" accessibilityState={{ selected: side === "sell" }}>
            <Text style={[s.sideText, side === "sell" && { color: "#0b0e12" }]}>Sell / Short</Text>
          </Pressable>
        </View>

        {/* size */}
        <Text style={s.label}>Size</Text>
        <View style={s.row}>
          <MiniInput value={sizeText} onChange={setSizeText} placeholder="0.00" width={120} style={{ flex: 1 }} align="left" />
          <Pressable onPress={() => setUnit((u) => (u === "usd" ? "contracts" : "usd"))} style={s.unit} accessibilityRole="button" accessibilityLabel="Toggle size unit">
            <Text style={s.unitText}>{unit === "usd" ? "USD" : market.symbol}</Text>
            <Ionicons name="swap-vertical" size={12} color={C.faint} />
          </Pressable>
        </View>
        {size > 0 ? <Text style={s.hint}>{unit === "usd" ? "= " + size + " " + market.symbol : "= " + fmtUsd(notional)}</Text> : null}
        <View style={s.slider}>
          <Pressable
            style={s.track}
            onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
            onPress={(e) => { const x = e.nativeEvent.locationX; if (trackW > 0) setPct(Math.round((x / trackW) * 100)); }}
            accessibilityRole="adjustable"
            accessibilityLabel="Size as a percent of available balance"
          >
            <View style={[s.fill, { width: `${pct}%` as const }]} />
            <View style={[s.knob, { left: `${pct}%` as const }]} />
          </Pressable>
          <Text style={s.pctText}>{Math.round(pct) + "%"}</Text>
        </View>
        <View style={s.pcts}>
          {[0, 25, 50, 75, 100].map((p) => (
            <Pressable key={p} onPress={() => setPct(p)} hitSlop={6} style={s.pctBtn} accessibilityRole="button" accessibilityLabel={p + " percent"}><Text style={s.pctLabel}>{p + "%"}</Text></Pressable>
          ))}
        </View>

        {/* limit price */}
        {type === "limit" ? (
          <>
            <Text style={s.label}>Limit price</Text>
            <View style={s.row}>
              <MiniInput value={priceText} onChange={setPriceText} placeholder={mark ? fmtPx(mark).replace(/,/g, "") : "0"} style={{ flex: 1 }} align="left" />
              <Pressable onPress={() => { if (mark) setPriceText(String(+mark.toPrecision(8))); }} style={s.unit}><Text style={s.unitText}>mark</Text></Pressable>
            </View>
            {market.venue === "hl" ? <SwitchRow label="Post only" value={postOnly} onChange={setPostOnly} /> : null}
          </>
        ) : null}

        {/* quick size */}
        <View style={s.row}>
          <Ionicons name="flash-outline" size={13} color={C.muted} />
          <Text style={s.label}>Quick size</Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => setEditPresets((e) => !e)} hitSlop={6} accessibilityRole="button" accessibilityLabel={editPresets ? "Done editing quick sizes" : "Edit quick sizes"}>
            {editPresets ? <Text style={s.done}>Done</Text> : <Ionicons name="create-outline" size={15} color={C.muted} />}
          </Pressable>
        </View>
        {editPresets ? (
          <View style={s.scope}>
            <Pressable onPress={() => setPresetScope("all")} style={[s.scopeBtn, presetScope === "all" && s.scopeOn]}><Text style={[s.scopeText, presetScope === "all" && s.scopeTextOn]}>All markets</Text></Pressable>
            <Pressable onPress={() => { setPresetScope("market"); if (!ms.presets) setMarketSettings(market.key, { presets: [1, 2, 5] }); }} style={[s.scopeBtn, presetScope === "market" && s.scopeOn]}><Text style={[s.scopeText, presetScope === "market" && s.scopeTextOn]}>{market.symbol + " only"}</Text></Pressable>
          </View>
        ) : null}
        <View style={s.presetRow}>
          <Text style={s.presetLabel}>{side === "buy" ? "Long" : "Short"}</Text>
          {[0, 1, 2].map((i) => {
            const v = presets ? presets[i] : settings.dollarPresets[i];
            if (editPresets) {
              return (
                <MiniInput key={i} value={v === undefined ? "" : String(v)} width={70} style={{ flex: 1 }} suffix={presets ? market.symbol : "$"}
                  onChange={(t) => {
                    const n = parseFloat(t);
                    if (presets) { const arr = [...presets]; arr[i] = Number.isFinite(n) ? n : 0; setMarketSettings(market.key, { presets: arr.filter((x) => x > 0).length ? arr : null }); }
                    else { const arr = [...settings.dollarPresets]; arr[i] = Number.isFinite(n) ? n : 0; updateSettings({ dollarPresets: arr.filter((x) => x > 0) }); }
                  }} />
              );
            }
            if (v === undefined) return <View key={i} style={{ flex: 1 }} />;
            return (
              <Pressable key={i} onPress={() => fillPreset(i)} style={[s.preset, { borderColor: side === "buy" ? "rgba(0,220,130,0.35)" : "rgba(255,59,92,0.35)" }]} accessibilityRole="button" accessibilityLabel={"Size " + (presets ? v + " " + market.symbol : "$" + v)}>
                <Text style={[s.presetText, { color: sideColor }]}>{presets ? v + " " + market.symbol : "$" + v.toLocaleString("en-US")}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={s.presetRow}>
          <Text style={s.presetLabel}>Close</Text>
          {settings.closePcts.map((p, i) => (
            editPresets ? (
              <MiniInput key={i} value={String(p)} width={60} style={{ flex: 1 }} suffix="%" onChange={(t) => { const n = parseFloat(t); const arr = [...settings.closePcts]; arr[i] = Number.isFinite(n) ? n : p; updateSettings({ closePcts: arr }); }} />
            ) : (
              <Pressable key={i} onPress={() => { if (pos) closePosition(pos.key, p / 100); else setMsg("no position to close"); }} disabled={!pos || locks.reduce} style={[s.preset, !pos && { opacity: 0.4 }]} accessibilityRole="button" accessibilityLabel={"Close " + p + " percent"}>
                <Text style={s.presetText}>{p + "%"}</Text>
              </Pressable>
            )
          ))}
        </View>
        {pos ? <Text style={s.hint}>{"close " + settings.closePcts.map((p) => closeSize(pos, p / 100, market.szDecimals ?? (pos.ref.kind === "mfp" ? pos.ref.sizeDecimals : null))).join(" / ") + " " + market.symbol}</Text> : null}

        <SwitchRow label="Reduce only" value={reduceOnly} onChange={setReduceOnly} />
        {exitsOffered ? <SwitchRow label="Take profit / stop loss" value={tpsl} onChange={setTpsl} /> : <Text style={s.hint}>TP / SL: a Hyperliquid limit order cannot carry them. Set them from the chart once it fills.</Text>}
        {exitsOffered && tpsl ? (
          <View style={s.row}>
            <MiniInput value={tpText} onChange={setTpText} placeholder="TP price" style={{ flex: 1 }} align="left" />
            <MiniInput value={slText} onChange={setSlText} placeholder="SL price" style={{ flex: 1 }} align="left" />
          </View>
        ) : null}

        {/* submit */}
        <Pressable onPress={submit} disabled={!canSubmit} style={({ pressed }) => [s.submit, { backgroundColor: side === "buy" ? "rgba(0,220,130,0.55)" : "rgba(255,59,92,0.55)" }, !canSubmit && { opacity: 0.45 }, pressed && canSubmit && { opacity: 0.8 }]} accessibilityRole="button" accessibilityLabel={label}>
          <Text style={s.submitText}>{locks.reduce ? "working..." : lockedHere ? "waiting for the venue" : label}</Text>
        </Pressable>
        {check && !check.ok && size > 0 ? <Text style={s.refuse}>{check.reason}</Text> : null}
        {msg && !(check && !check.ok && msg === check.reason) ? <Text style={s.msg}>{msg}</Text> : null}
        {!settings.oneClick && !reduces ? <Text style={s.hint}>Opening orders confirm first (One-click trading is off in Settings).</Text> : null}

        {/* info */}
        <View style={s.info}>
          <Info label="Estimated price" value={fmtPx(Number.isFinite(price) ? price : null)} />
          <View style={s.infoRow}>
            <Text style={s.infoLabel}>Max slippage</Text>
            <View style={{ flex: 1 }} />
            <MiniInput value={slipText} onChange={setSlipText} width={72} style={{ flexGrow: 0, width: 72 }} suffix="%" onBlur={() => { const v = parseFloat(slipText); if (Number.isFinite(v) && v > 0 && v <= MAX_SLIPPAGE * 100) setMarketSettings(market.key, { slippage: v / 100 }); else setSlipText(String(+(ms.slippage * 100).toFixed(2))); }} />
          </View>
          {slippage > MAX_SLIPPAGE ? <Text style={s.refuse}>{"above " + MAX_SLIPPAGE * 100 + "% - the builder refuses"}</Text> : null}
          <Info label="Fees (est., base tier)" value={fmtPct(FEE_EST[market.venue] * 100, false, 3) + (notional ? " = " + fmtUsd(notional * FEE_EST[market.venue]) : "")} />
          <Info label="Max notional (this market)" value={fmtUsd(ms.maxNotional)} />
          {bal?.exposureCap !== null && bal?.exposureCap !== undefined ? <Info label="Max position value" value={fmtUsd(bal.exposureCap)} /> : null}
          {bal?.accountExposureCap !== null && bal?.accountExposureCap !== undefined ? <Info label="Account exposure cap" value={fmtUsd(bal.accountExposureCap)} /> : null}
          {remaining !== null ? <Info label="Estimated remaining" value={fmtUsd(remaining)} color={remaining < 0 ? C.bear : undefined} /> : null}
          <View style={s.sep} />
          <Info label="Margin used" value={marginPct !== null ? fmtPct(marginPct, false) : "-"} />
          <View style={s.bar}><View style={[s.barFill, { width: `${Math.min(100, Math.max(0, marginPct ?? 0))}%` as const }]} /></View>
          <Info label="Margin balance" value={fmtUsd(bal?.equity)} />
          <Info label="Available balance" value={fmtUsd(bal?.available)} />
          {bal ? <Text style={s.hint}>{bal.label}</Text> : null}
        </View>
        {phone ? <View style={{ height: 20 }} /> : null}
      </ScrollView>
      <ConfirmSheet
        visible={confirm !== null}
        intent={confirm?.intent ?? null}
        market={confirm?.market ?? null}
        notional={confirm?.notional ?? 0}
        onCancel={() => setConfirm(null)}
        onSend={sendConfirmed}
      />
    </View>
  );
}

function stepLev(cur: number, dir: 1 | -1, max: number | null): number {
  const cap = max ?? 50;
  const steps = LEV_STEPS.filter((x) => x <= cap);
  if (!steps.includes(cap)) steps.push(cap);
  let i = steps.findIndex((x) => x >= cur);
  if (i < 0) i = steps.length - 1;
  if (steps[i] !== cur && dir < 0) i = Math.max(0, i);
  else i = Math.max(0, Math.min(steps.length - 1, i + dir));
  return steps[i];
}

function Info({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={s.infoRow}>
      <Text style={s.infoLabel}>{label}</Text>
      <View style={{ flex: 1 }} />
      <Text style={[s.infoValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  panel: { flex: 1, minHeight: 0 },
  content: { padding: 10, gap: 8 },
  note: { ...F.regular, color: C.faint, fontSize: T.caption, padding: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  chip: { minHeight: 32, paddingHorizontal: 10, borderRadius: S.radiusSm, borderWidth: 1, borderColor: C.border, backgroundColor: C.card, justifyContent: "center" },
  chipOn: { borderColor: C.accentBorder, backgroundColor: C.accentBg },
  chipText: { ...F.semibold, color: C.muted, fontSize: T.caption },
  chipTextOn: { color: C.accentText },
  venueOne: { ...F.semibold, color: C.muted, fontSize: T.caption },
  flash: { minWidth: 34, minHeight: 34, borderRadius: S.radiusSm, borderWidth: 1, borderColor: C.border, alignItems: "center", justifyContent: "center" },
  flashOn: { borderColor: C.accentBorder, backgroundColor: C.accentBg },
  select: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, minHeight: 38, paddingHorizontal: 10, borderRadius: S.radiusSm, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg },
  selectText: { ...F.medium, color: C.text, fontSize: T.body },
  stepBtn: { minWidth: 28, minHeight: 32, alignItems: "center", justifyContent: "center" },
  stepText: { ...F.semibold, color: C.muted, fontSize: T.bodyL },
  apply: { minHeight: 38, paddingHorizontal: 12, borderRadius: S.radiusSm, backgroundColor: C.accent, alignItems: "center", justifyContent: "center" },
  applyText: { ...F.semibold, color: "#fff", fontSize: T.caption },
  hint: { ...F.regular, color: C.faint, fontSize: T.micro, lineHeight: 15, flexShrink: 1 },
  tabs: { flexDirection: "row", gap: 20, borderBottomWidth: 1, borderBottomColor: C.border },
  tab: { paddingTop: 4, minHeight: 34, justifyContent: "flex-end" },
  tabText: { ...F.medium, color: C.muted, fontSize: T.body, paddingBottom: 7 },
  tabTextOn: { color: C.text },
  tabBar: { height: 2, borderRadius: 2, backgroundColor: "transparent" },
  tabBarOn: { backgroundColor: C.accent },
  sideRow: { flexDirection: "row", gap: 4, backgroundColor: C.bg, borderRadius: S.radiusMd, padding: 3, borderWidth: 1, borderColor: C.border },
  sideBtn: { flex: 1, minHeight: 40, borderRadius: S.radiusSm, alignItems: "center", justifyContent: "center" },
  sideText: { ...F.semibold, color: C.muted, fontSize: T.body },
  label: { ...F.medium, color: C.muted, fontSize: T.caption },
  unit: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 36, paddingHorizontal: 10, borderRadius: S.radiusSm, borderWidth: 1, borderColor: C.border },
  unitText: { ...F.semibold, color: C.muted, fontSize: T.caption },
  slider: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 32 },
  track: { flex: 1, height: 28, justifyContent: "center" },
  fill: { position: "absolute", left: 0, height: 4, borderRadius: 2, backgroundColor: C.accent },
  knob: { position: "absolute", marginLeft: -8, width: 16, height: 16, borderRadius: 8, backgroundColor: C.text, borderWidth: 2, borderColor: C.accent },
  pctText: { ...F.medium, color: C.text, fontSize: T.caption, minWidth: 40, textAlign: "right", fontVariant: ["tabular-nums"] },
  pcts: { flexDirection: "row", justifyContent: "space-between" },
  pctBtn: { minHeight: 24, minWidth: 36, alignItems: "center", justifyContent: "center" },
  pctLabel: { ...F.regular, color: C.faint, fontSize: T.micro },
  done: { ...F.semibold, color: C.accentText, fontSize: T.caption },
  scope: { flexDirection: "row", gap: 4, backgroundColor: C.bg, borderRadius: S.radiusSm, padding: 3, borderWidth: 1, borderColor: C.border },
  scopeBtn: { flex: 1, minHeight: 32, alignItems: "center", justifyContent: "center", borderRadius: 5 },
  scopeOn: { backgroundColor: C.accentBg },
  scopeText: { ...F.medium, color: C.muted, fontSize: T.caption },
  scopeTextOn: { color: C.accentText },
  presetRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  presetLabel: { ...F.regular, color: C.faint, fontSize: T.caption, minWidth: 40 },
  preset: { flex: 1, minHeight: 36, borderRadius: S.radiusSm, borderWidth: 1, borderColor: C.border, backgroundColor: C.card, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
  presetText: { ...F.semibold, color: C.text, fontSize: T.caption, fontVariant: ["tabular-nums"] },
  submit: { minHeight: 46, borderRadius: S.radiusMd, alignItems: "center", justifyContent: "center", marginTop: 4 },
  submitText: { ...F.semibold, color: C.text, fontSize: T.bodyL },
  refuse: { ...F.regular, color: C.bear, fontSize: T.micro, lineHeight: 15, flexShrink: 1 },
  msg: { ...F.regular, color: C.muted, fontSize: T.caption, lineHeight: 16, flexShrink: 1 },
  info: { borderWidth: 1, borderColor: C.border, borderRadius: S.radiusMd, padding: 10, gap: 6, backgroundColor: C.card },
  infoRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 20 },
  infoLabel: { ...F.regular, color: C.muted, fontSize: T.caption, flexShrink: 1 },
  infoValue: { ...F.medium, color: C.text, fontSize: T.caption, fontVariant: ["tabular-nums"] },
  sep: { height: 1, backgroundColor: C.border, marginVertical: 2 },
  bar: { height: 4, borderRadius: 2, backgroundColor: C.border, overflow: "hidden" },
  barFill: { height: 4, backgroundColor: C.accent },
});
