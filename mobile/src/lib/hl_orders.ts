// Order builders for the Hyperliquid exchange API. PURE and IMPORT-FREE:
// the scoping lives in the types (tif the literal "Ioc", a reduce-only wire
// with r the literal true, an opening wire with r the literal false that
// only a single-order action may carry) and in assertScopedAction, the
// runtime twin that hl_exchange.ts runs before any signature. node --test
// loads this file straight from source.
//
// Contract (SECURITY.md): the app may emit
// reduce-only IoC orders that close or reduce an existing position; ONE
// non-reduce-only IoC order that opens the opposite side as the second leg
// of a reverse, only after the first leg proved the coin flat
// (buildReverseOpenOrder, the only place an opening wire is built); and
// cancels of the tracked wallet's own orders. Nothing here can express a
// standalone open or increase, a leverage change, a transfer or a
// withdrawal, and scripts/check-exchange-guard.js keeps it that way.

// KEY ORDER IS LOAD-BEARING: the action is msgpack-encoded in insertion
// order and that byte string is what gets hashed and signed. The wire is
// built as a literal in exactly the SDK's order a, b, p, s, r, t (then c,
// which this app never sets) and test/hl_orders.test.mjs pins the order;
// a refactor that spreads or reorders these keys changes the signed hash.
export type OrderWire = {
  a: number;            // asset id (main dex: index in meta; builder dex: 110000 + i*10000 + index)
  b: boolean;           // buy (true closes a short), sell (false closes a long)
  p: string;            // limit price cap, float_to_wire formatted
  s: string;            // size, float_to_wire formatted
  r: true;              // reduce-only, always
  t: { limit: { tif: "Ioc" } };
};

// The reverse's second leg: the same wire with r the literal false. Same
// load-bearing key order.
export type OpenWire = {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: false;
  t: { limit: { tif: "Ioc" } };
};

export type CancelWire = { a: number; o: number };

export type ExchangeAction =
  | { type: "order"; orders: OrderWire[]; grouping: "na" }
  | { type: "order"; orders: [OpenWire]; grouping: "na" }
  | { type: "cancel"; cancels: CancelWire[] };

