// MyFundedPerps (MFP) request builders, gates and parsers. PURE and
// IMPORT-FREE: node --test loads this file straight from source, and
// mfp_exchange.ts runs assertMfpWrite on every write before it is sent.
//
// Contract (docs/CONTRACT.md "Allowed venue writes"): exactly five MFP
// writes -
//   order   POST   /v1/orders                       market or limit, optional attached TP / SL
//   modify  PATCH  /v1/orders/{id}                  price, optional size
//   cancel  DELETE /v1/orders/{id}
//   close   POST   /v1/positions/{id}/close         full (no size) or partial (size)
//   exits   PUT    /v1/positions/{id}/exit-orders   place / modify / cancel a position's TP / SL
// Field names come from the MFP OpenAPI tool schemas (create-order,
// modify-order, cancel-order, close-position, replace-position-exit-orders)
// and from a close verified on the live venue. expected_price is REQUIRED by
// the live API on market closes (sandbox 2026-10-17) and REFUSED by it on a
// limit order ("expected_price: is not supported for limit orders", live
// 2026-11-17): a market order carries it, a limit order never does. The
// venue never prices off expected_price. Every write carries a fresh client_order_id
// where the endpoint takes one, plus an Idempotency-Key header
// (mfp_exchange.ts), and is sent ONCE.

export type MfpEnv = "live" | "sandbox";

// The key's prefix names its environment; a key presented on the other
// host is refused by the venue, so the app never guesses.
export function mfpEnvForKey(key: string): MfpEnv | null {
  if (typeof key !== "string") return null;
  if (/^fp_live_[A-Za-z0-9_-]{24,}$/.test(key)) return "live";
  if (/^fp_test_[A-Za-z0-9_-]{24,}$/.test(key)) return "sandbox";
  return null;
}

// ---- parsed shapes (the API is beta: every field is checked) --------------

export type MfpRisk = {
  equity: number | null;
  unrealizedPnl: number | null;
  marginUsed: number | null;
  availableBalance: number | null;
  dailyLossRoom: number | null;
  maxDrawdownRoom: number | null;
  remainingProfitEquity: number | null;
  marksComplete: boolean;
};

export type MfpAccount = {
  id: string;
  accountNumber: string;
  name: string;
  stage: string;            // evaluation | funded
  status: string;           // active | passed | failed | closed
  startingBalance: number | null;
  balance: number | null;
  risk: MfpRisk | null;
};

export type MfpPosition = {
  id: string;
  accountId: string;
  marketId: string;         // "binance|BTCUSDT", "hyperliquid|xyz:AAPL"
  provider: string;
  symbol: string;
  coin: string;
  side: "long" | "short";
  size: number;             // base-asset units, always positive
  entryPrice: number;
  leverage: number;
  marginMode: "cross" | "isolated";
  liquidationPrice: number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
  sizeDecimals: number | null;
  openedAt: number | null;
};

export type MfpOrder = {
  id: string;
  clientOrderId: string | null;
  marketId: string | null;
  positionId: string | null;
  status: string;           // pending | filled | rejected | expired | resting | canceled | armed
  type: string | null;      // market | limit | stop_market | take_market | ...
  side: string;
  size: number | null;
  filledSize: number | null;   // filled_size: what executed, on an order that did not fill in one go
  price: number | null;     // limit price
  triggerPrice: number | null;
  fillPrice: number | null;
  reduceOnly: boolean | null;
  positionSideAfter: string | null;   // long | short | flat (filled orders)
  positionSizeAfter: number | null;
  rejectReason: string | null;
  createdAt: number | null;           // requested_at, epoch ms
  settledAt: number | null;           // settled_at, epoch ms (a filled order)
  takeProfitPrice: number | null;     // the exits attached to an entry
  stopLossPrice: number | null;
  bracketRole: string | null;         // take_profit | stop_loss: an exit placed for a position
};

export type MfpPolicy = {
  manualTradingBlocked: boolean;
  openingExposureRestricted: boolean;
  reduceOnlyRestricted: boolean;
  platformHalt: boolean;
  copyFollowerLocked: boolean;
  competitionOpeningRestricted: boolean;
  orderCooldownMs: number;
  executionDelayMaxMs: number;
  // limits.max_position_value_usd: the venue's ceiling on ONE position's
  // value. Not a per-market plan cap (those are not on this response).
  exposureCap: number | null;
  // maximum_total_notional_usd: the account model / size total exposure cap
  // (null when the venue has none configured).
  accountExposureCap: number | null;
};

