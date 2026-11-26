// The Hyperliquid venue client: reads through hyperliquid.ts (info API,
// by the wallet address), writes through hl_exchange.ts with the agent key
// read for one call. Produces the venue-neutral shapes in types.ts.
import { chartSourceForMfp } from "./candles";
import {
  assetFor, cancelOrders, closePosition, loadAssetTable, midFor, modifyOrder, reversePosition, sendOrder, setLeverage,
  venueSize,
} from "./hl_exchange";
import { buildLimitOrder, buildMarketOrder, buildTriggerOrder, hlOrderFate, newCloid } from "./hl_orders";
import type { OrderPreview } from "./hl_orders";
import {
  fetchActiveLeverage, fetchAllMids, fetchClearinghouses, fetchFills, fetchHistoricalOrders, fetchHlMarkets, fetchOpenOrders, fetchOrderStatus, listDexes,
} from "./hyperliquid";
import type { HlMarketRow, HlOpenOrder } from "./hyperliquid";
import { hlKeyRefusal, hlTradeKey } from "./keys";
import type { OrderIntent } from "./order_policy";
import { currentSession } from "./session";
import { getSettings, marketSettings } from "./settings_store";
import type { Balance, HistoryRow, Market, OpenOrder, Position, Quote, VenueSnapshot } from "./types";
import type { ExitLeg, LeverageRead, LiveLeg, Lookup, StepFn, VenueClient, WriteOutcome, WriteRef } from "./venue";

const DEX_TTL_MS = 10 * 60_000;
const MARKETS_TTL_MS = 60_000;

let dexCache: { at: number; dexes: string[] } | null = null;
async function dexes(): Promise<string[]> {
  if (dexCache && Date.now() - dexCache.at < DEX_TTL_MS) return dexCache.dexes;
  const d = await listDexes();
  dexCache = { at: Date.now(), dexes: d };
  return d;
}

let rowsCache: { at: number; rows: HlMarketRow[] } | null = null;
export async function hlMarketRows(): Promise<HlMarketRow[]> {
  if (rowsCache && Date.now() - rowsCache.at < MARKETS_TTL_MS) return rowsCache.rows;
  const rows = await fetchHlMarkets(await dexes());
  rowsCache = { at: Date.now(), rows };
  return rows;
}
export const hlMarketRowsCached = (): HlMarketRow[] => rowsCache?.rows ?? [];

export const hlSymbol = (coin: string): string => coin.slice(coin.indexOf(":") + 1);
const key = (coin: string) => "hl:" + coin;

export function hlMarketFromRow(r: HlMarketRow): Market {
  return {
    key: key(r.coin), venue: "hl", id: r.coin, symbol: hlSymbol(r.coin), chartCoin: r.coin, chartNote: null,
    szDecimals: r.szDecimals, maxLeverage: r.maxLeverage, provider: null,
  };
}

// A trigger is a position's TP / SL only when it is reduce-only: a stop or
// take order that can open (a stop entry) is "other", never an exit.
export function hlOrderKind(o: HlOpenOrder): OpenOrder["kind"] {
  if (o.isTrigger) {
    if (!o.reduceOnly) return "other";
    if (/take profit/i.test(o.orderType)) return "tp";
    if (/stop/i.test(o.orderType)) return "sl";
    return "other";
  }
  return "limit";
}
const orderKind = hlOrderKind;

function toOpenOrder(o: HlOpenOrder): OpenOrder {
  return {
    key: "hl:" + o.oid, venue: "hl", marketId: o.coin, symbol: hlSymbol(o.coin),
    side: o.side === "B" ? "buy" : "sell", kind: orderKind(o),
    price: o.isTrigger && o.triggerPx !== null ? o.triggerPx : o.limitPx,
    size: o.sz, reduceOnly: o.reduceOnly, status: "resting", createdAt: o.timestamp || null,
    ref: { kind: "hl", dex: o.dex, oid: o.oid, cloid: o.cloid, isTrigger: o.isTrigger },
  };
}

const wallet = (): string => getSettings().wallet;

