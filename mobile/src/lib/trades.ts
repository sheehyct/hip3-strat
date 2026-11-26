// Round-trip trades, statistics and loss concentrations over Hyperliquid
// fills. PURE and IMPORT-FREE on purpose: `node --test test/` loads this file
// straight from source through Node's type stripping (Node >= 22.6), so it
// must stay erasable-syntax only (no enums, namespaces or parameter
// properties) and must not import react-native, expo or storage.
//
// Contract reminder: nothing here classifies a bar or computes
// timeframe continuity. The continuity status of a trade is READ from a
// stamp of the scanner worker's served state (see tfc_stamps.ts); this
// module only compares that served reading with the trade's side.
//
// Numbers are USD as JS numbers parsed from the venue's decimal strings.
// Sums of decimal strings carry float noise, which the flat-epsilon rule
// absorbs; display formatting is the caller's job (src/lib/fmt.ts).

// ---- fills ----------------------------------------------------------------

export type Fill = {
  tid: number;
  oid: number;
  time: number;            // ms since epoch (venue)
  coin: string;            // "BTC" (main dex) or "xyz:AAPL" (builder dex)
  side: "B" | "A";         // B = buy, A = sell (ask)
  px: number;
  sz: number;
  startPosition: number;   // signed position BEFORE this fill (venue truth)
  closedPnl: number;       // realized pnl on the closing part of this fill
  fee: number;             // venue fee (negative = rebate)
  builderFee: number;      // builder-dex fee (0 on the main dex)
  feeToken: string;
  dir: string;             // "Open Long" ... - cross-checked, never trusted
  liquidatedUser: string | null; // fill.liquidation.liquidatedUser, if any
};

function num(x: unknown): number | null {
  const v = typeof x === "string" ? parseFloat(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(v) ? v : null;
}

// Spot rows share the fills feed: "PURR/USDC" pairs and "@<index>" ids.
export function isSpotCoin(coin: string): boolean {
  return coin.includes("/") || coin.startsWith("@");
}

// Parse one raw userFills / userFillsByTime row. Returns null for spot rows,
// zero-size rows and anything malformed (never throws on venue input).
export function parseFill(raw: unknown): Fill | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.coin !== "string" || isSpotCoin(r.coin)) return null;
  if (r.side !== "B" && r.side !== "A") return null;
  const px = num(r.px), sz = num(r.sz), start = num(r.startPosition);
  const time = num(r.time), tid = num(r.tid);
  if (px === null || sz === null || start === null || time === null || tid === null) return null;
  if (sz <= 0) return null;
  const liq = r.liquidation && typeof r.liquidation === "object"
    ? (r.liquidation as Record<string, unknown>).liquidatedUser
    : null;
  return {
    tid,
    oid: num(r.oid) ?? 0,
    time,
    coin: r.coin,
    side: r.side,
    px,
    sz,
    startPosition: start,
    closedPnl: num(r.closedPnl) ?? 0,
    fee: num(r.fee) ?? 0,
    builderFee: num(r.builderFee) ?? 0,
    feeToken: typeof r.feeToken === "string" ? r.feeToken : "USDC",
    dir: typeof r.dir === "string" ? r.dir : "",
    liquidatedUser: typeof liq === "string" ? liq : null,
  };
}

// dex/sym split of a coin id: "xyz:AAPL" -> {dex:"xyz", sym:"AAPL"}; "BTC" -> {dex:"", sym:"BTC"}.
export function splitCoin(coin: string): { dex: string; sym: string } {
  const i = coin.indexOf(":");
  return i < 0 ? { dex: "", sym: coin } : { dex: coin.slice(0, i), sym: coin.slice(i + 1) };
}

// ---- trades ---------------------------------------------------------------

export type Leg = {
  tid: number;
  time: number;
  kind: "open" | "close";
  size: number;
  px: number;
  pnl: number;   // closedPnl carried by a close leg (0 on open legs)
  fee: number;   // this leg's share of fee + builderFee
};

export type TradeSide = "long" | "short";
export type TradeStatus = "open" | "closed";
export type CloseReason = "manual" | "liquidation" | "adl" | "unknown";

export type Trade = {
  id: string;
  wallet: string;
  coin: string;
  dex: string;
  sym: string;
  side: TradeSide;
  status: TradeStatus;
  truncated: boolean;      // history starts mid-position or has a gap: excluded from stats
  openTime: number | null; // null when truncated at the start
  closeTime: number | null;
  entryAvgPx: number | null;
  exitAvgPx: number | null;
  maxSize: number;
  fills: number;
  orders: number;
  grossPnl: number;        // sum of closedPnl over close legs
  fees: number;            // sum of fee + builderFee over all legs
  funding: number | null;  // signed funding received (+) / paid (-); null = not fetched
  netPnl: number;          // gross - fees + (funding ?? 0)
  returnPct: number | null;// net / (entryAvgPx * maxSize) * 100 (return on notional)
  durationMs: number | null;
  closeReason: CloseReason;
  legs: Leg[];
  tfc: TfcStamp | null;
};

export type Diag = {
  spotSkipped: number;   // not counted here (parseFill drops them) - kept for callers that count
  gaps: number;          // chain breaks (missing fills) detected
  dirMismatch: number;   // dir strings that disagreed with the arithmetic
  nonUsdcFee: number;    // fills whose feeToken was not USDC (amounts NOT converted)
};

const flatEps = (ref: number): number => Math.max(1e-9, 1e-6 * Math.abs(ref));
const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);
const near = (a: number, b: number): boolean => Math.abs(a - b) <= flatEps(Math.max(Math.abs(a), Math.abs(b), 1));
const endOf = (f: Fill): number => f.startPosition + (f.side === "B" ? f.sz : -f.sz);

