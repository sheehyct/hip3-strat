// Venue-neutral order policy (docs/CONTRACT.md "Order discipline"): every intent
// passes checkIntent before a venue builder sees it, and the one-click rule
// lives here too. PURE and IMPORT-FREE so node --test loads it from source.
//
// The venue builders (hl_orders.ts, mfp_orders.ts) repeat the structural
// checks they can see (slippage range, closing side, size vs position);
// this module holds the ones that need Settings and the position book.

export type VenueId = "hl" | "mfp";
export type OrderSide = "buy" | "sell";

export const DEFAULT_SLIPPAGE = 0.01;      // 1 percent
export const MAX_SLIPPAGE = 0.05;          // the builder refuses above 5 percent
export const DEFAULT_MAX_NOTIONAL = 1000;  // USD per order on a market with no setting

export type MarketSettings = {
  slippage: number;       // fraction, (0, MAX_SLIPPAGE]
  maxNotional: number;    // USD, > 0
  // Quick-size presets for THIS market, in contracts (null = use the
  // global dollar presets).
  presets: number[] | null;
};

export const DEFAULT_MARKET_SETTINGS: MarketSettings = { slippage: DEFAULT_SLIPPAGE, maxNotional: DEFAULT_MAX_NOTIONAL, presets: null };

export type OrderIntent = {
  venue: VenueId;
  marketId: string;
  side: OrderSide;
  type: "market" | "limit";
  size: number;              // base units, > 0
  price: number | null;      // limit price (limit only)
  reduceOnly: boolean;
  postOnly: boolean;         // limit only (HL Alo)
  slippage: number;          // market only: the cap, fraction
  tp: number | null;         // optional attached exits
  sl: number | null;
  leverage: number | null;   // informational: the current setting
  marginMode: "cross" | "isolated" | null;
};

export type PositionLite = { side: "long" | "short"; size: number } | null;

export type IntentCheck =
  | { ok: true; notional: number; refPx: number }
  | { ok: false; reason: string };

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

// The reference price an intent is sized at: the limit price for a limit,
// the mark (mid) for a market order.
export function refPrice(intent: OrderIntent, mark: number | null): number | null {
  if (intent.type === "limit") return fin(intent.price) && intent.price > 0 ? intent.price : null;
  return fin(mark) && mark > 0 ? mark : null;
}

// Does this intent reduce `pos` (and only reduce it)?
export function reduces(intent: { side: OrderSide; size: number }, pos: PositionLite): boolean {
  if (!pos) return false;
  const closingSide: OrderSide = pos.side === "long" ? "sell" : "buy";
  return intent.side === closingSide && intent.size <= pos.size + 1e-12;
}

// The per-market cap on anything that opens or adds exposure: an opening
// order, a moved order that is not reduce-only (at its NEW price and size),
// a reverse's opening leg (at the size and price it is about to be sent
// at). null = within the cap.
export function capRefusal(size: number, price: number, maxNotional: number): string | null {
  if (!fin(maxNotional) || !(maxNotional > 0)) return "no max notional set for this market";
  if (!fin(size) || !fin(price) || !(price > 0)) return "no size or price to check against the max notional";
  const notional = Math.abs(size) * price;
  if (notional > maxNotional + 1e-9) return "notional $" + round2(notional) + " is above this market's max $" + round2(maxNotional);
  return null;
}

