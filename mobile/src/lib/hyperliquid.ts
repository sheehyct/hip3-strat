// Hyperliquid portfolio client. Public info API, read-only by address -
// no API keys, no signing, nothing sensitive beyond the address itself
// (which stays in on-device storage; see lib/store.ts).
//
// Clearinghouse state is PER DEX on Hyperliquid: the main dex ("") and each
// HIP-3 builder dex (xyz, ...) hold positions in separate clearinghouses, so
// a full portfolio view must query every dex explicitly.

import {
  Fill, FundingRow, parseFill, parseFundingRow, parsePortfolio, PortfolioWindows,
} from "./trades";

const API = "https://api.hyperliquid.xyz/info";

// Exported for hl_exchange.ts, which re-reads clearinghouse state and open
// orders around a close; still the read-only info endpoint.
export async function infoPost<T>(body: object): Promise<T> {
  return post<T>(body);
}

// ---- position charts (read-only market data) --------------------------------

// The public WebSocket (candle stream for an open chart); src/lib/hl_stream.ts
// is its only client. Read-only market data, no account.
export const HL_WS_URL = "wss://api.hyperliquid.xyz/ws";

// Raw candleSnapshot rows for one coin / interval / window (candles.ts parses).
export async function fetchCandlesRaw(coin: string, interval: string, startTime: number, endTime: number): Promise<unknown> {
  return post<unknown>({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } });
}

// Every coin id across the main dex and each builder dex ("BTC",
// "xyz:AAPL", ...) - the chart-source lookup for MFP positions. Session cache.
let coinNames: Promise<Set<string>> | null = null;
export function fetchHlCoinNames(): Promise<Set<string>> {
  if (!coinNames) {
    coinNames = (async () => {
      const dexes = await listDexes();
      const metas = await Promise.all(
        dexes.map((dex) => post<{ universe?: { name?: string; isDelisted?: boolean }[] }>(dex ? { type: "meta", dex } : { type: "meta" })),
      );
      // Delisted markets stay in meta with no candles: never a chart source.
      const out = new Set<string>();
      for (const m of metas) for (const u of m.universe || []) if (u && typeof u.name === "string" && u.isDelisted !== true) out.add(u.name);
      return out;
    })().catch((e) => { coinNames = null; throw e; });
  }
  return coinNames;
}

async function post<T>(body: object, tries = 0): Promise<T> {
  let r: Response;
  try {
    r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (tries < 3) {
      await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, tries)));
      return post<T>(body, tries + 1);
    }
    throw e;
  }
  if (r.status === 429 && tries < 5) {
    await new Promise((res) => setTimeout(res, 800 * Math.pow(2, tries)));
    return post<T>(body, tries + 1);
  }
  if (!r.ok) throw new Error("HTTP " + r.status);
  return (await r.json()) as T;
}

export type Position = {
  dex: string;            // "" = main dex
  coin: string;
  szi: number;            // signed size: >0 long, <0 short
  entryPx: number | null;
  positionValue: number;  // abs notional in USD
  unrealizedPnl: number;
  returnOnEquity: number; // fraction, e.g. 0.12 = +12%
  liquidationPx: number | null;
  marginUsed: number;
  leverage: number | null;
};

export type DexSummary = {
  dex: string;
  accountValue: number;
  totalMarginUsed: number;
  positions: Position[];
};

export type Portfolio = {
  address: string;
  fetchedAt: number;
  totalValue: number;
  dexes: DexSummary[];    // only dexes with value or positions
  positions: Position[];  // flattened, sorted by abs notional desc
};

type RawClearinghouse = {
  marginSummary?: { accountValue?: string; totalMarginUsed?: string };
  assetPositions?: {
    position: {
      coin: string;
      szi: string;
      entryPx?: string | null;
      positionValue?: string;
      unrealizedPnl?: string;
      returnOnEquity?: string;
      liquidationPx?: string | null;
      marginUsed?: string;
      leverage?: { type: string; value: number };
    };
  }[];
};

function num(x: string | number | null | undefined): number {
  const v = typeof x === "string" ? parseFloat(x) : x;
  return typeof v === "number" && isFinite(v) ? v : 0;
}

// perpDexs: first element is null (the main dex), then {name, ...} per
// HIP-3 builder dex.
export async function listDexes(): Promise<string[]> {
  const raw = await post<({ name?: string } | null)[]>({ type: "perpDexs" });
  const out: string[] = [""];
  for (const d of raw || []) {
    if (d && typeof d.name === "string" && d.name) out.push(d.name);
  }
  return out;
}

export async function fetchPortfolio(address: string, dexList?: string[]): Promise<Portfolio> {
  const dexes = dexList ?? (await listDexes());
  const states = await Promise.all(
    dexes.map((dex) =>
      post<RawClearinghouse>({ type: "clearinghouseState", user: address, dex })
        .then((s) => ({ dex, s }))
        .catch(() => ({ dex, s: null as RawClearinghouse | null }))
    )
  );

  const summaries: DexSummary[] = [];
  for (const { dex, s } of states) {
    if (!s) continue;
    const accountValue = num(s.marginSummary?.accountValue);
    const positions: Position[] = (s.assetPositions || []).map((ap) => {
      const p = ap.position;
      return {
        dex,
        coin: p.coin,
        szi: num(p.szi),
        entryPx: p.entryPx == null ? null : num(p.entryPx),
        positionValue: num(p.positionValue),
        unrealizedPnl: num(p.unrealizedPnl),
        returnOnEquity: num(p.returnOnEquity),
        liquidationPx: p.liquidationPx == null ? null : num(p.liquidationPx),
        marginUsed: num(p.marginUsed),
        leverage: p.leverage ? p.leverage.value : null,
      };
    }).filter((p) => p.szi !== 0);
    if (accountValue > 0 || positions.length) {
      summaries.push({
        dex,
        accountValue,
        totalMarginUsed: num(s.marginSummary?.totalMarginUsed),
        positions,
      });
    }
  }

  const flat = summaries.flatMap((d) => d.positions)
    .sort((a, b) => b.positionValue - a.positionValue);

  return {
    address,
    fetchedAt: Date.now(),
    totalValue: summaries.reduce((acc, d) => acc + d.accountValue, 0),
    dexes: summaries,
    positions: flat,
  };
}