// Fills that share a millisecond are NOT in execution order by tid (seen
// live: a sweep's second fill carried the smaller tid). Within such a group
// the venue's startPosition chain is the order: start from the fill whose
// startPosition equals the running position (or, unknown, the one no other
// fill's end leads to) and follow end -> start. Anything that will not chain
// keeps its tid order and the gap rule decides.
function chainOrder(group: Fill[], pos: number): Fill[] {
  if (group.length < 2) return group;
  const remaining = [...group];
  const out: Fill[] = [];
  let head: Fill | undefined = remaining.find((f) => near(f.startPosition, pos));
  if (!head) head = remaining.find((f) => !remaining.some((g) => g !== f && near(endOf(g), f.startPosition)));
  while (head) {
    out.push(head);
    remaining.splice(remaining.indexOf(head), 1);
    const e = endOf(head);
    head = remaining.find((f) => near(f.startPosition, e));
  }
  return out.length ? [...out, ...remaining] : group;
}

type Open = Trade & { openSz: number; openNot: number; closeSz: number; closeNot: number; oids: Set<number> };

function newTrade(wallet: string, coin: string, side: TradeSide, id: string, openTime: number | null, truncated: boolean): Open {
  const { dex, sym } = splitCoin(coin);
  return {
    id, wallet, coin, dex, sym, side, status: "open", truncated, openTime, closeTime: null,
    entryAvgPx: null, exitAvgPx: null, maxSize: 0, fills: 0, orders: 0, grossPnl: 0, fees: 0,
    funding: null, netPnl: 0, returnPct: null, durationMs: null, closeReason: "unknown", legs: [], tfc: null,
    openSz: 0, openNot: 0, closeSz: 0, closeNot: 0, oids: new Set<number>(),
  };
}

function dirExpectation(dir: string): "open" | "close" | "flip" | null {
  if (/^Open /.test(dir)) return "open";
  if (/^Close /.test(dir)) return "close";
  if (/ > /.test(dir)) return "flip";
  return null;
}

// Rebuild round-trip trades for ONE wallet from its fills (any order; all
// coins). Positions per coin are disjoint in time on Hyperliquid, so one
// running signed size per coin is enough. `startPosition` is the venue's
// truth and drives every decision; the running size only bridges fills that
// share a millisecond (where order is ambiguous).
export function reconstructTrades(wallet: string, fills: Fill[]): { trades: Trade[]; diag: Diag } {
  const diag: Diag = { spotSkipped: 0, gaps: 0, dirMismatch: 0, nonUsdcFee: 0 };
  const byCoin = new Map<string, Fill[]>();
  for (const f of fills) {
    if (isSpotCoin(f.coin)) { diag.spotSkipped++; continue; }
    if (!(f.sz > 0)) continue;
    if (f.feeToken && f.feeToken !== "USDC") diag.nonUsdcFee++;
    const arr = byCoin.get(f.coin);
    if (arr) arr.push(f); else byCoin.set(f.coin, [f]);
  }
  const trades: Trade[] = [];
  const coins = [...byCoin.keys()].sort();
  for (const coin of coins) {
    const sorted = byCoin.get(coin)!;
    sorted.sort((a, b) => a.time - b.time || a.tid - b.tid);
    let cur: Open | null = null;
    let pos = 0;
    let lastTime = -Infinity;
    // Same-millisecond groups are re-ordered by the startPosition chain.
    const arr: Fill[] = [];
    for (let i = 0; i < sorted.length;) {
      let j = i + 1;
      while (j < sorted.length && sorted[j].time === sorted[i].time) j++;
      const group = sorted.slice(i, j);
      const prevEnd = arr.length ? endOf(arr[arr.length - 1]) : 0;
      arr.push(...chainOrder(group, prevEnd));
      i = j;
    }

    const finalize = (f: Fill | null, truncated: boolean) => {
      if (!cur) return;
      const t = cur;
      if (f) { t.closeTime = f.time; t.status = "closed"; } else { t.status = truncated ? "closed" : "open"; }
      if (truncated) t.truncated = true;
      trades.push(t);
      cur = null;
    };
    const legFee = (f: Fill, size: number) => (f.fee + f.builderFee) * (size / f.sz);
    const openLeg = (f: Fill, size: number, side: TradeSide, flipBorn: boolean) => {
      if (!cur) cur = newTrade(wallet, coin, side, coin + ":" + f.tid + (flipBorn ? ":o" : ""), f.time, false);
      const t = cur;
      t.openSz += size; t.openNot += size * f.px;
      const fee = legFee(f, size);
      t.fees += fee; t.fills++; t.oids.add(f.oid);
      t.legs.push({ tid: f.tid, time: f.time, kind: "open", size, px: f.px, pnl: 0, fee });
    };
    const closeLeg = (f: Fill, size: number) => {
      const t = cur!;
      t.closeSz += size; t.closeNot += size * f.px; t.grossPnl += f.closedPnl;
      const fee = legFee(f, size);
      t.fees += fee; t.fills++; t.oids.add(f.oid);
      t.legs.push({ tid: f.tid, time: f.time, kind: "close", size, px: f.px, pnl: f.closedPnl, fee });
      if (f.liquidatedUser && f.liquidatedUser.toLowerCase() === wallet.toLowerCase()) t.closeReason = "liquidation";
      else if (!f.liquidatedUser && /liquidat/i.test(f.dir)) t.closeReason = "liquidation";
      else if (/deleverag|\badl\b/i.test(f.dir)) t.closeReason = "adl";
    };
    const openTruncated = (f: Fill, start: number) => {
      const t = newTrade(wallet, coin, start > 0 ? "long" : "short", coin + ":" + f.tid + ":t", null, true);
      t.openSz = Math.abs(start); t.openNot = Math.abs(start) * f.px; t.maxSize = Math.abs(start);
      cur = t;
    };

    for (const f of arr) {
      const delta = f.side === "B" ? f.sz : -f.sz;
      const start = f.startPosition;
      const end = start + delta;
      const ref = Math.max(Math.abs(start), Math.abs(end), f.sz);
      const s0 = Math.abs(start) <= flatEps(ref) ? 0 : Math.abs(start);
      const s1 = Math.abs(end) <= flatEps(ref) ? 0 : Math.abs(end);

      if (!cur && s0 > 0) {
        openTruncated(f, start);
      } else if (cur && f.time > lastTime && Math.abs(pos - start) > flatEps(Math.max(Math.abs(pos), ref))) {
        diag.gaps++;
        finalize(null, true);
        if (s0 > 0) openTruncated(f, start);
      }

      const expect = dirExpectation(f.dir);
      if (s0 === 0) {
        if (expect !== null && expect !== "open") diag.dirMismatch++;
        openLeg(f, f.sz, delta > 0 ? "long" : "short", false);
      } else if (s1 === 0) {
        if (expect !== null && expect !== "close") diag.dirMismatch++;
        closeLeg(f, f.sz);
        finalize(f, false);
      } else if (sign(start) === sign(end)) {
        if (s1 > s0) { if (expect !== null && expect !== "open") diag.dirMismatch++; openLeg(f, s1 - s0, start > 0 ? "long" : "short", false); }
        else { if (expect !== null && expect !== "close") diag.dirMismatch++; closeLeg(f, s0 - s1); }
      } else {
        if (expect !== null && expect !== "flip") diag.dirMismatch++;
        closeLeg(f, s0);
        finalize(f, false);
        openLeg(f, s1, end > 0 ? "long" : "short", true);
      }
      if (cur) (cur as Open).maxSize = Math.max((cur as Open).maxSize, s1);
      pos = s1 === 0 ? 0 : end;
      lastTime = f.time;
    }
    if (cur) finalize(null, false);
  }

  const out: Trade[] = trades.map((raw) => {
    const t = raw as Open;
    t.entryAvgPx = t.openSz > 0 ? t.openNot / t.openSz : null;
    t.exitAvgPx = t.closeSz > 0 ? t.closeNot / t.closeSz : null;
    t.orders = t.oids.size;
    if (t.status === "closed" && !t.truncated && t.closeReason === "unknown") t.closeReason = "manual";
    t.durationMs = t.openTime !== null && t.closeTime !== null ? t.closeTime - t.openTime : null;
    const { openSz, openNot, closeSz, closeNot, oids, ...rest } = t;
    void openSz; void openNot; void closeSz; void closeNot; void oids;
    return withNet(rest);
  });
  out.sort((a, b) => (b.closeTime ?? b.openTime ?? 0) - (a.closeTime ?? a.openTime ?? 0));
  return { trades: out, diag };
}

