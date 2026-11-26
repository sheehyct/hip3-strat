// Last served /api/state payload per universe, recorded at the fetchState
// choke point (api.ts) exactly like noteServerDisplayVersion. The portfolio
// side reads a coin's CURRENT served continuity from here (positions view,
// continuity stamps) - display of server output, never a computation.
import type { ApiState, Coin, UniverseId } from "./api";

type Entry = { state: ApiState; receivedAt: number };
const cache: Partial<Record<UniverseId, Entry>> = {};

const KNOWN: UniverseId[] = ["xyz", "perps"];

// Components read this cache through useSyncExternalStore (subscribeServed +
// a snapshot getter): the React Compiler memoizes a component on the props
// and hook results it can see, so a bare module read would be computed once
// and never again. `version` bumps on every write and wakes subscribers.
let version = 0;
const listeners = new Set<() => void>();
export function subscribeServed(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function servedVersion(): number {
  return version;
}
function bump(): void {
  version++;
  for (const l of listeners) l();
}

// `uni` is the universe the caller requested; undefined means the worker
// returned everything (older worker or no filter), split by coin.uni.
export function noteServedState(state: ApiState, uni: UniverseId | undefined, receivedAt = Date.now()): void {
  if (uni) { cache[uni] = { state, receivedAt }; bump(); return; }
  for (const u of KNOWN) {
    const coins = state.coins.filter((c) => c.uni === u);
    if (coins.length) cache[u] = { state: { ...state, coins }, receivedAt };
  }
  bump();
}

// Snapshot getter for useSyncExternalStore: the SAME Coin object until the
// next payload replaces it (referential stability is what the hook needs).
export function servedCoinSnapshot(coinId: string): Coin | null {
  const uni = universeOfCoin(coinId);
  if (!uni) return null;
  const e = cache[uni];
  if (!e) return null;
  return e.state.coins.find((c) => c.name === coinId) ?? null;
}

// Which served universe a Hyperliquid coin id belongs to: "xyz:AAPL" -> xyz,
// a bare main-dex name -> perps, any other builder dex -> null (not served).
export function universeOfCoin(coin: string): UniverseId | null {
  const i = coin.indexOf(":");
  if (i < 0) return "perps";
  return coin.slice(0, i) === "xyz" ? "xyz" : null;
}

export type ServedCoin = { coin: Coin; ts: number; uni: UniverseId; receivedAt: number };

// The coin's last served row, matched on Coin.name == the Hyperliquid coin id
// (verified: the worker serves "xyz:TSLA" / "BTC" as name).
export function getServedCoin(coinId: string): ServedCoin | null {
  const uni = universeOfCoin(coinId);
  if (!uni) return null;
  const e = cache[uni];
  if (!e) return null;
  const coin = e.state.coins.find((c) => c.name === coinId);
  return coin ? { coin, ts: e.state.ts, uni, receivedAt: e.receivedAt } : null;
}

// The worker's continuity ledger as the cached payloads advertise it:
// undefined = no payload cached yet (unknown), null = the worker serves no
// ledger, a number = how far back /api/continuity_at reaches.
export function servedLedgerSince(): number | null | undefined {
  let seen = false;
  for (const u of KNOWN) {
    const e = cache[u];
    if (!e) continue;
    seen = true;
    const l = e.state.continuity_ledger;
    if (l && typeof l.since === "number") return l.since;
  }
  return seen ? null : undefined;
}

export function servedAgeMs(uni: UniverseId, now = Date.now()): number | null {
  const e = cache[uni];
  return e ? now - e.receivedAt : null;
}
