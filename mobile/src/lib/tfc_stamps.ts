// Continuity stamps: a copy of the scanner worker's SERVED continuity for a
// coin, taken when the app first notices a trade (a position appearing in
// the 30 s poll, or an opening fill arriving in a sync). Pure storage of
// server output - the app never derives continuity from price.
//
// A stamp speaks for a trade only when it was taken within AT_ENTRY_MS of
// the opening fill; later stamps are kept (they still say what continuity
// looked like when the app saw the position) but classify as unknown.
// Journal per wallet in AsyncStorage: hip3.tfcStamps.<address> - the
// address is in the key only and never leaves the device. A second source,
// the worker's continuity ledger, fills in trades the app did not watch
// open (syncWorkerStamps below; its own journal, hip3.tfcWorker.<address>).
import AsyncStorage from "@react-native-async-storage/async-storage";

import { fetchState, UniverseId } from "./api";
import { getServedCoin, noteServedState, servedAgeMs, servedLedgerSince, universeOfCoin } from "./state_cache";
import { getWorkerUrl } from "./store";
import {
  AT_ENTRY_MS, chunks, LEDGER_MAX_ITEMS, LedgerAnswer, ledgerKey, LedgerLookup,
  parseLedgerAnswers, pickLedgerLookups, providerFromStamps, retryAfterMs, TfcStamp, Trade,
} from "./trades";

const K = (wallet: string) => "hip3.tfcStamps." + wallet.toLowerCase();
const CAP = 2000;
const MAX_AGE_MS = 400 * 86400e3;
const REFETCH_MIN_MS = 60e3; // one extra universe fetch per minute at most

type Journal = { v: 1; stamps: TfcStamp[] };

function isStamp(x: unknown): x is TfcStamp {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.wallet === "string" && typeof o.coin === "string" &&
    typeof o.observedAt === "number" && typeof o.stateTs === "number" &&
    (o.openTime === null || typeof o.openTime === "number") &&
    (o.source === "device" || o.source === "worker");
}

export async function loadStamps(wallet: string): Promise<TfcStamp[]> {
  try {
    const raw = await AsyncStorage.getItem(K(wallet));
    if (!raw) return [];
    const j = JSON.parse(raw) as Partial<Journal>;
    return Array.isArray(j.stamps) ? j.stamps.filter(isStamp) : [];
  } catch {
    return [];
  }
}

async function saveStamps(wallet: string, stamps: TfcStamp[], now: number): Promise<void> {
  const kept = stamps.filter((s) => now - s.observedAt <= MAX_AGE_MS).slice(-CAP);
  const j: Journal = { v: 1, stamps: kept };
  await AsyncStorage.setItem(K(wallet), JSON.stringify(j));
}

// Copy the served continuity fields of one coin into a stamp.
function stampFromServed(wallet: string, coinId: string, openTime: number | null, now: number): TfcStamp | null {
  const served = getServedCoin(coinId);
  if (!served) return null;
  const c = served.coin as unknown as Record<string, unknown>;
  const dwm = c.dwmContinuity && typeof c.dwmContinuity === "object"
    ? (c.dwmContinuity as TfcStamp["dwm"]) : null;
  return {
    wallet, coin: coinId, openTime, observedAt: now, stateTs: served.ts,
    ftfc: served.coin.ftfc ?? null, dots: Array.isArray(served.coin.dots) ? [...served.coin.dots] : [],
    dwm, source: "device", lagMs: openTime === null ? null : now - openTime,
  };
}

