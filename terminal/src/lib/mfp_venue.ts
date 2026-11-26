// The MyFundedPerps venue client: reads on the view key (silent), writes
// on the trade key read for one call. Produces the venue-neutral shapes in
// types.ts. Markets come from the keyless public list (mfp_market_list.ts);
// their chart source is the Hyperliquid coin of the same instrument
// (candles.ts chartSourceForMfp).
//
// MFP counts GETs per key, so the poll is read in PARTS at their own pace
// (the venue's limit and this app's budget: mfp_rate.ts):
// - the book (open positions + working orders, two GETs) on every snapshot.
//   It is the read the pending ledger judges writes on, so a snapshot never
//   reuses an older book;
// - the account (balance, equity, rule room) when its copy is ACCOUNT_MS old;
// - the trading policy (the exposure caps shown) when POLICY_MS old.
// Between their reads the last good account and policy are shown. A part
// that is due but cannot be afforded this minute, or that fails, waits for
// the next snapshot; the book is never held back for it.
import { getMfpMeta } from "./agent_store";
import { chartSourceForMfp } from "./candles";
import { hlCoinSet } from "./hl_venue";
import { mfpAccountId, mfpReadKey, mfpTradeKey } from "./keys";
import {
  fetchMfpAccount, fetchMfpBook, fetchMfpFills, fetchMfpPolicy, fetchMfpQuote, fetchMfpRecentOrders, lookupMfpOrder, mfpCancelMarketOrders, mfpCancelOrder,
  mfpClosePosition, mfpModifyOrder, mfpPlaceOrder, mfpReadWait, mfpReplaceExits, mfpReversePosition,
} from "./mfp_exchange";
import { mfpListSnapshot, refreshMfpList } from "./mfp_market_list";
import type { MfpAccount, MfpEnv, MfpFill, MfpOrder, MfpPolicy, MfpPosition } from "./mfp_orders";
import { mfpEnvForKey, mfpTerminal, mfpWorking } from "./mfp_orders";
import { rateBucket } from "./mfp_rate";
import { mfpStreamLive, startMfpStream, stopMfpStream } from "./mfp_stream";
import type { OrderIntent } from "./order_policy";
import { currentSession } from "./session";
import type { Balance, HistoryRow, Market, OpenOrder, Position, Quote, VenueSnapshot } from "./types";
import { heldError, heldUntilOf } from "./venue";
import type { ExitLeg, LeverageRead, Lookup, ReadWhy, StepFn, StepPhase, VenueClient, WatchSignal, WriteOutcome, WriteRef } from "./venue";

const key = (marketId: string) => "mfp:" + marketId;

// How old the account and the policy may get before a snapshot re-reads them.
// While the account stream is live the book is read far less often
// (venue_store.ts), and the stream carries no equity or rule room: the
// account is then read every 15 s by itself (the store's balance beat).
export const ACCOUNT_MS = 30_000;
export const ACCOUNT_WATCHED_MS = 15_000;
export const POLICY_MS = 60_000;
// An account copy older than this is no longer shown as the balance.
const ACCOUNT_STALE_MS = 180_000;
// Timers run a little early or late: a part this close to due is due.
const DUE_SLACK_MS = 1_000;

// The parts kept between snapshots, for ONE account in one environment. A
// change of either starts from nothing.
// accountRead / policyRead: the read of that part that is OUT right now. A
// part is "being read" from the moment its request starts, not from when
// the answer arrives: the book's timer and the balance's timer fire together
// every 30 s, and a venue takes time to answer - without this both would
// ask for the same account (and policy) in that gap, twice a minute.
type Parts = {
  scope: string; account: MfpAccount | null; accountAt: number; accountRead: Promise<void> | null;
  policy: MfpPolicy | null; policyAt: number; policyRead: Promise<void> | null;
  fills: MfpFill[] | null; orders: MfpOrder[] | null;
};
const noParts = (scope: string): Parts => ({ scope, account: null, accountAt: 0, accountRead: null, policy: null, policyAt: 0, policyRead: null, fills: null, orders: null });
let parts: Parts = noParts("");
function partsFor(accountId: string, env: MfpEnv): Parts {
  const scope = env + "|" + accountId;
  if (parts.scope !== scope) parts = noParts(scope);
  return parts;
}
const due = (at: number, every: number, now: number): boolean => at === 0 || now - at >= every - DUE_SLACK_MS;
const accountEvery = (): number => (mfpStreamLive() ? ACCOUNT_WATCHED_MS : ACCOUNT_MS);
// Due, and not already being read.
const accountDue = (p: Parts, now: number): boolean => p.accountRead === null && due(p.accountAt, accountEvery(), now);
const policyDue = (p: Parts, now: number): boolean => p.policyRead === null && due(p.policyAt, POLICY_MS, now);