export const hlVenue: VenueClient = {
  id: "hl",

  async ready() { return /^0x[0-9a-fA-F]{40}$/.test(wallet()); },

  // No wallet, no agent key, or an agent key that was verified for another
  // wallet than the one tracked now (agent_binding.ts).
  async tradeBlocked() {
    return hlKeyRefusal();
  },

  async markets() {
    const rows = await hlMarketRows();
    return rows.filter((r) => !r.isDelisted).map(hlMarketFromRow);
  },

  async snapshot(): Promise<VenueSnapshot> {
    const address = wallet();
    const dx = await dexes();
    const [houses, rows] = await Promise.all([fetchClearinghouses(address, dx), hlMarketRows().catch(() => rowsCache?.rows ?? [])]);
    // A snapshot is all of it or nothing. One dex whose positions or orders
    // could not be read would make a position look flat or an order look
    // gone - and the pending ledger takes "not there" as proof. So a
    // partial read throws: the screen keeps the last complete read and the
    // status bar says which read failed.
    const bad = houses.findIndex((h) => !h);
    if (bad >= 0) throw new Error("positions unreadable on dex " + (dx[bad] || "main"));
    const markRow = new Map(rows.map((r) => [r.coin, r]));
    const orderLists = await Promise.all(dx.map((dex) => fetchOpenOrders(address, dex).catch(() => { throw new Error("open orders unreadable on dex " + (dex || "main")); })));
    const positions: Position[] = [];
    const mids: Record<string, number> = {};
    const chg24: Record<string, number> = {};
    for (const r of rows) {
      if (r.markPx !== null) mids[r.coin] = r.midPx ?? r.markPx;
      if (r.markPx !== null && r.prevDayPx !== null && r.prevDayPx > 0) chg24[r.coin] = ((r.markPx - r.prevDayPx) / r.prevDayPx) * 100;
    }
    let equity = 0, marginUsed = 0, available = 0, anyHouse = false;
    houses.forEach((h) => {
      if (!h) return;
      anyHouse = true;
      equity += h.accountValue; marginUsed += h.totalMarginUsed; available += h.withdrawable;
      for (const p of h.positions) {
        const row = markRow.get(p.coin);
        const mark = row?.markPx ?? (Math.abs(p.szi) > 0 ? p.positionValue / Math.abs(p.szi) : null);
        positions.push({
          key: key(p.coin), venue: "hl", marketId: p.coin, symbol: hlSymbol(p.coin), chartCoin: p.coin,
          side: p.szi > 0 ? "long" : "short", size: Math.abs(p.szi), entry: p.entryPx ?? 0, mark,
          pnl: p.unrealizedPnl, notional: p.positionValue, liq: p.liquidationPx, leverage: p.leverage,
          marginMode: p.leverageType, marginUsed: p.marginUsed,
          ref: { kind: "hl", dex: p.dex, szi: p.szi },
        });
      }
    });
    if (!anyHouse) throw new Error("clearinghouse unreadable on every dex");
    const orders: OpenOrder[] = [];
    orderLists.forEach((list) => { if (list) for (const o of list) orders.push(toOpenOrder(o)); });
    const balance: Balance = {
      venue: "hl", equity, available, marginUsed, dailyLossRoom: null, drawdownRoom: null, exposureCap: null, accountExposureCap: null,
      label: address.slice(0, 6) + "..." + address.slice(-4),
    };
    return { venue: "hl", positions, orders, balance, mids, chg24, at: Date.now() };
  },

  async history(): Promise<HistoryRow[]> {
    const address = wallet();
    const [fills, hist] = await Promise.all([fetchFills(address).catch(() => []), fetchHistoricalOrders(address).catch(() => [])]);
    const out: HistoryRow[] = fills.map((f) => ({
      key: "hl:fill:" + f.tid, venue: "hl", marketId: f.coin, symbol: hlSymbol(f.coin), time: f.time,
      side: f.side === "B" ? "buy" : "sell", size: f.sz, price: f.px, pnl: f.closedPnl, fee: f.fee,
      text: f.dir || "filled", status: "filled",
    }));
    for (const h of hist) {
      if (h.status === "filled" || h.status === "open" || h.status === "triggered") continue;
      const status: HistoryRow["status"] = h.status === "rejected" ? "rejected" : /cancel/i.test(h.status) ? "canceled" : "other";
      out.push({
        key: "hl:ord:" + h.oid, venue: "hl", marketId: h.coin, symbol: hlSymbol(h.coin), time: h.statusTimestamp || h.timestamp,
        side: h.side === "B" ? "buy" : "sell", size: h.origSz, price: h.isTrigger && h.triggerPx !== null ? h.triggerPx : h.limitPx,
        pnl: null, fee: null, text: h.status + (h.isTrigger ? " " + h.orderType.toLowerCase() : ""), status,
      });
    }
    out.sort((a, b) => b.time - a.time);
    return out.slice(0, 300);
  },

  async quote(marketId): Promise<Quote> {
    const asset = await assetFor(marketId);
    const mids = await fetchAllMids(asset.dex);
    const mid = mids[marketId] ?? null;
    return { bid: null, ask: null, mid, at: Date.now() };
  },

  async placeOrder(intent: OrderIntent, market: Market, mark: number | null, step: StepFn): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const k = await hlTradeKey();
    if (!k) return noAgentKey();
    const address = wallet();
    let asset;
    try { asset = await assetFor(market.id); } catch (e) { return { state: "rejected", message: e instanceof Error ? e.message : "unknown asset", ambiguous: false }; }
    let preview: OrderPreview;
    try {
      step("building the order");
      if (intent.type === "market") {
        const mid = mark ?? (await midFor(market.id, asset.dex));
        preview = buildMarketOrder(asset, intent.side === "buy", intent.size, mid, intent.slippage, intent.reduceOnly, newCloid(Date.now()));
      } else {
        preview = buildLimitOrder(asset, intent.side === "buy", intent.size, intent.price as number, intent.postOnly ? "Alo" : "Gtc", intent.reduceOnly, newCloid(Date.now()));
      }
    } catch (e) {
      return { state: "rejected", message: e instanceof Error ? e.message : "could not build the order", ambiguous: false };
    }
    step("sending " + preview.side + " " + preview.wire.s + " " + market.symbol + " (" + preview.label + ")");
    const res = await sendOrder(s, address, k, preview, undefined, (t, lost) => step(t, lost ? "lost" : undefined));
    const id = { ref: hlRef(preview.cloid), deadAfter: res.deadAfter, price: preview.px };
    const wantsExits = intent.tp !== null || intent.sl !== null;
    const legs: ExitLeg[] = [];
    const noLeg = (kind: "tp" | "sl", price: number, message: string): ExitLeg => ({ kind, price, state: "rejected", message, orderKey: null, ref: null, deadAfter: null });
    if (res.kind === "unknown" || (res.kind === "rejected" && res.ambiguous)) {
      // The entry's answer was lost, so no exit was sent. If the venue later
      // shows the entry filled, the position is live WITHOUT them: say so
      // now, one line per exit that was asked for.
      for (const [kind, px] of [["sl", intent.sl], ["tp", intent.tp]] as const) {
        if (px !== null) legs.push(noLeg(kind, px, "not sent: the entry's answer was lost - if the position shows, set it from the chart"));
      }
      return { state: res.kind === "unknown" ? "unknown" : "rejected", message: res.message ?? "answer lost", ambiguous: true, ...id, legs };
    }
    if (res.kind === "rejected") return { state: "rejected", message: res.message, ambiguous: false, ...id };
    if (res.kind === "resting") {
      // A resting limit cannot carry position triggers on Hyperliquid: say
      // so for each exit that was asked for, never drop it silently.
      for (const [kind, px] of [["sl", intent.sl], ["tp", intent.tp]] as const) {
        if (px !== null) legs.push(noLeg(kind, px, "a resting Hyperliquid limit cannot carry exits - set it from the chart once the order fills"));
      }
      return { state: "confirmed", message: "resting (oid " + res.oid + ")", ambiguous: res.ambiguous, orderKey: res.oid !== null ? "hl:" + res.oid : null, ...id, legs };
    }
    const short = res.filledSz < preview.size - Math.pow(10, -asset.szDecimals) / 2;
    const note = "filled " + res.filledSz + (short ? " of " + preview.size : "") + (res.avgPx ? " at " + res.avgPx : "");
    // Attached exits: only on a FILLED entry, sized to the VENUE's position
    // after the fill (never more than it holds), checked against the live
    // mid. Each leg is reported by itself and the stop goes first: a lost
    // answer on one leg (a wait of ~20 s) must not delay the protection.
    if (wantsExits) {
      step("placing the attached exits");   // no phase: sending again, back in flight
      let szi: number | null = null, mid: number | null = null;
      try { szi = await venueSize(address, market.id, asset.dex); mid = await midFor(market.id, asset.dex); } catch { szi = null; }
      for (const [kind, px] of [["sl", intent.sl], ["tp", intent.tp]] as const) {
        if (px === null) continue;
        if (szi === null) { legs.push(noLeg(kind, px, "could not re-read the position - set it from the chart")); continue; }
        if (szi === 0 || Math.sign(szi) !== (intent.side === "buy" ? 1 : -1)) { legs.push(noLeg(kind, px, "the venue shows no " + (intent.side === "buy" ? "long" : "short"))); continue; }
        try {
          const trig = buildTriggerOrder(asset, szi, kind, px, Math.min(Math.abs(szi), res.filledSz), newCloid(Date.now()), mid, intent.slippage);
          step("placing the attached " + kind);   // sending: in flight again
          const r2 = await sendOrder(s, address, k, trig, undefined, (t, lost) => step(t, lost ? "lost" : undefined));
          if (r2.kind === "resting") legs.push({ kind, price: trig.px, state: "sent", message: null, orderKey: r2.oid !== null ? "hl:" + r2.oid : null, ref: hlRef(trig.cloid), deadAfter: r2.deadAfter });
          else if (r2.kind === "filled") legs.push(noLeg(kind, trig.px, "it executed at once instead of resting - check the position"));
          else if (r2.kind === "rejected" && !r2.ambiguous) legs.push(noLeg(kind, trig.px, r2.message ?? "refused"));
          else legs.push({ kind, price: trig.px, state: "unknown", message: r2.message ?? "answer lost", orderKey: null, ref: hlRef(trig.cloid), deadAfter: r2.deadAfter });
        } catch (e) {
          legs.push(noLeg(kind, px, e instanceof Error ? e.message : "error"));
        }
      }
    }
    return { state: "confirmed", message: note, ambiguous: res.ambiguous, filled: res.filledSz, ...id, legs };
  },

  async closePosition(pos: Position, fraction: number, slippage: number, step: StepFn): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const k = await hlTradeKey();
    if (!k) return noAgentKey();
    if (pos.ref.kind !== "hl") return { state: "rejected", message: "not a Hyperliquid position", ambiguous: false };
    const szi = await liveSzi(pos.marketId, pos.ref.dex, pos.ref.szi);
    if (szi === 0) return { state: "rejected", message: "the venue no longer shows this position; nothing was sent", ambiguous: false };
    const r = await closePosition(s, wallet(), { coin: pos.marketId, dex: pos.ref.dex, szi }, k, { cancelRest: false, slippage, fraction }, (st) => step(st.text, st.stage === "waiting" ? "lost" : undefined));
    // sized: the venue position this close was sized on and the size sent.
    // The store's own copy can be a poll old; the ledger judges on this.
    const id = { ref: r.cloid ? hlRef(r.cloid) : null, deadAfter: r.deadAfter, sized: r.requested > 0 ? { from: Math.abs(szi), size: r.requested } : null };
    if (r.ambiguous && r.filled === 0) return { state: "unknown", message: r.error ?? "answer lost; the venue still holds the position", ambiguous: true, ...id };
    if (r.error && r.filled === 0) return { state: "rejected", message: r.error, ambiguous: r.ambiguous, ...id };
    if (r.residual === null) return { state: "unknown", message: "closed " + r.filled + " but could not re-read the venue", ambiguous: true, ...id };
    // What closed: the venue's answer or the re-read, whichever shows more
    // (the one re-read can lag the fill). Judged against the size that was
    // actually SENT (rounded to the size step), not the raw fraction.
    const closed = Math.max(r.filled, Math.abs(szi) - r.residual);
    const ok = closed >= r.requested - Math.max(r.requested * 1e-6, 1e-12);
    // An IoC is finished when it answers: a short fill leaves nothing in flight.
    if (!ok) return { state: "partial", message: "partly closed " + closed + ", " + r.residual + " left (the order is finished)" + (r.error ? "; " + r.error : ""), ambiguous: r.ambiguous, ...id };
    return { state: "confirmed", message: "closed " + closed + (r.residual > 0 ? ", " + r.residual + " left" : ""), ambiguous: r.ambiguous, filled: r.filled, ...id };
  },

  async flat(pos: Position, slippage: number, step: StepFn): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const k = await hlTradeKey();
    if (!k) return noAgentKey();
    if (pos.ref.kind !== "hl") return { state: "rejected", message: "not a Hyperliquid position", ambiguous: false };
    const szi = await liveSzi(pos.marketId, pos.ref.dex, pos.ref.szi);
    if (szi === 0) return { state: "rejected", message: "the venue no longer shows this position; nothing was sent", ambiguous: false };
    const r = await closePosition(s, wallet(), { coin: pos.marketId, dex: pos.ref.dex, szi }, k, { cancelRest: true, slippage }, (st) => step(st.text, st.stage === "waiting" ? "lost" : undefined));
    const id = { deadAfter: r.deadAfter };
    if (r.ambiguous && r.filled === 0 && r.residual !== 0) return { state: "unknown", message: r.error ?? "answer lost; the venue still holds the position", ambiguous: true, ...id };
    if (r.error && r.filled === 0 && r.residual !== 0) return { state: "rejected", message: r.error, ambiguous: r.ambiguous, ...id };
    if (r.residual === null) return { state: "unknown", message: "could not re-read the venue", ambiguous: true, ...id };
    if (r.residual > 0) return { state: "partial", message: r.residual + " still open (the close is finished); orders kept", ambiguous: r.ambiguous, ...id };
    // Flat but the cancel's answer was lost: the cancel can still land. It
    // stays on the ledger as its own item until the venue shows the orders
    // gone or its payload has expired; this line only says where things are.
    if (r.cancelLive) return { state: "partial", message: "flat, but the cancel's answer was lost (" + r.cancelLive.message + ")", ambiguous: true, ...id, live: [liveCancel(r.cancelLive)] };
    // Flat but a cancel was refused: the position is gone, the orders are not.
    if (r.error) return { state: "partial", message: "flat, but orders still rest: " + r.error, ambiguous: r.ambiguous, ...id };
    return { state: "confirmed", message: "flat; " + r.cancelled + " order(s) cancelled", ambiguous: r.ambiguous, ...id };
  },

  async reverse(pos: Position, slippage: number, step: StepFn, maxNotional: number): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const k = await hlTradeKey();
    if (!k) return noAgentKey();
    if (pos.ref.kind !== "hl") return { state: "rejected", message: "not a Hyperliquid position", ambiguous: false };
    const r = await reversePosition(s, wallet(), { coin: pos.marketId, dex: pos.ref.dex, szi: pos.ref.szi }, k, maxNotional, (st) => step(st.text, st.stage === "waiting" ? "lost" : undefined), slippage);
    if (r.stopped) {
      const c = r.close;
      if (!c) return { state: "rejected", message: r.stopped, ambiguous: false };
      // The close leg ran and no opening order was sent. What the close did
      // decides: it moved the position (finished, half done), its answer
      // was lost (unknown), or the venue refused it (nothing happened).
      const moved = c.filled > 0 || (c.residual !== null && c.residual < Math.abs(pos.ref.szi));
      // Closed, not reopened. A cancel whose answer was lost is still alive:
      // it goes on the ledger as its own item and holds the market's lock.
      if (moved) return { state: "partial", message: "closed " + c.filled + "; " + r.stopped, ambiguous: c.ambiguous || c.cancelLive !== null, deadAfter: c.deadAfter, live: c.cancelLive ? [liveCancel(c.cancelLive)] : undefined };
      if (c.ambiguous) return { state: "unknown", message: r.stopped, ambiguous: true, deadAfter: c.deadAfter };
      return { state: "rejected", message: r.stopped, ambiguous: false };
    }
    const o = r.open;
    if (!o) return { state: "unknown", message: "no opening result", ambiguous: true };
    // The opening order was never built or sent: finished, half done.
    if (o.requested === 0) return { state: "partial", message: "closed; the opening order was not sent" + (o.error ? ": " + o.error : ""), ambiguous: false };
    // The venue said the opening order filled (its answer, or its status for
    // the order): a claim for the ledger to verify on the position.
    if (o.fate === "filled") {
      const shown = o.position !== null && o.position !== 0 && Math.sign(o.position) === (pos.side === "long" ? -1 : 1);
      const said = shown ? "now " + ((o.position as number) > 0 ? "long " : "short ") + Math.abs(o.position as number) : "reopened " + o.filled + " (the venue's answer)";
      return { state: "confirmed", message: said + (o.error ? "; " + o.error : ""), ambiguous: o.ambiguous, deadAfter: o.deadAfter };
    }
    // The venue has not said what the opening order did. A position on the
    // new side would not say it either: the order is asked about by its id
    // (the ledger keeps asking) and the market stays locked until it settles.
    if (o.fate === "unknown") return { state: "unknown", message: "closed; " + (o.error ?? "the opening order's answer was lost"), ambiguous: true, ref: o.cloid ? hlRef(o.cloid) : null, deadAfter: o.deadAfter };
    return { state: "partial", message: "closed, nothing reopened" + (o.error ? ": " + o.error : ""), ambiguous: o.ambiguous, deadAfter: o.deadAfter };
  },

  async cancelOrder(order: OpenOrder): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const k = await hlTradeKey();
    if (!k) return noAgentKey();
    if (order.ref.kind !== "hl") return { state: "rejected", message: "not a Hyperliquid order", ambiguous: false };
    // A failure before anything is signed is a refusal, never an unknown.
    let asset;
    try { asset = await assetFor(order.marketId); } catch (e) { return { state: "rejected", message: (e instanceof Error ? e.message : "unknown asset") + "; nothing was sent", ambiguous: false }; }
    const r = await cancelOrders(s, wallet(), k, [{ asset, oid: order.ref.oid }]);
    return { state: r.ok ? "confirmed" : "rejected", message: r.message ?? (r.ok ? "cancelled" : null), ambiguous: r.ambiguous, deadAfter: r.deadAfter };
  },

  async modifyOrder(order: OpenOrder, price: number, size: number | null, mark: number | null): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const k = await hlTradeKey();
    if (!k) return noAgentKey();
    if (order.ref.kind !== "hl") return { state: "rejected", message: "not a Hyperliquid order", ambiguous: false };
    let repl: OrderPreview;
    try {
      const asset = await assetFor(order.marketId);
      const sz = size ?? order.size;
      if (order.ref.isTrigger) {
        if (order.kind !== "tp" && order.kind !== "sl") return { state: "rejected", message: "only TP / SL triggers can be moved here", ambiguous: false };
        const szi = order.side === "sell" ? sz : -sz;   // the trigger closes: a sell trigger belongs to a long
        const m = mark ?? (await midFor(order.marketId, asset.dex));
        repl = buildTriggerOrder(asset, szi, order.kind, price, sz, newCloid(Date.now()), m, marketSettings("hl:" + order.marketId).slippage);
      } else {
        repl = buildLimitOrder(asset, order.side === "buy", sz, price, "Gtc", order.reduceOnly, newCloid(Date.now()));
      }
    } catch (e) {
      return { state: "rejected", message: e instanceof Error ? e.message : "could not build the replacement", ambiguous: false };
    }
    const r = await modifyOrder(s, wallet(), k, order.ref.oid, repl, order.ref.dex);
    return { state: r.ok ? "confirmed" : "rejected", message: r.message ?? (r.ok ? "moved to " + repl.px : null), ambiguous: r.ambiguous, ref: hlRef(repl.cloid), price: repl.px, deadAfter: r.deadAfter };
  },

  async setExit(pos: Position, kind: "tp" | "sl", price: number, existing: OpenOrder | null, mark: number | null, step?: StepFn): Promise<WriteOutcome> {
    if (existing) return this.modifyOrder(existing, price, null, mark);
    const s = currentSession();   // before any await: the session this write began in
    const k = await hlTradeKey();
    if (!k) return noAgentKey();
    if (pos.ref.kind !== "hl") return { state: "rejected", message: "not a Hyperliquid position", ambiguous: false };
    let trig: OrderPreview;
    try {
      const asset = await assetFor(pos.marketId);
      const m = mark ?? (await midFor(pos.marketId, asset.dex));
      trig = buildTriggerOrder(asset, pos.ref.szi, kind, price, pos.size, newCloid(Date.now()), m, marketSettings("hl:" + pos.marketId).slippage);
    } catch (e) {
      return { state: "rejected", message: e instanceof Error ? e.message : "could not build the " + kind, ambiguous: false };
    }
    // A lost answer is waited out inside sendOrder (about 20 s): say so, so
    // the write stops counting as in flight and Close is not held behind it.
    const r = await sendOrder(s, wallet(), k, trig, undefined, (t, lost) => step?.(t, lost ? "lost" : undefined));
    const id = { ref: hlRef(trig.cloid), price: trig.px, deadAfter: r.deadAfter };
    if (r.kind === "resting") return { state: "confirmed", message: kind + " placed at " + trig.px, ambiguous: r.ambiguous, orderKey: r.oid !== null ? "hl:" + r.oid : null, ...id };
    // A trigger that executes at once is finished: nothing rests.
    if (r.kind === "filled") return { state: "partial", message: kind + " executed at once instead of resting - check the position", ambiguous: r.ambiguous, ...id };
    if (r.kind === "rejected") return { state: "rejected", message: r.message, ambiguous: r.ambiguous, ...id };
    return { state: "unknown", message: r.message ?? "answer lost", ambiguous: true, ...id };
  },

  async cancelExit(_pos: Position, order: OpenOrder): Promise<WriteOutcome> {
    return this.cancelOrder(order);
  },

  async setLeverage(market: Market, leverage: number, isCross: boolean): Promise<WriteOutcome> {
    const s = currentSession();   // before any await: the session this write began in
    const k = await hlTradeKey();
    if (!k) return noAgentKey();
    try {
      const asset = await assetFor(market.id);
      const r = await setLeverage(s, k, asset, isCross, leverage);
      return { state: r.ok ? "confirmed" : r.ambiguous ? "unknown" : "rejected", message: r.message ?? (leverage + "x " + (isCross ? "cross" : "isolated")), ambiguous: r.ambiguous, deadAfter: r.deadAfter };
    } catch (e) {
      return { state: "rejected", message: e instanceof Error ? e.message : "leverage change failed", ambiguous: false };
    }
  },

  // The venue's own status for an order this app sent, by its cloid.
  async lookup(ref: WriteRef): Promise<Lookup> {
    if (ref.venue !== "hl") return { status: "unreadable", full: false, filled: 0, message: null };
    try {
      const h = await fetchOrderStatus(wallet(), ref.cloid);
      if (!h) return { status: "unseen", full: false, filled: 0, message: null };
      const f = hlOrderFate(h.status, h.origSz, h.sz);
      if (f.fate === "unrecognized") return { status: "unreadable", full: false, filled: 0, message: h.status };
      return { status: f.fate, full: h.status === "filled", filled: f.filled, message: h.status, resting: h.status === "open" };
    } catch {
      // A failed or malformed read is unreadable, never "the venue does not
      // know this order": only the venue's explicit unknownOid is "unseen".
      return { status: "unreadable", full: false, filled: 0, message: null };
    }
  },

  // The user's leverage and margin mode on one coin, position or not.
  async leverage(market: Market): Promise<LeverageRead | null> {
    return fetchActiveLeverage(wallet(), market.id);
  },
};

