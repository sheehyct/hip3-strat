// Order builders for the Hyperliquid exchange API. PURE and IMPORT-FREE:
// node --test loads this file straight from source, and hl_exchange.ts runs
// assertScopedAction (the runtime twin of the types) on every action before
// it signs anything.
//
// Contract (docs/CONTRACT.md "Allowed venue writes"): exactly four action
// types -
//   order          market-style IoC with a slippage cap, limit Gtc / Alo,
//                  reduce-only, TP / SL trigger orders on a position
//   cancel         by oid
//   modify         move a resting limit or trigger (price, size)
//   updateLeverage cross / isolated + leverage for one asset
// grouping is always "na". Nothing here can express a transfer, a
// withdrawal, an agent approval, a builder fee, a TWAP or a batch modify,
// and scripts/check-exchange-guard.js keeps it that way.
//
// KEY ORDER IS LOAD-BEARING: the action is msgpack-encoded in insertion
// order and that byte string is what gets hashed and signed. Wires are
// built as literals in exactly the SDK's order a, b, p, s, r, t, c and
// test/hl_orders.test.mjs pins the order; a refactor that spreads or
// reorders these keys changes the signed hash.
//
// Rounding (broker.py, verified live by the executor): price = 5
// significant figures, then at most (6 - szDecimals) decimals; size =
// FLOOR to szDecimals (never round up).

export type Tif = "Ioc" | "Gtc" | "Alo";
export type TpSl = "tp" | "sl";

export type LimitType = { limit: { tif: Tif } };
// A trigger order: executes as a market order (isMarket) once the mark
// crosses triggerPx. p is the limit price the triggered order carries; the
// reference broker (place_bracket) sends p = triggerPx, which the venue
// accepted live.
export type TriggerType = { trigger: { isMarket: true; triggerPx: string; tpsl: TpSl } };

export type OrderWire = {
  a: number;            // asset id (main dex: index in meta; builder dex: 110000 + i*10000 + index)
  b: boolean;           // buy
  p: string;            // price, float_to_wire formatted
  s: string;            // size, float_to_wire formatted
  r: boolean;           // reduce-only
  t: LimitType | TriggerType;
  c: string;            // cloid: 0x + 32 hex, fresh per order
};

export type CancelWire = { a: number; o: number };

export type ExchangeAction =
  | { type: "order"; orders: OrderWire[]; grouping: "na" }
  | { type: "cancel"; cancels: CancelWire[] }
  | { type: "modify"; oid: number; order: OrderWire }
  | { type: "updateLeverage"; asset: number; isCross: boolean; leverage: number };

export type AssetInfo = {
  coin: string;         // Hyperliquid coin id: "BTC" or "xyz:AAPL"
  assetId: number;
  szDecimals: number;
  dex: string;          // "" = main dex
  index: number;        // index within that dex's meta.universe
  maxLeverage: number | null;
};

// Builder-deployed perp dexs start at 110000 and step by 10000 in perpDexs
// order (the SDK's perp_dex_to_offset); the main dex is the bare index.
export function assetIdFor(builderIdx: number | null, index: number): number {
  if (!Number.isInteger(index) || index < 0) throw new Error("bad asset index");
  if (builderIdx === null) return index;
  if (!Number.isInteger(builderIdx) || builderIdx < 0) throw new Error("bad builder index");
  return 110000 + builderIdx * 10000 + index;
}

// The SDK's float_to_wire: 8 decimals, reject when that rounding changes the
// number, strip trailing zeros, "-0" -> "0".
export function floatToWire(x: number): string {
  if (!Number.isFinite(x)) throw new Error("floatToWire: not finite");
  const rounded = x.toFixed(8);
  if (Math.abs(parseFloat(rounded) - x) >= 1e-12) throw new Error("floatToWire causes rounding: " + x);
  let s = rounded;
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0") s = "0";
  return s;
}