export type AssetInfo = {
  coin: string;         // Hyperliquid coin id: "BTC" or "xyz:AAPL"
  assetId: number;
  szDecimals: number;
  dex: string;          // "" = main dex
  index: number;        // index within that dex's meta.universe
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

// Price rounding (the venue's rule): 5 significant figures, then at most (6 - szDecimals)
// decimals. Python's round() is half-even on exact ties and JS is not; under
// a 1 percent slippage cap the difference cannot matter.
export function roundPx(px: number, szDecimals: number): number {
  if (!(px > 0) || !Number.isFinite(px)) throw new Error("roundPx: bad price");
  const sig = Number(px.toPrecision(5));
  const decimals = Math.max(0, 6 - szDecimals);
  return Number(sig.toFixed(decimals));
}

// Size rounding: floor to the asset's size decimals (never round up).
export function roundSz(sz: number, szDecimals: number): number {
  if (!(sz >= 0) || !Number.isFinite(sz)) throw new Error("roundSz: bad size");
  const step = Math.pow(10, szDecimals);
  return Math.floor(sz * step + 1e-9) / step;
}

export type ClosePreview = {
  action: ExchangeAction;   // exactly the bytes that will be signed
  wire: OrderWire;
  coin: string;
  dex: string;
  side: "SELL" | "BUY";     // SELL closes a long, BUY closes a short
  size: number;
  mid: number;
  capPx: number;
  slippage: number;
  label: "reduce-only IoC";
};

export const DEFAULT_SLIPPAGE = 0.01; // price cap: 1% from mid

// A reduce-only IoC order that closes `szi` of `coin` at a price capped
// `slippage` away from `mid`. Refuses anything that is not a live position
// or whose asset row does not belong to the coin.
export function buildClosePositionOrder(
  pos: { coin: string; szi: number },
  asset: AssetInfo,
  mid: number,
  slippage: number = DEFAULT_SLIPPAGE,
): ClosePreview {
  if (asset.coin !== pos.coin) throw new Error("asset row is for " + asset.coin + ", not " + pos.coin);
  if (!Number.isFinite(pos.szi) || pos.szi === 0) throw new Error("no position to close");
  if (!(mid > 0)) throw new Error("no mid for " + pos.coin);
  if (!(slippage > 0 && slippage < 0.2)) throw new Error("slippage out of range");
  const buy = pos.szi < 0;
  const capPx = roundPx(mid * (buy ? 1 + slippage : 1 - slippage), asset.szDecimals);
  const size = roundSz(Math.abs(pos.szi), asset.szDecimals);
  if (!(size > 0)) throw new Error("position below one size step");
  const wire: OrderWire = {
    a: asset.assetId, b: buy, p: floatToWire(capPx), s: floatToWire(size), r: true,
    t: { limit: { tif: "Ioc" } },
  };
  const action: ExchangeAction = { type: "order", orders: [wire], grouping: "na" };
  assertScopedAction(action);
  return {
    action, wire, coin: pos.coin, dex: asset.dex, side: buy ? "BUY" : "SELL",
    size, mid, capPx, slippage, label: "reduce-only IoC",
  };
}

// Actions built by buildReverseOpenOrder (module-private): the runtime
// guard accepts an opening wire only inside one of these, frozen as built.
const BUILT_OPENS = new WeakSet<object>();

// ---- the reverse's gates (pure; hl_exchange.reversePosition runs them) ----

// Before leg 1: the venue must still hold the position the sheet showed -
// same side, within one size step. A position that shrank (a take-profit
// filled) or flipped since the snapshot must not size a reverse.
export function reversePreCheck(priorSzi: number, venueSzi: number, szDecimals: number): string | null {
  if (!Number.isFinite(venueSzi) || venueSzi === 0) return "the venue shows no position any more";
  if (Math.sign(venueSzi) !== Math.sign(priorSzi)) return "the position changed side since the sheet opened";
  const step = Math.pow(10, -szDecimals);
  if (Math.abs(Math.abs(venueSzi) - Math.abs(priorSzi)) > step + 1e-12) return "the position size changed since the sheet opened - refresh and try again";
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

// A passed gate (module-private registry): buildReverseOpenOrder takes only
// a pass reverseGate issued, and the size comes from the pass.
export type ReverseGatePass = { readonly ok: true; readonly size: number };
const PASSED_GATES = new WeakSet<object>();

// After leg 1: every condition for an opening order to exist, and its size -
// never more than the venue held, what leg 1 asked for, or (when leg 1 was
// unambiguous) what it filled. Never throws.
export function reverseGate(g: ReverseGateInput): ReverseGatePass | { ok: false; reason: string } {
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
  const pass: ReverseGatePass = Object.freeze({ ok: true as const, size });
  PASSED_GATES.add(pass);
  return pass;
}

export type OpenPreview = {
  action: ExchangeAction;   // the bytes that will be signed (a preview's action is display-only: the guard refuses it)
  wire: OpenWire;
  coin: string;
  dex: string;
  side: "SELL" | "BUY";     // SELL opens a short (reversing a long), BUY opens a long
  size: number;
  mid: number;
  capPx: number;
  slippage: number;
  label: "IoC open";
};

// The reverse's second leg: ONE IoC order, not reduce-only, on the side
// OPPOSITE the position that leg 1 closed. `priorSzi` is the signed size
// the venue held before leg 1; `size` is what will open, never more than
// |priorSzi|. The one place an opening wire literal is written.
function reverseOpen(
  closed: { coin: string; priorSzi: number }, size: number, asset: AssetInfo, mid: number, slippage: number,
): OpenPreview {
  if (asset.coin !== closed.coin) throw new Error("asset row is for " + asset.coin + ", not " + closed.coin);
  if (!Number.isFinite(closed.priorSzi) || closed.priorSzi === 0) throw new Error("no prior position to reverse");
  if (!(mid > 0)) throw new Error("no mid for " + closed.coin);
  if (!(slippage > 0 && slippage < 0.2)) throw new Error("slippage out of range");
  const sz = roundSz(size, asset.szDecimals);
  if (!(sz > 0)) throw new Error("nothing was closed to reverse");
  if (sz > Math.abs(closed.priorSzi) + 1e-12) throw new Error("a reverse cannot open more than the position it closed");
  const buy = closed.priorSzi < 0; // a short reverses into a long (buy); a long into a short (sell)
  const capPx = roundPx(mid * (buy ? 1 + slippage : 1 - slippage), asset.szDecimals);
  const wire: OpenWire = Object.freeze({
    a: asset.assetId, b: buy, p: floatToWire(capPx), s: floatToWire(sz), r: false,
    t: Object.freeze({ limit: Object.freeze({ tif: "Ioc" as const }) }),
  });
  const action: ExchangeAction = Object.freeze({
    type: "order" as const, orders: Object.freeze([wire]) as unknown as [OpenWire], grouping: "na" as const,
  });
  return {
    action, wire, coin: closed.coin, dex: asset.dex, side: buy ? "BUY" : "SELL",
    size: sz, mid, capPx, slippage, label: "IoC open",
  };
}

// For the confirmation sheet only: the opening leg as it would look for the
// size the close is expected to cover. NOT signable - its action is never
// registered, so assertScopedAction refuses it.
export function previewReverseOpen(
  closed: { coin: string; priorSzi: number; closedSize: number },
  asset: AssetInfo, mid: number, slippage: number = DEFAULT_SLIPPAGE,
): OpenPreview {
  return reverseOpen(closed, closed.closedSize, asset, mid, slippage);
}

// The signable opening leg. Takes only a pass reverseGate issued (proven
// flat, orders cleared, size capped); the size comes from the pass. Only
// this exact frozen action may carry an opening wire past
// assertScopedAction - a hand-built, copied or preview action is refused.
export function buildReverseOpenOrder(
  pass: ReverseGatePass,
  closed: { coin: string; priorSzi: number },
  asset: AssetInfo,
  mid: number,
  slippage: number = DEFAULT_SLIPPAGE,
): OpenPreview {
  if (!pass || !PASSED_GATES.has(pass) || pass.ok !== true) throw new Error("an opening order needs a passed reverse gate");
  const out = reverseOpen(closed, pass.size, asset, mid, slippage);
  BUILT_OPENS.add(out.action);
  assertScopedAction(out.action);
  return out;
}

export function buildCancelAction(list: { asset: AssetInfo; oid: number }[]): ExchangeAction {
  if (!list.length) throw new Error("nothing to cancel");
  const action: ExchangeAction = {
    type: "cancel",
    cancels: list.map((c) => ({ a: c.asset.assetId, o: c.oid })),
  };
  assertScopedAction(action);
  return action;
}

const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
const keysExactly = (o: object, keys: string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};

// Runtime twin of the literal types: throws unless the value is exactly one
// of the permitted shapes with no extra keys (a cloid or a builder fee
// field is refused too). An opening (r false) wire is accepted only as the
// ONLY order in its action - never batched with anything. Catches an
// `as any` cast at the last moment.
export function assertScopedAction(a: unknown): asserts a is ExchangeAction {
  if (!a || typeof a !== "object") throw new Error("action is not an object");
  const o = a as Record<string, unknown>;
  if (o.type === "order") {
    if (!keysExactly(o, ["type", "orders", "grouping"])) throw new Error("order action has unexpected keys");
    if (o.grouping !== "na") throw new Error("order grouping must be na");
    if (!Array.isArray(o.orders) || !o.orders.length) throw new Error("order action needs orders");
    for (const w of o.orders) {
      if (!w || typeof w !== "object") throw new Error("order wire is not an object");
      const ow = w as Record<string, unknown>;
      if (!keysExactly(ow, ["a", "b", "p", "s", "r", "t"])) throw new Error("order wire has unexpected keys");
      if (!isInt(ow.a)) throw new Error("order asset must be a non-negative integer");
      if (typeof ow.b !== "boolean") throw new Error("order side must be boolean");
      if (typeof ow.p !== "string" || !/^-?\d+(\.\d+)?$/.test(ow.p) || !(parseFloat(ow.p) > 0)) throw new Error("order price must be a positive decimal string");
      if (typeof ow.s !== "string" || !/^\d+(\.\d+)?$/.test(ow.s) || !(parseFloat(ow.s) > 0)) throw new Error("order size must be a positive decimal string");
      if (ow.r === false) {
        if (o.orders.length !== 1) throw new Error("an opening order must be the only order in its action");
        if (!BUILT_OPENS.has(o) || !Object.isFrozen(o) || !Object.isFrozen(o.orders) || !Object.isFrozen(ow)) {
          throw new Error("an opening order must come from buildReverseOpenOrder, unmodified");
        }
      } else if (ow.r !== true) {
        throw new Error("order reduce-only flag must be a boolean");
      }
      const t = ow.t as Record<string, unknown> | null;
      if (!t || typeof t !== "object" || !keysExactly(t, ["limit"])) throw new Error("order type must be limit");
      const lim = t.limit as Record<string, unknown> | null;
      if (!lim || typeof lim !== "object" || !keysExactly(lim, ["tif"]) || lim.tif !== "Ioc") throw new Error("order tif must be Ioc");
    }
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
  throw new Error("action type not permitted: " + String(o.type));
}

export type OrderStatus =
  | { kind: "filled"; totalSz: number; avgPx: number; oid: number }
  | { kind: "resting"; oid: number }
  | { kind: "error"; message: string }      // the venue refused this order
  | { kind: "err"; message: string }        // the venue refused the whole request
  | { kind: "malformed"; message: string };

// The exchange endpoint's answer for a single-order action.
export function parseOrderResponse(json: unknown): OrderStatus {
  if (!json || typeof json !== "object") return { kind: "malformed", message: "non-object response" };
  const o = json as Record<string, unknown>;
  if (o.status === "err") return { kind: "err", message: typeof o.response === "string" ? o.response : JSON.stringify(o.response) };
  if (o.status !== "ok") return { kind: "malformed", message: "status " + String(o.status) };
  const resp = o.response as Record<string, unknown> | undefined;
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

export type CancelStatus = { ok: number; errors: string[] } | { kind: "err"; message: string } | { kind: "malformed"; message: string };

export function parseCancelResponse(json: unknown): CancelStatus {
  if (!json || typeof json !== "object") return { kind: "malformed", message: "non-object response" };
  const o = json as Record<string, unknown>;
  if (o.status === "err") return { kind: "err", message: typeof o.response === "string" ? o.response : JSON.stringify(o.response) };
  if (o.status !== "ok") return { kind: "malformed", message: "status " + String(o.status) };
  const resp = o.response as Record<string, unknown> | undefined;
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