// Make sure the universe of `coinId` is in the state cache and recent. One
// extra fetch per universe per minute at most; a coin on an unserved dex or
// a failed fetch simply yields no stamp (never a guess).
const lastFetch: Partial<Record<UniverseId, number>> = {};
async function ensureServed(coinId: string, now: number): Promise<void> {
  const uni = universeOfCoin(coinId);
  if (!uni) return;
  const age = servedAgeMs(uni, now);
  if (age !== null && age < 2 * 60e3) return;
  if (lastFetch[uni] && now - (lastFetch[uni] as number) < REFETCH_MIN_MS) return;
  lastFetch[uni] = now;
  try {
    const state = await fetchState(await getWorkerUrl(), uni);
    noteServedState(state, uni, now);
  } catch {
    // leave the cache as is; the caller stamps nothing
  }
}

// Trigger 1 - the position poll: coins newly present for this wallet since
// the previous poll get an "observed" stamp (openTime unknown here; the
// provider matches it to the trade whose opening fill precedes it within
// AT_ENTRY_MS). The first poll after launch stamps everything once, which
// only ever matches trades opened moments before - harmless.
const seen = new Map<string, Set<string>>();
export async function noteOpenPositions(wallet: string, coins: string[], now = Date.now()): Promise<void> {
  const key = wallet.toLowerCase();
  const prev = seen.get(key) ?? new Set<string>();
  const fresh = coins.filter((c) => !prev.has(c));
  seen.set(key, new Set(coins));
  if (!fresh.length) return;
  for (const c of fresh) await ensureServed(c, now);
  const stamps = await loadStamps(wallet);
  let added = 0;
  for (const c of fresh) {
    const s = stampFromServed(wallet, c, null, now);
    if (s) { stamps.push(s); added++; }
  }
  if (added) await saveStamps(wallet, stamps, now);
}

// Trigger 2 - the fills sync: trades with a known opening fill that have no
// stamp keyed to that exact openTime get one now (usually late, hence
// classified unknown, but it records what the app saw).
export async function stampTrades(wallet: string, trades: Trade[], now = Date.now()): Promise<TfcStamp[]> {
  const stamps = await loadStamps(wallet);
  const have = new Set(stamps.filter((s) => s.openTime !== null).map((s) => s.coin + "|" + s.openTime));
  const todo = trades.filter((t) => t.openTime !== null && !t.truncated && now - (t.openTime as number) <= 7 * 86400e3 && !have.has(t.coin + "|" + t.openTime));
  if (!todo.length) return stamps;
  const unis = new Set(todo.map((t) => t.coin));
  for (const c of unis) await ensureServed(c, now);
  let added = 0;
  for (const t of todo) {
    const s = stampFromServed(wallet, t.coin, t.openTime, now);
    if (s) { stamps.push(s); added++; }
  }
  if (added) await saveStamps(wallet, stamps, now);
  return stamps;
}

// ---- worker ledger stamps (the second provider) ---------------------------
//
// For trades without a stamp within AT_ENTRY_MS of entry, ask the worker's
// continuity ledger (POST /api/continuity_at) what it served at the opening
// fill. Journal per wallet: hip3.tfcWorker.<address> holds the covered
// answers as stamps plus the FINAL misses (not covered, older than
// LEDGER_RETRY_MS - the ledger never back-fills), so each trade is asked
// about once. The request body carries only {coin, t}: never the wallet.
const WK = (wallet: string) => "hip3.tfcWorker." + wallet.toLowerCase();
const WORKER_CAP = 5000;
const LEDGER_RETENTION_MS = 35 * 86400e3; // the worker's retention_days
const LOOKUP_TIMEOUT_MS = 20e3;           // the route's own deadline is 15 s

type WorkerJournal = { v: 1; stamps: TfcStamp[]; misses: string[] };

async function loadWorkerJournal(wallet: string): Promise<WorkerJournal> {
  try {
    const raw = await AsyncStorage.getItem(WK(wallet));
    if (!raw) return { v: 1, stamps: [], misses: [] };
    const j = JSON.parse(raw) as Partial<WorkerJournal>;
    return {
      v: 1,
      stamps: Array.isArray(j.stamps) ? j.stamps.filter((s) => isStamp(s) && s.source === "worker" && s.openTime !== null) : [],
      misses: Array.isArray(j.misses) ? j.misses.filter((m): m is string => typeof m === "string") : [],
    };
  } catch {
    return { v: 1, stamps: [], misses: [] };
  }
}