// broker.py round_px: 5 significant figures, then at most (6 - szDecimals)
// decimals.
export function roundPx(px: number, szDecimals: number): number {
  if (!(px > 0) || !Number.isFinite(px)) throw new Error("roundPx: bad price");
  const sig = Number(px.toPrecision(5));
  const decimals = Math.max(0, 6 - szDecimals);
  return Number(sig.toFixed(decimals));
}

// broker.py round_sz: floor to the asset's size decimals (never round up).
export function roundSz(sz: number, szDecimals: number): number {
  if (!(sz >= 0) || !Number.isFinite(sz)) throw new Error("roundSz: bad size");
  const step = Math.pow(10, szDecimals);
  return Math.floor(sz * step + 1e-9) / step;
}

export const DEFAULT_SLIPPAGE = 0.01;   // 1 percent, the per-market default
export const MAX_SLIPPAGE = 0.05;       // the builder refuses above 5 percent

const CLOID_RE = /^0x[0-9a-f]{32}$/;

// A fresh client order id: 16 bytes as 0x + 32 hex. `rand` is injectable.
export function newCloid(nowMs: number, rand: () => number = Math.random): string {
  if (!Number.isFinite(nowMs)) throw new Error("bad time");
  let hex = Math.floor(nowMs).toString(16).padStart(12, "0").slice(-12);
  while (hex.length < 32) hex += Math.floor(rand() * 16).toString(16);
  return "0x" + hex.slice(0, 32);
}

function checkCommon(asset: AssetInfo, size: number, cloid: string): number {
  if (!CLOID_RE.test(cloid)) throw new Error("bad cloid");
  if (!(size > 0) || !Number.isFinite(size)) throw new Error("size must be positive");
  const sz = roundSz(size, asset.szDecimals);
  if (!(sz > 0)) throw new Error("size below one size step");
  return sz;
}

function wire(asset: AssetInfo, isBuy: boolean, px: number, sz: number, reduceOnly: boolean, t: LimitType | TriggerType, cloid: string): OrderWire {
  // Literal in the SDK's key order: a, b, p, s, r, t, c.
  return { a: asset.assetId, b: isBuy, p: floatToWire(px), s: floatToWire(sz), r: reduceOnly, t, c: cloid };
}

export type OrderPreview = {
  action: ExchangeAction;   // exactly the bytes that will be signed
  wire: OrderWire;
  coin: string;
  dex: string;
  side: "BUY" | "SELL";
  size: number;
  px: number;               // the wire price (cap for a market, limit, or trigger)
  cloid: string;
  label: string;
};

// A market-style order: IoC limit capped `slippage` away from `mid`
// (buy above, sell below). The cap is what bounds the fill; the venue
// never prices off anything else.
export function buildMarketOrder(
  asset: AssetInfo, isBuy: boolean, size: number, mid: number, slippage: number, reduceOnly: boolean, cloid: string,
): OrderPreview {
  if (!(mid > 0) || !Number.isFinite(mid)) throw new Error("no mid for " + asset.coin);
  if (!(slippage > 0) || !(slippage <= MAX_SLIPPAGE)) throw new Error("slippage out of range (0, " + MAX_SLIPPAGE * 100 + "%]");
  const sz = checkCommon(asset, size, cloid);
  const capPx = roundPx(mid * (isBuy ? 1 + slippage : 1 - slippage), asset.szDecimals);
  // The venue's price rounding must never move the cap to the wrong side of
  // mid (a buy capped below mid cannot fill): refuse instead of sending.
  if (isBuy ? capPx < mid : capPx > mid) throw new Error("price rounding leaves no room for the slippage cap on " + asset.coin);
  const w = wire(asset, isBuy, capPx, sz, reduceOnly, { limit: { tif: "Ioc" } }, cloid);
  const action: ExchangeAction = { type: "order", orders: [w], grouping: "na" };
  assertScopedAction(action);
  return { action, wire: w, coin: asset.coin, dex: asset.dex, side: isBuy ? "BUY" : "SELL", size: sz, px: capPx, cloid, label: (reduceOnly ? "reduce-only " : "") + "IoC" };
}