// Recompute net and return from the pnl parts (used after funding lands).
export function withNet(t: Trade): Trade {
  const netPnl = t.grossPnl - t.fees + (t.funding ?? 0);
  const returnPct = t.entryAvgPx && t.maxSize > 0 ? (netPnl / (t.entryAvgPx * t.maxSize)) * 100 : null;
  return { ...t, netPnl, returnPct };
}

// ---- funding --------------------------------------------------------------

export type FundingRow = { time: number; coin: string; usdc: number; hash: string };

export function parseFundingRow(raw: unknown): FundingRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const d = r.delta && typeof r.delta === "object" ? (r.delta as Record<string, unknown>) : null;
  const time = num(r.time);
  if (!d || time === null || typeof d.coin !== "string") return null;
  const usdc = num(d.usdc);
  if (usdc === null) return null;
  return { time, coin: d.coin, usdc, hash: typeof r.hash === "string" ? r.hash : "" };
}

// Attribute funding rows to trades: a row belongs to the trade of the same
// coin whose [openTime, closeTime ?? now] contains its time. Positions per
// coin are disjoint in time, so attribution is unique. Returns tradeId -> usdc.
export function foldFunding(trades: Trade[], rows: FundingRow[], now: number): Map<string, number> {
  const byCoin = new Map<string, Trade[]>();
  for (const t of trades) {
    if (t.openTime === null) continue;
    const arr = byCoin.get(t.coin);
    if (arr) arr.push(t); else byCoin.set(t.coin, [t]);
  }
  const out = new Map<string, number>();
  for (const r of rows) {
    const arr = byCoin.get(r.coin);
    if (!arr) continue;
    for (const t of arr) {
      const end = t.closeTime ?? now;
      if (r.time >= (t.openTime as number) && r.time <= end) {
        out.set(t.id, (out.get(t.id) ?? 0) + r.usdc);
        break;
      }
    }
  }
  return out;
}

// Apply a funding map (missing id = null, i.e. unknown, never 0).
export function applyFunding(trades: Trade[], funding: Map<string, number>, covered: (t: Trade) => boolean): Trade[] {
  return trades.map((t) => withNet({ ...t, funding: covered(t) ? (funding.get(t.id) ?? 0) : null }));
}

// ---- windows and stats ----------------------------------------------------

export type Window = "day" | "week" | "month" | "all";
const WINDOW_MS: Record<Window, number> = { day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, all: Infinity };

// Rolling windows (24 h / 7 d / 30 d) so the numbers agree with the venue's
// portfolio graph windows, which are rolling too.
export function windowStart(w: Window, now: number): number {
  return w === "all" ? -Infinity : now - WINDOW_MS[w];
}

export function closedIn(trades: Trade[], w: Window, now: number): Trade[] {
  const start = windowStart(w, now);
  return trades.filter((t) => t.status === "closed" && !t.truncated && t.closeTime !== null && t.closeTime >= start);
}

export type Stats = {
  count: number; wins: number; losses: number; flat: number;
  winRate: number | null;        // wins / (wins + losses); null with no decided trade
  netPnl: number; grossPnl: number; fees: number; funding: number;
  fundingUnknown: number;        // trades whose funding was not fetched
  profitFactor: number | null;   // sum wins / |sum losses|; null with no losses
  expectancy: number;            // net / count
  avgWin: number; avgLoss: number;
  largestWin: number; largestLoss: number;
  // The same figures as returns on entry notional (per-trade returnPct);
  // trades without a return (no entry price) are left out of these.
  avgWinPct: number | null; avgLossPct: number | null;
  expectancyPct: number | null;
  largestWinPct: number | null; largestLossPct: number | null;
  avgDurationMs: number | null;
  longWins: number; longLosses: number; shortWins: number; shortLosses: number;
  best: Trade[]; worst: Trade[]; // top 5 by net
};

