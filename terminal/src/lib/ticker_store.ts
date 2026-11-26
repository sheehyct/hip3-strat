// Live prices: Hyperliquid mids for every coin (the allMids stream per
// dex) and the best bid / ask of the coin on screen (the bbo stream), read
// through useSyncExternalStore. In mock mode the prices come from the mock
// venue's tick. Nothing here carries a key.
import { subscribeStream } from "./hl_stream";
import { isMock } from "./mode";
import { mockMark, mockSubscribeTicks } from "./mock_venue";
import { hlMarketRowsCached } from "./hl_venue";

type Ticker = { mids: Record<string, number>; bbo: { coin: string; bid: number | null; ask: number | null } | null; live: boolean; at: number };

let state: Ticker = { mids: {}, bbo: null, live: false, at: 0 };
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function subscribeTicker(l: () => void): () => void {
  listeners.add(l);
  ensure();
  return () => { listeners.delete(l); };
}
export const tickerState = (): Ticker => state;
export const midOf = (coin: string | null): number | null => (coin ? state.mids[coin] ?? null : null);

let started = false;
let stopMids: (() => void) | null = null;
let stopMock: (() => void) | null = null;
let dexesSubscribed = new Set<string>();

function ensure(): void {
  if (started) return;
  started = true;
  if (isMock()) {
    const tick = () => {
      const mids: Record<string, number> = {};
      for (const c of ["BTC", "ETH", "SOL", "xyz:NVDA", "xyz:TSLA", "xyz:SP500", "xyz:GOLD", "kPEPE"]) mids[c] = mockMark(c);
      const b = bboCoin ? { coin: bboCoin, bid: mids[bboCoin] * 0.9999, ask: mids[bboCoin] * 1.0001 } : null;
      state = { mids, bbo: b, live: true, at: Date.now() };
      emit();
    };
    stopMock = mockSubscribeTicks(tick);
    tick();
    return;
  }
  subscribeDexes();
}

// One allMids subscription per dex (coin names are unique across dexes).
// The dex list comes from the market rows once they are cached; the main
// dex is subscribed right away.
function subscribeDexes(): void {
  const dexes = new Set<string>([""]);
  for (const r of hlMarketRowsCached()) dexes.add(r.dex);
  for (const dex of dexes) {
    if (dexesSubscribed.has(dex)) continue;
    dexesSubscribed.add(dex);
    const stop = subscribeStream({ type: "allMids", dex }, {
      onMsg: (m) => {
        if (m.type !== "allMids") return;
        state = { ...state, mids: { ...state.mids, ...m.mids }, at: Date.now() };
        emit();
      },
      onLive: (live) => { if (state.live !== live) { state = { ...state, live }; emit(); } },
    });
    const prev = stopMids;
    stopMids = () => { prev?.(); stop(); };
  }
}

// Called when the market rows land (new builder dexes to follow).
export function tickerMarketsChanged(): void {
  if (started && !isMock()) subscribeDexes();
}

let bboCoin: string | null = null;
let stopBbo: (() => void) | null = null;

// The coin on screen gets a bbo stream (the one-click panel's bid / ask).
export function watchBbo(coin: string | null): void {
  if (coin === bboCoin) return;
  bboCoin = coin;
  if (stopBbo) { stopBbo(); stopBbo = null; }
  state = { ...state, bbo: null };
  emit();
  if (!coin || isMock()) return;
  stopBbo = subscribeStream({ type: "bbo", coin }, {
    onMsg: (m) => {
      if (m.type !== "bbo") return;
      state = { ...state, bbo: { coin, bid: m.bid, ask: m.ask }, at: Date.now() };
      emit();
    },
  });
}

export function stopTicker(): void {
  stopMids?.(); stopMids = null;
  stopMock?.(); stopMock = null;
  stopBbo?.(); stopBbo = null;
  dexesSubscribed = new Set();
  started = false;
}

// Demo <-> live (venue_store calls this when the clients are swapped): drop
// every subscription AND the prices it left behind, then start again under
// the new mode. Without it the mode chosen at first start stayed for the
// tab's life, and a demo tick could price a real order.
export function resetTicker(): void {
  stopTicker();
  state = { mids: {}, bbo: null, live: false, at: 0 };
  emit();
  if (listeners.size) ensure();
  const coin = bboCoin;
  bboCoin = null;
  watchBbo(coin);
}
