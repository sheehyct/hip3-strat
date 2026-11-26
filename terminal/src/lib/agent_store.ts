// The key store: the Hyperliquid agent (API-wallet) key, the MFP trade key
// and the MFP read-only view key. The ONLY file that imports
// expo-secure-store (scripts/check-exchange-guard.js enforces it).
//
// Android: trade keys live in expo-secure-store with requireAuthentication
// (a biometric prompt on every read); the MFP view key is stored without
// the gate so the silent poll never prompts. Non-secret meta (agent
// address, account id / number) lives in AsyncStorage so the UI can render
// without unlocking anything.
//
// Web: SDK 57's SecureStore web module is an empty object, so there is NO
// secure store. Trade keys live in this module's memory for the browser tab
// only, entered once per session - never localStorage, IndexedDB, cookies
// or the URL (the guard bans direct web storage in src/). A reload forgets
// them. The wallet address and the view key's non-secret meta may persist
// through AsyncStorage.
//
// A key is never logged, never sent anywhere except as a signature (HL) or
// the Authorization header (MFP), and the HL key is refused when its derived
// address equals the tracked wallet (that would be the master key).
import AsyncStorage from "@react-native-async-storage/async-storage";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { deriveAddress } from "./hl_sign";

export type AgentMeta = {
  // The master wallet this agent was verified for (lower case). An agent key
  // signs for that wallet and no other, so the key is usable only while the
  // tracked wallet is this one (agent_binding.ts). "" = stored before the
  // binding existed: unusable until it is added again.
  wallet: string;
  agentAddress: string;   // derived from the key; what extraAgents lists
  name: string;           // the agent's name on the venue
  validUntil: number;     // ms; the venue's expiry (0 = unknown)
  storedAt: number;
};

export type MfpSlot = "trade" | "view";
export type MfpKeyMeta = {
  env: "live" | "sandbox";
  accountId: string;
  accountNumber: string;
  name: string;
  storedAt: number;
  keyFp?: string;   // first 16 hex of sha256(key)
  sees?: number;    // accounts the key saw when stored (a sandbox key may see several; the app uses accountId only)
};

const K_AGENT = "tt.agent";                                  // SecureStore
const K_AGENT_META = "tt.agentMeta";                         // AsyncStorage
const MFP_KEY = (slot: MfpSlot) => "tt.mfp." + slot;         // SecureStore
const MFP_META = (slot: MfpSlot) => "tt.mfpMeta." + slot;    // AsyncStorage
const AGENT_PROMPT = "Unlock the Hyperliquid agent key";
const MFP_PROMPT = "Unlock the MyFundedPerps trade key";

const isWeb = Platform.OS === "web";

// Web session memory: the tab's keys. Cleared on reload by nature.
const session = new Map<string, string>();
const sessionListeners = new Set<() => void>();
let sessionRev = 0;
const emitSession = () => { sessionRev++; for (const l of sessionListeners) l(); };
export function subscribeSession(l: () => void): () => void {
  sessionListeners.add(l);
  return () => { sessionListeners.delete(l); };
}
export const sessionRevision = (): number => sessionRev;

export function keyFingerprint(key: string): string {
  return bytesToHex(sha256(utf8ToBytes(key))).slice(0, 16);
}

export function secureStoreAvailable(): boolean {
  if (isWeb) return false;
  try { return SecureStore.canUseBiometricAuthentication(); } catch { return false; }
}

const gated: SecureStore.SecureStoreOptions = { requireAuthentication: true, authenticationPrompt: AGENT_PROMPT };
const optsFor = (slot: MfpSlot): SecureStore.SecureStoreOptions =>
  slot === "trade" ? { requireAuthentication: true, authenticationPrompt: MFP_PROMPT } : {};

// ---- Hyperliquid agent key ------------------------------------------------

// Refuses a master key (its address equals the tracked wallet) and a
// malformed key. The caller verifies the agent on the venue (extraAgents)
// before storing; this only derives and checks.
export function checkAgentKey(privKeyHex: string, wallet: string): { address: string } {
  const address = deriveAddress(privKeyHex.trim());
  if (wallet && address.toLowerCase() === wallet.trim().toLowerCase()) {
    throw new Error("this is the wallet's own key - paste an API-wallet (agent) key, never the master key");
  }
  return { address };
}

export async function setAgentKey(privKeyHex: string, meta: AgentMeta): Promise<void> {
  const key = privKeyHex.trim();
  if (isWeb) {
    session.set(K_AGENT, key);
    emitSession();
  } else {
    if (!secureStoreAvailable()) throw new Error("enroll a fingerprint or face and a screen lock first");
    await SecureStore.setItemAsync(K_AGENT, key, gated);
  }
  await AsyncStorage.setItem(K_AGENT_META, JSON.stringify(meta));
}