export function computeStats(trades: Trade[]): Stats {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const sum = (a: Trade[], k: (t: Trade) => number) => a.reduce((s, t) => s + k(t), 0);
  const sumWins = sum(wins, (t) => t.netPnl), sumLosses = sum(losses, (t) => t.netPnl);
  const durs = trades.filter((t) => t.durationMs !== null);
  const byNet = [...trades].sort((a, b) => b.netPnl - a.netPnl);
  const withRet = (a: Trade[]) => a.filter((t) => t.returnPct !== null);
  const meanRet = (a: Trade[]) => { const r = withRet(a); return r.length ? sum(r, (t) => t.returnPct as number) / r.length : null; };
  const retWins = withRet(wins), retLosses = withRet(losses);
  return {
    count: trades.length, wins: wins.length, losses: losses.length, flat: trades.length - wins.length - losses.length,
    winRate: wins.length + losses.length ? wins.length / (wins.length + losses.length) : null,
    netPnl: sum(trades, (t) => t.netPnl), grossPnl: sum(trades, (t) => t.grossPnl), fees: sum(trades, (t) => t.fees),
    funding: sum(trades, (t) => t.funding ?? 0), fundingUnknown: trades.filter((t) => t.funding === null).length,
    profitFactor: sumLosses < 0 ? sumWins / -sumLosses : null,
    expectancy: trades.length ? sum(trades, (t) => t.netPnl) / trades.length : 0,
    avgWin: wins.length ? sumWins / wins.length : 0, avgLoss: losses.length ? sumLosses / losses.length : 0,
    largestWin: wins.length ? byNet[0].netPnl : 0, largestLoss: losses.length ? byNet[byNet.length - 1].netPnl : 0,
    avgWinPct: meanRet(wins), avgLossPct: meanRet(losses), expectancyPct: meanRet(trades),
    largestWinPct: retWins.length ? Math.max(...retWins.map((t) => t.returnPct as number)) : null,
    largestLossPct: retLosses.length ? Math.min(...retLosses.map((t) => t.returnPct as number)) : null,
    avgDurationMs: durs.length ? sum(durs, (t) => t.durationMs as number) / durs.length : null,
    longWins: wins.filter((t) => t.side === "long").length, longLosses: losses.filter((t) => t.side === "long").length,
    shortWins: wins.filter((t) => t.side === "short").length, shortLosses: losses.filter((t) => t.side === "short").length,
    best: byNet.slice(0, 5), worst: byNet.slice(-5).reverse(),
  };
}

// ---- New York time (hour-of-day / weekday buckets) -------------------------

export type NyTime = { hour: (t: number) => number; weekday: (t: number) => number; source: "intl" | "rule" };

// Fixed US rule since 2007: EDT (UTC-4) from the second Sunday of March
// 07:00 UTC to the first Sunday of November 06:00 UTC, else EST (UTC-5).
function nthSundayUtc(year: number, month: number, n: number): number {
  const first = Date.UTC(year, month, 1);
  const dow = new Date(first).getUTCDay();
  const day = 1 + ((7 - dow) % 7) + (n - 1) * 7;
  return Date.UTC(year, month, day);
}
export function nyOffsetMsByRule(t: number): number {
  const y = new Date(t).getUTCFullYear();
  const start = nthSundayUtc(y, 2, 2) + 7 * 3600e3;  // second Sunday of March, 02:00 EST
  const end = nthSundayUtc(y, 10, 1) + 6 * 3600e3;   // first Sunday of November, 02:00 EDT
  return t >= start && t < end ? -4 * 3600e3 : -5 * 3600e3;
}
function ruleTime(): NyTime {
  return {
    source: "rule",
    hour: (t) => new Date(t + nyOffsetMsByRule(t)).getUTCHours(),
    weekday: (t) => new Date(t + nyOffsetMsByRule(t)).getUTCDay(),
  };
}

// Intl is preferred (it follows the platform tz database) but is proven on
// three known instants first; any throw or mismatch falls back to the rule.
export function makeNyTime(intl: typeof Intl | null = typeof Intl !== "undefined" ? Intl : null): NyTime {
  if (!intl) return ruleTime();
  try {
    const fmt = new intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", weekday: "short" });
    const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const parts = (t: number) => {
      let hour = -1, wd = -1;
      for (const p of fmt.formatToParts(new Date(t))) {
        if (p.type === "hour") hour = parseInt(p.value, 10) % 24;
        if (p.type === "weekday") wd = WD[p.value] ?? -1;
      }
      if (hour < 0 || wd < 0) throw new Error("parts");
      return { hour, wd };
    };
    const checks: [number, number, number][] = [
      [Date.UTC(2026, 0, 15, 17, 0), 12, 4],   // EST: 17:00Z = 12:00, Thursday
      [Date.UTC(2026, 6, 15, 16, 0), 12, 3],   // EDT: 16:00Z = 12:00, Wednesday
      [Date.UTC(2026, 2, 8, 7, 30), 3, 0],     // just after spring-forward: 03:30 EDT, Sunday
    ];
    for (const [t, h, w] of checks) {
      const p = parts(t);
      if (p.hour !== h || p.wd !== w) return ruleTime();
    }
    return { source: "intl", hour: (t) => parts(t).hour, weekday: (t) => parts(t).wd };
  } catch {
    return ruleTime();
  }
}

// ---- buckets and loss concentrations --------------------------------------

export type Dim = "side" | "dex" | "coin" | "hour" | "weekday" | "hold" | "tfc" | "wallet";
export const DIMS: Dim[] = ["side", "dex", "coin", "hour", "weekday", "hold", "tfc", "wallet"];

