// MyFundedPerps performance (see SECURITY.md): the account's
// closed positions, cached per account, mapped to Trades, joined with the
// scanner's continuity ledger through the Hyperliquid coin on the same base
// asset (the chart's own mapping), and shaped as a WalletPerf so the
// Performance and Trades views draw it the way they draw a Hyperliquid
// wallet. Its own pill: never summed into the Hyperliquid numbers.
//
// Reads go through mfp_exchange.ts on the ungated VIEW key (no fingerprint
// prompt on the five-minute refresh). Every step degrades on its own: a
// failed sync keeps the cache, a failed coin list keeps the last mapping.
import AsyncStorage from "@react-native-async-storage/async-storage";

import { getMfpKey, getMfpMeta, MfpKeyMeta } from "./agent_store";
import { chartSourceForMfp } from "./candles";
import { fetchHlCoinNames } from "./hyperliquid";
import { fetchMfpClosedSince } from "./mfp_exchange";
import type { MfpClosed } from "./mfp_orders";
import type { WalletPerf } from "./performance";
import { servedLedgerSince } from "./state_cache";
import { loadWorkerStamps, syncWorkerStamps } from "./tfc_stamps";
import { joinTfc, mfpPortfolioWindows, providerFromStamps, tradesFromMfp } from "./trades";
import type { TfcStamp } from "./trades";

const K = (accountId: string) => "hip3.mfpClosed." + accountId;
const CAP = 10000;

// The pseudo-wallet id the MFP account's trades and stamps are filed under
// (never an address; the worker ledger is only ever sent {coin, t}).
export const mfpWalletId = (accountId: string): string => "mfp:" + accountId;

// hl: the Hyperliquid coin each MFP market maps to (null = none), as last
// resolved against Hyperliquid's coin list. Kept so a failed list fetch does
// not relabel every trade as having no Hyperliquid market.
type Journal = { v: 1; rows: MfpClosed[]; complete: boolean; startingBalance: number | null; hl: Record<string, string | null> };

const marketKey = (r: { provider: string; coin: string; symbol: string }) => r.provider + "|" + r.coin + "|" + r.symbol;

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
function isRow(r: unknown): r is MfpClosed {
  const o = r as Record<string, unknown> | null;
  return !!o && typeof o.id === "string" && typeof o.marketId === "string" && (o.side === "long" || o.side === "short") &&
    isNum(o.size) && isNum(o.entryPrice) && isNum(o.openedAt) && isNum(o.closedAt) && isNum(o.realizedPnl) &&
    isNum(o.fees) && isNum(o.funding) && typeof o.provider === "string" && typeof o.symbol === "string" && typeof o.coin === "string";
}

async function loadJournal(accountId: string): Promise<Journal> {
  const empty: Journal = { v: 1, rows: [], complete: true, startingBalance: null, hl: {} };
  try {
    const raw = await AsyncStorage.getItem(K(accountId));
    if (!raw) return empty;
    const j = JSON.parse(raw) as Partial<Journal>;
    const hl: Record<string, string | null> = {};
    if (j.hl && typeof j.hl === "object") {
      for (const [k, v] of Object.entries(j.hl)) if (typeof v === "string" || v === null) hl[k] = v;
    }
    return {
      v: 1,
      rows: Array.isArray(j.rows) ? j.rows.filter(isRow) : [],
      complete: j.complete !== false,
      startingBalance: isNum(j.startingBalance) ? j.startingBalance : null,
      hl,
    };
  } catch {
    return empty;
  }
}

async function saveJournal(accountId: string, j: Journal): Promise<void> {
  const rows = [...j.rows].sort((a, b) => b.closedAt - a.closedAt).slice(0, CAP);
  await AsyncStorage.setItem(K(accountId), JSON.stringify({ v: 1, rows, complete: j.complete, startingBalance: j.startingBalance, hl: j.hl }));
}