// A resting limit: Gtc, or Alo (post-only; the venue rejects it if it
// would take).
export function buildLimitOrder(
  asset: AssetInfo, isBuy: boolean, size: number, px: number, tif: "Gtc" | "Alo", reduceOnly: boolean, cloid: string,
): OrderPreview {
  if (!(px > 0) || !Number.isFinite(px)) throw new Error("limit price must be positive");
  if (tif !== "Gtc" && tif !== "Alo") throw new Error("limit tif must be Gtc or Alo");
  const sz = checkCommon(asset, size, cloid);
  const lp = roundPx(px, asset.szDecimals);
  const w = wire(asset, isBuy, lp, sz, reduceOnly, { limit: { tif } }, cloid);
  const action: ExchangeAction = { type: "order", orders: [w], grouping: "na" };
  assertScopedAction(action);
  return { action, wire: w, coin: asset.coin, dex: asset.dex, side: isBuy ? "BUY" : "SELL", size: sz, px: lp, cloid, label: (reduceOnly ? "reduce-only " : "") + "limit " + tif };
}

// A take-profit or stop-loss on an EXISTING position: a reduce-only trigger
// that executes as a market order once the mark crosses triggerPx. The
// triggered order's limit price p sits `slippage` THROUGH the trigger on
// the closing side (a sell's p below, a buy's p above), so a gap past the
// trigger still fills inside the cap; the reference broker sends
// p = triggerPx, which can rest unfilled on a gap (UNVERIFIED which the
// venue prefers; both are accepted shapes). `posSzi` is the venue's signed
// position size: the trigger trades the closing side and never more than
// the position. A TP sits on the profitable side of the mark and an SL on
// the losing side; the builder refuses the wrong side rather than resting
// an order that would fire at once (a null mark skips that check - callers
// pass the mark).
export function buildTriggerOrder(
  asset: AssetInfo, posSzi: number, kind: TpSl, triggerPx: number, size: number, cloid: string, mark: number | null = null,
  slippage: number = DEFAULT_SLIPPAGE,
): OrderPreview {
  if (!Number.isFinite(posSzi) || posSzi === 0) throw new Error("no position for a " + kind);
  if (!(triggerPx > 0) || !Number.isFinite(triggerPx)) throw new Error("trigger price must be positive");
  const sz = checkCommon(asset, size, cloid);
  if (sz > Math.abs(posSzi) + 1e-12) throw new Error("a " + kind + " cannot exceed the position");
  const isBuy = posSzi < 0;    // closing side
  if (mark !== null && Number.isFinite(mark) && mark > 0) {
    const long = posSzi > 0;
    const above = triggerPx > mark;
    // long: tp above mark, sl below; short: tp below, sl above
    const ok = kind === "tp" ? (long ? above : !above) : (long ? !above : above);
    if (!ok) throw new Error("a " + kind + " for a " + (long ? "long" : "short") + " must be " + ((kind === "tp") === long ? "above" : "below") + " the mark");
  }
  if (!(slippage > 0) || !(slippage <= MAX_SLIPPAGE)) throw new Error("slippage out of range (0, " + MAX_SLIPPAGE * 100 + "%]");
  const tp = roundPx(triggerPx, asset.szDecimals);
  const lim = roundPx(tp * (isBuy ? 1 + slippage : 1 - slippage), asset.szDecimals);
  const w = wire(asset, isBuy, lim, sz, true, { trigger: { isMarket: true, triggerPx: floatToWire(tp), tpsl: kind } }, cloid);
  const action: ExchangeAction = { type: "order", orders: [w], grouping: "na" };
  assertScopedAction(action);
  return { action, wire: w, coin: asset.coin, dex: asset.dex, side: isBuy ? "BUY" : "SELL", size: sz, px: tp, cloid, label: kind + " trigger (reduce-only, market)" };
}

