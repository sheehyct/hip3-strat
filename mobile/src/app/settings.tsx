// Settings tab: wallet address (on-device only) and worker URL override.
import * as Application from "expo-application";
import * as Updates from "expo-updates";
import { useCallback, useEffect, useState } from "react";
import {
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AgentKeyRow } from "@/components/agent-key-row";
import { MfpKeyRows } from "@/components/mfp-key-rows";
import { alertScopeLine, getAlertScope } from "@/lib/alert_scope";
import { DEFAULT_WORKER_URL } from "@/lib/api";
import { DisplayParity, getDisplayParity } from "@/lib/display_parity";
import { selfTest } from "@/lib/hl_sign";
import { isValidAddress } from "@/lib/hyperliquid";
import { registerForPush, unregisterPush } from "@/lib/push";
import {
  getPushKey,
  getPushToken,
  getWallets,
  getWorkerUrl,
  setPushKey,
  setWallets,
  setWorkerUrl,
  Wallet,
} from "@/lib/store";
import { C } from "@/theme";

const APP_VERSION = Application.nativeApplicationVersion ?? "development";
const BUILD_VERSION = Application.nativeBuildVersion ?? "-";
const UPDATE_CHANNEL = Updates.channel || "embedded";
const UPDATE_RUNTIME = Updates.runtimeVersion || "development";
const UPDATE_SOURCE = Updates.isEmbeddedLaunch
  ? "embedded"
  : Updates.updateId?.slice(0, 8) ?? "development";

// Short form of a display-core hash, matching UPDATE_SOURCE's 8-char idiom.
const shortV = (v: string) => v.slice(0, 8);

// Part of release identity, not a setting: which DISPLAY-CORE block this build
// vendors, and whether the worker agrees. console.warn is invisible on a
// handset, so this line is how the mismatch actually reaches a user - the whole
// point of the stamp being "correct in git, stale on the phone" insurance.
function displayCoreLine(p: DisplayParity): string {
  if (p.match === null) return "display core " + shortV(p.local) + " / worker unknown";
  if (p.match) return "display core " + shortV(p.local) + " / worker matches";
  return "display core " + shortV(p.local) + " / worker " + shortV(p.server ?? "") +
    " - display may differ from the dashboard";
}

