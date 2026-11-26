// The MOCK venue layer: fake positions, orders, fills, balances and
// synthetic candles with a live tick, for the screenshot gate (web ?mock=1)
// and the Demo toggle. No network, no keys. Writes resolve after a short
// simulated latency so the pending state is visible; a limit price with
// more than 8 significant digits or a size under the step is rejected (the
// "bad tick / size" failure case), everything else fills or rests.
import type { Bar, ChartTf } from "./candles";
import { tfSpec } from "./candles";
import { mockScenario } from "./mode";
import { capRefusal } from "./order_policy";
import type { OrderIntent } from "./order_policy";
import type { Balance, HistoryRow, Market, OpenOrder, Position, Quote, VenueId, VenueSnapshot } from "./types";
import type { ExitLeg, LeverageRead, Lookup, StepFn, VenueClient, WriteOutcome } from "./venue";

// ---- deterministic prices ---------------------------------------------------

type Spec = { coin: string; base: number; vol: number; szDecimals: number; maxLev: number };
const HL_SPECS: Spec[] = [
  { coin: "BTC", base: 80250, vol: 0.0009, szDecimals: 5, maxLev: 40 },
  { coin: "ETH", base: 3410, vol: 0.0011, szDecimals: 4, maxLev: 25 },
  { coin: "SOL", base: 168.4, vol: 0.0015, szDecimals: 2, maxLev: 20 },
  { coin: "xyz:NVDA", base: 190.6, vol: 0.0007, szDecimals: 2, maxLev: 10 },
  { coin: "xyz:TSLA", base: 441.2, vol: 0.0009, szDecimals: 2, maxLev: 10 },
  { coin: "xyz:SP500", base: 7402.5, vol: 0.0003, szDecimals: 3, maxLev: 40 },
  { coin: "xyz:GOLD", base: 4081, vol: 0.0004, szDecimals: 3, maxLev: 20 },
  { coin: "kPEPE", base: 0.00912, vol: 0.002, szDecimals: 0, maxLev: 10 },
];
// MFP markets: provider|coin, with the HL coin that charts them.
const MFP_SPECS: { id: string; symbol: string; provider: string; coin: string; chart: string | null }[] = [
  { id: "hyperliquid|BTC", symbol: "BTC", provider: "hyperliquid", coin: "BTC", chart: "BTC" },
  { id: "binance|ETHUSDT", symbol: "ETH", provider: "binance", coin: "ETHUSDT", chart: "ETH" },
  { id: "binance|SOLUSDT", symbol: "SOL", provider: "binance", coin: "SOLUSDT", chart: "SOL" },
  { id: "hyperliquid|xyz:NVDA", symbol: "NVDA", provider: "hyperliquid", coin: "xyz:NVDA", chart: "xyz:NVDA" },
  { id: "hyperliquid|xyz:SP500", symbol: "SP500", provider: "hyperliquid", coin: "xyz:SP500", chart: "xyz:SP500" },
  { id: "binance|XAUUSDT", symbol: "XAU", provider: "binance", coin: "XAUUSDT", chart: "xyz:GOLD" },
];

// A seeded PRNG so every run of the mock draws the same history.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const hash = (s: string): number => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

// The mock clock: the real clock, or a fixed instant for reproducible
// screenshots (?scenario=... pins it).
const NOW0 = Date.now();
export const mockNow = (): number => NOW0 + (Date.now() - NOW0);