export type Bucket = {
  dim: Dim;
  key: string;      // stable id within the dim (e.g. "9" for 09:00 ET, "lt5m")
  label: string;    // display label
  count: number; wins: number; losses: number;
  netPnl: number; winPnl: number; lossPnl: number;
  avgReturnPct: number | null;  // mean per-trade return on notional in the bucket
};

export type HoldBucket = "lt5m" | "5-30m" | "30m-4h" | "4h-1d" | "gt1d";
export function holdBucket(ms: number): HoldBucket {
  return ms < 5 * 60e3 ? "lt5m" : ms < 30 * 60e3 ? "5-30m" : ms < 4 * 3600e3 ? "30m-4h" : ms < 86400e3 ? "4h-1d" : "gt1d";
}
const HOLD_LABEL: Record<HoldBucket, string> = { lt5m: "Held under 5m", "5-30m": "Held 5-30m", "30m-4h": "Held 30m-4h", "4h-1d": "Held 4h-1d", gt1d: "Held over 1d" };
const WEEKDAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TFC_LABEL: Record<TfcStatus, string> = { with: "With continuity", against: "Against continuity", mixed: "Mixed continuity", unknown: "Continuity unknown" };

export type BucketOptions = { ny: NyTime; walletLabel?: (wallet: string) => string; atEntryMs?: number };

export function bucketKey(t: Trade, dim: Dim, o: BucketOptions): { key: string; label: string } | null {
  switch (dim) {
    case "side": return { key: t.side, label: t.side === "long" ? "Longs" : "Shorts" };
    case "dex": return { key: t.dex, label: t.dex || "main" };
    case "coin": return { key: t.coin, label: t.sym };
    case "hour": {
      if (t.openTime === null) return null;
      const h = o.ny.hour(t.openTime);
      return { key: String(h), label: String(h).padStart(2, "0") + ":00 ET" };
    }
    case "weekday": {
      if (t.openTime === null) return null;
      const d = o.ny.weekday(t.openTime);
      return { key: String(d), label: WEEKDAY_LABEL[d] };
    }
    case "hold": {
      if (t.durationMs === null) return null;
      const b = holdBucket(t.durationMs);
      return { key: b, label: HOLD_LABEL[b] };
    }
    case "tfc": {
      const s = classifyTfc(t, t.tfc, o.atEntryMs);
      return { key: s, label: TFC_LABEL[s] };
    }
    case "wallet": return { key: t.wallet, label: o.walletLabel ? o.walletLabel(t.wallet) : t.wallet };
  }
}

export function bucketize(trades: Trade[], dim: Dim, o: BucketOptions): Bucket[] {
  const m = new Map<string, Bucket>();
  const retSum = new Map<string, { sum: number; n: number }>();
  for (const t of trades) {
    const k = bucketKey(t, dim, o);
    if (!k) continue;
    let b = m.get(k.key);
    if (!b) { b = { dim, key: k.key, label: k.label, count: 0, wins: 0, losses: 0, netPnl: 0, winPnl: 0, lossPnl: 0, avgReturnPct: null }; m.set(k.key, b); }
    b.count++; b.netPnl += t.netPnl;
    if (t.netPnl > 0) { b.wins++; b.winPnl += t.netPnl; }
    if (t.netPnl < 0) { b.losses++; b.lossPnl += t.netPnl; }
    if (t.returnPct !== null) {
      const r = retSum.get(k.key) ?? { sum: 0, n: 0 };
      r.sum += t.returnPct; r.n++;
      retSum.set(k.key, r);
    }
  }
  for (const [k, r] of retSum) { const b = m.get(k); if (b && r.n) b.avgReturnPct = r.sum / r.n; }
  return [...m.values()];
}

export type Concentration = Bucket & {
  lossShare: number;   // this bucket's losses / all losses (0..1)
  tradeShare: number;  // this bucket's trades / all trades (0..1)
  score: number;       // lossShare - tradeShare: over-representation among losses
};