export default function Settings() {
  const insets = useSafeAreaInsets();
  const [wallets, setWalletList] = useState<Wallet[]>([]);
  const [newLabel, setNewLabel] = useState("");
  const [newAddr, setNewAddr] = useState("");
  const [walletMsg, setWalletMsg] = useState("");
  const [url, setUrl] = useState("");
  const [saved, setSaved] = useState("");
  const [pushKey, setKey] = useState("");
  const [pushStatus, setPushStatus] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  // Snapshot on mount: the screener's poll is what records the worker's value,
  // and this screen remounts on every visit, so a fresh read is current enough.
  const [parity] = useState<DisplayParity>(getDisplayParity);
  // Same snapshot idiom for the worker's alert scope. Null = an older worker
  // (or no payload yet) - render nothing, per the additive-field convention.
  const [scopeLine] = useState<string | null>(() => alertScopeLine(getAlertScope()));
  // Signing self-test: the SDK's public dummy vector signed on THIS build.
  // Proves Hermes + noble + msgpack reproduce the Python SDK's bytes; no
  // secret is involved. Computed once per visit.
  const [signOk] = useState<boolean>(() => selfTest());

  useEffect(() => {
    (async () => {
      setWalletList(await getWallets());
      setUrl(await getWorkerUrl());
      setKey(await getPushKey());
      if (await getPushToken()) setPushStatus("this device is registered");
    })();
  }, []);

  const addWallet = useCallback(async () => {
    Keyboard.dismiss();
    const a = newAddr.trim();
    if (!isValidAddress(a)) {
      setWalletMsg("invalid address - expected 0x + 40 hex chars");
      return;
    }
    if (wallets.some((w) => w.address.toLowerCase() === a.toLowerCase())) {
      setWalletMsg("that address is already tracked");
      return;
    }
    const next = [...wallets, { label: newLabel.trim(), address: a }];
    setWalletList(next);
    await setWallets(next);
    setNewLabel("");
    setNewAddr("");
    setWalletMsg("added");
    setTimeout(() => setWalletMsg(""), 2000);
  }, [wallets, newLabel, newAddr]);

  const removeWallet = useCallback(async (index: number) => {
    const next = wallets.filter((_, i) => i !== index);
    setWalletList(next);
    await setWallets(next);
  }, [wallets]);

  const updateWallet = useCallback(async (index: number, w: Wallet) => {
    const next = wallets.map((x, i) => (i === index ? w : x));
    setWalletList(next);
    await setWallets(next);
  }, [wallets]);

  const doRegister = useCallback(async () => {
    Keyboard.dismiss();
    setPushBusy(true);
    await setPushKey(pushKey); // persist the key first; register reads it back
    await setWorkerUrl(url);
    setPushStatus(await registerForPush());
    setPushBusy(false);
  }, [pushKey, url]);

  const doUnregister = useCallback(async () => {
    setPushBusy(true);
    setPushStatus(await unregisterPush());
    setPushBusy(false);
  }, []);

  const save = useCallback(async () => {
    Keyboard.dismiss();
    await setWorkerUrl(url);
    setSaved("saved");
    setTimeout(() => setSaved(""), 2000);
  }, [url]);

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={[
        s.content,
        { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 90 },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={s.title}>Settings</Text>
      <View
        style={s.releaseIdentity}
        accessible
        accessibilityLabel={
          "App version " + APP_VERSION + ", build " + BUILD_VERSION +
          ", channel " + UPDATE_CHANNEL + ", runtime " + UPDATE_RUNTIME +
          ", update source " + UPDATE_SOURCE
        }
      >
        <Text style={s.releaseVersion}>{"v" + APP_VERSION + " (" + BUILD_VERSION + ")"}</Text>
        <Text style={s.releaseMeta} numberOfLines={1} ellipsizeMode="middle">
          {UPDATE_CHANNEL + " / " + UPDATE_RUNTIME + " / " + UPDATE_SOURCE}
        </Text>
      </View>
      <Text style={[s.displayCore, parity.match === false && s.displayCoreWarn]}>
        {displayCoreLine(parity)}
      </Text>
      <Text style={[s.displayCore, !signOk && s.displayCoreWarn]}>
        {signOk
          ? "signing self-test: ok (SDK vector reproduced on this device)"
          : "signing self-test: MISMATCH - do not use close/flatten on this build"}
      </Text>

      <Text style={s.label}>Hyperliquid wallets</Text>
      {wallets.map((w, i) => (
        <View key={w.address}>
          <View style={s.walletRow}>
            <Text style={s.walletLabel} numberOfLines={1}>
              {w.label || "wallet " + (i + 1)}
            </Text>
            <Text style={s.walletAddr}>
              {w.address.slice(0, 6) + "..." + w.address.slice(-4)}
            </Text>
            <Pressable onPress={() => removeWallet(i)} hitSlop={8}>
              <Text style={s.walletRemove}>remove</Text>
            </Pressable>
          </View>
          <AgentKeyRow wallet={w} onWalletChange={(next) => updateWallet(i, next)} />
        </View>
      ))}
      <TextInput
        style={s.input}
        placeholder="label (optional, e.g. main / algo)"
        placeholderTextColor={C.faint}
        value={newLabel}
        onChangeText={setNewLabel}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={[s.input, { marginTop: 6 }]}
        placeholder="0x..."
        placeholderTextColor={C.faint}
        value={newAddr}
        onChangeText={setNewAddr}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable
        onPress={addWallet}
        style={({ pressed }) => [s.linkButton, pressed && s.buttonPressed]}
      >
        <Text style={s.linkButtonText}>Add wallet</Text>
      </Pressable>
      {walletMsg ? (
        <Text style={[s.savedText, { color: walletMsg === "added" ? C.bull : C.bear }]}>
          {walletMsg}
        </Text>
      ) : null}
      <Text style={s.help}>
        Stored only on this device. Used read-only against Hyperliquid's public
        info API to show positions across all perp dexes (main + HIP-3). Track
        more than one account (e.g. main + algo) by adding each address; the
        Portfolio tab shows them combined or one at a time.
      </Text>

      <Text style={s.label}>MyFundedPerps</Text>
      <MfpKeyRows />

      <Text style={s.label}>Alert worker URL</Text>
      <TextInput
        style={s.input}
        placeholder={DEFAULT_WORKER_URL}
        placeholderTextColor={C.faint}
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Text style={s.help}>
        The scanner worker that computes all STRAT detection server-side. The
        default is a worker on this machine; enter the address of the one you
        run.
      </Text>

      <Pressable onPress={save} style={({ pressed }) => [s.button, pressed && s.buttonPressed]}>
        <Text style={s.buttonText}>Save</Text>
      </Pressable>
      {saved ? (
        <Text style={[s.savedText, { color: saved === "saved" ? C.bull : C.bear }]}>{saved}</Text>
      ) : null}

      <View style={s.divider} />

      <Text style={s.label}>Push alerts (this device)</Text>
      <Text style={s.help}>
        Register to receive the worker's transition alerts (LIVE / INVAL) as
        native notifications, scoped to your starred favorites (no favorites =
        every alert). Where the worker runs favorites-only alerting (crypto
        perps), a coin alerts only on transitions AFTER you star it. Needs the
        worker's push key and an EAS-built APK - Expo Go cannot receive
        Android push. ntfy keeps working independently.
      </Text>
      {scopeLine ? <Text style={s.help}>{scopeLine}</Text> : null}
      <TextInput
        style={s.input}
        placeholder="worker push key (x-push-key)"
        placeholderTextColor={C.faint}
        value={pushKey}
        onChangeText={setKey}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable
        onPress={doRegister}
        disabled={pushBusy}
        style={({ pressed }) => [s.button, (pressed || pushBusy) && s.buttonPressed]}
      >
        <Text style={s.buttonText}>{pushBusy ? "..." : "Register this device"}</Text>
      </Pressable>
      <Pressable
        onPress={doUnregister}
        disabled={pushBusy}
        style={({ pressed }) => [s.linkButton, (pressed || pushBusy) && s.buttonPressed]}
      >
        <Text style={s.linkButtonText}>Unregister</Text>
      </Pressable>
      {pushStatus ? <Text style={[s.savedText, { color: C.muted }]}>{pushStatus}</Text> : null}

      <View style={s.divider} />

      <Pressable
        onPress={() => Linking.openURL(url || DEFAULT_WORKER_URL)}
        style={({ pressed }) => [s.linkButton, pressed && s.buttonPressed]}
      >
        <Text style={s.linkButtonText}>Open web dashboard</Text>
      </Pressable>

      {/* Apache-2.0 attribution for the position charts (THIRD_PARTY_NOTICES.md). */}
      <Text style={[s.help, { marginTop: 14 }]}>
        Charts: TradingView Lightweight Charts (TM), Copyright (c) 2025 TradingView, Inc.
        https://www.tradingview.com/ - Apache License 2.0.
      </Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: { paddingHorizontal: 14 },
  title: { color: C.text, fontSize: 17, fontWeight: "600", marginBottom: 14 },
  releaseIdentity: {
    minHeight: 44, borderWidth: 1, borderColor: C.border, borderRadius: 8,
    backgroundColor: C.card, paddingHorizontal: 12, paddingVertical: 8,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10,
  },
  releaseVersion: { color: C.text, fontSize: 12, fontWeight: "600", flexShrink: 0 },
  releaseMeta: { color: C.faint, fontSize: 10.5, textAlign: "right", flexShrink: 1 },
  displayCore: { color: C.faint, fontSize: 10.5, marginTop: 6, lineHeight: 14 },
  displayCoreWarn: { color: C.warn },
  label: {
    color: C.muted, fontSize: 11, fontWeight: "500", textTransform: "uppercase",
    letterSpacing: 0.7, marginBottom: 6, marginTop: 10,
  },
  input: {
    borderWidth: 1, borderColor: C.input, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 9, color: C.text, fontSize: 13,
    backgroundColor: C.card,
  },
  help: { color: C.faint, fontSize: 11.5, lineHeight: 16, marginTop: 6, marginBottom: 4 },
  walletRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderWidth: 1, borderColor: C.border, borderRadius: 8,
    backgroundColor: C.card, paddingHorizontal: 12, paddingVertical: 8,
    marginBottom: 6,
  },
  walletLabel: { color: C.text, fontSize: 12.5, fontWeight: "600", flexShrink: 1 },
  walletAddr: { color: C.faint, fontSize: 11.5, fontVariant: ["tabular-nums"], marginLeft: "auto" },
  walletRemove: { color: C.bear, fontSize: 11.5, fontWeight: "500" },
  button: {
    marginTop: 16, backgroundColor: C.bullBg, borderWidth: 1,
    borderColor: "rgba(0,220,130,0.35)", borderRadius: 8,
    paddingVertical: 10, alignItems: "center",
  },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: C.bull, fontSize: 13, fontWeight: "600" },
  savedText: { fontSize: 12, marginTop: 8, textAlign: "center" },
  divider: { height: 1, backgroundColor: C.border, marginVertical: 18 },
  linkButton: {
    marginTop: 14, borderWidth: 1, borderColor: C.border, borderRadius: 8,
    paddingVertical: 10, alignItems: "center", backgroundColor: C.card,
  },
  linkButtonText: { color: C.muted, fontSize: 13, fontWeight: "500" },
});