// The biometric prompt fires here, on every read (Android). null = no key
// (or, on Android, the key was invalidated by a biometrics change).
export async function getAgentKey(): Promise<string | null> {
  if (isWeb) return session.get(K_AGENT) ?? null;
  return SecureStore.getItemAsync(K_AGENT, gated);
}

export function hasSessionAgentKey(): boolean {
  return isWeb && session.has(K_AGENT);
}

export async function getAgentMeta(): Promise<AgentMeta | null> {
  try {
    const raw = await AsyncStorage.getItem(K_AGENT_META);
    if (!raw) return null;
    const m = JSON.parse(raw) as Partial<AgentMeta>;
    if (typeof m.agentAddress !== "string") return null;
    return { wallet: typeof m.wallet === "string" ? m.wallet.trim().toLowerCase() : "", agentAddress: m.agentAddress, name: typeof m.name === "string" ? m.name : "", validUntil: typeof m.validUntil === "number" ? m.validUntil : 0, storedAt: typeof m.storedAt === "number" ? m.storedAt : 0 };
  } catch {
    return null;
  }
}

// The secure item goes first and its failure is SURFACED: a cancelled or
// failed delete must not leave a key resident behind a UI that says "none".
export async function clearAgentKey(): Promise<void> {
  if (isWeb) { session.delete(K_AGENT); emitSession(); }
  else await SecureStore.deleteItemAsync(K_AGENT, gated);
  await AsyncStorage.removeItem(K_AGENT_META);
}

// ---- MyFundedPerps keys ---------------------------------------------------

export async function getMfpMeta(slot: MfpSlot): Promise<MfpKeyMeta | null> {
  try {
    const raw = await AsyncStorage.getItem(MFP_META(slot));
    if (!raw) return null;
    const m = JSON.parse(raw) as Partial<MfpKeyMeta>;
    if ((m.env !== "live" && m.env !== "sandbox") || typeof m.accountId !== "string") return null;
    return {
      env: m.env, accountId: m.accountId,
      accountNumber: typeof m.accountNumber === "string" ? m.accountNumber : "",
      name: typeof m.name === "string" ? m.name : "",
      storedAt: typeof m.storedAt === "number" ? m.storedAt : 0,
      keyFp: typeof m.keyFp === "string" ? m.keyFp : undefined,
      sees: typeof m.sees === "number" ? m.sees : undefined,
    };
  } catch {
    return null;
  }
}

// Store a key the caller has verified on the venue. Throws (and stores
// nothing) when the other slot holds the same key or another account.
export async function setMfpKey(slot: MfpSlot, key: string, meta: MfpKeyMeta): Promise<void> {
  if (!isWeb && slot === "trade" && !secureStoreAvailable()) throw new Error("enroll a fingerprint or face and a screen lock first");
  const other: MfpSlot = slot === "trade" ? "view" : "trade";
  const otherMeta = await getMfpMeta(other);
  if (otherMeta && (otherMeta.accountId !== meta.accountId || otherMeta.env !== meta.env)) {
    throw new Error("this key is for a different account than the stored " + other + " key - not stored");
  }
  const fp = keyFingerprint(key);
  if (otherMeta && otherMeta.keyFp === fp) {
    throw new Error(slot === "trade"
      ? "this key is already stored as the VIEW key, where it needs no fingerprint - remove the view key, then add a Read Only key there"
      : "this is the stored trade key - the view key must be a separate Read Only key");
  }
  if (isWeb) {
    session.set(MFP_KEY(slot), key);
    emitSession();
  } else {
    await SecureStore.setItemAsync(MFP_KEY(slot), key, optsFor(slot));
  }
  try {
    await AsyncStorage.setItem(MFP_META(slot), JSON.stringify({ ...meta, keyFp: fp }));
  } catch (e) {
    if (isWeb) session.delete(MFP_KEY(slot));
    else await SecureStore.deleteItemAsync(MFP_KEY(slot), optsFor(slot)).catch(() => undefined);
    throw e;
  }
}

// Trade: the biometric prompt fires here (Android). View: no prompt.
export async function getMfpKey(slot: MfpSlot): Promise<string | null> {
  if (isWeb) return session.get(MFP_KEY(slot)) ?? null;
  return SecureStore.getItemAsync(MFP_KEY(slot), optsFor(slot));
}

export function hasSessionMfpKey(slot: MfpSlot): boolean {
  return isWeb && session.has(MFP_KEY(slot));
}

export async function clearMfpKey(slot: MfpSlot): Promise<void> {
  if (isWeb) { session.delete(MFP_KEY(slot)); emitSession(); }
  else await SecureStore.deleteItemAsync(MFP_KEY(slot), optsFor(slot));
  await AsyncStorage.removeItem(MFP_META(slot));
}

export async function clearMfpMeta(slot: MfpSlot): Promise<void> {
  await AsyncStorage.removeItem(MFP_META(slot));
}