// Multi-wallet fetch: ONE perpDexs roster shared across every wallet (the
// roster is venue state, not account state), each wallet still iterating ALL
// dexes (each has its own clearinghouse). Failures isolate per wallet - null in the
// result slot - so one unreachable address cannot blank the other account.
export async function fetchPortfolios(addresses: string[]): Promise<(Portfolio | null)[]> {
  const dexes = await listDexes();
  return Promise.all(
    addresses.map((a) => fetchPortfolio(a, dexes).catch(() => null)),
  );
}

export function isValidAddress(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a.trim());
}

// ---- agents (Settings) -----------------------------------------------------

export type ExtraAgent = { name: string; address: string; validUntil: number };

// The named API wallets a MASTER account has approved (info API, read-only).
// Settings verifies a pasted agent key against this list before storing it.
export async function fetchExtraAgents(master: string): Promise<ExtraAgent[]> {
  const raw = await post<unknown>({ type: "extraAgents", user: master });
  if (!Array.isArray(raw)) return [];
  const out: ExtraAgent[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.address !== "string") continue;
    out.push({
      name: typeof o.name === "string" ? o.name : "",
      address: o.address.toLowerCase(),
      validUntil: typeof o.validUntil === "number" ? o.validUntil : 0,
    });
  }
  return out;
}

// ---- history (Performance view) --------------------------------------------
//
// Still the public info API, still read-only by address. Fills are paged
// through userFillsByTime: a full page holds the OLDEST 2000 fills at or
// after startTime (verified live 2026-09-02), so paging advances startTime to
// the newest time seen (inclusive - the caller dedupes by tid) until a short
// page arrives. Only the newest 10000 fills exist server-side at all.

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const PAGE = 2000;
const FUNDING_PAGE = 500;

export type PagerOptions = { maxPages?: number; pauseMs?: number; endTime?: number };

export async function fetchFillsSince(
  address: string, sinceMs: number, o: PagerOptions = {},
): Promise<Fill[]> {
  const maxPages = o.maxPages ?? 5, pauseMs = o.pauseMs ?? 6000;
  const out: Fill[] = [];
  const seen = new Set<number>();
  let start = Math.max(0, Math.floor(sinceMs));
  for (let page = 0; page < maxPages; page++) {
    if (page) await sleep(pauseMs);
    const body: Record<string, unknown> = { type: "userFillsByTime", user: address, startTime: start, aggregateByTime: false };
    if (o.endTime !== undefined) body.endTime = o.endTime;
    const raw = await post<unknown[]>(body);
    if (!Array.isArray(raw)) break;
    let newest = start;
    for (const r of raw) {
      const f = parseFill(r);
      if (!f || seen.has(f.tid)) continue;
      seen.add(f.tid);
      out.push(f);
      if (f.time > newest) newest = f.time;
    }
    if (raw.length < PAGE) break;
    if (newest === start) break; // a full page inside one millisecond: cannot advance
    start = newest;
  }
  return out;
}

export type FundingPage = { rows: FundingRow[]; complete: boolean };

// userFunding pages at 500 rows; same inclusive-start idiom, deduped by
// (time, coin, hash). `complete` = the venue had nothing more (a short page).
export async function fetchFundingSince(
  address: string, sinceMs: number, o: PagerOptions = {},
): Promise<FundingPage> {
  const maxPages = o.maxPages ?? 40, pauseMs = o.pauseMs ?? 4000;
  const rows: FundingRow[] = [];
  const seen = new Set<string>();
  let start = Math.max(0, Math.floor(sinceMs));
  let complete = false;
  for (let page = 0; page < maxPages; page++) {
    if (page) await sleep(pauseMs);
    const raw = await post<unknown[]>({ type: "userFunding", user: address, startTime: start });
    if (!Array.isArray(raw)) break;
    let newest = start;
    for (const r of raw) {
      const row = parseFundingRow(r);
      if (!row) continue;
      const k = row.time + "|" + row.coin + "|" + row.hash;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(row);
      if (row.time > newest) newest = row.time;
    }
    if (raw.length < FUNDING_PAGE) { complete = true; break; }
    if (newest === start) break;
    start = newest;
  }
  rows.sort((a, b) => a.time - b.time);
  return { rows, complete };
}

// The venue's own equity history (all perp dexes aggregated; pnlHistory nets
// out deposits). Cached 60 s per address: a wallet-pill switch must not
// re-fetch, and the view re-polls on its own schedule.
const historyCache = new Map<string, { at: number; data: PortfolioWindows }>();
const HISTORY_TTL_MS = 60e3;

export async function fetchPortfolioHistory(address: string, now = Date.now()): Promise<PortfolioWindows> {
  const k = address.toLowerCase();
  const c = historyCache.get(k);
  if (c && now - c.at < HISTORY_TTL_MS) return c.data;
  const raw = await post<unknown>({ type: "portfolio", user: address });
  const data = parsePortfolio(raw);
  historyCache.set(k, { at: now, data });
  return data;
}