// Rank (dim, bucket) pairs by how much MORE of the losses they carry than
// their share of trades, so "longs are 80% of losses" is not reported when
// longs are 80% of trades. Eligible: >= 3 losers (>= 2 when fewer than 6
// losers overall) and >= 20% of losses. One bucket per dim; the continuity
// "unknown" bucket is never ranked (the caller prints its share as a note).
export function lossConcentrations(trades: Trade[], o: BucketOptions, dims: Dim[] = DIMS, max = 3): Concentration[] {
  const losers = trades.filter((t) => t.netPnl < 0);
  const totalLoss = losers.reduce((s, t) => s + t.netPnl, 0);
  if (!trades.length || totalLoss >= 0) return [];
  const minLosers = losers.length < 6 ? 2 : 3;
  const all: Concentration[] = [];
  for (const dim of dims) {
    for (const b of bucketize(trades, dim, o)) {
      if (dim === "tfc" && b.key === "unknown") continue;
      const lossShare = b.lossPnl / totalLoss, tradeShare = b.count / trades.length;
      if (b.losses < minLosers || lossShare < 0.2) continue;
      const score = lossShare - tradeShare;
      // A bucket that holds every trade explains nothing; demand real over-representation.
      if (score <= 0.05) continue;
      all.push({ ...b, lossShare, tradeShare, score });
    }
  }
  all.sort((a, b) => b.score - a.score || b.lossShare - a.lossShare);
  const seen = new Set<Dim>(), out: Concentration[] = [];
  for (const c of all) {
    if (seen.has(c.dim)) continue;
    seen.add(c.dim); out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

// "Shorts: 58% of losses from 35% of trades (7 losers, avg -$41.20)".
export function concentrationSentence(c: Concentration, money: (x: number) => string): string {
  const pct = (x: number) => Math.round(x * 100) + "%";
  return c.label + ": " + pct(c.lossShare) + " of losses from " + pct(c.tradeShare) + " of trades (" +
    c.losses + (c.losses === 1 ? " loser" : " losers") + ", avg " + money(c.lossPnl / c.losses) + ")";
}

// ---- continuity stamps ----------------------------------------------------

// A copy of the scanner worker's served continuity fields for one coin at
// the moment the app observed a trade's opening. Pure storage of server
// output: nothing here is derived from price.
export type TfcStamp = {
  wallet: string;
  coin: string;
  openTime: number | null;
  observedAt: number;          // when the app took the copy (worker: the ledger sample's time)
  stateTs: number;             // the served payload's ts (worker: the ledger sample's time)
  ftfc: "up" | "down" | "mixed" | null;
  dots: string[];
  dwm: { complete: boolean; dir: "up" | "down" | null; dots: Record<string, string | null> } | null;
  source: "device" | "worker";
  lagMs: number | null;        // device: observedAt - openTime; worker: openTime - at (the sample precedes the fill)
};

export type TfcStatus = "with" | "against" | "mixed" | "unknown";
export const AT_ENTRY_MS = 5 * 60e3;

export function stampLag(stamp: TfcStamp): number | null {
  if (stamp.lagMs !== null) return stamp.lagMs;
  return stamp.openTime === null ? null : stamp.observedAt - stamp.openTime;
}

// With = the served fast continuity matches the trade's side; against =
// opposite; mixed = served mixed; unknown = no stamp, or a stamp taken too
// long after entry to speak for it.
export function classifyTfc(trade: Trade, stamp: TfcStamp | null, atEntryMs: number = AT_ENTRY_MS): TfcStatus {
  if (!stamp) return "unknown";
  const lag = stampLag(stamp);
  if (lag === null || lag < 0 || lag > atEntryMs) return "unknown";
  if (stamp.ftfc === "mixed") return "mixed";
  if (stamp.ftfc === "up") return trade.side === "long" ? "with" : "against";
  if (stamp.ftfc === "down") return trade.side === "short" ? "with" : "against";
  return "unknown";
}

export type StampProvider = { get: (wallet: string, coin: string, openTime: number) => TfcStamp | null };

// Attach the best available stamp per trade (smallest lag wins across
// providers, so a worker ledger can outrank a late device stamp).
export function joinTfc(trades: Trade[], providers: StampProvider[]): Trade[] {
  return trades.map((t) => {
    if (t.openTime === null) return t;
    let best: TfcStamp | null = null;
    for (const p of providers) {
      const s = p.get(t.wallet, t.coin, t.openTime);
      if (!s) continue;
      const lag = stampLag(s), bestLag = best ? stampLag(best) : null;
      if (!best || (lag !== null && (bestLag === null || lag < bestLag))) best = s;
    }
    return best ? { ...t, tfc: best } : t;
  });
}

// Provider over a journal of stamps: for (coin, openTime) pick the stamp with
// the smallest lag among exact-openTime stamps (fills-sync and worker-ledger
// stamps) and position-observed stamps taken after the opening fill.
export function providerFromStamps(stamps: TfcStamp[]): StampProvider {
  const byCoin = new Map<string, TfcStamp[]>();
  for (const s of stamps) {
    const k = s.wallet.toLowerCase() + "|" + s.coin;
    const arr = byCoin.get(k);
    if (arr) arr.push(s); else byCoin.set(k, [s]);
  }
  return {
    get(wallet, coin, openTime) {
      const arr = byCoin.get(wallet.toLowerCase() + "|" + coin);
      if (!arr) return null;
      let best: TfcStamp | null = null, bestLag = Infinity;
      for (const s of arr) {
        let lag: number | null;
        if (s.openTime === openTime) lag = stampLag(s);
        else if (s.openTime === null && s.observedAt >= openTime) lag = s.observedAt - openTime;
        else continue;
        if (lag === null || lag < 0) continue;
        if (lag < bestLag) { bestLag = lag; best = { ...s, openTime, lagMs: lag }; }
      }
      return best;
    },
  };
}

// ---- worker continuity ledger (POST /api/continuity_at) -------------------

// The scanner worker records the continuity it served every 30 s, so the app
// can ask what it was at a trade's opening fill. A covered answer is the last
// sample at or before t (at most 60 s earlier) and becomes a stamp with
// source "worker", observedAt = stateTs = that sample, lagMs = t - at. The
// answer is copied, never derived. The route is the scanner worker's
// POST /api/continuity_at (its continuity ledger).
export const LEDGER_MAX_ITEMS = 200;          // the route's per-request cap
export const LEDGER_RETRY_MS = 2 * 60e3;      // a covered:false younger than this may still fill in
// The ledger covers t only from a sample at most 60 s earlier (its GAP_MS,
// 2 x the 30 s interval); a wider covered answer breaks the contract.
export const LEDGER_MAX_GAP_MS = 60e3;

export type LedgerLookup = { coin: string; t: number };
export type LedgerAnswer =
  | { kind: "stamp"; stamp: TfcStamp }
  | { kind: "miss" }    // FINAL: not covered and the ledger never back-fills
  | { kind: "retry" };  // too recent, or an item that failed validation: cache nothing

export const ledgerKey = (coin: string, t: number): string => coin + "|" + t;

export type LedgerPickOpts = {
  now: number;
  since: number | null;               // first sample the ledger still holds; null = not known
  retentionMs: number;
  served: (coin: string) => boolean;  // the coin's dex is one the worker serves
};

// Trades worth asking about: a known opening fill inside the ledger's reach,
// no stamp within AT_ENTRY_MS of it yet, and no answer (stamp or final miss)
// already on the device.
export function pickLedgerLookups(trades: Trade[], known: Set<string>, o: LedgerPickOpts): LedgerLookup[] {
  const out: LedgerLookup[] = [], asked = new Set<string>();
  for (const tr of trades) {
    const t = tr.openTime;
    if (t === null || tr.truncated) continue;
    if (t > o.now || t < o.now - o.retentionMs || (o.since !== null && t < o.since)) continue;
    if (!o.served(tr.coin)) continue;
    const k = ledgerKey(tr.coin, t);
    if (known.has(k) || asked.has(k)) continue;
    const lag = tr.tfc ? stampLag(tr.tfc) : null;
    if (lag !== null && lag >= 0 && lag <= AT_ENTRY_MS) continue;
    asked.add(k);
    out.push({ coin: tr.coin, t });
  }
  return out;
}

export function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const FTFC_VALUES = new Set(["up", "down", "mixed"]);

function ledgerDwm(raw: unknown): TfcStamp["dwm"] {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.complete !== "boolean" || !(o.dir === null || o.dir === "up" || o.dir === "down")) return null;
  if (!o.dots || typeof o.dots !== "object") return null;
  const dots: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(o.dots as Record<string, unknown>)) {
    if (v !== null && typeof v !== "string") return null;
    dots[k] = v;
  }
  return { complete: o.complete, dir: o.dir, dots };
}

