// Which tickers MyFundedPerps (MFP) lists - the Venue filter's matching
// rules: a filter for the tickers available on MFP only and the tickers
// available on Hyperliquid only.
//
// The list itself is MFP's PUBLIC market list (GET /v1/markets?venues=all,
// `security: []` in MFP's OpenAPI spec - no key, no account), fetched and
// cached by src/lib/mfp_market_list.ts. This module only parses that payload
// and answers "does MFP list this Hyperliquid coin?".
//
// PURE and IMPORT-FREE, like filters.ts: `node --test test/` loads it straight
// from source through Node's type stripping, so erasable syntax only.
//
// Display aggregation only: the answer narrows the screener list and nothing
// else - never a score, an alert, a STRAT classification or an order.

// `id` is the venue's market_id ("binance|BTCUSDT"); when the list row
// carries none it is rebuilt as provider|coin, the shape every position
// and order carries.
export type MfpMarket = { symbol: string; coin: string; provider: string; id: string };

// The screener's quick chip cycles off -> "mfp" -> "hl" -> off. "hl" means
// Hyperliquid ONLY: every screener coin is a Hyperliquid coin, so it is the
// set MFP does NOT list.
export type Venue = "mfp" | "hl";
export const VENUES: readonly { id: Venue; label: string; token: string }[] = [
  { id: "mfp", label: "MFP", token: "MFP only" },
  { id: "hl", label: "HL only", token: "HL only" },
];

export function sanitizeVenue(raw: unknown): Venue | null {
  return raw === "mfp" || raw === "hl" ? raw : null;
}

export function nextVenue(v: Venue | null): Venue | null {
  return v === null ? "mfp" : v === "mfp" ? "hl" : null;
}

// A row is kept only when it is a whole, OPEN market: a disabled or
// reduce-only market cannot take a new position, so it does not make a
// ticker "tradeable on MFP". An unreadable payload, or one with no usable
// row, is null - the caller then keeps its last good list instead of
// marking every ticker Hyperliquid-only on a bad answer.
const MAX_ROWS = 5000;
export function parseMfpMarkets(raw: unknown): MfpMarket[] | null {
  if (!raw || typeof raw !== "object") return null;
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const out: MfpMarket[] = [];
  for (const r of data.slice(0, MAX_ROWS)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.symbol !== "string" || typeof o.coin !== "string" || typeof o.provider !== "string") continue;
    if (!o.symbol || !o.coin || !o.provider) continue;
    if (o.trading_enabled === false || o.reduce_only === true) continue;
    const id = typeof o.id === "string" && o.id ? o.id : typeof o.market_id === "string" && o.market_id ? o.market_id : o.provider + "|" + o.coin;
    out.push({ symbol: o.symbol, coin: o.coin, provider: o.provider, id });
  }
  return out.length ? out : null;
}

// Hyperliquid coin id -> the MFP symbol of the SAME instrument where the two
// names differ. Only pairs that are unambiguously one instrument: HL's "k"
// coins are quoted per 1000 units (kPEPE = 1000 PEPE), and HL lists gold and
// silver by name where MFP uses the ISO codes. Anything less certain stays
// OUT - a ticker wrongly marked tradeable is worse than one missing.
export const MFP_ALIASES: ReadonlyMap<string, string> = new Map([
  ["kPEPE", "1000PEPE"],
  ["kBONK", "1000BONK"],
  ["kSHIB", "1000SHIB"],
  ["xyz:GOLD", "XAU"],
  ["xyz:SILVER", "XAG"],
]);

export type MfpIndex = { hl: ReadonlySet<string>; sym: ReadonlySet<string> };

export function buildMfpIndex(markets: readonly MfpMarket[]): MfpIndex {
  const hl = new Set<string>();
  const sym = new Set<string>();
  for (const m of markets) {
    if (m.provider === "hyperliquid") hl.add(m.coin);
    sym.add(m.symbol);
  }
  return { hl, sym };
}

// A Hyperliquid coin (id `name`, display `sym`) is on MFP when, in order:
// 1. MFP routes that exact Hyperliquid coin ("xyz:AAPL", "BTC");
// 2. MFP lists an instrument with the same symbol on any venue (BNB trades
//    on MFP through Binance - still tradeable there);
// 3. an alias above names the MFP symbol of the same instrument.
// Exact, case-sensitive string matches only - no fuzzy matching.
export function isOnMfp(idx: MfpIndex, name: string, sym: string): boolean {
  if (idx.hl.has(name) || idx.sym.has(sym)) return true;
  const alias = MFP_ALIASES.get(name);
  return alias !== undefined && idx.sym.has(alias);
}

// `onMfp` null = the list is not loaded. Honest absence, as in filters.ts:
// an unknown never passes a venue filter in either direction (the screen
// says why instead of guessing).
export function venuePasses(venue: Venue | null, onMfp: boolean | null): boolean {
  if (venue === null) return true;
  if (onMfp === null) return false;
  return venue === "mfp" ? onMfp : !onMfp;
}

// "just now" / "12m" / "3h" / "2d" - the list's age for the Filters sheet.
export function fmtListAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60000) return "just now";
  if (ms < 3600000) return Math.floor(ms / 60000) + "m";
  if (ms < 86400000) return Math.floor(ms / 3600000) + "h";
  return Math.floor(ms / 86400000) + "d";
}