// One-minute bars per coin, generated once from the seed, 5 days deep,
// ending at the minute before now; the forming minute moves with the tick.
const MIN_BARS = 5 * 24 * 60;
const minute = new Map<string, Bar[]>();
const live = new Map<string, Bar>();
function ensureSeries(coin: string): Bar[] {
  let bars = minute.get(coin);
  if (bars) return bars;
  const spec = HL_SPECS.find((s) => s.coin === coin) ?? { coin, base: 100, vol: 0.001, szDecimals: 2, maxLev: 10 };
  const r = rng(hash(coin));
  const end = Math.floor(mockNow() / 60000) * 60;    // the forming minute's open
  let px = spec.base;
  bars = [];
  for (let i = MIN_BARS; i >= 1; i--) {
    const t = end - i * 60;
    const drift = (Math.sin(i / 310) * 0.12 + Math.sin(i / 47) * 0.08) * spec.vol;
    const o = px;
    const c = o * (1 + (r() - 0.5) * 2 * spec.vol + drift);
    const h = Math.max(o, c) * (1 + r() * spec.vol * 0.8);
    const l = Math.min(o, c) * (1 - r() * spec.vol * 0.8);
    bars.push({ time: t, open: o, high: h, low: l, close: c, volume: Math.round((50 + r() * 400) * (spec.base > 1000 ? 0.1 : 10)) });
    px = c;
  }
  // Pull the last close to the base so the fixtures' entries sit near it.
  const k = spec.base / px;
  for (const b of bars) { b.open *= k; b.high *= k; b.low *= k; b.close *= k; }
  minute.set(coin, bars);
  live.set(coin, { time: end, open: spec.base, high: spec.base, low: spec.base, close: spec.base, volume: 0 });
  return bars;
}

// The forming bar walks a little every tick.
let tickRng = rng(7);
function tick(): void {
  const now = mockNow();
  const curMin = Math.floor(now / 60000) * 60;
  for (const spec of HL_SPECS) {
    ensureSeries(spec.coin);
    const b = live.get(spec.coin) as Bar;
    if (curMin > b.time) {
      minute.get(spec.coin)!.push({ ...b });
      live.set(spec.coin, { time: curMin, open: b.close, high: b.close, low: b.close, close: b.close, volume: 0 });
      continue;
    }
    const c = b.close * (1 + (tickRng() - 0.5) * spec.vol * 0.35);
    b.close = c; b.high = Math.max(b.high, c); b.low = Math.min(b.low, c); b.volume += Math.round(tickRng() * 3);
  }
  for (const l of tickListeners) l();
}
const tickListeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;
function ensureTicker(): void {
  if (!ticker) ticker = setInterval(tick, 1000);
}

export function mockMark(coin: string): number {
  ensureSeries(coin);
  return live.get(coin)!.close;
}

export function mockChg24(coin: string): number {
  const bars = ensureSeries(coin);
  const i = Math.max(0, bars.length - 24 * 60);
  const then = bars[i]?.close ?? mockMark(coin);
  return ((mockMark(coin) - then) / then) * 100;
}