export type ClosePreview = OrderPreview & { mid: number; slippage: number };

// A reduce-only IoC that closes `fraction` (0, 1] of a position of `szi`,
// capped `slippage` away from `mid`. The only thing it can do is reduce:
// the size never exceeds the position and the side is always the closing
// side.
export function buildClosePositionOrder(
  pos: { coin: string; szi: number }, asset: AssetInfo, mid: number, cloid: string,
  slippage: number = DEFAULT_SLIPPAGE, fraction: number = 1,
): ClosePreview {
  if (asset.coin !== pos.coin) throw new Error("asset row is for " + asset.coin + ", not " + pos.coin);
  if (!Number.isFinite(pos.szi) || pos.szi === 0) throw new Error("no position to close");
  if (!(fraction > 0) || !(fraction <= 1)) throw new Error("close fraction must be in (0, 1]");
  const buy = pos.szi < 0;
  const want = Math.abs(pos.szi) * fraction;
  const size = fraction === 1 ? Math.abs(pos.szi) : want;
  const p = buildMarketOrder(asset, buy, size, mid, slippage, true, cloid);
  if (p.size > Math.abs(pos.szi) + 1e-12) throw new Error("a close cannot exceed the position");
  return { ...p, mid, slippage, label: "reduce-only IoC close" };
}

export function buildCancelAction(list: { asset: AssetInfo; oid: number }[]): ExchangeAction {
  if (!list.length) throw new Error("nothing to cancel");
  const action: ExchangeAction = { type: "cancel", cancels: list.map((c) => ({ a: c.asset.assetId, o: c.oid })) };
  assertScopedAction(action);
  return action;
}

// modify: the resting order `oid` is replaced by `order` (same asset). The
// new wire carries its own fresh cloid.
export function buildModifyAction(oid: number, replacement: OrderPreview): ExchangeAction {
  if (!Number.isInteger(oid) || oid < 0) throw new Error("bad oid");
  const action: ExchangeAction = { type: "modify", oid, order: replacement.wire };
  assertScopedAction(action);
  return action;
}

// updateLeverage: integer leverage within the asset's maximum.
export function buildLeverageAction(asset: AssetInfo, isCross: boolean, leverage: number): ExchangeAction {
  if (!Number.isInteger(leverage) || leverage < 1) throw new Error("leverage must be a whole number >= 1");
  if (asset.maxLeverage !== null && leverage > asset.maxLeverage) throw new Error("leverage above the market's maximum " + asset.maxLeverage + "x");
  const action: ExchangeAction = { type: "updateLeverage", asset: asset.assetId, isCross, leverage };
  assertScopedAction(action);
  return action;
}

// ---- the reverse's gates (pure; hl_exchange.reversePosition runs them) ----

// Before leg 1: the venue must still hold the position the UI showed -
// same side, within one size step.
export function reversePreCheck(priorSzi: number, venueSzi: number, szDecimals: number): string | null {
  if (!Number.isFinite(venueSzi) || venueSzi === 0) return "the venue shows no position any more";
  if (Math.sign(venueSzi) !== Math.sign(priorSzi)) return "the position changed side since it was shown";
  const step = Math.pow(10, -szDecimals);
  if (Math.abs(Math.abs(venueSzi) - Math.abs(priorSzi)) > step + 1e-12) return "the position size changed since it was shown - refresh and try again";
  return null;
}

export type ReverseGateInput = {
  venueSzi: number;             // the venue's signed size read just before leg 1
  closeRequested: number;       // what leg 1 asked to close
  closeFilled: number;          // what leg 1 reports closed
  closeAmbiguous: boolean;      // a leg-1 send was ambiguous (filled then came from a re-read)
  closeResidual: number | null; // venue size after leg 1 (0 = proven flat)
  closeError: string | null;
  restingOnCoin: number | null; // open orders still on the coin after leg 1 (null = could not read)
  szDecimals: number;
};

