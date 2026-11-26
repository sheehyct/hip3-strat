// Settings: the wallet address (read-only), the keys, trading rules
// (one-click, demo), global quick-size presets, and per-market settings
// (slippage cap, max notional, contract presets).
import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Field, NumField, SwitchRow } from "@/components/field";
import { AgentKeyRow, MfpKeyRow } from "@/components/key-rows";
import { Card, GroupLabel, Pill } from "@/components/kit";
import { isValidAddress } from "@/lib/hyperliquid";
import { DEFAULT_MARKET_SETTINGS, MAX_SLIPPAGE } from "@/lib/order_policy";
import { getSettings, marketSettings, setMarketSettings, subscribeSettings, updateSettings } from "@/lib/settings_store";
import { VENUE_LABEL } from "@/lib/types";
import { subscribeVenues, venueState, venuesChanged } from "@/lib/venue_store";
import { C, F, S, T } from "@/theme";

export default function SettingsScreen() {
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const venues = useSyncExternalStore(subscribeVenues, venueState);
  const insets = useSafeAreaInsets();
  const [wallet, setWallet] = useState(settings.wallet);
  const [walletMsg, setWalletMsg] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string | null>(settings.symbol);

  const saveWallet = () => {
    const w = wallet.trim();
    if (w && !isValidAddress(w)) { setWalletMsg("not a 0x address (40 hex)"); return; }
    updateSettings({ wallet: w });
    setWalletMsg(w ? "saved" : "cleared");
    venuesChanged();
  };

  const markets = venues.markets;
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    const withSettings = new Set(Object.keys(settings.markets));
    const list = q ? markets.filter((m) => m.symbol.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : markets.filter((m) => withSettings.has(m.key) || settings.watchlist.includes(m.key));
    return list.slice(0, 30);
  }, [markets, search, settings.markets, settings.watchlist]);
  const pickedMarket = picked ? markets.find((m) => m.key === picked) ?? null : null;
  const ms = picked ? marketSettings(picked) : DEFAULT_MARKET_SETTINGS;
  const presetText = (i: number) => (ms.presets && ms.presets[i] !== undefined ? ms.presets[i] : null);
  const setPreset = (i: number, v: number | null) => {
    if (!picked) return;
    const arr = [...(ms.presets ?? [])];
    while (arr.length < 3) arr.push(0);
    arr[i] = v ?? 0;
    const clean = arr.filter((x) => x > 0);
    setMarketSettings(picked, { presets: clean.length ? clean : null });
  };

  return (
    <View style={s.screen}>
      <View style={[s.header, { paddingTop: insets.top + 6 }]}>
        <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} hitSlop={8} style={s.back} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={24} color={C.text} />
        </Pressable>
        <Text style={s.title}>Settings</Text>
      </View>
      <ScrollView contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 40 }]} keyboardShouldPersistTaps="handled">
        <GroupLabel>Hyperliquid</GroupLabel>
        <Card style={s.card}>
          <Field label="Wallet address (read only)" value={wallet} onChange={setWallet} placeholder="0x..." hint="The account whose positions are shown. Never a private key." error={walletMsg && walletMsg.startsWith("not") ? walletMsg : null} />
          <View style={s.row}>
            <Pill label="Save address" on={false} onPress={saveWallet} />
            {walletMsg && !walletMsg.startsWith("not") ? <Text style={s.note}>{walletMsg}</Text> : null}
          </View>
          <AgentKeyRow wallet={settings.wallet} />
        </Card>

        <GroupLabel>MyFundedPerps</GroupLabel>
        <Card style={s.card}>
          <MfpKeyRow slot="trade" />
          <View style={s.divider} />
          <MfpKeyRow slot="view" />
        </Card>

        <GroupLabel>Trading rules</GroupLabel>
        <Card style={s.card}>
          <SwitchRow label="One-click trading" value={settings.oneClick} onChange={(v) => updateSettings({ oneClick: v })} hint="Opening orders send on one tap, without a confirm sheet, when under the market's max notional. Closing is always one tap. Default off." />
          <SwitchRow label="Demo mode (mock venues)" value={settings.demo} onChange={(v) => updateSettings({ demo: v })} hint="Fake positions, orders and fills with synthetic candles. No network, no keys, nothing real can be sent." />
          <SwitchRow label="Strong magnet (drawings)" value={settings.magnet} onChange={(v) => updateSettings({ magnet: v })} hint="Every drawing point snaps to the nearest open, high, low or close of the bar under the pointer." />
          <View style={s.row}>
            <Text style={s.label}>Layout</Text>
            {(["auto", "desktop", "phone"] as const).map((l) => (
              <Pill key={l} label={l} on={settings.layout === l} onPress={() => updateSettings({ layout: l })} />
            ))}
          </View>
        </Card>

        <GroupLabel>Quick size, all markets (USD)</GroupLabel>
        <Card style={s.card}>
          <View style={s.row}>
            {[0, 1, 2].map((i) => (
              <NumField key={i} label={"Preset " + (i + 1)} value={settings.dollarPresets[i] ?? null} suffix="$" style={s.third}
                onChange={(v) => { const d = [...settings.dollarPresets]; d[i] = v ?? 0; updateSettings({ dollarPresets: d.filter((x) => x > 0) }); }} />
            ))}
          </View>
          <View style={s.row}>
            {[0, 1, 2].map((i) => (
              <NumField key={i} label={"Close " + (i + 1)} value={settings.closePcts[i] ?? null} suffix="%" style={s.third} min={1} max={100}
                onChange={(v) => { const d = [...settings.closePcts]; d[i] = v ?? 0; updateSettings({ closePcts: d }); }} />
            ))}
          </View>
          <Text style={s.note}>Defaults: $1,000 max notional and 1% slippage on every market until set below. The builder refuses above 5% slippage.</Text>
        </Card>

        <GroupLabel>Per-market settings</GroupLabel>
        <Card style={s.card}>
          <Field label="Find a market" value={search} onChange={setSearch} placeholder="BTC, NVDA, ETHUSDT..." />
          <View style={s.wrap}>
            {matches.map((m) => (
              <Pill key={m.key} label={VENUE_LABEL[m.venue] + " " + m.symbol + (m.venue === "mfp" && m.provider && m.provider !== "hyperliquid" ? " (" + m.provider + ")" : "")} on={picked === m.key} onPress={() => setPicked(m.key)} />
            ))}
            {!matches.length ? <Text style={s.note}>{markets.length ? "no match" : "markets loading..."}</Text> : null}
          </View>
          {pickedMarket ? (
            <View style={s.market}>
              <Text style={s.marketTitle}>{VENUE_LABEL[pickedMarket.venue] + " " + pickedMarket.symbol}</Text>
              <Text style={s.note}>{pickedMarket.id + (pickedMarket.chartNote ? " - " + pickedMarket.chartNote : "")}</Text>
              <View style={s.row}>
                <NumField label="Slippage cap" value={+(ms.slippage * 100).toFixed(3)} suffix="%" style={s.half} min={0.01} max={MAX_SLIPPAGE * 100}
                  onChange={(v) => { if (v !== null && v > 0 && v <= MAX_SLIPPAGE * 100) setMarketSettings(pickedMarket.key, { slippage: v / 100 }); }} />
                <NumField label="Max notional per order" value={ms.maxNotional} suffix="$" style={s.half} min={1}
                  onChange={(v) => { if (v !== null && v > 0) setMarketSettings(pickedMarket.key, { maxNotional: v }); }} />
              </View>
              <Text style={s.label}>Quick size for this market only (contracts; blank = use the dollar presets)</Text>
              <View style={s.row}>
                {[0, 1, 2].map((i) => (
                  <NumField key={i} label={"Preset " + (i + 1)} value={presetText(i)} suffix={pickedMarket.symbol} style={s.third} onChange={(v) => setPreset(i, v)} />
                ))}
              </View>
            </View>
          ) : null}
        </Card>

        <Text style={s.note}>
          {"Trade Terminal v0.1.0. Charts: TradingView Lightweight Charts (Apache-2.0, THIRD_PARTY_NOTICES.md). " +
            (Platform.OS === "web" ? "Web build: keys live in this tab's memory only and the app is never deployed." : "Keys live in the device secure store behind the biometric gate.")}
        </Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: S.gutter - 6, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  back: { minWidth: S.hit - 8, minHeight: S.hit, alignItems: "center", justifyContent: "center" },
  title: { ...F.semibold, color: C.text, fontSize: T.h1, letterSpacing: -0.4 },
  content: { paddingHorizontal: S.gutter, paddingTop: 4, gap: 4, maxWidth: 760, width: "100%", alignSelf: "center" },
  card: { gap: 12 },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8, flexWrap: "wrap" },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  third: { flexGrow: 1, flexBasis: 0, minWidth: 110 },
  half: { flexGrow: 1, flexBasis: 0, minWidth: 150 },
  divider: { height: 1, backgroundColor: C.border },
  label: { ...F.medium, color: C.faint, fontSize: T.micro, flexShrink: 1 },
  note: { ...F.regular, color: C.faint, fontSize: T.micro, lineHeight: 15, flexShrink: 1 },
  market: { gap: 10, borderTopWidth: 1, borderTopColor: C.border, paddingTop: 10 },
  marketTitle: { ...F.semibold, color: C.text, fontSize: T.bodyL },
});
