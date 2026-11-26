// Hyperliquid INFO client: the public, read-only info API by address. No
// keys, no signing. It covers what a trading
// terminal reads: meta + asset contexts per dex (mark, 24h change, funding,
// OI), clearinghouse state per dex, open orders per dex, fills, historical
// orders and the order-status lookup (how an uncertain send is resolved).
//
// Clearinghouse state is PER DEX on Hyperliquid: the main dex ("") and each
// HIP-3 builder dex (xyz, ...) hold positions in separate clearinghouses, so
// every portfolio read iterates ALL dexes (perpDexs, then the read per dex)
// or HIP-3 positions silently vanish.

const API = "https://api.hyperliquid.xyz/info";

// The public WebSocket (candles, mids, bbo); src/lib/hl_stream.ts is its
// only client. Read-only market data, no account.
export const HL_WS_URL = "wss://api.hyperliquid.xyz/ws";

// Exported for hl_exchange.ts, which re-reads the venue around every write;
// still the read-only info endpoint.
export async function infoPost<T>(body: object): Promise<T> {
  return post<T>(body);
}

// A read that never answers must not hang a poll (or a write waiting on its
// re-read) for ever: each attempt is cut off after this long. The deadline
// covers the WHOLE attempt, the body included: a venue that sends its
// headers and then stalls is cut off just the same.
const READ_TIMEOUT_MS = 10_000;

type Attempt<T> = { kind: "ok"; json: T } | { kind: "status"; status: number } | { kind: "failed"; error: unknown };

async function attempt<T>(body: object): Promise<Attempt<T>> {
  const ctl = new AbortController();
  let cut: (e: Error) => void = () => undefined;
  // Raced against the body read as well as passed to fetch: the deadline
  // then holds even where a body read does not honour the abort signal.
  const deadline = new Promise<never>((_, reject) => { cut = reject; });
  deadline.catch(() => undefined);
  const timer = setTimeout(() => { ctl.abort(); cut(new Error("timed out")); }, READ_TIMEOUT_MS);
  try {
    const r = await Promise.race([
      fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal }),
      deadline,
    ]);
    if (!r.ok) return { kind: "status", status: r.status };
    return { kind: "ok", json: (await Promise.race([r.json(), deadline])) as T };
  } catch (error) {
    return { kind: "failed", error };
  } finally {
    clearTimeout(timer);
  }
}

async function post<T>(body: object, tries = 0): Promise<T> {
  const a = await attempt<T>(body);
  if (a.kind === "ok") return a.json;
  if (a.kind === "failed") {
    if (tries < 3) {
      await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, tries)));
      return post<T>(body, tries + 1);
    }
    throw a.error;
  }
  if (a.status === 429 && tries < 5) {
    await new Promise((res) => setTimeout(res, 800 * Math.pow(2, tries)));
    return post<T>(body, tries + 1);
  }
  throw new Error("HTTP " + a.status);
}

function num(x: string | number | null | undefined): number {
  const v = typeof x === "string" ? parseFloat(x) : x;
  return typeof v === "number" && isFinite(v) ? v : 0;
}
const numOrNull = (x: unknown): number | null => {
  const v = typeof x === "string" ? parseFloat(x) : x;
  return typeof v === "number" && isFinite(v) ? v : null;
};

export function isValidAddress(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a.trim());
}

// ---- market data ----------------------------------------------------------

// Raw candleSnapshot rows for one coin / interval / window (candles.ts parses).
export async function fetchCandlesRaw(coin: string, interval: string, startTime: number, endTime: number): Promise<unknown> {
  return post<unknown>({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } });
}

// perpDexs: first element is null (the main dex), then {name, ...} per
// HIP-3 builder dex, in the order the asset-id offsets follow.
//
// Every account read iterates this list, so a list that lost a dex makes
// that dex's positions and orders look absent - and "not there" is taken as
// proof. An answer that is not exactly that shape is therefore unreadable,
// never "the main dex only".
export function parseDexList(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("dex list unreadable");
  if (raw[0] !== null) throw new Error("dex list unreadable: the main dex is not first");
  const out: string[] = [""];
  for (let i = 1; i < raw.length; i++) {
    const d = raw[i] as { name?: unknown } | null;
    if (!d || typeof d !== "object" || typeof d.name !== "string" || !d.name) throw new Error("dex list unreadable: malformed entry " + i);
    if (out.includes(d.name)) throw new Error("dex list unreadable: " + d.name + " appears twice");
    out.push(d.name);
  }
  return out;
}

