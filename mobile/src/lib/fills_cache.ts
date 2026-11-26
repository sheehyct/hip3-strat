// Per-wallet fills cache and sync. Fills are the only durable trade record
// the venue offers (userFillsByTime serves at most the newest 10000 fills,
// 2000 per page), so the app keeps its own copy and fetches incrementally.
// Storage: hip3.fills.<address> as compact tuples (~90 B per fill); caps
// 5000 fills AND 365 days per wallet. Eviction mid-position leaves a
// truncated trade behind through the startPosition rule - no bookkeeping.
// The address is in the KEY only and never leaves the device.
//
// Funding rows are NOT stored; only the per-trade attribution map and the
// fetched range are (trade ids are deterministic from fills, so the map
// survives a recompute).
import AsyncStorage from "@react-native-async-storage/async-storage";

import { fetchFillsSince, fetchFundingSince } from "./hyperliquid";
import {
  CompactFill, decodeFill, encodeFill, Fill, foldFunding, mergeFills, Trade,
} from "./trades";

const K_FILLS = (wallet: string) => "hip3.fills." + wallet.toLowerCase();
const K_FUND = (wallet: string) => "hip3.tradeFunding." + wallet.toLowerCase();

export const FILL_CAPS = { maxFills: 5000, maxAgeMs: 365 * 86400e3 };
const BACKFILL_PAGES = 5;       // 5 x 2000 = the venue's 10000-fill ceiling
const BACKFILL_PAUSE_MS = 6000;
const FUNDING_PAGES = 40;
const FUNDING_PAUSE_MS = 4000;

type FillsRecord = { v: 1; fetchedAt: number; fills: CompactFill[] };
type FundingRecord = { v: 1; from: number; cursor: number; map: Record<string, number> };

const memFills = new Map<string, Fill[]>();

export async function loadFills(wallet: string): Promise<Fill[]> {
  const k = K_FILLS(wallet);
  const m = memFills.get(k);
  if (m) return m;
  let out: Fill[] = [];
  try {
    const raw = await AsyncStorage.getItem(k);
    if (raw) {
      const rec = JSON.parse(raw) as Partial<FillsRecord>;
      if (Array.isArray(rec.fills)) out = rec.fills.map(decodeFill).filter((f): f is Fill => f !== null);
    }
  } catch {
    out = [];
  }
  memFills.set(k, out);
  return out;
}

async function saveFills(wallet: string, fills: Fill[], now: number): Promise<void> {
  const rec: FillsRecord = { v: 1, fetchedAt: now, fills: fills.map(encodeFill) };
  memFills.set(K_FILLS(wallet), fills);
  await AsyncStorage.setItem(K_FILLS(wallet), JSON.stringify(rec));
}

// One in-flight sync per wallet; concurrent callers share the promise.
const inflight = new Map<string, Promise<Fill[]>>();

export function syncFills(wallet: string, now = Date.now()): Promise<Fill[]> {
  const k = K_FILLS(wallet);
  const running = inflight.get(k);
  if (running) return running;
  const p = (async () => {
    const existing = await loadFills(wallet);
    const newest = existing.length ? existing[existing.length - 1].time : null;
    const firstRun = newest === null;
    const since = firstRun ? now - FILL_CAPS.maxAgeMs : newest;
    const incoming = await fetchFillsSince(wallet, since, {
      maxPages: firstRun ? BACKFILL_PAGES : 2,
      pauseMs: firstRun ? BACKFILL_PAUSE_MS : 1500,
    });
    const merged = mergeFills(existing, incoming, { ...FILL_CAPS, now });
    if (incoming.length || firstRun) await saveFills(wallet, merged, now);
    return merged;
  })().finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

export async function loadFundingRecord(wallet: string): Promise<FundingRecord | null> {
  try {
    const raw = await AsyncStorage.getItem(K_FUND(wallet));
    if (!raw) return null;
    const rec = JSON.parse(raw) as Partial<FundingRecord>;
    if (typeof rec.from !== "number" || typeof rec.cursor !== "number" || !rec.map || typeof rec.map !== "object") return null;
    return { v: 1, from: rec.from, cursor: rec.cursor, map: rec.map };
  } catch {
    return null;
  }
}

export type FundingState = {
  map: Map<string, number>;
  // A trade's funding is known when its whole window lies inside the fetched range.
  covered: (t: Trade) => boolean;
};

// Fetch funding rows from the fetched-range cursor forward (first run: from
// the oldest cached fill), fold them into the trades, persist the per-trade
// map and the range. Budgeted; resumes from the cursor next time.
export async function syncFunding(wallet: string, trades: Trade[], fills: Fill[], now = Date.now()): Promise<FundingState> {
  const rec = await loadFundingRecord(wallet);
  const oldestFill = fills.length ? fills[0].time : now;
  const from = rec ? Math.min(rec.from, oldestFill) : oldestFill;
  const start = rec ? rec.cursor : oldestFill;
  let cursor = start;
  const map = new Map<string, number>(rec ? Object.entries(rec.map) : []);
  try {
    const page = await fetchFundingSince(wallet, start, { maxPages: FUNDING_PAGES, pauseMs: FUNDING_PAUSE_MS });
    if (page.rows.length) {
      // Rows at exactly `start` were folded last time (inclusive start); drop them.
      const fresh = rec ? page.rows.filter((r) => r.time > start) : page.rows;
      const folded = foldFunding(trades, fresh, now);
      for (const [id, usdc] of folded) map.set(id, (map.get(id) ?? 0) + usdc);
    }
    cursor = page.complete ? now : page.rows.length ? page.rows[page.rows.length - 1].time : start;
  } catch {
    // keep what we had; the cursor does not advance
  }
  // Drop ids that no longer exist (eviction) so the record cannot grow unbounded.
  const ids = new Set(trades.map((t) => t.id));
  for (const id of [...map.keys()]) if (!ids.has(id)) map.delete(id);
  const out: FundingRecord = { v: 1, from, cursor, map: Object.fromEntries(map) };
  await AsyncStorage.setItem(K_FUND(wallet), JSON.stringify(out));
  const covered = (t: Trade) => t.openTime !== null && t.openTime >= from && (t.closeTime ?? now) <= cursor;
  return { map, covered };
}
