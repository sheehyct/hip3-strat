// On-device settings. The wallet address is deliberately stored ONLY here
// (AsyncStorage on the phone) - never hardcoded, never sent anywhere except
// Hyperliquid's public info API. An address in source would link whoever
// publishes the code to live positions.
import AsyncStorage from "@react-native-async-storage/async-storage";

import { DEFAULT_WORKER_URL, UniverseId } from "./api";
import { defaultFilters, sanitizeFilters } from "./filters";
import type { Filters } from "./filters";
import { PATTERN_FAMILY_IDS } from "./patterns";

const K_ADDRESS = "hip3.walletAddress"; // legacy single-wallet slot (see getWallets)
const K_WALLETS = "hip3.wallets";
const K_WORKER = "hip3.workerUrl";
const K_FAVS = "hip3.favorites";
const K_UNIVERSE = "hip3.universe";
const K_PUSHKEY = "hip3.pushKey";
const K_PUSHTOKEN = "hip3.pushToken";
// Read once, for migration only (see getFilters): the retired scan view's
// pattern-family allowlist, then removed with the view's other keys.
const K_PATTERN_FAMS = "hip3.patternFamilies";
const RETIRED_SCAN_KEYS = [
  K_PATTERN_FAMS, "hip3.scanTf", "hip3.scanMode", "hip3.scanPresets", "hip3.scanHiddenFields",
  "hip3.scanPatternStyle",
];
const K_FILTERS = "hip3.filters";
const K_PERF_UNIT = "hip3.perfUnit";

// A tracked Hyperliquid account (several may be tracked, for example a
// discretionary wallet and an automated one). The label is display-only; the address is the
// identity. Addresses live ONLY in this on-device store - never in source,
// never sent anywhere but Hyperliquid's public info API.
// `automated` (additive 2026-09-02): the account is traded by another
// process (a bot). It only changes copy - the close/flatten sheet warns
// that a phone-side close is a venue-level exit that process keeps
// trading around - never behaviour. Absent = false.
export type Wallet = { label: string; address: string; automated?: boolean };

function isWallet(w: unknown): w is Wallet {
  if (!w || typeof w !== "object") return false;
  const o = w as Record<string, unknown>;
  return (
    typeof o.label === "string" &&
    typeof o.address === "string" &&
    o.address.length > 0 &&
    (o.automated === undefined || typeof o.automated === "boolean")
  );
}

// Defensive parse mirrors getFavorites; a device that only ever saved the
// legacy single address sees it as one unlabeled wallet.
export async function getWallets(): Promise<Wallet[]> {
  try {
    const raw = await AsyncStorage.getItem(K_WALLETS);
    if (raw) {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(isWallet) : [];
    }
  } catch {
    return [];
  }
  const legacy = (await AsyncStorage.getItem(K_ADDRESS)) || "";
  return legacy ? [{ label: "", address: legacy }] : [];
}

export async function setWallets(wallets: Wallet[]): Promise<void> {
  await AsyncStorage.setItem(K_WALLETS, JSON.stringify(wallets));
  // Keep the legacy slot mirroring wallet #1 so an OTA rollback (which reads
  // only the old key) still shows a truthful address instead of a stale one.
  if (wallets.length) await AsyncStorage.setItem(K_ADDRESS, wallets[0].address);
  else await AsyncStorage.removeItem(K_ADDRESS);
}

export async function getWorkerUrl(): Promise<string> {
  return (await AsyncStorage.getItem(K_WORKER)) || DEFAULT_WORKER_URL;
}

export async function setWorkerUrl(u: string): Promise<void> {
  const v = u.trim();
  if (!v || v === DEFAULT_WORKER_URL) await AsyncStorage.removeItem(K_WORKER);
  else await AsyncStorage.setItem(K_WORKER, v);
}

export async function getFavorites(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(K_FAVS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function setFavorites(syms: string[]): Promise<void> {
  await AsyncStorage.setItem(K_FAVS, JSON.stringify(syms));
}

// Worker push-registration key (the worker's PUSH_REGISTER_KEY). On-device
// only, same discipline as the wallet address - never in source.
export async function getPushKey(): Promise<string> {
  return (await AsyncStorage.getItem(K_PUSHKEY)) || "";
}

export async function setPushKey(k: string): Promise<void> {
  const v = k.trim();
  if (!v) await AsyncStorage.removeItem(K_PUSHKEY);
  else await AsyncStorage.setItem(K_PUSHKEY, v);
}

// Last successfully registered Expo push token. Presence = "this device has
// registered before", which arms the quiet favorites/app-open re-sync.
export async function getPushToken(): Promise<string> {
  return (await AsyncStorage.getItem(K_PUSHTOKEN)) || "";
}

export async function setPushToken(t: string): Promise<void> {
  if (!t) await AsyncStorage.removeItem(K_PUSHTOKEN);
  else await AsyncStorage.setItem(K_PUSHTOKEN, t);
}

// Selected screener universe. Defaults to "xyz" (the original HIP-3 dex);
// any unrecognized stored value falls back to the default.
export async function getUniverse(): Promise<UniverseId> {
  return (await AsyncStorage.getItem(K_UNIVERSE)) === "perps" ? "perps" : "xyz";
}

export async function setUniverse(u: UniverseId): Promise<void> {
  await AsyncStorage.setItem(K_UNIVERSE, u);
}

// Screener filter state (the dashboard's `hip3-filters`), whitelist-validated
// on load so a stale or junk value degrades per field instead of filtering
// everything out. First run after the 2026-10-15 update: no stored filters
// yet, so the old scan view's persisted pattern families seed `pats` - the
// scope a user set there keeps applying, and stays visible on the list.
export async function getFilters(): Promise<Filters> {
  try {
    const raw = await AsyncStorage.getItem(K_FILTERS);
    if (raw) return sanitizeFilters(JSON.parse(raw), PATTERN_FAMILY_IDS);
    const legacy = await AsyncStorage.getItem(K_PATTERN_FAMS);
    const f = sanitizeFilters({ pats: legacy ? JSON.parse(legacy) : [] }, PATTERN_FAMILY_IDS);
    // Persist the migrated state BEFORE dropping the old keys, so a failed
    // write leaves the legacy scope in place for the next launch.
    await AsyncStorage.setItem(K_FILTERS, JSON.stringify(f));
    await AsyncStorage.multiRemove(RETIRED_SCAN_KEYS);
    return f;
  } catch {
    return defaultFilters();
  }
}

export async function setFilters(f: Filters): Promise<void> {
  await AsyncStorage.setItem(K_FILTERS, JSON.stringify(f));
}

// Performance view unit: money or percent of
// entry notional for the per-trade metrics. Any unrecognized value = money.
export type PerfUnit = "usd" | "pct";

export async function getPerfUnit(): Promise<PerfUnit> {
  return (await AsyncStorage.getItem(K_PERF_UNIT)) === "pct" ? "pct" : "usd";
}

export async function setPerfUnit(u: PerfUnit): Promise<void> {
  await AsyncStorage.setItem(K_PERF_UNIT, u);
}