// After leg 1: every condition for an opening order to exist, and its size -
// never more than the venue held, what leg 1 asked for, or (when leg 1 was
// unambiguous) what it filled. Never throws.
export function reverseGate(g: ReverseGateInput): { ok: true; size: number } | { ok: false; reason: string } {
  if (![g.venueSzi, g.closeRequested, g.closeFilled].every(Number.isFinite) || !Number.isInteger(g.szDecimals) || g.szDecimals < 0) {
    return { ok: false, reason: "the close figures are unreadable" };
  }
  if (!(g.closeFilled > 0)) return { ok: false, reason: "the close did not fill" };
  if (g.closeResidual === null) return { ok: false, reason: "could not prove the close flat" };
  if (g.closeResidual > 0) return { ok: false, reason: "the close was partial" };
  if (g.closeError) return { ok: false, reason: "the close finished with an error" };
  if (g.restingOnCoin === null) return { ok: false, reason: "could not confirm the coin's orders were cleared" };
  if (g.restingOnCoin > 0) return { ok: false, reason: g.restingOnCoin + " order(s) still rest on the coin" };
  let size = Math.min(g.closeRequested, Math.abs(g.venueSzi));
  if (!g.closeAmbiguous) size = Math.min(size, g.closeFilled);
  if (!(size > 0)) return { ok: false, reason: "nothing was closed to reverse" };
  size = roundSz(size, g.szDecimals);
  if (!(size > 0)) return { ok: false, reason: "nothing was closed to reverse" };
  return { ok: true, size };
}

// ---- the runtime guard ----------------------------------------------------

const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
const keysExactly = (o: object, keys: string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};
const posDec = (x: unknown): boolean => typeof x === "string" && /^\d+(\.\d+)?$/.test(x) && parseFloat(x) > 0;

function checkWire(w: unknown): void {
  if (!w || typeof w !== "object") throw new Error("order wire is not an object");
  const ow = w as Record<string, unknown>;
  if (!keysExactly(ow, ["a", "b", "p", "s", "r", "t", "c"])) throw new Error("order wire has unexpected keys");
  if (!isInt(ow.a)) throw new Error("order asset must be a non-negative integer");
  if (typeof ow.b !== "boolean") throw new Error("order side must be boolean");
  if (!posDec(ow.p)) throw new Error("order price must be a positive decimal string");
  if (!posDec(ow.s)) throw new Error("order size must be a positive decimal string");
  if (typeof ow.r !== "boolean") throw new Error("order reduce-only flag must be a boolean");
  if (typeof ow.c !== "string" || !CLOID_RE.test(ow.c)) throw new Error("order needs a cloid");
  const t = ow.t as Record<string, unknown> | null;
  if (!t || typeof t !== "object") throw new Error("order type missing");
  if (keysExactly(t, ["limit"])) {
    const lim = t.limit as Record<string, unknown> | null;
    if (!lim || typeof lim !== "object" || !keysExactly(lim, ["tif"]) || (lim.tif !== "Ioc" && lim.tif !== "Gtc" && lim.tif !== "Alo")) throw new Error("limit tif must be Ioc, Gtc or Alo");
    return;
  }
  if (keysExactly(t, ["trigger"])) {
    const tr = t.trigger as Record<string, unknown> | null;
    if (!tr || typeof tr !== "object" || !keysExactly(tr, ["isMarket", "triggerPx", "tpsl"])) throw new Error("trigger needs isMarket, triggerPx, tpsl");
    if (tr.isMarket !== true) throw new Error("trigger orders execute as market orders");
    if (!posDec(tr.triggerPx)) throw new Error("trigger price must be a positive decimal string");
    if (tr.tpsl !== "tp" && tr.tpsl !== "sl") throw new Error("trigger tpsl must be tp or sl");
    if (ow.r !== true) throw new Error("a TP / SL trigger must be reduce-only");
    return;
  }
  throw new Error("order type must be limit or trigger");
}