export type MfpFill = {
  id: string;
  orderId: string | null;
  marketId: string | null;
  symbol: string;
  side: string;
  size: number | null;
  price: number | null;
  fee: number | null;
  realizedPnl: number | null;
  time: number | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
// A venue timestamp as epoch milliseconds. The spec types the order
// timestamps as plain numbers and names the unit only for some of them, so
// a value too small to be milliseconds is read as seconds.
const ms = (v: unknown): number | null => { const x = num(v); return x === null ? null : x > 0 && x < 1e11 ? x * 1000 : x; };
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// Unwrap the {data: ...} envelope every success carries.
export function mfpData(json: unknown): unknown {
  const o = obj(json);
  return o ? o.data : undefined;
}

function parseRisk(v: unknown): MfpRisk | null {
  const r = obj(v);
  if (!r) return null;
  return {
    equity: num(r.equity),
    unrealizedPnl: num(r.unrealized_pnl),
    marginUsed: num(r.margin_used),
    availableBalance: num(r.available_balance),
    dailyLossRoom: num(r.daily_loss_room),
    maxDrawdownRoom: num(r.max_drawdown_room),
    remainingProfitEquity: num(r.remaining_profit_equity),
    marksComplete: r.marks_complete === true,
  };
}

export function parseMfpAccount(v: unknown): MfpAccount | null {
  const a = obj(v);
  if (!a) return null;
  const id = str(a.id);
  if (!id) return null;
  return {
    id,
    accountNumber: str(a.account_number) ?? "",
    name: str(a.name) ?? "",
    stage: str(a.stage) ?? "",
    status: str(a.status) ?? "",
    startingBalance: num(a.starting_balance),
    balance: num(a.balance),
    risk: parseRisk(a.risk),
  };
}

// GET /v1/accounts. null = the answer is not a readable list.
export function parseMfpAccounts(json: unknown): MfpAccount[] | null {
  const d = mfpData(json);
  if (!Array.isArray(d)) return null;
  const out: MfpAccount[] = [];
  for (const x of d) {
    const a = parseMfpAccount(x);
    if (!a) return null; // one unreadable account makes the whole list untrustworthy
    out.push(a);
  }
  return out;
}

// Which account a verified key is stored for. The app trades ONE account. A
// live key must see exactly that one. A sandbox key may see more (MFP issues
// one sandbox key for every sandbox account and its scope cannot be
// changed): then the user names the account, and nothing is stored until
// they have. `wanted` null = no account named yet. Throws on every refusal.
export type MfpAccountPick =
  | { account: MfpAccount; sees: number }
  | { account: null; choose: MfpAccount[] };

export function mfpPickAccount(env: MfpEnv, list: MfpAccount[], wanted: string | null): MfpAccountPick {
  if (list.length === 0) throw new Error("this key sees no account");
  if (new Set(list.map((a) => a.id)).size !== list.length) throw new Error("the venue's account list names an account twice - not stored");
  if (list.length > 1 && env !== "sandbox") throw new Error("this key sees " + list.length + " accounts - scope it to ONE challenge account on MFP; not stored");
  if (wanted === null) return list.length === 1 ? { account: list[0], sees: 1 } : { account: null, choose: list };
  const hit = list.find((a) => a.id === wanted);
  if (!hit) throw new Error("this key does not see the account that was picked - not stored");
  return { account: hit, sees: list.length };
}

// How many rows of an account-scoped answer name ANOTHER account. A key may
// see more than one account, so the venue's own filter is not taken on
// trust: the caller treats any such row as an unreadable answer.
export function mfpForeignRows(json: unknown, accountId: string): number {
  const d = mfpData(json);
  const rows = Array.isArray(d) ? d : d !== undefined ? [d] : [];
  let n = 0;
  for (const r of rows) {
    const o = obj(r);
    if (o && typeof o.account_id === "string" && o.account_id !== accountId) n++;
  }
  return n;
}

export function parseMfpPosition(v: unknown): MfpPosition | null {
  const p = obj(v);
  if (!p) return null;
  const id = str(p.id), accountId = str(p.account_id), marketId = str(p.market_id);
  const side = p.side === "long" || p.side === "short" ? p.side : null;
  const size = num(p.size), entryPrice = num(p.entry_price), leverage = num(p.leverage);
  const marginMode = p.margin_mode === "cross" || p.margin_mode === "isolated" ? p.margin_mode : null;
  if (!id || !accountId || !marketId || !side || size === null || !(size > 0) || entryPrice === null || leverage === null || !(leverage > 0) || !marginMode) return null;
  const sd = num(p.size_decimals);
  return {
    id, accountId, marketId,
    provider: str(p.provider) ?? "",
    symbol: str(p.symbol) ?? "",
    coin: str(p.coin) ?? "",
    side, size, entryPrice, leverage, marginMode,
    liquidationPrice: num(p.liquidation_price),
    markPrice: num(p.mark_price),
    unrealizedPnl: num(p.unrealized_pnl),
    sizeDecimals: sd !== null && Number.isInteger(sd) && sd >= 0 ? sd : null,
    openedAt: num(p.opened_at),
  };
}

// GET /v1/positions (open). null = unreadable; a malformed row also makes
// the list unreadable, never silently shorter (a hidden position must not
// look flat to a gate).
export function parseMfpPositions(json: unknown): MfpPosition[] | null {
  const d = mfpData(json);
  if (!Array.isArray(d)) return null;
  const out: MfpPosition[] = [];
  for (const x of d) {
    const p = parseMfpPosition(x);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

export function parseMfpOrder(v: unknown): MfpOrder | null {
  const o = obj(v);
  if (!o) return null;
  const id = str(o.id), status = str(o.status);
  if (!id || !status) return null;
  return {
    id,
    clientOrderId: str(o.client_order_id),
    marketId: str(o.market_id),
    positionId: str(o.position_id) ?? str(o.target_position_id),
    status,
    type: str(o.type),
    side: str(o.side) ?? "",
    size: num(o.size),
    filledSize: num(o.filled_size),
    price: num(o.limit_price) ?? num(o.price),
    triggerPrice: num(o.trigger_price),
    fillPrice: num(o.fill_price),
    reduceOnly: typeof o.reduce_only === "boolean" ? o.reduce_only : null,
    positionSideAfter: str(o.position_side_after),
    positionSizeAfter: num(o.position_size_after),
    rejectReason: str(o.reject_reason) ?? str(o.cancel_reason),
    // Field names per the public OpenAPI spec (the Order schema): an order
    // has requested_at / settled_at (no created_at), carries its attached
    // exits as attached_take_profit_price / attached_stop_loss_price, and an
    // exit placed for a position says which one it is in bracket_role. The
    // older names stay as fallbacks; neither set has been seen on a live
    // payload yet.
    createdAt: ms(o.requested_at) ?? ms(o.created_at),
    settledAt: ms(o.settled_at),
    takeProfitPrice: num(o.attached_take_profit_price) ?? num(o.take_profit_price),
    stopLossPrice: num(o.attached_stop_loss_price) ?? num(o.stop_loss_price),
    bracketRole: str(o.bracket_role),
  };
}

// The client_order_id lookup (GET /v1/orders?client_order_id=) answers with
// a page; the order is the one row whose client_order_id matches. Anything
// else is "not found" (null), never a guess.
export function parseMfpOrderLookup(json: unknown, clientOrderId: string): MfpOrder | null {
  const d = mfpData(json);
  const rows = Array.isArray(d) ? d : d !== undefined ? [d] : [];
  for (const r of rows) {
    const o = parseMfpOrder(r);
    if (o && o.clientOrderId === clientOrderId) return o;
  }
  return null;
}

// GET /v1/orders?status=working: the complete bounded pending + resting set.
// null = unreadable; one malformed row makes the whole set unreadable (an
// unseen order must never look absent to a gate).
export function parseMfpWorkingOrders(json: unknown): MfpOrder[] | null {
  const d = mfpData(json);
  if (!Array.isArray(d)) return null;
  const out: MfpOrder[] = [];
  for (const x of d) {
    const o = parseMfpOrder(x);
    if (!o || !o.marketId) return null;
    out.push(o);
  }
  return out;
}

// GET /v1/orders (recent, newest first): lenient - a malformed row is
// skipped (history is display only).
export function parseMfpRecentOrders(json: unknown): MfpOrder[] {
  const d = mfpData(json);
  if (!Array.isArray(d)) return [];
  const out: MfpOrder[] = [];
  for (const x of d) {
    const o = parseMfpOrder(x);
    if (o) out.push(o);
  }
  return out;
}

// GET /v1/fills: lenient, display only. Per the public OpenAPI spec a fill
// IS a filled Order record: its `id` is the order's id (there is no
// order_id or fill_id), `size` is the executed quantity, `fill_price` the
// execution price, and its time is settled_at (requested_at when absent).
// The older guesses stay as fallbacks; a row needs only an id.
export function parseMfpFills(json: unknown): MfpFill[] {
  const d = mfpData(json);
  if (!Array.isArray(d)) return [];
  const out: MfpFill[] = [];
  for (const x of d) {
    const f = obj(x);
    if (!f) continue;
    const id = str(f.id) ?? str(f.fill_id);
    if (!id) continue;
    out.push({
      id,
      orderId: str(f.order_id) ?? id,
      marketId: str(f.market_id),
      symbol: str(f.symbol) ?? "",
      side: str(f.side) ?? "",
      size: num(f.size),
      price: num(f.fill_price) ?? num(f.price),
      fee: num(f.fee),
      realizedPnl: num(f.realized_pnl),
      time: ms(f.settled_at) ?? ms(f.requested_at) ?? ms(f.filled_at) ?? ms(f.created_at) ?? ms(f.time),
    });
  }
  return out;
}

export function parseMfpPolicy(json: unknown): MfpPolicy | null {
  const p = obj(mfpData(json));
  if (!p) return null;
  if (typeof p.manual_trading_blocked !== "boolean" || typeof p.opening_exposure_restricted !== "boolean") return null;
  const halt = obj(p.trading_halt);
  const limits = obj(p.limits);
  const competition = obj(p.competition);
  const cooldown = limits ? num(limits.order_cooldown_ms) : null;
  const delayMax = limits ? num(limits.execution_delay_max_ms) : null;
  return {
    manualTradingBlocked: p.manual_trading_blocked,
    openingExposureRestricted: p.opening_exposure_restricted,
    // Any restriction (or a missing field) blocks: only an explicit null is clear.
    reduceOnlyRestricted: p.restriction !== null,
    platformHalt: halt ? halt.platform === true : true,
    copyFollowerLocked: p.copy_follower_locked === true,
    competitionOpeningRestricted: competition !== null && competition.opening_exposure_restricted === true,
    orderCooldownMs: cooldown !== null && cooldown >= 0 ? cooldown : 1000,
    executionDelayMaxMs: delayMax !== null && delayMax >= 0 ? delayMax : 0,
    // Per the public OpenAPI spec (AccountTradingPolicy): the ceiling on one
    // position's value is limits.max_position_value_usd, and the account
    // model / size total is the TOP-LEVEL maximum_total_notional_usd (null
    // when not configured). Shown only when present.
    exposureCap: limits ? num(limits.max_position_value_usd) : null,
    accountExposureCap: num(p.maximum_total_notional_usd),
  };
}

export type MfpQuote = { bid: number | null; ask: number | null; mid: number | null };

// GET /v1/markets/{id}/quote -> bid / ask / mid (null when unavailable).
export function parseMfpQuote(json: unknown): MfpQuote {
  const q = obj(mfpData(json));
  if (!q) return { bid: null, ask: null, mid: null };
  const pos = (v: unknown) => { const x = num(v); return x !== null && x > 0 ? x : null; };
  return { bid: pos(q.bid) ?? pos(q.best_bid), ask: pos(q.ask) ?? pos(q.best_ask), mid: pos(q.mid) };
}

export function parseMfpMid(json: unknown): number | null {
  return parseMfpQuote(json).mid;
}

export type MfpError = { status: number; code: string; message: string };

// The error envelope {error: {code, message, request_id, details}}, or a
// status line. Validation details are folded into the message.
export function parseMfpError(status: number, json: unknown): MfpError {
  const e = obj(obj(json)?.error);
  const details = e && Array.isArray(e.details)
    ? e.details.map((d) => { const x = obj(d); return x ? (str(x.field) ?? "?") + ": " + (str(x.issue) ?? "?") : null; }).filter(Boolean).join("; ")
    : "";
  const message = (e && str(e.message)) || "HTTP " + status;
  return {
    status,
    code: (e && str(e.code)) || "http_" + status,
    message: details ? message + " (" + details + ")" : message,
  };
}

// A 4xx is the venue's refusal only when it carries the venue's error
// envelope ({ error: { code } }); the pass-through answers its own refusals
// in the same shape. An empty 400 written by an HTTP parser, or a proxy's
// HTML page, is not the venue saying no: the request may have gone on.
export function mfpIsRefusal(json: unknown): boolean {
  const e = obj(obj(json)?.error);
  return !!e && typeof e.code === "string" && e.code !== "";
}

// Why the account cannot open (a new or increasing order), or null when it can.
export function mfpOpeningBlocked(p: MfpPolicy | null): string | null {
  if (!p) return "the account's trading policy could not be read";
  if (p.platformHalt) return "trading is halted on the platform";
  if (p.manualTradingBlocked) return "manual trading is blocked on this account";
  if (p.reduceOnlyRestricted) return "the account is restricted to reducing orders";
  if (p.openingExposureRestricted) return "opening exposure is restricted on this account";
  if (p.competitionOpeningRestricted) return "opening exposure is restricted by a competition";
  if (p.copyFollowerLocked) return "the account is locked as a copy follower";
  return null;
}

// A terminal order needs no more polling.
export const mfpTerminal = (status: string): boolean =>
  status === "filled" || status === "rejected" || status === "expired" || status === "canceled" || status === "cancelled";

// Is this a working (resting / pending / armed) order?
export const mfpWorking = (status: string): boolean => !mfpTerminal(status);

// Is `took` what the venue makes of a requested size when it floors it to
// the market's step (the modify endpoint's rule)? The step is not known
// here, so `took` must be a floor of `requested` at its OWN last decimal:
// not above it, and less than one unit of that decimal below it. 0.123 for
// 0.12345 passes; 1 for 0.12345 (above) does not, nor 0.1 for 0.25 (more
// than one unit of its last decimal below).
export function mfpSizeFloors(requested: number, took: number): boolean {
  if (!(requested > 0) || !(took > 0)) return false;
  const eps = Math.max(Math.abs(requested), 1) * 1e-12;
  if (took > requested + eps) return false;
  let d = 0;
  while (d < 12 && Math.abs(Math.round(took * Math.pow(10, d)) / Math.pow(10, d) - took) > eps) d++;
  return requested - took < Math.pow(10, -d) - eps;
}

// Operation ids: printable ASCII, at most 128 chars, unique per intended
// operation. The caller supplies the entropy (this file stays import-free).
export type MfpOpKind = "open" | "close" | "rev-close" | "rev-open" | "modify" | "cancel" | "exits";
export function mfpOperationId(kind: MfpOpKind, nowMs: number, rand: number): string {
  if (!Number.isFinite(nowMs) || !Number.isFinite(rand)) throw new Error("bad operation id inputs");
  const r = Math.floor(Math.abs(rand) * 2 ** 52).toString(36);
  return "tt-" + kind + "-" + Math.floor(nowMs).toString(36) + "-" + r;
}

// ---- wires -----------------------------------------------------------------

export type OrderBody = {
  client_order_id: string;
  type: "market" | "limit";
  account_id: string;
  market_id: string;
  side: "buy" | "sell";
  size: number;
  leverage: number;
  margin_mode: "cross" | "isolated";
  reduce_only: boolean;
  expected_price?: number;      // market orders only: the venue refuses it on a limit
  limit_price?: number;
  slippage_tolerance_bps?: number;
  take_profit_price?: number;
  stop_loss_price?: number;
};
export type ModifyBody = { price: number; size?: number };
export type CloseBody = { client_order_id: string; type: "market"; expected_price: number; slippage_tolerance_bps: number; size?: number };
export type ExitOp =
  | { kind: "cancel"; order_id: string }
  | { kind: "modify"; order_id: string; price: number; size?: number }
  | { kind: "place"; group: "tp" | "sl"; price: number; size: number; execution_type: "market" };
export type ExitsBody = {
  expected_position_size: number;
  expected_orders: { order_id: string; price: number; size: number }[];
  operations: ExitOp[];
};

export type MfpWrite =
  | { kind: "order"; method: "POST"; path: "/v1/orders"; body: OrderBody; idempotencyKey: string }
  | { kind: "modify"; method: "PATCH"; path: string; body: ModifyBody; idempotencyKey: string }
  | { kind: "cancel"; method: "DELETE"; path: string; body: null; idempotencyKey: string }
  | { kind: "close"; method: "POST"; path: string; body: CloseBody; idempotencyKey: string }
  | { kind: "exits"; method: "PUT"; path: string; body: ExitsBody; idempotencyKey: string };

const ID_RE = /^[A-Za-z0-9_|:.-]{1,128}$/;
const OPID_RE = /^[\x21-\x7e]{1,128}$/;
const MAX_SLIPPAGE_BPS = 500;   // 5 percent

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const posNum = (x: unknown): x is number => fin(x) && x > 0;

export type MfpOrderInput = {
  accountId: string;
  marketId: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  size: number;
  limitPrice: number | null;
  reduceOnly: boolean;
  leverage: number;
  marginMode: "cross" | "isolated";
  expectedPrice: number;      // the observed mid
  slippage: number;           // fraction; market orders only
  tp: number | null;
  sl: number | null;
};

// POST /v1/orders. The attached take_profit_price / stop_loss_price go on
// the entry (MFP's "Take Profit / Stop Loss" checkbox). slippage becomes
// slippage_tolerance_bps on a market order (the venue's own cap field;
// UNVERIFIED whether the venue enforces it on the paper engine).
export function buildMfpOrder(i: MfpOrderInput, clientOrderId: string, idempotencyKey: string): MfpWrite {
  if (!ID_RE.test(i.accountId) || !ID_RE.test(i.marketId)) throw new Error("bad account or market id");
  if (!OPID_RE.test(clientOrderId) || !OPID_RE.test(idempotencyKey)) throw new Error("bad operation id");
  if (i.side !== "buy" && i.side !== "sell") throw new Error("bad side");
  if (i.type !== "market" && i.type !== "limit") throw new Error("order type must be market or limit");
  if (!posNum(i.size)) throw new Error("size must be positive");
  if (!posNum(i.expectedPrice)) throw new Error("no mid for " + i.marketId);
  if (!posNum(i.leverage)) throw new Error("leverage must be positive");
  if (i.marginMode !== "cross" && i.marginMode !== "isolated") throw new Error("bad margin mode");
  const body: OrderBody = {
    client_order_id: clientOrderId,
    type: i.type,
    account_id: i.accountId,
    market_id: i.marketId,
    side: i.side,
    size: i.size,
    leverage: i.leverage,
    margin_mode: i.marginMode,
    reduce_only: i.reduceOnly === true,
  };
  if (i.type === "limit") {
    if (!posNum(i.limitPrice)) throw new Error("a limit order needs a positive price");
    body.limit_price = i.limitPrice;   // and no expected_price: the venue refuses it on a limit
  } else {
    body.expected_price = i.expectedPrice;
    if (!(i.slippage > 0)) throw new Error("a market order needs a slippage cap");
    const bps = Math.round(i.slippage * 10000);
    if (bps > MAX_SLIPPAGE_BPS) throw new Error("slippage above 5% is refused");
    body.slippage_tolerance_bps = bps;
  }
  if (i.tp !== null) {
    if (!posNum(i.tp)) throw new Error("take profit must be positive");
    if (i.reduceOnly) throw new Error("a reducing order cannot carry attached exits");
    body.take_profit_price = i.tp;
  }
  if (i.sl !== null) {
    if (!posNum(i.sl)) throw new Error("stop loss must be positive");
    if (i.reduceOnly) throw new Error("a reducing order cannot carry attached exits");
    body.stop_loss_price = i.sl;
  }
  const write: MfpWrite = Object.freeze({ kind: "order" as const, method: "POST" as const, path: "/v1/orders" as const, body: Object.freeze(body), idempotencyKey });
  assertMfpWrite(write);
  return write;
}

// PATCH /v1/orders/{id}: a new price and optionally a new size.
export function buildMfpModify(orderId: string, price: number, size: number | null, idempotencyKey: string): MfpWrite {
  if (!ID_RE.test(orderId)) throw new Error("bad order id");
  if (!posNum(price)) throw new Error("price must be positive");
  if (!OPID_RE.test(idempotencyKey)) throw new Error("bad operation id");
  const body: ModifyBody = { price };
  if (size !== null) {
    if (!posNum(size)) throw new Error("size must be positive");
    body.size = size;
  }
  const write: MfpWrite = Object.freeze({ kind: "modify" as const, method: "PATCH" as const, path: "/v1/orders/" + encodeURIComponent(orderId), body: Object.freeze(body), idempotencyKey });
  assertMfpWrite(write);
  return write;
}

// DELETE /v1/orders/{id}.
export function buildMfpCancel(orderId: string, idempotencyKey: string): MfpWrite {
  if (!ID_RE.test(orderId)) throw new Error("bad order id");
  if (!OPID_RE.test(idempotencyKey)) throw new Error("bad operation id");
  const write: MfpWrite = Object.freeze({ kind: "cancel" as const, method: "DELETE" as const, path: "/v1/orders/" + encodeURIComponent(orderId), body: null, idempotencyKey });
  assertMfpWrite(write);
  return write;
}

// POST /v1/positions/{id}/close: a market close, full when `size` is null,
// else a partial of at most the position (the server derives the side and
// reduce-only). The observed mid is the required reference price and the
// market's slippage cap rides along as slippage_tolerance_bps (the close
// schema carries the field; every market order in this app has a cap).
export function buildMfpClose(pos: MfpPosition, mid: number, size: number | null, slippage: number, clientOrderId: string, idempotencyKey: string): MfpWrite {
  if (!ID_RE.test(pos.id)) throw new Error("bad position id");
  if (!posNum(mid)) throw new Error("no mid for " + pos.marketId);
  if (!(slippage > 0)) throw new Error("a market close needs a slippage cap");
  const bps = Math.round(slippage * 10000);
  if (bps > MAX_SLIPPAGE_BPS) throw new Error("slippage above 5% is refused");
  if (!OPID_RE.test(clientOrderId) || !OPID_RE.test(idempotencyKey)) throw new Error("bad operation id");
  const body: CloseBody = { client_order_id: clientOrderId, type: "market", expected_price: mid, slippage_tolerance_bps: bps };
  if (size !== null) {
    if (!posNum(size)) throw new Error("close size must be positive");
    if (size > pos.size + 1e-12) throw new Error("a close cannot exceed the position");
    if (Math.abs(size - pos.size) > 1e-12) body.size = size;   // exactly the position = a full close, no size
  }
  const write: MfpWrite = Object.freeze({
    kind: "close" as const, method: "POST" as const,
    path: "/v1/positions/" + encodeURIComponent(pos.id) + "/close",
    body: Object.freeze(body), idempotencyKey,
  });
  assertMfpWrite(write);
  return write;
}

// PUT /v1/positions/{id}/exit-orders: the stale-snapshot-guarded batch. The
// caller passes the exits it currently sees on the position
// (expected_orders) and the operations; a placed leg covers the full
// position and executes as a market order when hit.
export function buildMfpExits(
  pos: MfpPosition, expected: { orderId: string; price: number; size: number }[], ops: ExitOp[], idempotencyKey: string,
): MfpWrite {
  if (!ID_RE.test(pos.id)) throw new Error("bad position id");
  if (!OPID_RE.test(idempotencyKey)) throw new Error("bad operation id");
  if (!ops.length) throw new Error("no exit operations");
  for (const o of ops) {
    if (o.kind === "place") {
      if (!posNum(o.price) || !posNum(o.size)) throw new Error("exit needs a positive price and size");
      if (o.size > pos.size + 1e-12) throw new Error("an exit cannot exceed the position");
      if (o.group !== "tp" && o.group !== "sl") throw new Error("exit group must be tp or sl");
    } else if (o.kind === "modify") {
      if (!ID_RE.test(o.order_id) || !posNum(o.price)) throw new Error("bad modify");
      if (o.size !== undefined && (!posNum(o.size) || o.size > pos.size + 1e-12)) throw new Error("an exit cannot exceed the position");
    } else if (o.kind === "cancel") {
      if (!ID_RE.test(o.order_id)) throw new Error("bad cancel");
    } else {
      throw new Error("bad exit operation");
    }
  }
  const body: ExitsBody = {
    expected_position_size: pos.size,
    expected_orders: expected.map((e) => ({ order_id: e.orderId, price: e.price, size: e.size })),
    operations: ops.map((o) => (o.kind === "place" ? { kind: "place" as const, group: o.group, price: o.price, size: o.size, execution_type: "market" as const } : o.kind === "modify" ? (o.size === undefined ? { kind: "modify" as const, order_id: o.order_id, price: o.price } : { kind: "modify" as const, order_id: o.order_id, price: o.price, size: o.size }) : { kind: "cancel" as const, order_id: o.order_id })),
  };
  const write: MfpWrite = Object.freeze({
    kind: "exits" as const, method: "PUT" as const,
    path: "/v1/positions/" + encodeURIComponent(pos.id) + "/exit-orders",
    body: Object.freeze(body), idempotencyKey,
  });
  assertMfpWrite(write);
  return write;
}

// ---- the reverse's gates -------------------------------------------------

// Before leg 1: the venue still holds the position the UI showed - same
// id, same side, same size (to the position's own precision when known).
export function mfpReversePreCheck(shown: MfpPosition, venue: MfpPosition[] | null): string | null {
  if (!venue) return "the open positions could not be read";
  const now = venue.find((p) => p.id === shown.id);
  if (!now) return "the venue shows no position any more";
  if (now.side !== shown.side) return "the position changed side since it was shown";
  if (now.marketId !== shown.marketId) return "the position changed market since it was shown";
  const tol = now.sizeDecimals !== null ? Math.pow(10, -now.sizeDecimals) / 2 : 1e-12;
  if (Math.abs(now.size - shown.size) > tol) return "the position size changed since it was shown - refresh and try again";
  if (venue.some((p) => p.marketId === shown.marketId && p.id !== shown.id)) return "more than one position is open on this market";
  return null;
}

// Before leg 1: a working order on the market that is not reduce-only could
// fill into the reversed position and grow it.
export function mfpWorkingBlocksReverse(working: MfpOrder[] | null, marketId: string): string | null {
  if (!working) return "the working orders could not be read";
  const n = working.filter((o) => o.marketId === marketId && o.reduceOnly !== true).length;
  return n ? n + " working order(s) on this market could add to the reversed position - cancel them first" : null;
}

export type MfpReverseGateInput = {
  pre: MfpPosition;
  close: MfpOrder | null;
  venueAfter: MfpPosition[] | null;
  workingAfter: MfpOrder[] | null;
  policy: MfpPolicy | null;
};

// After leg 1: the close FILLED and left the market flat, the venue's own
// positions agree, nothing is still working on the market, and the account
// may open. Never throws.
export function mfpReverseGate(g: MfpReverseGateInput): { ok: true; size: number } | { ok: false; reason: string } {
  if (!g.close) return { ok: false, reason: "the close was never confirmed" };
  if (g.close.status !== "filled") return { ok: false, reason: "the close ended " + g.close.status + (g.close.rejectReason ? " (" + g.close.rejectReason + ")" : "") };
  if (g.close.positionSideAfter !== "flat") return { ok: false, reason: "the close did not leave the market flat" };
  if (g.close.positionSizeAfter !== null && g.close.positionSizeAfter !== 0) return { ok: false, reason: "the close left a residual" };
  if (!(g.pre.size > 0) || !Number.isFinite(g.pre.size)) return { ok: false, reason: "nothing was closed to reverse" };
  const tol = g.pre.sizeDecimals !== null ? Math.pow(10, -g.pre.sizeDecimals) / 2 : 1e-12;
  if (g.close.size !== null && g.close.size < g.pre.size - tol) return { ok: false, reason: "the close filled less than the position held" };
  if (!g.venueAfter) return { ok: false, reason: "could not re-read the open positions" };
  if (g.venueAfter.some((p) => p.marketId === g.pre.marketId)) return { ok: false, reason: "the venue still shows a position on this market" };
  if (!g.workingAfter) return { ok: false, reason: "could not re-read the working orders" };
  const left = g.workingAfter.filter((o) => o.marketId === g.pre.marketId).length;
  if (left) return { ok: false, reason: left + " order(s) still work on this market" };
  const blocked = mfpOpeningBlocked(g.policy);
  if (blocked) return { ok: false, reason: blocked };
  return { ok: true, size: g.pre.size };
}

// ---- the runtime guard ----------------------------------------------------

const keysExactly = (o: object, keys: string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};
const keysWithin = (o: object, required: string[], optional: string[]): boolean => {
  const k = Object.keys(o);
  return required.every((x) => k.includes(x)) && k.every((x) => required.includes(x) || optional.includes(x));
};

const ORDER_REQUIRED = ["client_order_id", "type", "account_id", "market_id", "side", "size", "leverage", "margin_mode", "reduce_only"];
const ORDER_OPTIONAL = ["expected_price", "limit_price", "slippage_tolerance_bps", "take_profit_price", "stop_loss_price"];
const ORDER_PATH = /^\/v1\/orders\/[A-Za-z0-9_%.-]{1,200}$/;

// Throws unless the value is exactly one of the five permitted writes with
// no extra keys and no field outside its documented range.
export function assertMfpWrite(w: unknown): asserts w is MfpWrite {
  const o = obj(w);
  if (!o) throw new Error("write is not an object");
  if (!keysExactly(o, ["kind", "method", "path", "body", "idempotencyKey"])) throw new Error("write has unexpected keys");
  if (typeof o.idempotencyKey !== "string" || !OPID_RE.test(o.idempotencyKey)) throw new Error("write needs an idempotency key");
  const b = obj(o.body);
  if (o.kind === "order") {
    if (o.method !== "POST" || o.path !== "/v1/orders") throw new Error("order path not permitted");
    if (!b || !keysWithin(b, ORDER_REQUIRED, ORDER_OPTIONAL)) throw new Error("order body has unexpected keys");
    if (b.type !== "market" && b.type !== "limit") throw new Error("order type must be market or limit");
    if (b.side !== "buy" && b.side !== "sell") throw new Error("order side must be buy or sell");
    if (typeof b.reduce_only !== "boolean") throw new Error("reduce_only must be boolean");
    if (!posNum(b.size) || !posNum(b.leverage)) throw new Error("order needs positive size and leverage");
    if (b.type === "market" && !posNum(b.expected_price)) throw new Error("a market order needs a positive expected_price");
    if (b.type === "limit" && "expected_price" in b) throw new Error("a limit order has no expected_price");
    if (b.margin_mode !== "cross" && b.margin_mode !== "isolated") throw new Error("bad margin mode");
    if (typeof b.client_order_id !== "string" || !OPID_RE.test(b.client_order_id)) throw new Error("order needs a client order id");
    if (b.type === "limit" && !posNum(b.limit_price)) throw new Error("a limit order needs limit_price");
    if (b.type === "market" && "limit_price" in b) throw new Error("a market order has no limit_price");
    if ("slippage_tolerance_bps" in b && (!posNum(b.slippage_tolerance_bps) || (b.slippage_tolerance_bps as number) > MAX_SLIPPAGE_BPS)) throw new Error("slippage above 5% is refused");
    if ("take_profit_price" in b && !posNum(b.take_profit_price)) throw new Error("bad take profit");
    if ("stop_loss_price" in b && !posNum(b.stop_loss_price)) throw new Error("bad stop loss");
    if (b.reduce_only === true && ("take_profit_price" in b || "stop_loss_price" in b)) throw new Error("a reducing order cannot carry attached exits");
    return;
  }
  if (o.kind === "modify") {
    if (o.method !== "PATCH" || typeof o.path !== "string" || !ORDER_PATH.test(o.path)) throw new Error("modify path not permitted");
    if (!b || !keysWithin(b, ["price"], ["size"])) throw new Error("modify body has unexpected keys");
    if (!posNum(b.price) || ("size" in b && !posNum(b.size))) throw new Error("modify needs a positive price (and size)");
    return;
  }
  if (o.kind === "cancel") {
    if (o.method !== "DELETE" || typeof o.path !== "string" || !ORDER_PATH.test(o.path)) throw new Error("cancel path not permitted");
    if (o.body !== null) throw new Error("a cancel has no body");
    return;
  }
  if (o.kind === "close") {
    if (o.method !== "POST" || typeof o.path !== "string" || !/^\/v1\/positions\/[A-Za-z0-9_%.-]{1,200}\/close$/.test(o.path)) throw new Error("close path not permitted");
    if (!b || !keysWithin(b, ["client_order_id", "type", "expected_price", "slippage_tolerance_bps"], ["size"])) throw new Error("a close carries only client_order_id, type, expected_price, slippage_tolerance_bps and an optional size");
    if (b.type !== "market") throw new Error("a close must be a market close");
    if (!posNum(b.expected_price)) throw new Error("a close needs a positive reference price");
    if (!posNum(b.slippage_tolerance_bps) || (b.slippage_tolerance_bps as number) > MAX_SLIPPAGE_BPS) throw new Error("slippage above 5% is refused");
    if ("size" in b && !posNum(b.size)) throw new Error("a partial close needs a positive size");
    if (typeof b.client_order_id !== "string" || !OPID_RE.test(b.client_order_id)) throw new Error("close needs a client order id");
    return;
  }
  if (o.kind === "exits") {
    if (o.method !== "PUT" || typeof o.path !== "string" || !/^\/v1\/positions\/[A-Za-z0-9_%.-]{1,200}\/exit-orders$/.test(o.path)) throw new Error("exits path not permitted");
    if (!b || !keysExactly(b, ["expected_position_size", "expected_orders", "operations"])) throw new Error("exits body has unexpected keys");
    if (!posNum(b.expected_position_size)) throw new Error("exits need the expected position size");
    if (!Array.isArray(b.expected_orders) || !Array.isArray(b.operations) || !b.operations.length) throw new Error("exits need expected_orders and operations");
    for (const e of b.expected_orders) {
      const x = obj(e);
      if (!x || !keysExactly(x, ["order_id", "price", "size"]) || typeof x.order_id !== "string" || !posNum(x.price) || !posNum(x.size)) throw new Error("bad expected order");
    }
    for (const op of b.operations) {
      const x = obj(op);
      if (!x) throw new Error("bad exit operation");
      if (x.kind === "cancel") { if (!keysExactly(x, ["kind", "order_id"]) || typeof x.order_id !== "string") throw new Error("bad cancel operation"); }
      else if (x.kind === "modify") { if (!keysWithin(x, ["kind", "order_id", "price"], ["size"]) || typeof x.order_id !== "string" || !posNum(x.price) || ("size" in x && !posNum(x.size))) throw new Error("bad modify operation"); }
      else if (x.kind === "place") {
        if (!keysExactly(x, ["kind", "group", "price", "size", "execution_type"])) throw new Error("bad place operation");
        if ((x.group !== "tp" && x.group !== "sl") || !posNum(x.price) || !posNum(x.size) || x.execution_type !== "market") throw new Error("bad place operation");
        if ((x.size as number) > (b.expected_position_size as number) + 1e-12) throw new Error("an exit cannot exceed the position");
      } else throw new Error("exit operation kind not permitted");
    }
    return;
  }
  throw new Error("write kind not permitted: " + String(o.kind));
}
