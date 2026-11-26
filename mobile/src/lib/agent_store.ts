// The agent (API-wallet) key store. The ONLY file that imports
// expo-secure-store (scripts/check-exchange-guard.js enforces it).
//
// Contract (SECURITY.md): the key is a Hyperliquid
// API-wallet key, never a master key; it is stored only after the venue
// confirms the approval (extraAgents), only with requireAuthentication (a
// biometric prompt on every read), never in AsyncStorage, never logged,
// never sent anywhere except as a signature to the exchange endpoint. A
// small NON-secret record in AsyncStorage (agent address, name, expiry)
// lets the UI show buttons and approval state without a prompt.
//
// Web: SDK 57's SecureStore web module is an empty object, so every call
// here checks the platform first and reports "unavailable" - the web export
// (the screenshot gate) renders no close controls.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export type AgentMeta = {
  agentAddress: string;   // derived from the key; what extraAgents lists
  name: string;           // the agent's name on the venue
  validUntil: number;     // ms; the venue's expiry
  storedAt: number;
};

const K_KEY = (wallet: string) => "hip3.agent." + wallet.toLowerCase();       // SecureStore: [A-Za-z0-9._-] only
const K_META = (wallet: string) => "hip3.agentMeta." + wallet.toLowerCase();   // AsyncStorage
const PROMPT = "Unlock the HIP3 agent key";

export async function agentSigningAvailable(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

// Biometrics (or a device credential) enrolled and usable for the gate.
export function canGateWithBiometrics(): boolean {
  if (Platform.OS === "web") return false;
  try {
    return SecureStore.canUseBiometricAuthentication();
  } catch {
    return false;
  }
}

const secureOpts: SecureStore.SecureStoreOptions = {
  requireAuthentication: true,
  authenticationPrompt: PROMPT,
};

// Store only with the biometric requirement; the caller has already
// verified the approval on the venue (Settings does the extraAgents check).
export async function setAgentKey(wallet: string, privKeyHex: string, meta: AgentMeta): Promise<void> {
  if (Platform.OS === "web") throw new Error("secure store unavailable on web");
  if (!canGateWithBiometrics()) throw new Error("enroll a fingerprint or face and a screen lock first");
  await SecureStore.setItemAsync(K_KEY(wallet), privKeyHex, secureOpts);
  await AsyncStorage.setItem(K_META(wallet), JSON.stringify(meta));
}

// The biometric prompt fires here, on every read. null = no key, or the
// key was invalidated by a biometrics change (the caller clears the meta
// record and asks for a re-paste). A cancelled prompt rejects.
export async function getAgentKey(wallet: string): Promise<string | null> {
  if (Platform.OS === "web") return null;
  return SecureStore.getItemAsync(K_KEY(wallet), secureOpts);
}

export async function getAgentMeta(wallet: string): Promise<AgentMeta | null> {
  try {
    const raw = await AsyncStorage.getItem(K_META(wallet));
    if (!raw) return null;
    const m = JSON.parse(raw) as Partial<AgentMeta>;
    if (typeof m.agentAddress !== "string" || typeof m.validUntil !== "number") return null;
    return { agentAddress: m.agentAddress, name: typeof m.name === "string" ? m.name : "", validUntil: m.validUntil, storedAt: typeof m.storedAt === "number" ? m.storedAt : 0 };
  } catch {
    return null;
  }
}

// The secure item goes first and its failure is SURFACED: a cancelled or
// failed delete must not leave a key resident on the device behind a UI
// that says "none stored" (the meta record is removed only once the
// secure delete succeeded).
export async function clearAgentKey(wallet: string): Promise<void> {
  if (Platform.OS !== "web") {
    await SecureStore.deleteItemAsync(K_KEY(wallet), secureOpts);
  }
  await AsyncStorage.removeItem(K_META(wallet));
}

// After a biometrics change the venue key is gone but the meta record may
// linger; this drops the record alone (the secure item is already unreadable).
export async function clearAgentMeta(wallet: string): Promise<void> {
  await AsyncStorage.removeItem(K_META(wallet));
}

// Wallet.automated flag lives on the Wallet record (store.ts); this module
// only knows keys and their venue-side meta.

// ---- MyFundedPerps keys (SECURITY.md) -------------------------------------
//
// Two keys, both scoped by the user to ONE challenge account:
// - "trade" (Read And Trade): behind requireAuthentication, read only inside
//   a close / reverse run;
// - "view" (Read Only, set on the MFP site - the API cannot report a key's
//   level): secure store WITHOUT the gate, so the 30 s refresh is silent.
// The caller verifies each key on the venue first (exactly one account, the
// prefix matching the host); this module refuses a view key equal to the
// stored trade key (and vice versa) and a key whose account differs from the
// other slot's. The non-secret meta (env, account id/number/name) lives in
// AsyncStorage so the UI can render without unlocking anything.

export type MfpSlot = "trade" | "view";
export type MfpKeyMeta = {
  env: "live" | "sandbox";
  accountId: string;
  accountNumber: string;
  name: string;
  storedAt: number;
  keyFp?: string;   // first 16 hex of sha256(key); set by setMfpKey
};

export function mfpKeyFingerprint(key: string): string {
  return bytesToHex(sha256(utf8ToBytes(key))).slice(0, 16);
}

const MFP_KEY =(slot: MfpSlot) => "hip3.mfp." + slot;          // SecureStore
const MFP_META = (slot: MfpSlot) => "hip3.mfpMeta." + slot;     // AsyncStorage
const MFP_PROMPT = "Unlock the MyFundedPerps trade key";

const optsFor = (slot: MfpSlot): SecureStore.SecureStoreOptions =>
  slot === "trade" ? { requireAuthentication: true, authenticationPrompt: MFP_PROMPT } : {};

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
    };
  } catch {
    return null;
  }
}