// Throws unless the value is exactly one of the permitted shapes with no
// extra keys (a builder fee, a vault address or a batch is refused).
export function assertScopedAction(a: unknown): asserts a is ExchangeAction {
  if (!a || typeof a !== "object") throw new Error("action is not an object");
  const o = a as Record<string, unknown>;
  if (o.type === "order") {
    if (!keysExactly(o, ["type", "orders", "grouping"])) throw new Error("order action has unexpected keys");
    if (o.grouping !== "na") throw new Error("order grouping must be na");
    if (!Array.isArray(o.orders) || o.orders.length !== 1) throw new Error("an order action carries exactly one order");
    checkWire(o.orders[0]);
    return;
  }
  if (o.type === "cancel") {
    if (!keysExactly(o, ["type", "cancels"])) throw new Error("cancel action has unexpected keys");
    if (!Array.isArray(o.cancels) || !o.cancels.length) throw new Error("cancel action needs cancels");
    for (const c of o.cancels) {
      if (!c || typeof c !== "object") throw new Error("cancel is not an object");
      const cw = c as Record<string, unknown>;
      if (!keysExactly(cw, ["a", "o"])) throw new Error("cancel has unexpected keys");
      if (!isInt(cw.a) || !isInt(cw.o)) throw new Error("cancel asset and oid must be non-negative integers");
    }
    return;
  }
  if (o.type === "modify") {
    if (!keysExactly(o, ["type", "oid", "order"])) throw new Error("modify action has unexpected keys");
    if (!isInt(o.oid)) throw new Error("modify oid must be a non-negative integer");
    checkWire(o.order);
    return;
  }
  if (o.type === "updateLeverage") {
    if (!keysExactly(o, ["type", "asset", "isCross", "leverage"])) throw new Error("updateLeverage action has unexpected keys");
    if (!isInt(o.asset)) throw new Error("updateLeverage asset must be a non-negative integer");
    if (typeof o.isCross !== "boolean") throw new Error("updateLeverage isCross must be boolean");
    if (!Number.isInteger(o.leverage) || (o.leverage as number) < 1 || (o.leverage as number) > 200) throw new Error("updateLeverage leverage must be a whole number in 1..200");
    return;
  }
  throw new Error("action type not permitted: " + String(o.type));
}

// ---- responses ------------------------------------------------------------

export type OrderStatus =
  | { kind: "filled"; totalSz: number; avgPx: number; oid: number }
  | { kind: "resting"; oid: number }
  | { kind: "error"; message: string }      // the venue refused this order
  | { kind: "err"; message: string }        // the venue refused the whole request
  | { kind: "malformed"; message: string };

function envelope(json: unknown): { kind: "err"; message: string } | { kind: "malformed"; message: string } | { ok: Record<string, unknown> } {
  if (!json || typeof json !== "object") return { kind: "malformed", message: "non-object response" };
  const o = json as Record<string, unknown>;
  if (o.status === "err") return { kind: "err", message: typeof o.response === "string" ? o.response : JSON.stringify(o.response) };
  if (o.status !== "ok") return { kind: "malformed", message: "status " + String(o.status) };
  return { ok: o };
}