const hlRef = (cloid: string): WriteRef => ({ venue: "hl", cloid });

// No key to sign with, and why: none stored, the unlock failed, or the
// stored key is tied to another wallet than the one tracked now.
async function noAgentKey(): Promise<WriteOutcome> {
  return { state: "rejected", message: ((await hlKeyRefusal()) ?? "the Hyperliquid agent key could not be unlocked") + "; nothing was sent", ambiguous: false };
}

const liveCancel = (c: { oids: number[]; deadAfter: number | null; message: string }): LiveLeg => ({
  kind: "cancel", orderKeys: c.oids.map((oid) => "hl:" + oid), message: c.message, deadAfter: c.deadAfter,
});

// The size a close acts on: the venue's own, read now. The store's copy can
// be one poll old (a close sent just before this one may not show yet), and
// a fraction of a stale size closes more than was asked. 0 = the venue no
// longer holds that side. If the read fails the shown size is used: the
// order is reduce-only, and an exit must never wait on a read.
async function liveSzi(coin: string, dex: string, shown: number): Promise<number> {
  try {
    const v = await venueSize(wallet(), coin, dex);
    return v !== 0 && Math.sign(v) === Math.sign(shown) ? v : 0;
  } catch {
    return shown;
  }
}

// The MFP chart-source lookup needs every Hyperliquid coin id.
export async function hlCoinSet(): Promise<Set<string>> {
  return new Set((await hlMarketRows()).filter((r) => !r.isDelisted).map((r) => r.coin));
}
export const chartSource = chartSourceForMfp;
export { loadAssetTable };