export function mockBars(coin: string, tf: ChartTf, startMs: number, endMs: number): Bar[] {
  ensureTicker();
  const ms = tfSpec(tf).ms;
  const all = [...ensureSeries(coin), live.get(coin) as Bar];
  const step = ms / 60000;
  const out: Bar[] = [];
  const buckets = new Map<number, Bar>();
  for (const b of all) {
    const bt = Math.floor(b.time / (ms / 1000)) * (ms / 1000);
    const cur = buckets.get(bt);
    if (!cur) buckets.set(bt, { time: bt, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
  }
  for (const b of buckets.values()) if (b.time * 1000 >= startMs && b.time * 1000 <= endMs) out.push(b);
  out.sort((a, b) => a.time - b.time);
  void step;
  return out;
}

export function mockStream(coin: string, tf: ChartTf, onBar: (b: Bar) => void): () => void {
  ensureTicker();
  const ms = tfSpec(tf).ms;
  const l = () => {
    const bars = mockBars(coin, tf, mockNow() - 2 * ms, mockNow() + ms);
    const last = bars[bars.length - 1];
    if (last) onBar(last);
  };
  tickListeners.add(l);
  return () => { tickListeners.delete(l); };
}

export function mockSubscribeTicks(l: () => void): () => void {
  ensureTicker();
  tickListeners.add(l);
  return () => { tickListeners.delete(l); };
}

// ---- the fake books ----------------------------------------------------------

type Book = { positions: Position[]; orders: OpenOrder[]; history: HistoryRow[] };
let nextId = 1000;
const now = mockNow();

const hlSym = (c: string) => c.slice(c.indexOf(":") + 1);
const mfpSpec = (id: string) => MFP_SPECS.find((m) => m.id === id);
const chartCoinOf = (venue: VenueId, id: string): string | null => (venue === "hl" ? id : (mfpSpec(id)?.chart ?? null));
const symOf = (venue: VenueId, id: string): string => (venue === "hl" ? hlSym(id) : (mfpSpec(id)?.symbol ?? id));

function pos(venue: VenueId, id: string, side: "long" | "short", size: number, entry: number, lev: number, mode: "cross" | "isolated"): Position {
  const szi = side === "long" ? size : -size;
  return {
    key: venue + ":" + id, venue, marketId: id, symbol: symOf(venue, id), chartCoin: chartCoinOf(venue, id), side, size, entry, mark: null, pnl: null,
    notional: size * entry, liq: side === "long" ? entry * (1 - 0.9 / lev) : entry * (1 + 0.9 / lev), leverage: lev, marginMode: mode, marginUsed: (size * entry) / lev,
    ref: venue === "hl" ? { kind: "hl", dex: id.includes(":") ? id.slice(0, id.indexOf(":")) : "", szi } : { kind: "mfp", positionId: "pos_" + hash(id).toString(36), accountId: "acct_demo", sizeDecimals: 3 },
  };
}
function ord(venue: VenueId, id: string, side: "buy" | "sell", kind: OpenOrder["kind"], price: number, size: number, reduceOnly: boolean): OpenOrder {
  const oid = nextId++;
  return {
    key: venue + ":" + oid, venue, marketId: id, symbol: symOf(venue, id), side, kind, price, size, reduceOnly, status: "resting", createdAt: now - oid * 1000,
    ref: venue === "hl" ? { kind: "hl", dex: id.includes(":") ? id.slice(0, id.indexOf(":")) : "", oid, cloid: null, isTrigger: kind === "tp" || kind === "sl" } : { kind: "mfp", orderId: "ord_" + oid, clientOrderId: null, positionId: null },
  };
}
function fill(venue: VenueId, id: string, minsAgo: number, side: "buy" | "sell", size: number, price: number, pnl: number | null, text: string, status: HistoryRow["status"] = "filled"): HistoryRow {
  return { key: venue + ":h:" + nextId++, venue, marketId: id, symbol: symOf(venue, id), time: now - minsAgo * 60000, side, size, price, pnl, fee: status === "filled" ? +(size * price * 0.00035).toFixed(2) : null, text, status };
}

const books: Record<VenueId, Book> = {
  hl: {
    positions: [
      pos("hl", "BTC", "long", 0.05, 79810, 10, "cross"),
      pos("hl", "xyz:NVDA", "short", 20, 191.9, 5, "isolated"),
    ],
    orders: [
      ord("hl", "BTC", "sell", "tp", 84000, 0.05, true),
      ord("hl", "BTC", "sell", "sl", 77500, 0.05, true),
      ord("hl", "ETH", "buy", "limit", 3300, 0.5, false),
    ],
    history: [
      fill("hl", "BTC", 42, "buy", 0.05, 79810, null, "Open Long"),
      fill("hl", "xyz:NVDA", 130, "sell", 20, 191.9, null, "Open Short"),
      fill("hl", "SOL", 310, "sell", 12, 171.2, 38.4, "Close Long"),
      fill("hl", "SOL", 390, "buy", 12, 168.0, null, "Open Long"),
      fill("hl", "ETH", 15, "buy", 1, 3200, null, "canceled limit", "canceled"),
      fill("hl", "ETH", 16, "buy", 1, 3200.123456, null, "rejected: Price must be divisible by tick size.", "rejected"),
    ],
  },
  mfp: {
    positions: [
      pos("mfp", "binance|ETHUSDT", "short", 1.5, 3438.2, 20, "cross"),
      pos("mfp", "hyperliquid|xyz:NVDA", "long", 10, 189.4, 5, "cross"),
    ],
    orders: [
      ord("mfp", "hyperliquid|xyz:NVDA", "sell", "sl", 185.0, 10, true),
      ord("mfp", "binance|ETHUSDT", "buy", "limit", 3280, 1.5, true),
    ],
    history: [
      fill("mfp", "binance|ETHUSDT", 55, "sell", 1.5, 3438.2, null, "filled"),
      fill("mfp", "hyperliquid|xyz:NVDA", 200, "buy", 10, 189.4, null, "filled"),
      fill("mfp", "hyperliquid|BTC", 800, "sell", 0.02, 80100, -14.2, "filled"),
      fill("mfp", "hyperliquid|BTC", 860, "buy", 0.02, 80810, null, "filled"),
    ],
  },
};

const markOf = (venue: VenueId, id: string): number => mockMark(chartCoinOf(venue, id) ?? "BTC");

function snapshotOf(venue: VenueId): VenueSnapshot {
  const b = books[venue];
  const positions = b.positions.map((p) => {
    const mark = markOf(venue, p.marketId);
    const pnl = (mark - p.entry) * p.size * (p.side === "long" ? 1 : -1);
    return { ...p, mark, pnl, notional: p.size * mark };
  });
  const mids: Record<string, number> = {};
  const chg24: Record<string, number> = {};
  const ids = venue === "hl" ? HL_SPECS.map((s) => s.coin) : MFP_SPECS.map((m) => m.id);
  for (const id of ids) { mids[id] = markOf(venue, id); chg24[id] = mockChg24(chartCoinOf(venue, id) ?? "BTC"); }
  const upnl = positions.reduce((a, p) => a + (p.pnl ?? 0), 0);
  const margin = positions.reduce((a, p) => a + (p.marginUsed ?? 0), 0);
  const balance: Balance = venue === "hl"
    ? { venue, equity: 12480.5 + upnl, available: 12480.5 - margin, marginUsed: margin, dailyLossRoom: null, drawdownRoom: null, exposureCap: null, accountExposureCap: null, label: "0xd3m0...c0de" }
    : { venue, equity: 10248.51 + upnl, available: 10248.51 - margin, marginUsed: margin, dailyLossRoom: 412.3 + upnl, drawdownRoom: 1050.8 + upnl, exposureCap: 150000, accountExposureCap: 400000, label: "A1 evaluation (sandbox)" };
  return { venue, positions, orders: b.orders.map((o) => ({ ...o })), balance, mids, chg24, at: mockNow() };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const LATENCY_MS = 650;
const levers = new Map<string, LeverageRead>();   // venue:marketId -> the market's leverage setting
const sigDigits = (x: number): number => x.toString().replace(/^-?0*\.?0*/, "").replace(".", "").replace(/0+$/, "").length;

export function makeMockVenue(venue: VenueId): VenueClient {
  const book = books[venue];
  const label = venue === "hl" ? "HL" : "MFP";
  const findPos = (p: Position) => book.positions.find((x) => x.key === p.key);
  return {
    id: venue,
    async ready() { return true; },
    async tradeBlocked() { return null; },
    // The mock gives its orders no ids to ask about: the book re-read decides.
    async lookup(): Promise<Lookup> { return { status: "unreadable", full: false, filled: 0, message: null }; },
    // The mock keeps a leverage setting per market, so a change on a market
    // with no position can be read back like on the venue.
    async leverage(m: Market): Promise<LeverageRead | null> { return levers.get(venue + ":" + m.id) ?? { leverage: 5, marginMode: "cross" }; },
    async markets(): Promise<Market[]> {
      if (venue === "hl") return HL_SPECS.map((s) => ({ key: "hl:" + s.coin, venue, id: s.coin, symbol: hlSym(s.coin), chartCoin: s.coin, chartNote: null, szDecimals: s.szDecimals, maxLeverage: s.maxLev, provider: null }));
      return MFP_SPECS.map((m) => ({ key: "mfp:" + m.id, venue, id: m.id, symbol: m.symbol, chartCoin: m.chart, chartNote: m.provider === "hyperliquid" ? null : "chart: Hyperliquid " + m.chart + " - MFP fills on " + m.provider, szDecimals: 3, maxLeverage: 40, provider: m.provider }));
    },
    async snapshot() { ensureTicker(); await sleep(60); return snapshotOf(venue); },
    async history() { return [...book.history].sort((a, b) => b.time - a.time); },
    async quote(marketId): Promise<Quote> {
      const mid = markOf(venue, marketId);
      return { bid: mid * 0.9999, ask: mid * 1.0001, mid, at: mockNow() };
    },
    async placeOrder(intent: OrderIntent, market: Market, _mark, step: StepFn): Promise<WriteOutcome> {
      step("sending to " + label + " (mock)");
      await sleep(LATENCY_MS);
      // ?scenario=lost: the answer never arrives and the book is untouched, so
      // the unsettled strip and the lock can be seen (and shot) without a venue.
      if (mockScenario() === "lost") return { state: "unknown", message: "transport: timed out (mock)", ambiguous: true };
      if (intent.type === "limit" && intent.price !== null && sigDigits(intent.price) > 8) return { state: "rejected", message: "Price must be divisible by tick size.", ambiguous: false };
      const step0 = market.szDecimals !== null ? Math.pow(10, -market.szDecimals) : 0;
      if (intent.size < step0) return { state: "rejected", message: "Order size below the minimum size step.", ambiguous: false };
      const mark = markOf(venue, market.id);
      if (intent.type === "limit") {
        const crosses = intent.side === "buy" ? (intent.price as number) >= mark : (intent.price as number) <= mark;
        if (!crosses) {
          book.orders.push(ord(venue, market.id, intent.side, "limit", intent.price as number, intent.size, intent.reduceOnly));
          return { state: "confirmed", message: "resting at " + intent.price, ambiguous: false };
        }
      }
      const px = intent.type === "limit" ? (intent.price as number) : mark * (1 + (intent.side === "buy" ? 1 : -1) * 0.0002);
      applyFill(venue, market.id, intent.side, intent.size, px, intent.leverage ?? 5, intent.marginMode ?? "cross");
      const legs: ExitLeg[] = [];
      for (const [kind, lv] of [["sl", intent.sl], ["tp", intent.tp]] as const) {
        if (lv === null) continue;
        const o = ord(venue, market.id, intent.side === "buy" ? "sell" : "buy", kind, lv, intent.size, true);
        book.orders.push(o);
        legs.push({ kind, price: lv, state: "sent", message: null, orderKey: o.key, ref: null, deadAfter: null });
      }
      return { state: "confirmed", message: "filled " + intent.size + " at " + px.toFixed(2), ambiguous: false, filled: intent.size, legs };
    },
    async closePosition(p: Position, fraction: number, _s, step: StepFn): Promise<WriteOutcome> {
      step("closing " + Math.round(fraction * 100) + "% on " + label + " (mock)");
      await sleep(LATENCY_MS);
      const cur = findPos(p);
      if (!cur) return { state: "rejected", message: "the venue shows no position any more", ambiguous: false };
      // The same rounding as the store's closeSize (the market's size step),
      // so the re-read shows exactly what the close asked for.
      const unit = Math.pow(10, venue === "hl" ? (HL_SPECS.find((sp) => sp.coin === cur.marketId)?.szDecimals ?? 2) : 3);
      const size = fraction === 1 ? cur.size : Math.floor(cur.size * fraction * unit + 1e-9) / unit;
      const px = markOf(venue, cur.marketId);
      applyFill(venue, cur.marketId, cur.side === "long" ? "sell" : "buy", size, px, cur.leverage ?? 5, cur.marginMode ?? "cross");
      return { state: "confirmed", message: "closed " + size + " at " + px.toFixed(2), ambiguous: false };
    },
    async flat(p: Position, s: number, step: StepFn): Promise<WriteOutcome> {
      const r = await this.closePosition(p, 1, s, step);
      const before = book.orders.length;
      book.orders = book.orders.filter((o) => o.marketId !== p.marketId);
      return { ...r, message: (r.message ?? "") + "; " + (before - book.orders.length) + " order(s) cancelled" };
    },
    async reverse(p: Position, s: number, step: StepFn, maxNotional: number): Promise<WriteOutcome> {
      const cur = findPos(p);
      if (!cur) return { state: "rejected", message: "the venue shows no position any more", ambiguous: false };
      const size = cur.size;
      const r = await this.flat(p, s, step);
      if (r.state !== "confirmed") return r;
      step("venue reads flat; opening the opposite side");
      await sleep(LATENCY_MS);
      const px = markOf(venue, cur.marketId);
      const cap = capRefusal(size, px, maxNotional);
      if (cap) return { state: "partial", message: "closed; the opening order was not sent: " + cap, ambiguous: false };
      applyFill(venue, cur.marketId, cur.side === "long" ? "sell" : "buy", size, px, cur.leverage ?? 5, cur.marginMode ?? "cross");
      return { state: "confirmed", message: "now " + (cur.side === "long" ? "short " : "long ") + size, ambiguous: false };
    },
    async cancelOrder(o: OpenOrder): Promise<WriteOutcome> {
      await sleep(LATENCY_MS);
      const n = book.orders.length;
      book.orders = book.orders.filter((x) => x.key !== o.key);
      return n === book.orders.length ? { state: "rejected", message: "Order was never placed", ambiguous: false } : { state: "confirmed", message: "cancelled", ambiguous: false };
    },
    async modifyOrder(o: OpenOrder, price: number, size: number | null, _mark: number | null): Promise<WriteOutcome> {
      await sleep(LATENCY_MS);
      if (sigDigits(price) > 8) return { state: "rejected", message: "Price must be divisible by tick size.", ambiguous: false };
      const cur = book.orders.find((x) => x.key === o.key);
      if (!cur) return { state: "rejected", message: "the order is gone", ambiguous: false };
      cur.price = price;
      if (size !== null) cur.size = size;
      return { state: "confirmed", message: "moved to " + price, ambiguous: false };
    },
    async setExit(p: Position, kind, price, existing): Promise<WriteOutcome> {
      if (existing) return this.modifyOrder(existing, price, null, null);
      await sleep(LATENCY_MS);
      const cur = findPos(p);
      if (!cur) return { state: "rejected", message: "the venue shows no position any more", ambiguous: false };
      book.orders.push(ord(venue, cur.marketId, cur.side === "long" ? "sell" : "buy", kind, price, cur.size, true));
      return { state: "confirmed", message: kind + " placed at " + price, ambiguous: false };
    },
    async cancelExit(_p, o) { return this.cancelOrder(o); },
    async setLeverage(m: Market, lev: number, cross: boolean): Promise<WriteOutcome> {
      await sleep(LATENCY_MS);
      for (const p of book.positions) if (p.marketId === m.id) { p.leverage = lev; p.marginMode = cross ? "cross" : "isolated"; }
      levers.set(venue + ":" + m.id, { leverage: lev, marginMode: cross ? "cross" : "isolated" });
      return { state: "confirmed", message: lev + "x " + (cross ? "cross" : "isolated"), ambiguous: false };
    },
  };
}

function applyFill(venue: VenueId, id: string, side: "buy" | "sell", size: number, px: number, lev: number, mode: "cross" | "isolated"): void {
  const book = books[venue];
  const cur = book.positions.find((p) => p.marketId === id);
  const dir = side === "buy" ? 1 : -1;
  let pnl: number | null = null;
  let text = side === "buy" ? "Open Long" : "Open Short";
  if (!cur) {
    book.positions.push(pos(venue, id, dir > 0 ? "long" : "short", size, px, lev, mode));
  } else {
    const curDir = cur.side === "long" ? 1 : -1;
    if (curDir === dir) {
      const n = cur.size + size;
      cur.entry = (cur.entry * cur.size + px * size) / n;
      cur.size = n;
    } else {
      const closed = Math.min(cur.size, size);
      pnl = (px - cur.entry) * closed * curDir;
      text = cur.side === "long" ? "Close Long" : "Close Short";
      const left = cur.size - closed;
      if (left <= 1e-9) {
        book.positions = book.positions.filter((p) => p !== cur);
        // the venue cancels a flat position's reduce-only exits
        book.orders = book.orders.filter((o) => !(o.marketId === id && o.reduceOnly));
        if (size - closed > 1e-9) book.positions.push(pos(venue, id, dir > 0 ? "long" : "short", size - closed, px, lev, mode));
      } else {
        cur.size = left;
        for (const o of book.orders) if (o.marketId === id && o.reduceOnly) o.size = Math.min(o.size, left);
      }
    }
  }
  book.history.unshift(fill(venue, id, 0, side, size, px, pnl, text));
}
