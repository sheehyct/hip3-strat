// Settings: the two MyFundedPerps keys (see SECURITY.md).
// - View key (Read Only on the MFP site): powers the Portfolio poll, stored
//   WITHOUT the fingerprint gate.
// - Trade key (Read And Trade): used only by Close / Reverse, stored behind
//   the fingerprint gate.
// Each pasted key is verified on the venue first (exactly one account; the
// prefix picks the host); agent_store refuses the same key in both slots and
// keys for two different accounts. The pasted text lives in component state
// for one attempt and is cleared whatever the outcome; never logged.
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { agentSigningAvailable, canGateWithBiometrics, clearMfpKey, getMfpMeta, MfpKeyMeta, MfpSlot, setMfpKey } from "@/lib/agent_store";
import { verifyMfpKey } from "@/lib/mfp_exchange";
import { mfpEnvForKey } from "@/lib/mfp_orders";
import { C } from "@/theme";

const LABEL: Record<MfpSlot, string> = { view: "View key (Read Only)", trade: "Trade key (Read And Trade)" };
const HELP: Record<MfpSlot, string> =
  {
    view: "Create an API key on MyFundedPerps (Settings > API Keys) with access level Read Only, scoped to ONE challenge account. Shows the account and its positions here; refreshes without a fingerprint, so it must not be able to trade - the app cannot check the level, MFP sets it.",
    trade: "A SEPARATE key with Read And Trade, scoped to the same one account. Stored behind your fingerprint and used only to close or reverse a position (full close; a reverse opens the other side for the same size). Needs the EAS-built APK.",
  };

export function MfpKeyRows() {
  const [rev, setRev] = useState(0); // a store in one slot re-reads the other's meta
  return (
    <View>
      <MfpKeyRow slot="view" rev={rev} onChanged={() => setRev((n) => n + 1)} />
      <MfpKeyRow slot="trade" rev={rev} onChanged={() => setRev((n) => n + 1)} />
    </View>
  );
}

function MfpKeyRow({ slot, rev, onChanged }: { slot: MfpSlot; rev: number; onChanged: () => void }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [meta, setMeta] = useState<MfpKeyMeta | null>(null);
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setAvailable(await agentSigningAvailable());
    setMeta(await getMfpMeta(slot));
  }, [slot]);

  useEffect(() => { refresh(); }, [refresh, rev]);

  const verifyAndStore = useCallback(async () => {
    const pasted = input.trim();
    setInput("");
    setMsg(null);
    if (!pasted) return;
    setBusy(true);
    try {
      if (!mfpEnvForKey(pasted)) {
        setMsg({ text: "not an MFP API key - expected fp_live_... or fp_test_...; not stored", ok: false });
        return;
      }
      if (slot === "trade" && !canGateWithBiometrics()) {
        setMsg({ text: "enroll a fingerprint or face and a screen lock first - the key was not stored", ok: false });
        return;
      }
      const v = await verifyMfpKey(pasted);
      await setMfpKey(slot, pasted, {
        env: v.env, accountId: v.account.id, accountNumber: v.account.accountNumber, name: v.account.name, storedAt: Date.now(),
      });
      setMsg({ text: "stored - " + (v.account.name || "account") + (v.account.accountNumber ? " #" + v.account.accountNumber : "") + (v.env === "sandbox" ? " (sandbox)" : ""), ok: true });
      onChanged();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "could not store the key", ok: false });
    } finally {
      setBusy(false);
    }
  }, [input, slot, onChanged]);

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await clearMfpKey(slot);
      setMsg({ text: "key removed", ok: true });
      onChanged();
    } catch (e) {
      // The secure delete did not complete: the key is STILL on the device.
      setMsg({ text: "not removed - " + (e instanceof Error ? e.message : "the secure store refused the delete"), ok: false });
    } finally {
      setBusy(false);
    }
  }, [slot, onChanged]);

  const stored = meta !== null;
  return (
    <View style={[s.box, stored && s.boxStored]}>
      <View style={s.head}>
        <Text style={s.label}>{LABEL[slot]}</Text>
        {stored ? (
          <Pressable onPress={remove} disabled={busy} hitSlop={12} accessibilityRole="button">
            <Text style={s.remove}>remove key</Text>
          </Pressable>
        ) : (
          <Text style={s.headMeta}>{available === false ? "unavailable on this platform" : "none stored"}</Text>
        )}
      </View>
      {meta ? (
        <View style={s.lineRow}>
          <Text style={s.line}>{(meta.name || "account") + (meta.accountNumber ? " #" + meta.accountNumber : "")}</Text>
          <Text style={[s.line, { color: meta.env === "sandbox" ? C.warn : C.bull, flexShrink: 1 }]}>{meta.env}</Text>
        </View>
      ) : null}
      {!stored && available !== false ? (
        <>
          <TextInput
            style={s.input}
            placeholder={slot === "view" ? "Read Only key (fp_live_...)" : "Read And Trade key (fp_live_...)"}
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
      <Text style={s.help}>{HELP[slot]}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  // overflow visible: Android can clip a paragraph's last line at a
  // large font scale (same box as AgentKeyRow).
  box: {
    marginBottom: 10, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 10,
    borderWidth: 1, borderColor: C.border, borderRadius: 8, backgroundColor: C.bg, gap: 6,
    overflow: "visible",
  },
  boxStored: { borderLeftWidth: 2, borderLeftColor: "rgba(0,220,130,0.35)" },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 },
  label: { fontSize: 10, fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.7, color: C.muted, flexShrink: 1 },
  headMeta: { color: C.faint, fontSize: 11 },
  remove: { color: C.bear, fontSize: 11.5, fontWeight: "500" },
  lineRow: { flexDirection: "row", alignItems: "baseline", gap: 5, flexWrap: "wrap" },
  line: { color: C.text, fontSize: 11.5, fontVariant: ["tabular-nums"] },
  input: {
    borderWidth: 1, borderColor: C.input, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 9, color: C.text, fontSize: 13, backgroundColor: C.card,
  },
  button: {
    borderWidth: 1, borderColor: "rgba(0,220,130,0.35)", borderRadius: 8, paddingVertical: 10,
    alignItems: "center", backgroundColor: C.bullBg, minHeight: 44, justifyContent: "center",
  },
  buttonDim: { opacity: 0.6 },
  buttonText: { color: C.bull, fontSize: 13, fontWeight: "600" },
  msg: { fontSize: 12, textAlign: "center", marginTop: 2 },
  help: { color: C.faint, fontSize: 11.5, lineHeight: 17, flexShrink: 1 },
});