export async function loadWorkerStamps(wallet: string): Promise<TfcStamp[]> {
  return (await loadWorkerJournal(wallet)).stamps;
}

async function saveWorkerJournal(wallet: string, j: WorkerJournal): Promise<void> {
  const stamps = [...j.stamps].sort((a, b) => (a.openTime as number) - (b.openTime as number)).slice(-WORKER_CAP);
  await AsyncStorage.setItem(WK(wallet), JSON.stringify({ v: 1, stamps, misses: j.misses.slice(-WORKER_CAP) }));
}

type LookupReply = { status: number; retryAfter: string | null; body: unknown };

// The deadline covers the body read too, not just the headers: a stalled
// body must not hold the single-flight chain (and every later wallet) open.
async function postLookup(base: string, items: LedgerLookup[]): Promise<LookupReply> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctl.abort(); reject(new Error("continuity lookup timed out")); }, LOOKUP_TIMEOUT_MS);
  });
  const work = (async (): Promise<LookupReply> => {
    const r = await fetch(base + "/api/continuity_at", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(items),
      signal: ctl.signal,
    });
    const body = r.status === 200 ? await r.json() : null;
    return { status: r.status, retryAfter: r.headers.get("Retry-After"), body };
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    work.catch(() => undefined); // a late failure after the deadline is not unhandled
  }
}

// One lookup in flight per device (the route admits four at once for every
// client together), and no request at all while a 503 / failure pause runs.
let chain: Promise<unknown> = Promise.resolve();
let pausedUntil = 0;

export function syncWorkerStamps(wallet: string, trades: Trade[], now = Date.now()): Promise<TfcStamp[]> {
  const run = chain.then(() => syncWorkerOnce(wallet, trades, now));
  chain = run.catch(() => undefined);
  return run;
}

async function syncWorkerOnce(wallet: string, trades: Trade[], now: number): Promise<TfcStamp[]> {
  const j = await loadWorkerJournal(wallet);
  const since = servedLedgerSince();
  // A cached payload without the field: this worker serves no ledger.
  if (since === null || Date.now() < pausedUntil) return j.stamps;
  const known = new Set<string>(j.misses);
  for (const s of j.stamps) known.add(ledgerKey(s.coin, s.openTime as number));
  const todo = pickLedgerLookups(trades, known, {
    now, since: since ?? null, retentionMs: LEDGER_RETENTION_MS,
    served: (c) => universeOfCoin(c) !== null,
  });
  if (!todo.length) return j.stamps;
  const base = (await getWorkerUrl()).replace(/\/+$/, "");
  let changed = false;
  for (const batch of chunks(todo, LEDGER_MAX_ITEMS)) {
    let r: LookupReply;
    try {
      r = await postLookup(base, batch);
    } catch {
      // network failure, deadline, or an unparseable 200 body
      pausedUntil = Date.now() + 30e3;
      break;
    }
    // Any 503 is "try later" (busy, timeout, ledger disabled): cache nothing.
    if (r.status === 503) { pausedUntil = Date.now() + retryAfterMs(r.retryAfter); break; }
    const answers: LedgerAnswer[] | null = r.status === 200 ? parseLedgerAnswers(r.body, batch, wallet, now) : null;
    if (!answers) { pausedUntil = Date.now() + 60e3; break; }
    answers.forEach((a, i) => {
      if (a.kind === "stamp") { j.stamps.push(a.stamp); changed = true; }
      else if (a.kind === "miss") { j.misses.push(ledgerKey(batch[i].coin, batch[i].t)); changed = true; }
    });
  }
  if (changed) await saveWorkerJournal(wallet, j);
  return j.stamps;
}

export { AT_ENTRY_MS, providerFromStamps };