// Store a key the caller has verified on the venue. Throws (and stores
// nothing) when the other slot holds the same key or another account.
export async function setMfpKey(slot: MfpSlot, key: string, meta: MfpKeyMeta): Promise<void> {
  if (Platform.OS === "web") throw new Error("secure store unavailable on web");
  if (slot === "trade" && !canGateWithBiometrics()) throw new Error("enroll a fingerprint or face and a screen lock first");
  const other: MfpSlot = slot === "trade" ? "view" : "trade";
  const otherMeta = await getMfpMeta(other);
  if (otherMeta && (otherMeta.accountId !== meta.accountId || otherMeta.env !== meta.env)) {
    throw new Error("this key is for a different account than the stored " + other + " key - not stored");
  }
  // Same-key check without unlocking the gated slot: each meta carries a
  // short SHA-256 fingerprint of its key (a hash of a high-entropy key
  // reveals nothing usable).
  const fp = mfpKeyFingerprint(key);
  if (otherMeta && otherMeta.keyFp === fp) {
    // Storing the trade key that already sits in the UNGATED view slot means
    // a trade-capable key is readable without a fingerprint: say so, and
    // point at the fix (never at keeping it there).
    throw new Error(slot === "trade"
      ? "this key is already stored as the VIEW key, where it needs no fingerprint - remove the view key, then add a Read Only key there"
      : "this is the stored trade key - the view key must be a separate Read Only key");
  }
  await SecureStore.setItemAsync(MFP_KEY(slot), key, optsFor(slot));
  try {
    await AsyncStorage.setItem(MFP_META(slot), JSON.stringify({ ...meta, keyFp: fp }));
  } catch (e) {
    // No meta = no same-key fingerprint and a UI that says "none stored":
    // never leave a key behind without its record.
    await SecureStore.deleteItemAsync(MFP_KEY(slot), optsFor(slot)).catch(() => undefined);
    throw e;
  }
}

// Trade: the biometric prompt fires here. View: no prompt. null = none
// stored (or invalidated by a biometrics change, for the trade slot).
export async function getMfpKey(slot: MfpSlot): Promise<string | null> {
  if (Platform.OS === "web") return null;
  return SecureStore.getItemAsync(MFP_KEY(slot), optsFor(slot));
}

// Secure item first, its failure surfaced (same rule as clearAgentKey).
export async function clearMfpKey(slot: MfpSlot): Promise<void> {
  if (Platform.OS !== "web") await SecureStore.deleteItemAsync(MFP_KEY(slot), optsFor(slot));
  await AsyncStorage.removeItem(MFP_META(slot));
}

export async function clearMfpMeta(slot: MfpSlot): Promise<void> {
  await AsyncStorage.removeItem(MFP_META(slot));
}
