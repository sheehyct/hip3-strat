// Settings rows for the keys: the Hyperliquid agent key and the two MFP
// keys. Each verifies on the venue before storing (the agent against the
// wallet's approved agents; an MFP key is stored for exactly one account: a
// live key must see only that one, a sandbox key that sees several asks
// which one) and never shows, logs or persists the key itself. On web the key lives in
// the tab's session only and the row says so.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";

import { Field } from "@/components/field";
import { Button } from "@/components/kit";
import { agentRefusal } from "@/lib/agent_binding";
import {
  checkAgentKey, clearAgentKey, clearMfpKey, getAgentMeta, getMfpMeta, hasSessionAgentKey, hasSessionMfpKey, setAgentKey, setMfpKey,
  subscribeSession, sessionRevision,
} from "@/lib/agent_store";
import type { AgentMeta, MfpKeyMeta, MfpSlot } from "@/lib/agent_store";
import { fmtDateTimeET, fmtUsd } from "@/lib/fmt";
import { fetchExtraAgents } from "@/lib/hyperliquid";
import { verifyMfpKey } from "@/lib/mfp_exchange";
import type { MfpAccount } from "@/lib/mfp_orders";
import { venuesChanged } from "@/lib/venue_store";
import { C, F, T } from "@/theme";

const isWeb = Platform.OS === "web";

export function AgentKeyRow({ wallet }: { wallet: string }) {
  const [meta, setMeta] = useState<AgentMeta | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const rev = useSyncExternalStore(subscribeSession, sessionRevision);
  const load = useCallback(() => { getAgentMeta().then(setMeta); }, []);
  useEffect(load, [load, rev]);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      if (!wallet) throw new Error("set the wallet address first");
      const { address } = checkAgentKey(key, wallet);
      let name = "", validUntil = 0;
      try {
        const agents = await fetchExtraAgents(wallet);
        const hit = agents.find((a) => a.address === address.toLowerCase());
        if (!hit) throw new Error("this agent is not approved on the wallet (" + address.slice(0, 8) + "...) - approve it on Hyperliquid first");
        name = hit.name; validUntil = hit.validUntil;
      } catch (e) {
        throw e instanceof Error ? e : new Error("could not verify the agent on the venue");
      }
      // Bound to the wallet it was just verified against: it stops being
      // usable the moment the tracked wallet is another one.
      await setAgentKey(key, { wallet: wallet.trim().toLowerCase(), agentAddress: address, name, validUntil, storedAt: Date.now() });
      setKey("");
      setMsg("stored" + (isWeb ? " for this tab's session" : ""));
      load();
      venuesChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "not stored");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try { await clearAgentKey(); setMsg("removed"); load(); venuesChanged(); } catch (e) { setMsg(e instanceof Error ? e.message : "remove failed"); } finally { setBusy(false); }
  };
  const inSession = isWeb ? hasSessionAgentKey() : true;
  // The stored agent is tied to the wallet it was verified for: say so here
  // when the tracked wallet is another one (the key is refused for writes).
  const unusable = meta && wallet ? agentRefusal(meta, wallet) : null;
  return (
    <View style={k.wrap}>
      {meta ? (
        <View style={k.status}>
          <Text style={k.ok}>{"agent " + (meta.name || meta.agentAddress.slice(0, 10) + "...") + (meta.validUntil ? " until " + fmtDateTimeET(meta.validUntil) + " ET" : "")}</Text>
          {unusable ? <Text style={k.warn}>{"not usable: " + unusable}</Text> : null}
          {isWeb && !inSession ? <Text style={k.warn}>key not in this tab's session - paste it again to trade (web keeps keys in memory only)</Text> : null}
        </View>
      ) : (
        <Text style={k.hint}>API-wallet (agent) private key, never the master key. Approved on Hyperliquid under More, API.</Text>
      )}
      <Field label="Agent key" value={key} onChange={setKey} secure placeholder="0x..." />
      <View style={k.btns}>
        <Button label={busy ? "working..." : meta && !inSession ? "Store for this session" : "Verify and store"} onPress={save} variant="primary" disabled={busy || key.trim().length < 64} />
        {meta ? <Button label="Remove" onPress={remove} variant="danger" disabled={busy} /> : null}
      </View>
      {msg ? <Text style={k.msg}>{msg}</Text> : null}
    </View>
  );
}