function ledgerAnswer(r: Record<string, unknown>, q: LedgerLookup, wallet: string, now: number): LedgerAnswer {
  if (r.covered === false) return now - q.t > LEDGER_RETRY_MS ? { kind: "miss" } : { kind: "retry" };
  if (r.covered !== true) return { kind: "retry" };
  const at = r.at;
  if (typeof at !== "number" || !Number.isFinite(at) || at > q.t || q.t - at > LEDGER_MAX_GAP_MS) return { kind: "retry" };
  if (typeof r.ready !== "boolean") return { kind: "retry" };
  if (!(r.ftfc === null || (typeof r.ftfc === "string" && FTFC_VALUES.has(r.ftfc)))) return { kind: "retry" };
  if (!Array.isArray(r.dots) || !r.dots.every((d) => typeof d === "string")) return { kind: "retry" };
  return {
    kind: "stamp",
    stamp: {
      wallet, coin: q.coin, openTime: q.t, observedAt: at, stateTs: at,
      // An unready coin is covered with ftfc null - the served truth; it classifies unknown.
      ftfc: r.ready ? (r.ftfc as TfcStamp["ftfc"]) : null,
      dots: [...(r.dots as string[])],
      dwm: ledgerDwm(r.dwmContinuity),
      source: "worker",
      lagMs: q.t - at,
    },
  };
}

// Validate a 200 body against the batch that was asked. Answers come back in
// request order; any misalignment (length, coin, t) means nothing in the body
// can be trusted, so the whole batch is dropped (null) and asked again later.
export function parseLedgerAnswers(raw: unknown, asked: LedgerLookup[], wallet: string, now: number): LedgerAnswer[] | null {
  if (!Array.isArray(raw) || raw.length !== asked.length) return null;
  const out: LedgerAnswer[] = [];
  for (let i = 0; i < asked.length; i++) {
    const r = raw[i], q = asked[i];
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    if (o.coin !== q.coin || o.t !== q.t) return null;
    out.push(ledgerAnswer(o, q, wallet, now));
  }
  return out;
}

// Pause after a 503: busy / timeout carry Retry-After: 5; the ledger-disabled
// 503 carries none, and a disabled ledger does not come back in seconds.
export function retryAfterMs(header: string | null): number {
  const n = header === null || header.trim() === "" ? NaN : Number(header);
  if (!Number.isFinite(n) || n < 0) return 10 * 60e3;
  return Math.min(10 * 60e3, Math.max(5e3, n * 1000));
}

// ---- portfolio history (equity graph) ------------------------------------

export type Series = [number, number][];
export type PortfolioWindow = { accountValueHistory: Series; pnlHistory: Series; vlm: number };
export type PortfolioWindows = Record<string, PortfolioWindow>;

function parseSeries(raw: unknown): Series {
  if (!Array.isArray(raw)) return [];
  const out: Series = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const t = num(p[0]), v = num(p[1]);
    if (t === null || v === null) continue;
    out.push([t, v]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

// The venue returns [[name, window], ...]; an object keyed by name is also accepted.
export function parsePortfolio(raw: unknown): PortfolioWindows {
  const out: PortfolioWindows = {};
  const add = (name: unknown, w: unknown) => {
    if (typeof name !== "string" || !w || typeof w !== "object") return;
    const o = w as Record<string, unknown>;
    out[name] = { accountValueHistory: parseSeries(o.accountValueHistory), pnlHistory: parseSeries(o.pnlHistory), vlm: num(o.vlm) ?? 0 };
  };
  if (Array.isArray(raw)) for (const pair of raw) { if (Array.isArray(pair) && pair.length >= 2) add(pair[0], pair[1]); }
  else if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw as Record<string, unknown>)) add(k, v);
  return out;
}

export const WINDOW_KEY: Record<Window, string> = { day: "perpDay", week: "perpWeek", month: "perpMonth", all: "perpAllTime" };

// Cumulative PnL over the window, re-based so the first point is 0.
export function pnlSeries(w: PortfolioWindow | undefined): Series {
  if (!w || !w.pnlHistory.length) return [];
  const base = w.pnlHistory[0][1];
  return w.pnlHistory.map(([t, v]) => [t, v - base]);
}

// Keep at most `max` points: every k-th point plus each bucket's min and max.
export function decimate(series: Series, max = 500): Series {
  if (series.length <= max) return series;
  const k = Math.ceil(series.length / max);
  const keep = new Set<number>();
  for (let i = 0; i < series.length; i += k) {
    keep.add(i);
    let lo = i, hi = i;
    for (let j = i; j < Math.min(i + k, series.length); j++) {
      if (series[j][1] < series[lo][1]) lo = j;
      if (series[j][1] > series[hi][1]) hi = j;
    }
    keep.add(lo); keep.add(hi);
  }
  keep.add(series.length - 1);
  return [...keep].sort((a, b) => a - b).map((i) => series[i]);
}

// ---- MyFundedPerps closed positions (SECURITY.md) --------------------------
//
// An MFP closed position is already one whole round trip, so it maps onto a
// Trade directly. gross = the venue's realized_pnl (price P&L only) and
// net = gross - fees + funding: on the sandbox (2026-10-23) the balance
// moved by exactly that sum. No legs: the venue reports the position, not
// its fills, and splitting its fee between an open and a close leg would be
// invented. The structural row type keeps this module import-free.
export type MfpClosedRow = {
  id: string; provider: string; symbol: string; coin: string; side: TradeSide; size: number;
  entryPrice: number; exitPrice: number | null; openedAt: number; closedAt: number;
  realizedPnl: number; fees: number; funding: number; closeReason: string | null;
};

