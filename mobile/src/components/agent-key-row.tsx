// Settings: the "Agent key" row under a tracked wallet. Paste a Hyperliquid
// API-wallet private key; the row derives its address, refuses a master key,
// asks the venue (extraAgents) whether that agent is approved for THIS
// wallet, and stores it behind the biometric gate only when it is. The
// pasted text lives in component state for the length of the attempt and
// is cleared whatever the outcome; it is never logged or persisted here.
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";

import {
  AgentMeta, agentSigningAvailable, canGateWithBiometrics, clearAgentKey, getAgentMeta, setAgentKey,
} from "@/lib/agent_store";
import { deriveAddress } from "@/lib/hl_sign";
import { fetchExtraAgents } from "@/lib/hyperliquid";
import { fmtDateLongET } from "@/lib/perf_fmt";
import type { Wallet } from "@/lib/store";
import { C } from "@/theme";

type Approval = { state: "approved"; name: string; validUntil: number } | { state: "expired" } | { state: "revoked" } | { state: "unknown" };

const short = (a: string) => a.slice(0, 6) + "..." + a.slice(-4);

export function AgentKeyRow({ wallet, onWalletChange }: { wallet: Wallet; onWalletChange: (w: Wallet) => void }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [meta, setMeta] = useState<AgentMeta | null>(null);
  const [approval, setApproval] = useState<Approval>({ state: "unknown" });
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setAvailable(await agentSigningAvailable());
    const m = await getAgentMeta(wallet.address);
    setMeta(m);
    if (!m) { setApproval({ state: "unknown" }); return; }
    try {
      const agents = await fetchExtraAgents(wallet.address);
      const hit = agents.find((a) => a.address === m.agentAddress.toLowerCase());
      if (!hit) setApproval({ state: "revoked" });
      else if (hit.validUntil && hit.validUntil < Date.now()) setApproval({ state: "expired" });
      else setApproval({ state: "approved", name: hit.name, validUntil: hit.validUntil });
    } catch {
      setApproval({ state: "unknown" });
    }
  }, [wallet.address]);

  useEffect(() => { refresh(); }, [refresh]);

  const verifyAndStore = useCallback(async () => {
    const pasted = input.trim();
    setInput("");
    setMsg(null);
    if (!pasted) return;
    setBusy(true);
    try {
      if (!canGateWithBiometrics()) {
        setMsg({ text: "enroll a fingerprint or face and a screen lock first - the key was not stored", ok: false });
        return;
      }
      let agentAddress: string;
      try {
        agentAddress = deriveAddress(pasted);
      } catch {
        setMsg({ text: "not a private key - expected 0x + 64 hex chars", ok: false });
        return;
      }
      if (agentAddress === wallet.address.toLowerCase()) {
        setMsg({ text: "this is the master key, not an API wallet - not stored", ok: false });
        return;
      }
      const agents = await fetchExtraAgents(wallet.address);
      const hit = agents.find((a) => a.address === agentAddress);
      if (!hit) {
        setMsg({ text: "NOT approved for this wallet - the key was not stored", ok: false });
        return;
      }
      if (hit.validUntil && hit.validUntil < Date.now()) {
        setMsg({ text: "that agent expired on " + fmtDateLongET(hit.validUntil) + " - create a new one; not stored", ok: false });
        return;
      }
      await setAgentKey(wallet.address, pasted, { agentAddress, name: hit.name, validUntil: hit.validUntil, storedAt: Date.now() });
      setMsg({ text: "stored - approved as " + (hit.name || "unnamed") + (hit.validUntil ? " until " + fmtDateLongET(hit.validUntil) : ""), ok: true });
      await refresh();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "could not store the key", ok: false });
    } finally {
      setBusy(false);
    }
  }, [input, wallet.address, refresh]);

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await clearAgentKey(wallet.address);
      setMsg({ text: "key removed", ok: true });
      await refresh();
    } catch (e) {
      // The secure delete did not complete (prompt cancelled, keystore error):
      // the key is STILL on the device and the row keeps saying so.
      setMsg({ text: "not removed - " + (e instanceof Error ? e.message : "the secure store refused the delete"), ok: false });
    } finally {
      setBusy(false);
    }
  }, [wallet.address, refresh]);

  const stored = meta !== null;
  // Separate Text nodes (nested values vanished on an Android build at a large font scale).
  const status: { text: string; color: string } | null = !meta ? null
    : approval.state === "approved"
      ? { text: "approved as " + (approval.name || "unnamed") + (approval.validUntil ? " until " + fmtDateLongET(approval.validUntil) : ""), color: C.bull }
      : approval.state === "expired" ? { text: "expired - remove and re-create", color: C.bear }
      : approval.state === "revoked" ? { text: "revoked - remove and re-create", color: C.bear }
      : { text: "stored" + (meta.name ? " as " + meta.name : "") + " - approval not re-checked (offline)", color: C.faint };
  const approvalLine = meta && status ? (
    <View style={s.lineRow}>
      <Text style={s.line}>{"agent " + short(meta.agentAddress)}</Text>
      <Text style={[s.line, { color: status.color, flexShrink: 1 }]}>{status.text}</Text>
    </View>
  ) : null;

  return (
    <View style={[s.box, stored && s.boxStored]}>
      <View style={s.head}>
        <Text style={s.label}>Agent key</Text>
        {stored ? (
          <Pressable onPress={remove} disabled={busy} hitSlop={12} accessibilityRole="button">
            <Text style={s.remove}>remove key</Text>
          </Pressable>
        ) : (
          <Text style={s.headMeta}>{available === false ? "unavailable on this platform" : "none stored"}</Text>
        )}
      </View>
      {approvalLine}
      <View style={s.toggleRow}>
        <Switch
          value={wallet.automated === true}
          onValueChange={(v) => onWalletChange({ ...wallet, automated: v })}
          trackColor={{ false: "rgba(255,255,255,0.15)", true: C.bull }}
          thumbColor={C.text}
          accessibilityLabel="automated wallet (traded by another process)"
        />
        <Text style={s.toggleText}>automated (traded by another process)</Text>
      </View>
      {!stored && available !== false ? (
        <>
          <TextInput
            style={s.input}
            placeholder="API wallet private key (0x...)"
            placeholderTextColor={C.faint}
            value={input}
            onChangeText={setInput}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={!busy}
          />
          <Pressable
            onPress={verifyAndStore}
            disabled={busy || !input.trim()}
            style={({ pressed }) => [s.button, (pressed || busy || !input.trim()) && s.buttonDim]}
            accessibilityRole="button"
          >
            <Text style={s.buttonText}>{busy ? "..." : "Verify and store"}</Text>
          </Pressable>
        </>
      ) : null}
      {msg ? <Text style={[s.msg, { color: msg.ok ? C.bull : C.bear }]}>{msg.text}</Text> : null}
      <Text style={s.help}>
        Create a NAMED API wallet for this account under More {">"} API on Hyperliquid and paste its
        private key. Stored only in this device's secure store behind your fingerprint; used only to
        close or reverse positions and cancel your own orders. An API wallet cannot withdraw or
        transfer. Needs the EAS-built APK - not Expo Go, not web.
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  // overflow visible: Android clips children by default, and at a large font
  // scale a measured paragraph height can come up a line short (a test
  // phone lost the help text's last line) - better shown than cut.
  box: {
    marginTop: -2, marginBottom: 10, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10,
    borderWidth: 1, borderColor: C.border, borderRadius: 8, backgroundColor: C.bg, gap: 6,
    overflow: "visible",
  },
  boxStored: { borderLeftWidth: 2, borderLeftColor: "rgba(0,220,130,0.35)" },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { fontSize: 10, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.7, color: C.muted },
  headMeta: { color: C.faint, fontSize: 11 },
  remove: { color: C.bear, fontSize: 11.5, fontWeight: "500" },
  lineRow: { flexDirection: "row", alignItems: "baseline", gap: 5, flexWrap: "wrap" },
  line: { color: C.text, fontSize: 11.5, fontVariant: ["tabular-nums"] },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  toggleText: { color: C.muted, fontSize: 11.5, flex: 1, flexShrink: 1 },
  input: {
    borderWidth: 1, borderColor: C.input, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 9, color: C.text, fontSize: 13, backgroundColor: C.card,
  },
  // The Settings primary style (Save / Register): storing a key is the row's main action.
  button: {
    borderWidth: 1, borderColor: "rgba(0,220,130,0.35)", borderRadius: 8, paddingVertical: 10,
    alignItems: "center", backgroundColor: C.bullBg, minHeight: 44, justifyContent: "center",
  },
  buttonDim: { opacity: 0.6 },
  buttonText: { color: C.bull, fontSize: 13, fontWeight: "600" },
  msg: { fontSize: 12, textAlign: "center", marginTop: 2 },
  help: { color: C.faint, fontSize: 11.5, lineHeight: 17, flexShrink: 1 },
});