export function checkIntent(
  intent: OrderIntent,
  ctx: { mark: number | null; position: PositionLite; settings: MarketSettings; szDecimals: number | null },
): IntentCheck {
  if (!fin(intent.size) || !(intent.size > 0)) return { ok: false, reason: "size must be positive" };
  if (ctx.szDecimals !== null) {
    const step = Math.pow(10, -ctx.szDecimals);
    if (intent.size < step - 1e-12) return { ok: false, reason: "size is below the market's size step (" + step + ")" };
  }
  if (intent.type === "limit") {
    if (!fin(intent.price) || !(intent.price > 0)) return { ok: false, reason: "a limit order needs a positive price" };
  } else {
    if (!fin(intent.slippage) || !(intent.slippage > 0)) return { ok: false, reason: "a market order needs a slippage cap" };
    if (intent.slippage > MAX_SLIPPAGE + 1e-12) return { ok: false, reason: "slippage above " + MAX_SLIPPAGE * 100 + "% is refused" };
    if (intent.postOnly) return { ok: false, reason: "post-only applies to limit orders" };
  }
  // What a venue cannot do is refused here, never accepted and then dropped.
  if (intent.venue === "mfp" && intent.postOnly) return { ok: false, reason: "MyFundedPerps has no post-only order" };
  if (intent.venue === "hl" && intent.type === "limit" && (intent.tp !== null || intent.sl !== null)) {
    return { ok: false, reason: "Hyperliquid cannot attach TP / SL to a limit order - set them from the chart once it fills" };
  }
  const px = refPrice(intent, ctx.mark);
  if (px === null) return { ok: false, reason: intent.type === "limit" ? "no limit price" : "no mark price to size the order" };
  const notional = intent.size * px;
  const isReduce = reduces(intent, ctx.position);
  if (intent.reduceOnly && !isReduce) {
    return { ok: false, reason: ctx.position ? "reduce-only, but this order would not reduce the " + ctx.position.side : "reduce-only, but there is no position to reduce" };
  }
  // An opening (or increasing) order is bounded by the per-market cap. A
  // pure reduction is bounded by the position instead (it can only shrink
  // exposure), so a $50k close is fine under a $1k cap.
  if (!isReduce) {
    const cap = capRefusal(intent.size, px, ctx.settings.maxNotional);
    if (cap) return { ok: false, reason: cap };
  }
  // Attached exits must sit on the right side of the reference price for
  // the position the order creates (or adds to).
  const long = intent.side === "buy";
  if (intent.tp !== null) {
    if (!fin(intent.tp) || !(intent.tp > 0)) return { ok: false, reason: "take profit must be a positive price" };
    if (long ? intent.tp <= px : intent.tp >= px) return { ok: false, reason: "take profit must be " + (long ? "above" : "below") + " the entry" };
  }
  if (intent.sl !== null) {
    if (!fin(intent.sl) || !(intent.sl > 0)) return { ok: false, reason: "stop loss must be a positive price" };
    if (long ? intent.sl >= px : intent.sl <= px) return { ok: false, reason: "stop loss must be " + (long ? "below" : "above") + " the entry" };
  }
  if (isReduce && (intent.tp !== null || intent.sl !== null)) return { ok: false, reason: "a reducing order cannot carry attached exits" };
  // An order that FLIPS the position (opposite side, larger than it) would
  // leave exits sized for the order, not the resulting position: refused.
  const flips = ctx.position !== null && ctx.position.side !== (intent.side === "buy" ? "long" : "short") && intent.size > ctx.position.size + 1e-12;
  if (flips && (intent.tp !== null || intent.sl !== null)) return { ok: false, reason: "attached exits are not allowed on an order that flips the position - close first" };
  return { ok: true, notional, refPx: px };
}

// The size that closes `fraction` of a position, floored to the market's
// size step (a 100 percent close uses the whole position, never a floored
// fragment that leaves dust).
export function closeSize(pos: { size: number }, fraction: number, szDecimals: number | null): number {
  if (!(fraction > 0) || !(fraction <= 1)) throw new Error("close fraction must be in (0, 1]");
  if (fraction === 1) return pos.size;
  const raw = pos.size * fraction;
  if (szDecimals === null) return raw;
  const step = Math.pow(10, szDecimals);
  return Math.floor(raw * step + 1e-9) / step;
}

// One-click: an OPENING order may skip the confirm sheet only with the
// toggle on and the order under the market's cap. A reducing order is
// always one tap.
export function oneClickAllowed(
  toggle: boolean, isReduce: boolean, notional: number, settings: MarketSettings,
): boolean {
  // isReduce here means the intent is reduce-only AND reduces the position
  // (venue_store forces the flag on every reducing intent).
  if (isReduce) return true;
  if (!toggle) return false;
  return fin(notional) && notional <= settings.maxNotional + 1e-9;
}

// A TP / SL level placed on a tag: 1 percent from the entry on the
// profitable / losing side.
export function defaultExitLevel(kind: "tp" | "sl", side: "long" | "short", entry: number, pct = 0.01): number {
  const up = (kind === "tp") === (side === "long");
  return entry * (up ? 1 + pct : 1 - pct);
}

// Is `price` on the correct side of the mark for a TP / SL of this position?
export function exitSideOk(kind: "tp" | "sl", side: "long" | "short", price: number, mark: number): boolean {
  const above = price > mark;
  return kind === "tp" ? (side === "long" ? above : !above) : (side === "long" ? !above : above);
}

// Dollar PnL of a position at `price` (the label on a TP / SL line).
export function pnlAt(side: "long" | "short", size: number, entry: number, price: number): number {
  const d = price - entry;
  return (side === "long" ? d : -d) * size;
}

// Size from a dollar amount at a price, floored to the size step.
export function sizeForDollars(dollars: number, px: number, szDecimals: number | null): number {
  if (!(dollars > 0) || !(px > 0)) return 0;
  const raw = dollars / px;
  if (szDecimals === null) return raw;
  const step = Math.pow(10, szDecimals);
  return Math.floor(raw * step + 1e-9) / step;
}

export function sanitizeMarketSettings(raw: unknown): MarketSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const slip = fin(o.slippage) && o.slippage > 0 && o.slippage <= MAX_SLIPPAGE ? o.slippage : DEFAULT_SLIPPAGE;
  const cap = fin(o.maxNotional) && o.maxNotional > 0 ? o.maxNotional : DEFAULT_MAX_NOTIONAL;
  let presets: number[] | null = null;
  if (Array.isArray(o.presets)) {
    const p = o.presets.filter((x): x is number => fin(x) && x > 0).slice(0, 3);
    presets = p.length ? p : null;
  }
  return { slippage: slip, maxNotional: cap, presets };
}

function round2(x: number): string {
  return (Math.round(x * 100) / 100).toLocaleString("en-US");
}