// The exchange endpoint's answer for a single-order action.
export function parseOrderResponse(json: unknown): OrderStatus {
  const e = envelope(json);
  if (!("ok" in e)) return e;
  const resp = e.ok.response as Record<string, unknown> | undefined;
  const data = resp && typeof resp === "object" ? (resp.data as Record<string, unknown> | undefined) : undefined;
  const statuses = data && typeof data === "object" ? data.statuses : undefined;
  if (!Array.isArray(statuses) || !statuses.length) return { kind: "malformed", message: "no statuses" };
  const st = statuses[0] as Record<string, unknown> | string;
  if (typeof st === "string") return { kind: "malformed", message: "status " + st };
  if (st.error !== undefined) return { kind: "error", message: String(st.error) };
  if (st.filled && typeof st.filled === "object") {
    const f = st.filled as Record<string, unknown>;
    const totalSz = parseFloat(String(f.totalSz)), avgPx = parseFloat(String(f.avgPx));
    if (!Number.isFinite(totalSz) || !Number.isFinite(avgPx)) return { kind: "malformed", message: "filled status without numeric totalSz/avgPx" };
    return { kind: "filled", totalSz, avgPx, oid: Number(f.oid) };
  }
  if (st.resting && typeof st.resting === "object") {
    return { kind: "resting", oid: Number((st.resting as Record<string, unknown>).oid) };
  }
  return { kind: "malformed", message: "unknown status shape" };
}

// What an orderStatus answer means for an order this app sent. "open" = it
// can still change; "done" = it is finished and `filled` is what executed
// (a canceled or rejected order can still have a filled part: an IoC that
// matched some size before its remainder was canceled); "unrecognized" = a
// status this app does not know, which stays unknown rather than guessed.
// `sz` is the size still unfilled, `origSz` the size the order was sent with.
export type OrderFate = { fate: "open" | "done" | "unrecognized"; filled: number };

export function hlOrderFate(status: string, origSz: number, sz: number): OrderFate {
  const executed = Number.isFinite(origSz) && Number.isFinite(sz) ? Math.max(0, origSz - sz) : 0;
  if (status === "open" || status === "triggered") return { fate: "open", filled: executed };
  if (status === "filled") return { fate: "done", filled: executed > 0 ? executed : Number.isFinite(origSz) ? origSz : 0 };
  if (/cancell?ed$/i.test(status) || /rejected$/i.test(status) || status === "scheduledCancel") return { fate: "done", filled: executed };
  return { fate: "unrecognized", filled: 0 };
}

export type CancelStatus = { ok: number; errors: string[] } | { kind: "err"; message: string } | { kind: "malformed"; message: string };

export function parseCancelResponse(json: unknown): CancelStatus {
  const e = envelope(json);
  if (!("ok" in e)) return e;
  const resp = e.ok.response as Record<string, unknown> | undefined;
  const data = resp && typeof resp === "object" ? (resp.data as Record<string, unknown> | undefined) : undefined;
  const statuses = data && typeof data === "object" ? data.statuses : undefined;
  if (!Array.isArray(statuses)) return { kind: "malformed", message: "no statuses" };
  let ok = 0;
  const errors: string[] = [];
  for (const st of statuses) {
    if (st === "success") ok++;
    else if (st && typeof st === "object" && (st as Record<string, unknown>).error !== undefined) errors.push(String((st as Record<string, unknown>).error));
    else errors.push("unknown status " + JSON.stringify(st));
  }
  return { ok, errors };
}

// modify and updateLeverage answer {status: "ok", response: {type: default}}
// on success; a refused modify answers with an order-style status list.
export type SimpleStatus = { kind: "ok" } | { kind: "error"; message: string } | { kind: "err"; message: string } | { kind: "malformed"; message: string };

export function parseSimpleResponse(json: unknown): SimpleStatus {
  const e = envelope(json);
  if (!("ok" in e)) return e;
  const resp = e.ok.response as Record<string, unknown> | undefined;
  if (!resp || typeof resp !== "object") return { kind: "malformed", message: "no response" };
  const data = resp.data as Record<string, unknown> | undefined;
  const statuses = data && typeof data === "object" ? data.statuses : undefined;
  if (Array.isArray(statuses) && statuses.length) {
    const st = statuses[0] as Record<string, unknown> | string;
    if (st && typeof st === "object" && st.error !== undefined) return { kind: "error", message: String(st.error) };
  }
  return { kind: "ok" };
}