export function MfpKeyRow({ slot }: { slot: MfpSlot }) {
  const [meta, setMeta] = useState<MfpKeyMeta | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // A sandbox key that sees several accounts: the list to pick ONE from.
  // Nothing is stored until one is picked; editing the key drops the list.
  const [choices, setChoices] = useState<MfpAccount[] | null>(null);
  const rev = useSyncExternalStore(subscribeSession, sessionRevision);
  const load = useCallback(() => { getMfpMeta(slot).then(setMeta); }, [slot]);
  useEffect(load, [load, rev]);
  const editKey = (v: string) => { setKey(v); setChoices(null); };

  // `wanted`: the account picked from the list (the venue is asked again,
  // so the key must still see it); none on the first press.
  const save = async (wanted: string | null = null) => {
    setBusy(true); setMsg(null);
    try {
      const v = await verifyMfpKey(key.trim(), wanted);
      if (!v.account) {
        setChoices(v.choose);
        setMsg("this sandbox key sees " + v.choose.length + " accounts - pick the ONE this app reads and trades; nothing is stored yet");
        return;
      }
      await setMfpKey(slot, key.trim(), { env: v.env, accountId: v.account.id, accountNumber: v.account.accountNumber, name: v.account.name, storedAt: Date.now(), sees: v.sees });
      setKey("");
      setChoices(null);
      setMsg("stored: " + (v.account.accountNumber || v.account.name) + " (" + v.env + ")" + (isWeb ? ", this tab's session only" : ""));
      load();
      venuesChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "not stored");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try { await clearMfpKey(slot); setMsg("removed"); load(); venuesChanged(); } catch (e) { setMsg(e instanceof Error ? e.message : "remove failed"); } finally { setBusy(false); }
  };
  const inSession = isWeb ? hasSessionMfpKey(slot) : true;
  return (
    <View style={k.wrap}>
      {meta ? (
        <View style={k.status}>
          <Text style={k.ok}>{(meta.accountNumber || meta.name || meta.accountId) + " " + meta.env}</Text>
          {meta.sees && meta.sees > 1 ? <Text style={k.hint}>{"this key sees " + meta.sees + " accounts; the app reads and trades this one only"}</Text> : null}
          {isWeb && !inSession ? <Text style={k.warn}>key not in this tab's session - paste it again (web keeps keys in memory only)</Text> : null}
        </View>
      ) : (
        <Text style={k.hint}>
          {slot === "trade"
            ? "Read And Trade key (fp_live_ or fp_test_). A live key must be scoped to ONE challenge account; a sandbox key that sees several asks which one to use. Behind the fingerprint on Android."
            : "A separate Read Only key for the same account, so the silent poll never prompts."}
        </Text>
      )}
      <Field label={slot === "trade" ? "MFP trade key" : "MFP view key (read only)"} value={key} onChange={editKey} secure placeholder="fp_test_..." />
      {choices ? (
        <View style={k.pick}>
          {choices.map((a) => (
            <View key={a.id} style={k.pickRow}>
              <View style={k.pickText}>
                <Text style={k.pickName}>{a.accountNumber || a.name || a.id}</Text>
                <Text style={k.hint}>{[a.name && a.accountNumber ? a.name : "", a.stage, a.status, a.balance !== null ? fmtUsd(a.balance) : ""].filter(Boolean).join(", ")}</Text>
              </View>
              <Button label="Use this account" onPress={() => save(a.id)} disabled={busy} />
            </View>
          ))}
        </View>
      ) : null}
      <View style={k.btns}>
        <Button label={busy ? "working..." : "Verify and store"} onPress={() => save()} variant="primary" disabled={busy || key.trim().length < 24} />
        {meta ? <Button label="Remove" onPress={remove} variant="danger" disabled={busy} /> : null}
      </View>
      {msg ? <Text style={k.msg}>{msg}</Text> : null}
    </View>
  );
}

const k = StyleSheet.create({
  wrap: { gap: 8 },
  status: { gap: 2 },
  ok: { ...F.medium, color: C.bull, fontSize: T.caption, flexShrink: 1 },
  warn: { ...F.regular, color: C.warn, fontSize: T.micro, lineHeight: 15, flexShrink: 1 },
  hint: { ...F.regular, color: C.faint, fontSize: T.micro, lineHeight: 15, flexShrink: 1 },
  btns: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  pick: { gap: 8 },
  pickRow: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  pickText: { flexShrink: 1, minWidth: 140, gap: 2 },
  pickName: { ...F.medium, color: C.text, fontSize: T.caption, flexShrink: 1 },
  msg: { ...F.regular, color: C.muted, fontSize: T.caption, flexShrink: 1 },
});