function balanceOf(p: Parts, env: MfpEnv, now: number): Balance | null {
  const a = p.account;
  if (!a || now - p.accountAt > ACCOUNT_STALE_MS) return null;
  const risk = a.risk;
  return {
    venue: "mfp",
    equity: risk?.equity ?? a.balance, available: risk?.availableBalance ?? null, marginUsed: risk?.marginUsed ?? null,
    dailyLossRoom: risk?.dailyLossRoom ?? null, drawdownRoom: risk?.maxDrawdownRoom ?? null,
    exposureCap: p.policy?.exposureCap ?? null, accountExposureCap: p.policy?.accountExposureCap ?? null,
    label: (a.accountNumber || a.name || "account") + " " + a.stage + (env === "sandbox" ? " (sandbox)" : ""),
  };
}

// Read the account and / or the policy into `p`. Each is marked as being
// read from this call until its answer (accountRead / policyRead). A failed
// read keeps the last good copy (it is tried again when next due); it never
// throws. Returns whether anything new was read.
async function readParts(p: Parts, k: string, accountId: string, cls: "background" | "settle", account: boolean, policy: boolean, at: number): Promise<boolean> {
  let got = false;
  const jobs: Promise<void>[] = [];
  if (account) {
    const job: Promise<void> = fetchMfpAccount(k, accountId, cls)
      .then((v) => { if (parts === p) { p.account = v; p.accountAt = at; got = true; } }, () => undefined)
      .then(() => { if (p.accountRead === job) p.accountRead = null; });
    p.accountRead = job;
    jobs.push(job);
  }
  if (policy) {
    const job: Promise<void> = fetchMfpPolicy(k, accountId, cls)
      .then((v) => { if (parts === p) { p.policy = v; p.policyAt = at; got = true; } }, () => undefined)
      .then(() => { if (p.policyRead === job) p.policyRead = null; });
    p.policyRead = job;
    jobs.push(job);
  }
  await Promise.all(jobs);
  return got;
}

// Which key (by its request-count bucket, never the key) and account the
// running stream was started for, and who listens to it.
let watchOn: ((signal: WatchSignal) => void) | null = null;
let watchFor = "";
async function watchIdentity(): Promise<string> {
  const k = await mfpReadKey().catch(() => null);
  const a = await mfpAccountId().catch(() => null);
  return (k ? rateBucket(k) : "") + "|" + (a ?? "");
}

// The raw venue position behind a Position (needed by the close / reverse
// gates, which compare the venue's re-read against what was shown).
const rawPositions = new Map<string, MfpPosition>();   // by position id
const rawOrders = new Map<string, MfpOrder>();         // by order id

// What an order is. An exit placed for a position says so in bracket_role
// (the spec has no "stop loss" order type: a stop is a stop_market /
// stop_limit whose bracket_role is stop_loss); the type's prefix is the
// fallback, and only for a reduce-only order: a stop / take order that can
// open (a stop-market ENTRY, as the sandbox account holds) is "other",
// never a position's exit.
export function mfpOrderKind(o: MfpOrder): OpenOrder["kind"] {
  if (o.bracketRole === "take_profit") return "tp";
  if (o.bracketRole === "stop_loss") return "sl";
  const t = (o.type ?? "").toLowerCase();
  if (t.startsWith("take")) return o.reduceOnly === true ? "tp" : "other";
  if (t.startsWith("stop")) return o.reduceOnly === true ? "sl" : "other";
  if (t === "limit") return "limit";
  if (t === "market") return "market";
  return "other";
}
const orderKind = mfpOrderKind;

function toOpenOrder(o: MfpOrder, symbolOf: (m: string) => string): OpenOrder {
  const mid = o.marketId ?? "";
  return {
    key: "mfp:" + o.id, venue: "mfp", marketId: mid, symbol: symbolOf(mid),
    side: o.side === "sell" ? "sell" : "buy", kind: orderKind(o),
    price: o.triggerPrice ?? o.price ?? 0, size: o.size ?? 0, reduceOnly: o.reduceOnly === true,
    status: o.status === "resting" || o.status === "armed" ? "resting" : "pending", createdAt: o.createdAt,
    filled: Math.max(0, o.filledSize ?? 0),
    ref: { kind: "mfp", orderId: o.id, clientOrderId: o.clientOrderId, positionId: o.positionId },
  };
}