// hlCoinOf maps a row to the Hyperliquid coin on the same base asset (for
// the continuity ledger and the TradingView link); null = no equivalent, and
// the trade's coin is then "mfp:<symbol>", which no served universe matches.
export function tradesFromMfp(rows: MfpClosedRow[], wallet: string, hlCoinOf: (r: MfpClosedRow) => string | null): Trade[] {
  return rows.map((r): Trade => {
    const hl = hlCoinOf(r);
    const net = r.realizedPnl - r.fees + r.funding;
    const notional = r.entryPrice * r.size;
    return {
      id: "mfp:" + r.id,
      wallet,
      coin: hl ?? "mfp:" + (r.symbol || r.coin),
      dex: hl && hl.includes(":") ? hl.split(":")[0] : "",
      sym: r.symbol || r.coin,
      side: r.side,
      status: "closed",
      truncated: false,
      openTime: r.openedAt,
      closeTime: r.closedAt,
      entryAvgPx: r.entryPrice,
      exitAvgPx: r.exitPrice,
      maxSize: r.size,
      fills: 0,
      orders: 0,
      grossPnl: r.realizedPnl,
      fees: r.fees,
      funding: r.funding,
      netPnl: net,
      returnPct: notional > 0 ? (net / notional) * 100 : null,
      durationMs: r.closedAt >= r.openedAt ? r.closedAt - r.openedAt : null,
      closeReason: r.closeReason === "liquidation" ? "liquidation" : r.closeReason === null || r.closeReason === "system" ? "unknown" : "manual",
      legs: [],
      tfc: null,
    };
  }).sort((a, b) => (b.closeTime as number) - (a.closeTime as number));
}

// The MFP account's equity line per window, shaped like the Hyperliquid
// portfolio windows so the Performance view draws both the same way. The API
// serves no equity history, so the line is the realized net of each closed
// trade stepped from the starting balance, ending at `now`. Only the All
// window adds the open positions' current unrealized P&L to that last
// point: a shorter window cannot know how much of it accrued inside the
// window, so it stays realized only.
export function mfpPortfolioWindows(trades: Trade[], startingBalance: number, unrealized: number | null, now: number): PortfolioWindows {
  const closed = trades
    .filter((t) => t.status === "closed" && t.closeTime !== null)
    .sort((a, b) => (a.closeTime as number) - (b.closeTime as number));
  const first = closed.length ? Math.min(...closed.map((t) => t.openTime ?? (t.closeTime as number))) : now;
  // A close stamped after `now` (a slow sync, the venue's clock) must not
  // put the end point behind it.
  const end = closed.length ? Math.max(now, closed[closed.length - 1].closeTime as number) : now;
  const out: PortfolioWindows = {};
  for (const w of ["day", "week", "month", "all"] as Window[]) {
    const start = w === "all" ? Math.min(first, now) : now - WINDOW_MS[w];
    let cum = 0;
    for (const t of closed) if ((t.closeTime as number) < start) cum += t.netPnl;
    const pnl: Series = [[start, cum]];
    let vlm = 0;
    for (const t of closed) {
      if ((t.closeTime as number) < start) continue;
      cum += t.netPnl;
      pnl.push([t.closeTime as number, cum]);
      vlm += t.maxSize * ((t.entryAvgPx ?? 0) + (t.exitAvgPx ?? 0));
    }
    pnl.push([end, cum + (w === "all" ? unrealized ?? 0 : 0)]);
    out[WINDOW_KEY[w]] = { pnlHistory: pnl, accountValueHistory: pnl.map(([x, v]): [number, number] => [x, startingBalance + v]), vlm };
  }
  return out;
}

// ---- compact storage codec (fills cache) -----------------------------------

export type CompactFill = [number, number, number, string, 0 | 1, number, number, number, number, number, number, string, string | null, string];

export function encodeFill(f: Fill): CompactFill {
  return [f.tid, f.oid, f.time, f.coin, f.side === "B" ? 1 : 0, f.px, f.sz, f.startPosition, f.closedPnl, f.fee, f.builderFee, f.dir, f.liquidatedUser, f.feeToken];
}

export function decodeFill(c: unknown): Fill | null {
  if (!Array.isArray(c) || c.length < 12) return null;
  const n = (i: number) => num(c[i]);
  const tid = n(0), oid = n(1), time = n(2), px = n(5), sz = n(6), start = n(7);
  if (tid === null || oid === null || time === null || px === null || sz === null || start === null || typeof c[3] !== "string") return null;
  return {
    tid, oid, time, coin: c[3], side: c[4] === 1 ? "B" : "A", px, sz, startPosition: start,
    closedPnl: n(8) ?? 0, fee: n(9) ?? 0, builderFee: n(10) ?? 0,
    dir: typeof c[11] === "string" ? c[11] : "", liquidatedUser: typeof c[12] === "string" ? c[12] : null,
    feeToken: typeof c[13] === "string" ? c[13] : "USDC",
  };
}

// Union by tid (incoming wins), sorted by time then tid, then evicted to the
// caps from the OLD end. Eviction mid-position simply leaves a truncated
// trade behind through the startPosition rule; no extra bookkeeping.
export function mergeFills(existing: Fill[], incoming: Fill[], caps: { maxFills: number; maxAgeMs: number; now: number }): Fill[] {
  const m = new Map<number, Fill>();
  for (const f of existing) m.set(f.tid, f);
  for (const f of incoming) m.set(f.tid, f);
  let all = [...m.values()].sort((a, b) => a.time - b.time || a.tid - b.tid);
  const minTime = caps.now - caps.maxAgeMs;
  all = all.filter((f) => f.time >= minTime);
  if (all.length > caps.maxFills) all = all.slice(all.length - caps.maxFills);
  return all;
}
