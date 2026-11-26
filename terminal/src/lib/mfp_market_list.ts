// MFP's PUBLIC market list for the Venue filter. The ONE MyFundedPerps
// REST call outside mfp_exchange.ts (docs/CONTRACT.md "Allowed venue
// writes"): a plain GET of /v1/markets?venues=all,
// which MFP's OpenAPI spec marks `security: []` - public, no key. This file
// never reads, holds or sends a key, never imports the key store or the MFP
// exchange client, and makes exactly one request shape. `npm run
// guard:exchange` enforces all of that.
//
// Cached in AsyncStorage so the filter works offline and on a cold start;
// refreshed when older than LIST_MAX_AGE_MS. A failed or unreadable fetch
// keeps the last good list (parseMfpMarkets returns null rather than an
// empty list, so a bad answer can never flip every ticker to "HL only").
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useSyncExternalStore } from "react";
import { Platform } from "react-native";

import { buildMfpIndex, MfpIndex, MfpMarket, parseMfpMarkets, sanitizeVenue, Venue } from "./mfp_markets";

// On the web the same GET goes through the app's own origin (the
// pass-through, server/), because a browser cannot call MFP directly (CORS).
const LIST_URL = Platform.OS === "web" ? "/mfp/live/v1/markets?venues=all" : "https://developers.myfundedperpetuals.com/v1/markets?venues=all";
const K_LIST = "tt.mfpMarkets.v1";
const K_VENUE = "tt.venue.v1";
const TIMEOUT_MS = 15000;
// MFP adds markets occasionally, not by the minute.
export const LIST_MAX_AGE_MS = 6 * 3600 * 1000;
// A pull-to-refresh re-reads the list only past this age.
export const LIST_PULL_AGE_MS = 10 * 60 * 1000;

export type MfpListSnap = {
  index: MfpIndex | null;
  rows: MfpMarket[];  // the parsed market rows behind `index` (the MFP market registry)
  at: number;        // when the list in `index` was fetched (epoch ms), 0 = never
  loading: boolean;
  error: string;     // last fetch failure, "" after a success
};

let snap: MfpListSnap = { index: null, rows: [], at: 0, loading: false, error: "" };
const subs = new Set<() => void>();
let hydrated: Promise<void> | null = null;
let inflight: Promise<void> | null = null;

function emit(patch: Partial<MfpListSnap>) {
  snap = { ...snap, ...patch };
  subs.forEach((f) => f());
}

export function subscribeMfpList(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

export function mfpListSnapshot(): MfpListSnap {
  return snap;
}

async function hydrate(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(K_LIST);
    if (!raw) return;
    const o = JSON.parse(raw) as { at?: unknown; rows?: unknown };
    const rows = parseMfpMarkets({ data: o.rows });
    const at = typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0;
    // A fetch that landed first wins over the cache.
    if (rows && at > 0 && snap.at === 0) emit({ index: buildMfpIndex(rows), rows, at });
  } catch {
    // Junk in storage: behave as if nothing was cached.
  }
}

// Load the cache once, then fetch when the list is older than `maxAgeMs`
// (or missing). Concurrent callers share one request.
export function refreshMfpList(maxAgeMs: number = LIST_MAX_AGE_MS): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    if (!hydrated) hydrated = hydrate();
    await hydrated;
    if (snap.index && Date.now() - snap.at < maxAgeMs) return;
    emit({ loading: true });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(LIST_URL, { method: "GET", headers: { Accept: "application/json" }, signal: ctl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const rows = parseMfpMarkets(await res.json());
      if (!rows) throw new Error("unreadable market list");
      const at = Date.now();
      emit({ index: buildMfpIndex(rows), rows, at, loading: false, error: "" });
      AsyncStorage.setItem(K_LIST, JSON.stringify({ at, rows })).catch(() => undefined);
    } catch (e) {
      const msg = e instanceof Error ? (e.name === "AbortError" ? "timed out" : e.message) : "fetch failed";
      emit({ loading: false, error: msg || "fetch failed" });
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => { inflight = null; });
  return inflight;
}

// The screener's hook: the current list (useSyncExternalStore, so the React
// Compiler cannot memoize a stale first read) plus a refresh on mount.
export function useMfpList(): MfpListSnap {
  const s = useSyncExternalStore(subscribeMfpList, mfpListSnapshot, mfpListSnapshot);
  useEffect(() => { refreshMfpList(); }, []);
  return s;
}

// The Venue filter choice, persisted on its own key.
export async function getVenue(): Promise<Venue | null> {
  try {
    return sanitizeVenue(await AsyncStorage.getItem(K_VENUE));
  } catch {
    return null;
  }
}

export async function setVenue(v: Venue | null): Promise<void> {
  try {
    if (v === null) await AsyncStorage.removeItem(K_VENUE);
    else await AsyncStorage.setItem(K_VENUE, v);
  } catch {
    // Best effort: the choice still holds for this session.
  }
}