export type MfpPerf = {
  perf: WalletPerf;
  meta: MfpKeyMeta;
  // Set when the closed trades do not explain the account's balance change
  // (older closes not read, or a non-trade balance adjustment).
  reconcile: string | null;
};

const usd = (x: number) => (x < 0 ? "-$" : "$") + Math.abs(x).toFixed(2);

// null = no MFP view key on this device.
export async function loadMfpPerformance(now = Date.now()): Promise<MfpPerf | null> {
  const meta = await getMfpMeta("view");
  if (!meta) return null;
  const wallet = mfpWalletId(meta.accountId);
  const j = await loadJournal(meta.accountId);
  let dirty = false;
  let error: string | null = null;
  let balance: number | null = null;
  let unrealized: number | null = null;
  let flat = false;   // no margin in use: nothing open whose fees or funding could already sit in the balance
  try {
    const key = await getMfpKey("view");
    if (!key) throw new Error("view key missing on this device - add it again in Settings");
    const s = await fetchMfpClosedSince(key, meta.accountId, new Set(j.rows.map((r) => r.id)));
    balance = s.account.balance;
    unrealized = s.account.risk?.unrealizedPnl ?? null;
    flat = s.account.risk !== null && s.account.risk.marginUsed === 0;
    if (s.account.startingBalance !== null && s.account.startingBalance !== j.startingBalance) {
      j.startingBalance = s.account.startingBalance;
      dirty = true;
    }
    // A capped sync leaves a hole below its oldest row that later syncs
    // (which stop at the newest cached row) never fill: say so for good.
    if (!s.complete && j.complete) { j.complete = false; dirty = true; }
    const seen = new Set(j.rows.map((r) => r.id));
    const add = s.fresh.filter((r) => !seen.has(r.id));
    if (add.length) { j.rows = [...add, ...j.rows]; dirty = true; }
  } catch (e) {
    error = e instanceof Error ? e.message : "MFP history sync failed";
  }

  try {
    const hlCoins = await fetchHlCoinNames();
    for (const r of j.rows) {
      const k = marketKey(r);
      const c = chartSourceForMfp(r, hlCoins)?.coin ?? null;
      if (j.hl[k] !== c) { j.hl[k] = c; dirty = true; }
    }
  } catch {
    // keep the last mapping (a market never resolved stays unmapped this round)
  }
  if (dirty) {
    try { await saveJournal(meta.accountId, j); } catch { /* shown from memory this round */ }
  }

  const raw = tradesFromMfp(j.rows, wallet, (r) => j.hl[marketKey(r)] ?? null);
  let worker: TfcStamp[] = [];
  try {
    worker = await syncWorkerStamps(wallet, raw, now);
  } catch {
    try { worker = await loadWorkerStamps(wallet); } catch { /* none cached */ }
  }
  const trades = joinTfc(raw, [providerFromStamps(worker)]);

  const history = j.startingBalance !== null ? mfpPortfolioWindows(trades, j.startingBalance, unrealized, now) : {};
  let reconcile: string | null = null;
  if (!j.complete) reconcile = "only the newest " + j.rows.length + " closed positions were read - older ones are missing from these numbers";
  else if (flat && balance !== null && j.startingBalance !== null) {
    const change = balance - j.startingBalance;
    const explained = trades.reduce((s, t) => s + t.netPnl, 0);
    if (Math.abs(change - explained) > 0.01) {
      reconcile = "closed trades explain " + usd(explained) + " of the account's " + usd(change) + " balance change";
    }
  }
  const perf: WalletPerf = {
    address: wallet,
    trades,
    history,
    diag: { spotSkipped: 0, gaps: 0, dirMismatch: 0, nonUsdcFee: 0 },
    fillCount: j.rows.length,
    syncedAt: now,
    fundingDone: true,
    error,
    ledgerSince: servedLedgerSince() ?? null,
  };
  return { perf, meta, reconcile };
}
