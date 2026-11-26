// Persisted user drawings per chart coin (AsyncStorage), read by components
// through useSyncExternalStore (the React Compiler memoizes a bare module
// read - see state_cache.ts / chart_focus.ts for the same idiom).
//
// Flow (docs/CHART_BAKEOFF.md):
// - The engine reports every user create / move / delete through its
//   onDrawingsChange native action -> saveFromEngine(): the cache updates
//   and the write is persisted, but `rev` does NOT bump, so the engine is not
//   told to redraw what it just drew.
// - Anything that changes the set from OUTSIDE the engine (first load from
//   storage, Clear all, a coin switch) bumps `rev`; engines redraw only on a
//   rev change.
//
// Display-only user annotations: nothing may read these into a filter, a
// score, an alert or any STRAT classification.
import AsyncStorage from "@react-native-async-storage/async-storage";

import { Drawing, drawingsStorageKey, sanitizeDrawings } from "./drawings";

type Entry = { drawings: Drawing[]; rev: number; loaded: boolean };
const EMPTY: Entry = { drawings: [], rev: 0, loaded: false };

const cache = new Map<string, Entry>();
const loading = new Map<string, Promise<void>>();
// Per-coin write chain: each write starts after the previous one for that
// coin settles, so writes land in order (the last edit always wins).
const writeChain = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function subscribeDrawings(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

// Snapshot for useSyncExternalStore. Returns a STABLE object per state so
// React does not loop; a coin never loaded yet starts its load here.
export function drawingsSnapshot(coin: string | null): Entry {
  if (!coin) return EMPTY;
  const e = cache.get(coin);
  if (!e) { ensureLoaded(coin); return EMPTY; }
  return e;
}

function ensureLoaded(coin: string): void {
  if (cache.has(coin) || loading.has(coin)) return;
  const p = AsyncStorage.getItem(drawingsStorageKey(coin))
    .then((raw) => {
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      // A user action may have landed while the read was in flight: keep it.
      const prev = cache.get(coin);
      if (prev && prev.loaded) return;
      cache.set(coin, { drawings: sanitizeDrawings(parsed), rev: (prev?.rev ?? 0) + 1, loaded: true });
      emit();
    })
    .catch(() => {
      if (!cache.has(coin)) { cache.set(coin, { drawings: [], rev: 1, loaded: true }); emit(); }
    })
    .finally(() => { loading.delete(coin); });
  loading.set(coin, p);
}

// WRITE-THROUGH: this used to debounce 400 ms
// on a setTimeout, but React Native on Android pauses JS timers when the app
// is backgrounded - place a line, switch to the broker app, the process is
// reclaimed, and the line was never written. Engines report only discrete
// events (place, drag end, delete), so there is nothing to debounce: write
// immediately, chained per coin so concurrent writes stay ordered.
function persist(coin: string, drawings: Drawing[]): void {
  const body = JSON.stringify(drawings);
  const prev = writeChain.get(coin) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => AsyncStorage.setItem(drawingsStorageKey(coin), body))
    .catch(() => undefined);
  writeChain.set(coin, next);
  next.finally(() => { if (writeChain.get(coin) === next) writeChain.delete(coin); });
}

// From the engine (onDrawingsChange): no rev bump.
export function saveFromEngine(coin: string, raw: unknown): void {
  const drawings = sanitizeDrawings(raw);
  const prev = cache.get(coin);
  cache.set(coin, { drawings, rev: prev?.rev ?? 1, loaded: true });
  persist(coin, drawings);
  emit();
}

// From native UI (Clear all, delete from a list): rev bumps, engines redraw.
export function replaceDrawings(coin: string, drawings: Drawing[]): void {
  const clean = sanitizeDrawings(drawings);
  const prev = cache.get(coin);
  cache.set(coin, { drawings: clean, rev: (prev?.rev ?? 0) + 1, loaded: true });
  persist(coin, clean);
  emit();
}

export function clearDrawings(coin: string): void {
  replaceDrawings(coin, []);
}