const symbolOfMarket = (marketId: string): string => {
  const row = mfpListSnapshot().rows.find((r) => r.id === marketId);
  if (row) return row.symbol;
  const coin = marketId.slice(marketId.indexOf("|") + 1);
  return coin.replace(/USDT$|USD$/, "").replace(/^xyz:/, "");
};

async function accountOrNull(): Promise<string | null> {
  return mfpAccountId();
}

export const mfpVenue: VenueClient = {
  id: "mfp",

  async ready() { return (await mfpReadKey()) !== null && (await accountOrNull()) !== null; },

  async tradeBlocked() {
    const meta = await getMfpMeta("trade");
    if (!meta) return "no MFP trade key";
    return null;
  },

  async markets() {
    await refreshMfpList();
    const rows = mfpListSnapshot().rows;
    const hl = await hlCoinSet().catch(() => new Set<string>());
    return rows.map((r) => {
      const src = chartSourceForMfp({ provider: r.provider, coin: r.coin, symbol: r.symbol }, hl);
      return {
        key: key(r.id), venue: "mfp" as const, id: r.id, symbol: r.symbol, chartCoin: src?.coin ?? null, chartNote: src?.note ?? null,
        szDecimals: null, maxLeverage: null, provider: r.provider,
      };
    });
  },

  // At most this many order lookups per reconcile pass (each is a GET on
  // the read key): unsettled writes take turns instead of multiplying.
  maxLookups: 2,

  // The account stream (mfp_stream.ts), on the READ key. What it reports is
  // only ever "read the venue now" (or whether it can be relied on to say
  // so): no pushed frame is shown or settles a write. Returns the stop.
  watch(on) {
    watchOn = on;
    watchFor = "";
    watchIdentity().then((id) => { if (watchOn === on) watchFor = id; });
    startMfpStream({ key: mfpReadKey, account: mfpAccountId, on });
    return () => { if (watchOn === on) { watchOn = null; stopMfpStream(); } };
  },

  // Settings were saved. The stream starts over ONLY when the MFP read key
  // or its account is not the one it was started for: saving the wallet or
  // the Hyperliquid key must not drop a live stream, nor give a key the
  // venue rejected one more try.
  async rewatch() {
    const on = watchOn;
    if (!on) return;
    const id = await watchIdentity();
    if (watchOn !== on || id === watchFor) return;
    watchFor = id;
    startMfpStream({ key: mfpReadKey, account: mfpAccountId, on });
  },

  async snapshot(why: ReadWhy = "tick"): Promise<VenueSnapshot> {
    const k = await mfpReadKey();
    const accountId = await accountOrNull();
    const env = k ? mfpEnvForKey(k) : null;
    if (!k || !accountId || !env) throw new Error("no MFP view key");
    const cls = why === "settle" ? "settle" : "background";
    const t0 = Date.now();
    const p = partsFor(accountId, env);
    // The account and the policy ride along when they are due and the
    // BACKGROUND share of this minute has room for them on top of the book.
    // The book never waits for them, and they never take the room a book
    // read is given while a write is unsettled (cls "settle") - except the
    // very first account, without which there is no balance to show at all.
    let withAccount = accountDue(p, t0);
    let withPolicy = policyDue(p, t0);
    const first = !p.account && !p.accountRead;
    const partsCls = first ? cls : "background";
    if (!first && (withAccount || withPolicy) && mfpReadWait(k, 2 + (withAccount ? 1 : 0) + (withPolicy ? 1 : 0), "background") > 0) {
      withAccount = false; withPolicy = false;
    }
    const wait = mfpReadWait(k, 2 + (first ? (withAccount ? 1 : 0) + (withPolicy ? 1 : 0) : 0), cls);
    if (wait > 0) throw heldError(t0 + wait, "rate limited, next read in " + Math.ceil(wait / 1000) + " s");   // nothing was sent
    const [book] = await Promise.all([fetchMfpBook(k, accountId, cls), readParts(p, k, accountId, partsCls, withAccount, withPolicy, t0)]);
    // The first account of all may be on its way from the balance beat.
    if (!p.account && p.accountRead) await p.accountRead;
    if (!p.account) throw new Error("the account was unreadable");
    const v = { env, positions: book.positions, working: book.working };
    const hl = await hlCoinSet().catch(() => new Set<string>());
    rawPositions.clear();
    const positions: Position[] = v.positions.map((p) => {
      rawPositions.set(p.id, p);
      const src = chartSourceForMfp({ provider: p.provider, coin: p.coin, symbol: p.symbol }, hl);
      const mark = p.markPrice;
      const pnl = p.unrealizedPnl ?? (mark !== null ? (mark - p.entryPrice) * p.size * (p.side === "long" ? 1 : -1) : null);
      return {
        key: key(p.marketId), venue: "mfp", marketId: p.marketId, symbol: p.symbol || symbolOfMarket(p.marketId), chartCoin: src?.coin ?? null,
        side: p.side, size: p.size, entry: p.entryPrice, mark, pnl, notional: p.size * (mark ?? p.entryPrice), liq: p.liquidationPrice,
        leverage: p.leverage, marginMode: p.marginMode, marginUsed: null,
        ref: { kind: "mfp", positionId: p.id, accountId: p.accountId, sizeDecimals: p.sizeDecimals },
      };
    });
    rawOrders.clear();
    const orders: OpenOrder[] = [];
    for (const o of v.working) {
      if (!mfpWorking(o.status)) continue;
      rawOrders.set(o.id, o);
      orders.push(toOpenOrder(o, symbolOfMarket));
    }
    const balance = balanceOf(p, env, Date.now());
    const mids: Record<string, number> = {};
    for (const q of v.positions) if (q.markPrice !== null) mids[q.marketId] = q.markPrice;
    return { venue: "mfp", positions, orders, balance, mids, chg24: {}, at: Date.now() };
  },

  // The account and the policy alone, when either is due (the store asks
  // between book reads). null = nothing was read. Never a read of the book.
  async balance(): Promise<Balance | null> {
    const k = await mfpReadKey();
    const accountId = await accountOrNull();
    const env = k ? mfpEnvForKey(k) : null;
    if (!k || !accountId || !env) return null;
    const t0 = Date.now();
    const p = partsFor(accountId, env);
    const withAccount = accountDue(p, t0);
    const withPolicy = policyDue(p, t0);
    if (!withAccount && !withPolicy) return null;
    if (mfpReadWait(k, (withAccount ? 1 : 0) + (withPolicy ? 1 : 0)) > 0) return null;   // no room this minute: later
    if (!(await readParts(p, k, accountId, "background", withAccount, withPolicy, t0))) return null;
    return balanceOf(p, env, Date.now());
  },

  // Fills and recent orders: two GETs. A list that could not be read keeps
  // its last good rows; when neither could be read (or neither may be sent
  // yet) this throws and the store keeps the history it has.
  async history(): Promise<HistoryRow[]> {
    const k = await mfpReadKey();
    const accountId = await accountOrNull();
    const env = k ? mfpEnvForKey(k) : null;
    if (!k || !accountId || !env) return [];
    const wait = mfpReadWait(k, 2);
    if (wait > 0) throw heldError(Date.now() + wait);   // nothing was sent
    const p = partsFor(accountId, env);
    const [f, o] = await Promise.all([fetchMfpFills(k, accountId).then((v) => v, () => null), fetchMfpRecentOrders(k, accountId).then((v) => v, () => null)]);
    if (f === null && o === null) throw new Error("the history could not be read");
    if (parts === p) { if (f) p.fills = f; if (o) p.orders = o; }
    const fills = f ?? p.fills ?? [];
    const orders = o ?? p.orders ?? [];
    const out: HistoryRow[] = fills.map((f) => ({
      key: "mfp:fill:" + f.id, venue: "mfp", marketId: f.marketId ?? "", symbol: f.symbol || symbolOfMarket(f.marketId ?? ""), time: f.time ?? 0,
      side: f.side === "sell" ? "sell" : f.side === "buy" ? "buy" : null, size: f.size, price: f.price, pnl: f.realizedPnl, fee: f.fee,
      text: "filled", status: "filled",
    }));
    const fillOrderIds = new Set(fills.map((f) => f.orderId).filter((x): x is string => !!x));
    for (const o of orders) {
      if (mfpWorking(o.status) || (o.status === "filled" && fillOrderIds.has(o.id))) continue;
      const status: HistoryRow["status"] = o.status === "filled" ? "filled" : o.status === "rejected" ? "rejected" : o.status === "expired" ? "expired" : /cancel/.test(o.status) ? "canceled" : "other";
      out.push({
        key: "mfp:ord:" + o.id, venue: "mfp", marketId: o.marketId ?? "", symbol: symbolOfMarket(o.marketId ?? ""), time: o.settledAt ?? o.createdAt ?? 0,
        side: o.side === "sell" ? "sell" : "buy", size: o.size, price: o.fillPrice ?? o.price ?? o.triggerPrice, pnl: null, fee: null,
        text: o.status + (o.rejectReason ? ": " + o.rejectReason : "") + (o.type ? " " + o.type : ""), status,
      });
    }
    out.sort((a, b) => b.time - a.time);
    return out.slice(0, 300);
  },

  async quote(marketId): Promise<Quote> {
    const k = await mfpReadKey();
    if (!k) return { bid: null, ask: null, mid: null, at: Date.now() };
    const q = await fetchMfpQuote(k, marketId);
    return { ...q, at: Date.now() };
  },

  async placeOrder(intent: OrderIntent, market: Market, mark: number | null, step: StepFn): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const k = await mfpTradeKey();
    const accountId = await accountOrNull();
    if (!k || !accountId) return { state: "rejected", message: "no MFP trade key (unlock or add it in Settings)", ambiguous: false };
    let mid = mark;
    if (mid === null) mid = (await fetchMfpQuote(k, market.id)).mid;
    if (mid === null) return { state: "rejected", message: "no price for " + market.symbol, ambiguous: false };
    const r = await mfpPlaceOrder(s, k, {
      accountId, marketId: market.id, side: intent.side, type: intent.type, size: intent.size, limitPrice: intent.price,
      reduceOnly: intent.reduceOnly, leverage: intent.leverage ?? 1, marginMode: intent.marginMode ?? "cross",
      expectedPrice: mid, slippage: intent.slippage, tp: intent.tp, sl: intent.sl,
    }, (st) => step(st.text, phaseOf(st)));
    const id = { ref: mfpRef(r.clientOrderId) };
    // MFP attaches the exits itself, to the order. Every exit that was asked
    // for is tracked whatever the entry answered, short of a refusal:
    // "sent" once the entry filled (each verified on the re-read), "waiting"
    // while the entry rests, is still being placed, or its answer was lost
    // (the ledger verifies each one the moment the entry is shown filled).
    const legs = (state: "sent" | "waiting"): ExitLeg[] => {
      const out: ExitLeg[] = [];
      for (const [kind, px] of [["sl", intent.sl], ["tp", intent.tp]] as const) {
        if (px !== null) out.push({ kind, price: px, state, message: null, orderKey: null, ref: null, deadAfter: null });
      }
      return out;
    };
    if (r.kind === "filled") return { state: "confirmed", message: "filled" + (r.order?.fillPrice ? " at " + r.order.fillPrice : ""), ambiguous: r.ambiguous, filled: r.order?.size ?? null, ...id, legs: legs("sent") };
    // Finished with only a part executed: that part is a position, and the
    // exits owed for it are checked now, each by itself.
    if (r.kind === "partial") return { state: "partial", message: r.message, ambiguous: r.ambiguous, filled: r.order?.filledSize ?? null, ...id, legs: legs("sent") };
    // Resting with part of it already executed: the same, while the rest works.
    const ran = Math.max(0, r.order?.filledSize ?? 0);
    if (r.kind === "resting") return { state: "confirmed", message: ran > 0 ? "resting; " + ran + " already executed" : "resting", ambiguous: r.ambiguous, orderKey: r.order ? "mfp:" + r.order.id : null, ...id, legs: legs(ran > 0 ? "sent" : "waiting") };
    if (r.kind === "pending") return { state: "pending", message: r.message, ambiguous: r.ambiguous, ...id, legs: legs("waiting") };
    if (r.kind === "rejected") return { state: "rejected", message: r.message, ambiguous: r.ambiguous, ...id, legs: r.ambiguous ? legs("waiting") : [] };
    return { state: "unknown", message: r.message, ambiguous: true, ...id, legs: legs("waiting") };
  },

  async closePosition(pos: Position, fraction: number, slippage: number, step: StepFn): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const k = await mfpTradeKey();
    if (!k) return { state: "rejected", message: "no MFP trade key", ambiguous: false };
    if (pos.ref.kind !== "mfp") return { state: "rejected", message: "not an MFP position", ambiguous: false };
    const shown = rawPositions.get(pos.ref.positionId);
    if (!shown) return { state: "rejected", message: "position not in the last venue read - refresh", ambiguous: false };
    const r = await mfpClosePosition(s, k, shown, fraction, slippage, (st) => step(st.text, phaseOf(st)));
    if (r.stopped) return { state: "rejected", message: r.stopped, ambiguous: false };
    const c = r.close;
    if (!c) return { state: "unknown", message: "no close result", ambiguous: true };
    // sized: the venue position this close was sized on and the size sent
    // (the ledger judges on these, not on the store's possibly older copy).
    const id = { ref: c.clientOrderId ? mfpRef(c.clientOrderId) : null, sized: { from: c.basis, size: c.requested } };
    // A close that was sent and left no order record is uncertain, not refused.
    const noRecord = !c.refused && c.order === null && c.clientOrderId !== null;
    if (c.error && !c.pending && c.order?.status !== "filled") return { state: "rejected", message: c.error, ambiguous: c.ambiguous || noRecord, ...id };
    if (c.pending) return { state: "pending", message: c.error, ambiguous: c.ambiguous, ...id };
    if (c.residual === null) return { state: "unknown", message: "could not re-read the venue", ambiguous: true, ...id };
    // Judged against the size that was actually SENT (rounded to the size
    // step), not the raw fraction.
    const left = fraction === 1 ? 0 : Math.max(0, c.basis - c.requested);
    const ok = c.residual <= left + Math.min(Math.max(left * 1e-6, 1e-9), c.requested * 0.4);
    // The close order is terminal here: a short result leaves nothing in flight.
    if (!ok) return { state: "partial", message: c.residual + " still open (the close is finished)", ambiguous: c.ambiguous, ...id };
    return { state: "confirmed", message: fraction === 1 ? "flat" : "closed " + (c.basis - c.residual), ambiguous: c.ambiguous, ...id };
  },

  async flat(pos: Position, slippage: number, step: StepFn): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const r = await this.closePosition(pos, 1, slippage, step);
    // Only a CONFIRMED flat cancels the market's orders: a close still
    // pending must not have its own order (or the position's exits)
    // cancelled from under it.
    if (r.state !== "confirmed") return r;
    const k = await mfpTradeKey();
    const accountId = await accountOrNull();
    if (!k || !accountId) return { ...r, state: "partial", message: "flat, but the market's orders were not cancelled (no MFP trade key)" };
    step("cancelling the market's orders");
    const c = await mfpCancelMarketOrders(s, k, accountId, pos.marketId).catch((e) => ({ count: 0, errors: [e instanceof Error ? e.message : "cancel failed"], live: [] as string[] }));
    // Flat but a cancel's answer was lost: that cancel can still land. It
    // stays on the ledger as its own item until the venue shows the order
    // gone (MFP gives no expiry) or it is dismissed.
    if (c.live.length) {
      return {
        ...r, state: "partial", ambiguous: true, message: "flat, but a cancel's answer was lost: " + c.errors.join("; "),
        live: [{ kind: "cancel", orderKeys: c.live.map((id) => "mfp:" + id), message: "answer lost", deadAfter: null }],
      };
    }
    // Flat but a cancel was refused: the position is gone, the orders are not.
    if (c.errors.length) return { ...r, state: "partial", message: "flat, but orders still rest: " + c.errors.join("; ") };
    return { ...r, message: "flat; " + c.count + " order(s) cancelled" };
  },

  async reverse(pos: Position, slippage: number, step: StepFn, maxNotional: number): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const k = await mfpTradeKey();
    if (!k) return { state: "rejected", message: "no MFP trade key", ambiguous: false };
    if (pos.ref.kind !== "mfp") return { state: "rejected", message: "not an MFP position", ambiguous: false };
    const shown = rawPositions.get(pos.ref.positionId);
    if (!shown) return { state: "rejected", message: "position not in the last venue read - refresh", ambiguous: false };
    const r = await mfpReversePosition(s, k, shown, slippage, maxNotional, (st) => step(st.text, phaseOf(st)));
    if (r.stopped) {
      const c = r.close;
      if (!c) return { state: "rejected", message: r.stopped, ambiguous: false };
      // The close leg ran and no opening order was sent. What the close did
      // decides: still working on MFP, filled (half done), answer lost, or
      // refused (nothing happened).
      // A close still working on MFP is a write that is still alive: it can
      // only reduce, but it would also reduce whatever is opened next. The
      // reverse itself is over (no opposite side was ordered); the close
      // goes on the ledger as its own item and holds the market's lock.
      if (c.pending) {
        return {
          state: "partial", message: r.stopped, ambiguous: c.ambiguous,
          live: [{ kind: "close", state: c.ambiguous ? "unknown" : "sent", ref: c.clientOrderId ? mfpRef(c.clientOrderId) : null, message: c.error, deadAfter: null }],
        };
      }
      // A close that was SENT and left no order record (an unreadable answer
      // and nothing found by its id yet) is not a refusal: MFP gives no
      // expiry, so it can still execute. It stays on the ledger, by its id,
      // until the venue says what happened to it or it is dismissed.
      if (!c.refused && c.order === null && c.clientOrderId !== null) {
        return {
          state: "partial", message: r.stopped, ambiguous: true,
          live: [{ kind: "close", state: "unknown", ref: mfpRef(c.clientOrderId), message: c.error ?? "the close left no order record", deadAfter: null }],
        };
      }
      if (c.order?.status === "filled" || (c.residual !== null && c.residual < shown.size)) return { state: "partial", message: "closed; " + r.stopped, ambiguous: c.ambiguous };
      if (c.ambiguous || c.residual === null) return { state: "unknown", message: r.stopped, ambiguous: true };
      return { state: "rejected", message: (c.error ? c.error + "; " : "") + r.stopped, ambiguous: false };
    }
    const o = r.open;
    if (!o) return { state: "unknown", message: "no opening result", ambiguous: true };
    // The opening order was never built or sent: finished, half done.
    if (o.clientOrderId === null) return { state: "partial", message: "closed; the opening order was not sent" + (o.error ? ": " + o.error : ""), ambiguous: false };
    // What the opening order did is taken from the ORDER (the venue's answer,
    // or its record looked up by the id this app gave it), never from the
    // position: a position on the new side says a position exists, not that
    // this order opened it.
    const ref = mfpRef(o.clientOrderId);
    const held = o.held && o.held.side !== shown.side ? "now " + o.held.side + " " + o.held.size : null;
    if (o.order?.status === "filled") return { state: "confirmed", message: (held ?? "reopened (the venue's answer)") + (o.error ? "; " + o.error : ""), ambiguous: o.ambiguous, ref };
    // Still working on MFP, or sent with no record found yet: the venue has
    // not said. The ledger asks about this order by its id until it does.
    if (o.pending) return { state: o.order ? "pending" : "unknown", message: "closed; " + (o.error ?? "the opening order is still working"), ambiguous: o.ambiguous || !o.order, ref };
    const ran = o.order ? Math.max(0, o.order.filledSize ?? 0) : 0;
    if (ran > 0) return { state: "partial", message: "closed; the opening order ended (" + (o.error ?? "not filled") + ") with " + ran + " executed - check the position", ambiguous: o.ambiguous, ref };
    return { state: "partial", message: "closed, nothing reopened" + (o.error ? ": " + o.error : ""), ambiguous: o.ambiguous, ref };
  },

  async cancelOrder(order: OpenOrder): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const k = await mfpTradeKey();
    const accountId = await accountOrNull();
    if (!k || !accountId) return { state: "rejected", message: "no MFP trade key", ambiguous: false };
    if (order.ref.kind !== "mfp") return { state: "rejected", message: "not an MFP order", ambiguous: false };
    const r = await mfpCancelOrder(s, k, accountId, order.ref.orderId);
    return { state: r.ok ? "confirmed" : "rejected", message: r.message ?? (r.ok ? "cancelled" : null), ambiguous: r.ambiguous };
  },

  async modifyOrder(order: OpenOrder, price: number, size: number | null, _mark: number | null): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const k = await mfpTradeKey();
    const accountId = await accountOrNull();
    if (!k || !accountId) return { state: "rejected", message: "no MFP trade key", ambiguous: false };
    if (order.ref.kind !== "mfp") return { state: "rejected", message: "not an MFP order", ambiguous: false };
    const r = await mfpModifyOrder(s, k, accountId, order.ref.orderId, price, size, { price: order.price, size: order.size });
    // MFP keeps the order's id through a move: the order is watched (its
    // own fate - filled, cancelled - settles the move), never taken as proof.
    // size: what the venue took the order to (it floors a size to the step).
    const took = r.size ?? null;
    return { state: r.ok ? "confirmed" : "rejected", message: r.message ?? (r.ok ? "moved to " + price + (took !== null && size !== null && took !== size ? " (size " + took + ")" : "") : null), ambiguous: r.ambiguous, price, size: took, watch: watchOf(order) };
  },

  // Position exits go through the exits batch: a place for a new leg,
  // a modify for an existing one, with the exits currently seen as the
  // stale-snapshot guard.
  async setExit(pos: Position, kind: "tp" | "sl", price: number, existing: OpenOrder | null): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const k = await mfpTradeKey();
    if (!k) return { state: "rejected", message: "no MFP trade key", ambiguous: false };
    if (pos.ref.kind !== "mfp") return { state: "rejected", message: "not an MFP position", ambiguous: false };
    const shown = rawPositions.get(pos.ref.positionId);
    if (!shown) return { state: "rejected", message: "position not in the last venue read - refresh", ambiguous: false };
    const expected = exitsOn(shown);
    const ops = existing && existing.ref.kind === "mfp"
      ? [{ kind: "modify" as const, order_id: existing.ref.orderId, price }]
      : [{ kind: "place" as const, group: kind, price, size: shown.size, execution_type: "market" as const }];
    const r = await mfpReplaceExits(s, k, shown, expected, ops);
    return { state: r.ok ? "confirmed" : r.ambiguous ? "unknown" : "rejected", message: r.message ?? kind + " at " + price, ambiguous: r.ambiguous, price, watch: existing ? watchOf(existing) : null };
  },

  async cancelExit(pos: Position, order: OpenOrder): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const k = await mfpTradeKey();
    if (!k) return { state: "rejected", message: "no MFP trade key", ambiguous: false };
    if (pos.ref.kind !== "mfp" || order.ref.kind !== "mfp") return { state: "rejected", message: "not an MFP position", ambiguous: false };
    const shown = rawPositions.get(pos.ref.positionId);
    if (!shown) {
      // The position is not in the last read: cancel the order itself, in
      // the session THIS call began in (cancelOrder() would capture the
      // session again, after the key wait - a session that may be a new one).
      const accountId = await accountOrNull();
      if (!accountId) return { state: "rejected", message: "no MFP trade key", ambiguous: false };
      const c = await mfpCancelOrder(s, k, accountId, order.ref.orderId);
      return { state: c.ok ? "confirmed" : "rejected", message: c.message ?? (c.ok ? "cancelled" : null), ambiguous: c.ambiguous };
    }
    const r = await mfpReplaceExits(s, k, shown, exitsOn(shown), [{ kind: "cancel", order_id: order.ref.orderId }]);
    return { state: r.ok ? "confirmed" : r.ambiguous ? "unknown" : "rejected", message: r.message, ambiguous: r.ambiguous };
  },

  // MFP sets leverage and margin mode per ORDER (fields on POST /v1/orders),
  // not per market: the order panel's leverage control is the next order's
  // leverage. Nothing to send here.
  async setLeverage(): Promise<WriteOutcome> {
    return { state: "confirmed", message: "MFP applies leverage per order; the panel's value goes on the next order", ambiguous: false, nothingSent: true };
  },

  // The venue's own record of an order this app sent, by its
  // client_order_id, on the view key (no fingerprint prompt).
  async lookup(ref: WriteRef): Promise<Lookup> {
    const none: Lookup = { status: "unreadable", full: false, filled: 0, message: null };
    if (ref.venue !== "mfp") return none;
    try {
      const k = await mfpReadKey();
      const accountId = await accountOrNull();
      if (!k || !accountId) return none;
      const o = await lookupMfpOrder(k, accountId, ref.clientOrderId);
      if (!o) return { ...none, status: "unseen" };
      if (!mfpTerminal(o.status)) return { ...none, status: "open", filled: Math.max(0, o.filledSize ?? 0), message: o.status, resting: o.status === "resting" || o.status === "armed" };
      const full = o.status === "filled";
      // A cancelled or expired order can have executed in part: filled_size
      // (the spec's name; not yet seen on a live payload) says how much.
      return { status: "done", full, filled: full ? o.size ?? 0 : Math.max(0, o.filledSize ?? 0), message: o.status + (o.rejectReason ? ": " + o.rejectReason : "") };
    } catch (e) {
      // held: the look was not sent (the key's budget). The store then does
      // not count it as this write's turn.
      return heldUntilOf(e) !== null ? { ...none, held: true } : none;
    }
  },

  // MFP has no per-market leverage setting to read (it is per order).
  async leverage(): Promise<LeverageRead | null> {
    return null;
  },
};

const mfpRef = (clientOrderId: string): WriteRef => ({ venue: "mfp", clientOrderId });
// The request is out and the client is only looking the order up: the write
// is no longer in flight (venue.ts StepPhase).
const phaseOf = (st: { stage: string }): StepPhase | undefined => (st.stage === "lost" ? "lost" : st.stage === "waiting" ? "placed" : undefined);
const watchOf = (o: OpenOrder): WriteRef | null => (o.ref.kind === "mfp" && o.ref.clientOrderId ? mfpRef(o.ref.clientOrderId) : null);

// The exits currently resting on a position (the stale-snapshot guard).
function exitsOn(p: MfpPosition): { orderId: string; price: number; size: number }[] {
  const out: { orderId: string; price: number; size: number }[] = [];
  for (const o of rawOrders.values()) {
    if (o.marketId !== p.marketId || o.reduceOnly !== true) continue;
    if (o.positionId && o.positionId !== p.id) continue;
    const price = o.triggerPrice ?? o.price;
    if (price === null || o.size === null) continue;
    out.push({ orderId: o.id, price, size: o.size });
  }
  return out;
}
