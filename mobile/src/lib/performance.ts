// Per-wallet performance loading: fills sync -> round trips -> continuity
// stamps -> funding -> the venue's equity history. Plain async functions
// (no React) so the shell screen can drive them on its own schedule and
// the pieces stay testable. Every step degrades on its own: a failed fills
// sync falls back to the cache, a failed history fetch leaves the graph
// empty, a funding budget miss leaves funding null (shown as unknown).
import { loadFills, syncFills, syncFunding } from "./fills_cache";
import { fetchPortfolioHistory } from "./hyperliquid";
import { servedLedgerSince } from "./state_cache";
import { loadStamps, loadWorkerStamps, stampTrades, syncWorkerStamps } from "./tfc_stamps";
import {
  applyFunding, Diag, joinTfc, PortfolioWindows, providerFromStamps, reconstructTrades, TfcStamp, Trade,
} from "./trades";

export type WalletPerf = {
  address: string;
  trades: Trade[];             // every reconstructed trade, newest first
  history: PortfolioWindows;   // {} until the venue answers
  diag: Diag;
  fillCount: number;
  syncedAt: number;
  fundingDone: boolean;        // false while the funding pass is still owed
  error: string | null;        // last sync error, shown as a note (data may be cached)
  ledgerSince: number | null;  // how far back the worker's continuity ledger reaches; null = not known
};

// Phase 1: fills (cache first, then the venue), trades, stamps, history.
export async function loadWalletPerformance(address: string, now = Date.now()): Promise<WalletPerf> {
  let error: string | null = null;
  let fills = await loadFills(address);
  try {
    fills = await syncFills(address, now);
  } catch (e) {
    error = e instanceof Error ? e.message : "fills sync failed";
  }
  const { trades: raw, diag } = reconstructTrades(address, fills);
  let device: TfcStamp[] = [];
  try {
    device = await stampTrades(address, raw, now);
  } catch {
    try { device = await loadStamps(address); } catch { /* no stamps */ }
  }
  const deviceProvider = providerFromStamps(device);
  // The worker ledger only answers for trades the device did not stamp at
  // entry, so it is asked with the device join already applied; the final
  // join then picks the smaller lag per trade across both providers.
  let worker: TfcStamp[] = [];
  try {
    worker = await syncWorkerStamps(address, joinTfc(raw, [deviceProvider]), now);
  } catch {
    try { worker = await loadWorkerStamps(address); } catch { /* none cached */ }
  }
  const trades = joinTfc(raw, [deviceProvider, providerFromStamps(worker)]);
  let history: PortfolioWindows = {};
  try {
    history = await fetchPortfolioHistory(address, now);
  } catch (e) {
    error = error ?? (e instanceof Error ? e.message : "history fetch failed");
  }
  const ledgerSince = servedLedgerSince() ?? null;
  return { address, trades, history, diag, fillCount: fills.length, syncedAt: now, fundingDone: false, error, ledgerSince };
}

// Phase 2: funding attribution (budgeted, resumable). Returns the same
// record with funding folded into net PnL where the fetched range covers
// the trade; the rest stay null.
export async function addFunding(perf: WalletPerf, now = Date.now()): Promise<WalletPerf> {
  try {
    const fills = await loadFills(perf.address);
    const f = await syncFunding(perf.address, perf.trades, fills, now);
    return { ...perf, trades: applyFunding(perf.trades, f.map, f.covered), fundingDone: true };
  } catch {
    return { ...perf, fundingDone: true };
  }
}