export async function listDexes(): Promise<string[]> {
  return parseDexList(await post<unknown>({ type: "perpDexs" }));
}

export type HlMarketRow = {
  coin: string;
  dex: string;
  index: number;          // within that dex's universe
  assetId: number;
  szDecimals: number;
  maxLeverage: number | null;
  isDelisted: boolean;
  markPx: number | null;
  midPx: number | null;
  prevDayPx: number | null;
  funding: number | null;
  openInterest: number | null;
  dayNtlVlm: number | null;
};

type RawMetaCtx = [
  { universe?: { name?: string; szDecimals?: number; maxLeverage?: number; isDelisted?: boolean }[] },
  { markPx?: string; midPx?: string | null; prevDayPx?: string; funding?: string; openInterest?: string; dayNtlVlm?: string }[],
];

// metaAndAssetCtxs for every dex: the market list with live context. One
// call per dex; the order of `dexes` is perpDexs order (asset-id offsets).
export async function fetchHlMarkets(dexes?: string[]): Promise<HlMarketRow[]> {
  const list = dexes ?? (await listDexes());
  const all = await Promise.all(list.map((dex) => post<RawMetaCtx>(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" }).catch(() => null)));
  const out: HlMarketRow[] = [];
  all.forEach((res, di) => {
    if (!res || !Array.isArray(res) || !res[0]) return;
    const uni = res[0].universe || [];
    const ctxs = Array.isArray(res[1]) ? res[1] : [];
    uni.forEach((u, i) => {
      if (!u || typeof u.name !== "string" || typeof u.szDecimals !== "number") return;
      const c = ctxs[i] || {};
      out.push({
        coin: u.name, dex: list[di], index: i,
        assetId: di === 0 ? i : 110000 + (di - 1) * 10000 + i,
        szDecimals: u.szDecimals,
        maxLeverage: typeof u.maxLeverage === "number" ? u.maxLeverage : null,
        isDelisted: u.isDelisted === true,
        markPx: numOrNull(c.markPx), midPx: numOrNull(c.midPx), prevDayPx: numOrNull(c.prevDayPx),
        funding: numOrNull(c.funding), openInterest: numOrNull(c.openInterest), dayNtlVlm: numOrNull(c.dayNtlVlm),
      });
    });
  });
  return out;
}

export async function fetchAllMids(dex: string): Promise<Record<string, number>> {
  const raw = await post<Record<string, string>>(dex ? { type: "allMids", dex } : { type: "allMids" });
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const p = parseFloat(v);
    if (Number.isFinite(p) && p > 0) out[k] = p;
  }
  return out;
}

// ---- account state --------------------------------------------------------

export type HlPosition = {
  dex: string;
  coin: string;
  szi: number;            // signed size: >0 long, <0 short
  entryPx: number | null;
  positionValue: number;  // abs notional in USD
  unrealizedPnl: number;
  liquidationPx: number | null;
  marginUsed: number;
  leverage: number | null;
  leverageType: "cross" | "isolated" | null;
};

export type HlClearinghouse = {
  dex: string;
  accountValue: number;
  totalMarginUsed: number;
  withdrawable: number;
  positions: HlPosition[];
};

type RawClearinghouse = {
  marginSummary?: { accountValue?: string; totalMarginUsed?: string };
  withdrawable?: string;
  assetPositions?: {
    position: {
      coin: string;
      szi: string;
      entryPx?: string | null;
      positionValue?: string;
      unrealizedPnl?: string;
      liquidationPx?: string | null;
      marginUsed?: string;
      leverage?: { type: string; value: number };
    };
  }[];
};

export async function fetchClearinghouse(address: string, dex: string): Promise<HlClearinghouse> {
  const s = await post<RawClearinghouse>({ type: "clearinghouseState", user: address, dex });
  if (!s || typeof s !== "object" || !Array.isArray(s.assetPositions)) throw new Error("malformed clearinghouse state for dex " + (dex || "main"));
  const positions: HlPosition[] = s.assetPositions.map((ap) => {
    const p = ap && ap.position;
    // A row whose coin or size cannot be read makes the whole state
    // unreadable: a hidden position must never look flat.
    if (!p || typeof p.coin !== "string" || numOrNull(p.szi) === null) throw new Error("malformed position row for dex " + (dex || "main"));
    return {
      dex,
      coin: p.coin,
      szi: num(p.szi),
      entryPx: p.entryPx == null ? null : num(p.entryPx),
      positionValue: num(p.positionValue),
      unrealizedPnl: num(p.unrealizedPnl),
      liquidationPx: p.liquidationPx == null ? null : num(p.liquidationPx),
      marginUsed: num(p.marginUsed),
      leverage: p.leverage ? p.leverage.value : null,
      leverageType: p.leverage ? (p.leverage.type === "isolated" ? ("isolated" as const) : ("cross" as const)) : null,
    };
  }).filter((p) => p.szi !== 0);
  return {
    dex,
    accountValue: num(s.marginSummary?.accountValue),
    totalMarginUsed: num(s.marginSummary?.totalMarginUsed),
    withdrawable: num(s.withdrawable),
    positions,
  };
}

// Every dex, failures isolated per dex (null) so one unreachable
// clearinghouse cannot blank the others - but the caller must treat a null
// as UNKNOWN, never as flat.
export async function fetchClearinghouses(address: string, dexes: string[]): Promise<(HlClearinghouse | null)[]> {
  return Promise.all(dexes.map((dex) => fetchClearinghouse(address, dex).catch(() => null)));
}

export type HlOpenOrder = {
  dex: string;
  coin: string;
  oid: number;
  cloid: string | null;
  side: "A" | "B";        // A = ask (sell), B = bid (buy)
  limitPx: number;
  sz: number;             // remaining
  origSz: number;
  reduceOnly: boolean;
  isTrigger: boolean;
  triggerPx: number | null;
  orderType: string;      // "Limit", "Stop Market", "Take Profit Market", ...
  tif: string | null;
  timestamp: number;
};

type RawOpenOrder = {
  coin: string; oid: number; cloid?: string | null; side: string; limitPx: string; sz: string; origSz?: string;
  reduceOnly?: boolean; isTrigger?: boolean; triggerPx?: string; orderType?: string; tif?: string | null; timestamp?: number;
};

// frontendOpenOrders: the rich row (reduceOnly, isTrigger, triggerPx,
// orderType), the same oid universe as openOrders. Throws when unreadable:
// "could not read" must never look like "none".
export async function fetchOpenOrders(address: string, dex: string): Promise<HlOpenOrder[]> {
  const raw = await post<unknown>({ type: "frontendOpenOrders", user: address, dex });
  if (!Array.isArray(raw)) throw new Error("open orders unreadable");
  const out: HlOpenOrder[] = [];
  for (const r of raw as RawOpenOrder[]) {
    // One unreadable row makes the list unreadable: an unseen order must
    // never look absent.
    if (!r || typeof r.coin !== "string" || !Number.isInteger(r.oid)) throw new Error("malformed open order row");
    out.push({
      dex, coin: r.coin, oid: r.oid, cloid: typeof r.cloid === "string" ? r.cloid : null,
      side: r.side === "A" ? "A" : "B", limitPx: num(r.limitPx), sz: num(r.sz), origSz: num(r.origSz ?? r.sz),
      reduceOnly: r.reduceOnly === true, isTrigger: r.isTrigger === true,
      triggerPx: r.isTrigger ? numOrNull(r.triggerPx) : null,
      orderType: typeof r.orderType === "string" ? r.orderType : "Limit",
      tif: typeof r.tif === "string" ? r.tif : null,
      timestamp: typeof r.timestamp === "number" ? r.timestamp : 0,
    });
  }
  return out;
}

export type HlFill = {
  coin: string; px: number; sz: number; side: "A" | "B"; time: number; dir: string;
  closedPnl: number; fee: number; oid: number; tid: number; cloid: string | null;
};

// userFills: the newest fills (the venue caps the answer at 2000). Coins
// from builder dexes arrive with their prefixed names ("xyz:NVDA").
// UNVERIFIED: that userFills aggregates every dex (userFillsByTime, paged
// without a dex parameter, has been seen to return HIP-3 fills).
export async function fetchFills(address: string): Promise<HlFill[]> {
  const raw = await post<unknown>({ type: "userFills", user: address });
  if (!Array.isArray(raw)) return [];
  const out: HlFill[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.coin !== "string" || typeof o.time !== "number") continue;
    out.push({
      coin: o.coin, px: num(o.px as string), sz: num(o.sz as string), side: o.side === "A" ? "A" : "B", time: o.time,
      dir: typeof o.dir === "string" ? o.dir : "", closedPnl: num(o.closedPnl as string), fee: num(o.fee as string),
      oid: typeof o.oid === "number" ? o.oid : 0, tid: typeof o.tid === "number" ? o.tid : 0,
      cloid: typeof o.cloid === "string" ? o.cloid : null,
    });
  }
  return out;
}

export type HlHistoricalOrder = {
  coin: string; oid: number; cloid: string | null; side: "A" | "B"; limitPx: number; origSz: number; sz: number;
  reduceOnly: boolean; isTrigger: boolean; triggerPx: number | null; orderType: string; timestamp: number;
  status: string; statusTimestamp: number;
};

// historicalOrders: the newest 2000 orders with their final status
// (filled / canceled / rejected / triggered / open ...).
export async function fetchHistoricalOrders(address: string): Promise<HlHistoricalOrder[]> {
  const raw = await post<unknown>({ type: "historicalOrders", user: address });
  if (!Array.isArray(raw)) return [];
  const out: HlHistoricalOrder[] = [];
  for (const r of raw) {
    const h = parseOrderWithStatus(r);
    if (h) out.push(h);
  }
  return out;
}

function parseOrderWithStatus(r: unknown): HlHistoricalOrder | null {
  if (!r || typeof r !== "object") return null;
  const o = (r as Record<string, unknown>).order as Record<string, unknown> | undefined;
  const status = (r as Record<string, unknown>).status;
  if (!o || typeof o !== "object" || typeof o.coin !== "string" || typeof status !== "string") return null;
  return {
    coin: o.coin, oid: typeof o.oid === "number" ? o.oid : 0, cloid: typeof o.cloid === "string" ? o.cloid : null,
    side: o.side === "A" ? "A" : "B", limitPx: num(o.limitPx as string), origSz: num(o.origSz as string), sz: num(o.sz as string),
    reduceOnly: o.reduceOnly === true, isTrigger: o.isTrigger === true, triggerPx: o.isTrigger ? numOrNull(o.triggerPx) : null,
    orderType: typeof o.orderType === "string" ? o.orderType : "Limit", timestamp: typeof o.timestamp === "number" ? o.timestamp : 0,
    status, statusTimestamp: typeof (r as Record<string, unknown>).statusTimestamp === "number" ? ((r as Record<string, unknown>).statusTimestamp as number) : 0,
  };
}

// One orderStatus answer. null ONLY for the venue's explicit "unknownOid":
// that is the one answer that says the venue does not know this order, and
// after the payload's expiry it is taken as proof the order never arrived.
// Everything else that is not a complete order record - an empty record, a
// missing status, a size that is not a number - throws: unreadable is never
// absent, and a size defaulted to zero would be read as "nothing executed".
export function parseOrderStatus(raw: unknown): HlHistoricalOrder | null {
  if (!raw || typeof raw !== "object") throw new Error("order status unreadable");
  const o = raw as Record<string, unknown>;
  if (o.status === "unknownOid") return null;
  if (o.status !== "order") throw new Error("order status unreadable");
  const h = parseOrderWithStatus(o.order);
  const inner = h ? ((o.order as Record<string, unknown>).order as Record<string, unknown>) : null;
  if (!h || !inner || !Number.isInteger(inner.oid) || numOrNull(inner.origSz) === null || numOrNull(inner.sz) === null || !h.status) {
    throw new Error("order status unreadable: malformed order record");
  }
  return h;
}

// orderStatus by oid or cloid: how an uncertain send is resolved (never by
// resending). null = the venue says it does not know this order.
export async function fetchOrderStatus(address: string, oidOrCloid: number | string): Promise<HlHistoricalOrder | null> {
  return parseOrderStatus(await post<unknown>({ type: "orderStatus", user: address, oid: oidOrCloid }));
}

// activeAssetData: the user's leverage and margin mode on ONE coin, whether
// or not a position is open (the coin carries its dex prefix, "xyz:NVDA").
// It is how a leverage change is verified on a market with no position.
// Throws when unreadable.
export type HlLeverage = { leverage: number; marginMode: "cross" | "isolated" };
export function parseActiveAsset(raw: unknown, coin: string): HlLeverage {
  const o = raw as { coin?: unknown; leverage?: { type?: unknown; value?: unknown } } | null;
  const l = o && typeof o === "object" ? o.leverage : null;
  if (!o || o.coin !== coin || !l || typeof l !== "object" || typeof l.value !== "number" || !Number.isFinite(l.value) || (l.type !== "cross" && l.type !== "isolated")) {
    throw new Error("leverage unreadable for " + coin);
  }
  return { leverage: l.value, marginMode: l.type };
}

export async function fetchActiveLeverage(address: string, coin: string): Promise<HlLeverage> {
  return parseActiveAsset(await post<unknown>({ type: "activeAssetData", user: address, coin }), coin);
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
