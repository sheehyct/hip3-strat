// MyFundedPerps (MFP) request builders, gates and parsers. PURE and
// IMPORT-FREE: node --test loads this file straight from source, and
// mfp_exchange.ts runs assertMfpWrite on every write before it is sent.
//
// Contract (SECURITY.md): the app may send exactly two
// kinds of MFP write -
// - a FULL market close of one position (POST /v1/positions/{id}/close with
//   no size; the server derives side and reduce-only), and
// - as the second leg of a reverse only, ONE market order opening the
//   opposite side for the re-read pre-close size, with leverage and margin
//   mode copied verbatim from the closed position and no attached TP/SL.
// The opening body is built in exactly one place (buildMfpReverseOpen), from
// a pass that only mfpReverseGate issues; the runtime guard accepts only that
// frozen output. scripts/check-exchange-guard.js keeps the opening flag
// literal inside this file (exactly twice: the type and the builder).

export type MfpEnv = "live" | "sandbox";

// The key's prefix names its environment; a key presented on the other
// host is refused by the venue, so the app never guesses.
export function mfpEnvForKey(key: string): MfpEnv | null {
  if (typeof key !== "string") return null;
  // Real keys carry 64 random characters; 24 is a floor that refuses
  // truncated pastes and keeps the stored key fingerprint unguessable.
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
  sizeDecimals: number | null;
  openedAt: number | null;
};

export type MfpOrder = {
  id: string;
  clientOrderId: string | null;
  marketId: string | null;
  status: string;           // pending | filled | rejected | expired | resting | canceled
  side: string;
  size: number | null;
  fillPrice: number | null;
  reduceOnly: boolean | null;
  positionSideAfter: string | null;   // long | short | flat (filled orders)
  positionSizeAfter: number | null;
  rejectReason: string | null;
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
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
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
    sizeDecimals: sd !== null && Number.isInteger(sd) && sd >= 0 ? sd : null,
    openedAt: num(p.opened_at),
  };
}

// GET /v1/positions (open). null = unreadable; a malformed row also makes
// the list unreadable, never silently shorter (a hidden position must not
// look flat to a reverse gate).
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

// A closed position (GET /v1/positions, closed status; see
// SECURITY.md): one whole round trip. Verified on the sandbox 2026-10-23:
// realizedPnl is the GROSS price P&L ((exit - entry) * size * dir), and the
// account's balance moves by exactly realizedPnl - fees + funding (funding
// signed: + received, - paid).
export type MfpClosed = {
  id: string;
  marketId: string;
  provider: string;
  symbol: string;           // the base asset ("BTC")
  coin: string;             // the venue's pair ("BTCUSDT")
  side: "long" | "short";
  size: number;
  entryPrice: number;
  exitPrice: number | null;
  leverage: number | null;
  openedAt: number;
  closedAt: number;
  realizedPnl: number;
  fees: number;
  funding: number;
  closeReason: string | null; // user | take_profit | stop_loss | liquidation | reversal | system; absent on old rows
};

export function parseMfpClosed(v: unknown): MfpClosed | null {
  const p = obj(v);
  if (!p || p.status !== "closed") return null;
  const id = str(p.id), marketId = str(p.market_id);
  const side = p.side === "long" || p.side === "short" ? p.side : null;
  const size = num(p.size), entryPrice = num(p.entry_price);
  const openedAt = num(p.opened_at), closedAt = num(p.closed_at), realizedPnl = num(p.realized_pnl);
  if (!id || !marketId || !side || size === null || !(size > 0) || entryPrice === null || openedAt === null || closedAt === null || realizedPnl === null) return null;
  // Fees and funding move the balance: a closed row without them is not
  // counted as zero.
  const fees = num(p.fees), funding = num(p.funding);
  if (fees === null || funding === null) return null;
  return {
    id, marketId,
    provider: str(p.provider) ?? "",
    symbol: str(p.symbol) ?? "",
    coin: str(p.coin) ?? "",
    side, size, entryPrice,
    exitPrice: num(p.exit_price),
    leverage: num(p.leverage),
    openedAt, closedAt, realizedPnl, fees, funding,
    closeReason: str(p.close_reason),
  };
}

// One page of closed positions, newest close first. null = unreadable; a
// malformed row makes the page unreadable, never silently shorter (a missing
// loss would flatter every number on the Performance view).
export function parseMfpClosedPage(json: unknown): { rows: MfpClosed[]; hasMore: boolean; nextCursor: string | null } | null {
  const o = obj(json);
  if (!o || !Array.isArray(o.data)) return null;
  const rows: MfpClosed[] = [];
  for (const x of o.data) {
    const c = parseMfpClosed(x);
    if (!c) return null;
    rows.push(c);
  }
  const hasMore = o.has_more === true;
  const nextCursor = str(o.next_cursor);
  if (hasMore && !nextCursor) return null; // more pages promised with no way to reach them
  return { rows, hasMore, nextCursor };
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
    status,
    side: str(o.side) ?? "",
    size: num(o.size),
    fillPrice: num(o.fill_price),
    reduceOnly: typeof o.reduce_only === "boolean" ? o.reduce_only : null,
    positionSideAfter: str(o.position_side_after),
    positionSizeAfter: num(o.position_size_after),
    rejectReason: str(o.reject_reason),
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

// Before leg 1: a working order on the market that is not reduce-only could
// fill into the reversed position and grow it. Reduce-only exits (TP/SL) do
// not block here - the venue cancels them when the position closes, and
// leg 2 waits for that (mfpReverseGate requires none left).
export function mfpWorkingBlocksReverse(working: MfpOrder[] | null, marketId: string): string | null {
  if (!working) return "the working orders could not be read";
  const n = working.filter((o) => o.marketId === marketId && o.reduceOnly !== true).length;
  return n ? n + " working order(s) on this market could add to the reversed position - cancel them on MFP first" : null;
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
  };
}

// GET /v1/markets/{id}/quote -> mid (null when unavailable).
export function parseMfpMid(json: unknown): number | null {
  const q = obj(mfpData(json));
  if (!q) return null;
  const mid = num(q.mid);
  return mid !== null && mid > 0 ? mid : null;
}

export type MfpError = { status: number; code: string; message: string };

// The error envelope {error: {code, message, request_id, details}}, or a
// status line. Validation details ("expected_price: is required for market
// closes") are folded into the message - the generic message alone does not
// say which field.
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

// Why the account cannot open (the reverse's leg 2), or null when it can.
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
  status === "filled" || status === "rejected" || status === "expired" || status === "canceled";

// Idempotency keys and client order ids: printable ASCII, at most 128 chars,
// unique per intended operation. Uniqueness, not secrecy, is what matters,
// so the caller supplies the entropy (this file stays import-free).
export function mfpOperationId(kind: "close" | "rev-close" | "rev-open", nowMs: number, rand: number): string {
  if (!Number.isFinite(nowMs) || !Number.isFinite(rand)) throw new Error("bad operation id inputs");
  const r = Math.floor(Math.abs(rand) * 2 ** 52).toString(36);
  return "hip3m-" + kind + "-" + Math.floor(nowMs).toString(36) + "-" + r;
}

// ---- wires -----------------------------------------------------------------

// expected_price is REQUIRED by the live API for market closes (sandbox
// 2026-10-17: "expected_price: is required for market closes"; the OpenAPI
// spec marks it optional). The venue never prices off it.
export type CloseWire = { client_order_id: string; type: "market"; expected_price: number };

export type OpenWire = {
  client_order_id: string;
  type: "market";
  account_id: string;
  market_id: string;
  side: "buy" | "sell";
  size: number;
  expected_price: number;
  leverage: number;
  margin_mode: "cross" | "isolated";
  reduce_only: false;
};

export type MfpWrite =
  | { kind: "close"; path: string; body: CloseWire; idempotencyKey: string }
  | { kind: "open"; path: "/v1/orders"; body: OpenWire; idempotencyKey: string };

const ID_RE = /^[A-Za-z0-9_|:.-]{1,128}$/;
const OPID_RE = /^[\x21-\x7e]{1,128}$/;

// A FULL market close of one position: no size; the observed mid as the
// required reference price.
export function buildMfpClose(pos: MfpPosition, mid: number, clientOrderId: string, idempotencyKey: string): MfpWrite {
  if (!ID_RE.test(pos.id)) throw new Error("bad position id");
  if (!(mid > 0) || !Number.isFinite(mid)) throw new Error("no mid for " + pos.marketId);
  if (!OPID_RE.test(clientOrderId) || !OPID_RE.test(idempotencyKey)) throw new Error("bad operation id");
  const write: MfpWrite = Object.freeze({
    kind: "close" as const,
    path: "/v1/positions/" + encodeURIComponent(pos.id) + "/close",
    body: Object.freeze({ client_order_id: clientOrderId, type: "market" as const, expected_price: mid }),
    idempotencyKey,
  });
  assertMfpWrite(write);
  return write;
}

// ---- the reverse's gates -------------------------------------------------

// Before leg 1: the venue still holds the position the sheet showed - same
// id, same side, same size (to the position's own precision when known).
export function mfpReversePreCheck(shown: MfpPosition, venue: MfpPosition[] | null): string | null {
  if (!venue) return "the open positions could not be read";
  const now = venue.find((p) => p.id === shown.id);
  if (!now) return "the venue shows no position any more";
  if (now.side !== shown.side) return "the position changed side since the sheet opened";
  if (now.marketId !== shown.marketId) return "the position changed market since the sheet opened";
  const tol = now.sizeDecimals !== null ? Math.pow(10, -now.sizeDecimals) / 2 : 1e-12;
  if (Math.abs(now.size - shown.size) > tol) return "the position size changed since the sheet opened - refresh and try again";
  if (venue.some((p) => p.marketId === shown.marketId && p.id !== shown.id)) return "more than one position is open on this market";
  return null;
}

export type MfpReverseGateInput = {
  pre: MfpPosition;                 // the venue's position re-read just before leg 1
  close: MfpOrder | null;           // the close order as last read (null = never confirmed)
  venueAfter: MfpPosition[] | null; // open positions re-read after the close (and after the cooldown)
  workingAfter: MfpOrder[] | null;  // working orders re-read at the same moment
  policy: MfpPolicy | null;         // trading policy re-read at the same moment
};

// A pass is bound to the position it was issued for and is spent by the
// first build (buildMfpReverseOpen deletes it).
export type MfpReverseGatePass = {
  readonly ok: true; readonly size: number;
  readonly accountId: string; readonly marketId: string; readonly side: "long" | "short";
};
const PASSED_GATES = new WeakSet<object>();

// After leg 1: the close FILLED and left the market flat, the venue's own
// positions agree, nothing is still working on the market (the venue has
// cancelled the position's exits), and the account may open. The size is the
// pre-close size; a close whose readable fill is smaller refuses instead (a
// fragment or a shrunken position must never size a bigger open). Never throws.
export function mfpReverseGate(g: MfpReverseGateInput): MfpReverseGatePass | { ok: false; reason: string } {
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
  const pass: MfpReverseGatePass = Object.freeze({
    ok: true as const, size: g.pre.size, accountId: g.pre.accountId, marketId: g.pre.marketId, side: g.pre.side,
  });
  PASSED_GATES.add(pass);
  return pass;
}

const BUILT_OPENS = new WeakSet<object>();

function reverseOpenBody(closed: MfpPosition, size: number, mid: number, clientOrderId: string): OpenWire {
  if (!(mid > 0) || !Number.isFinite(mid)) throw new Error("no mid for " + closed.marketId);
  if (!(size > 0) || size > closed.size) throw new Error("a reverse cannot open more than the position it closed");
  if (!ID_RE.test(closed.accountId) || !ID_RE.test(closed.marketId)) throw new Error("bad account or market id");
  if (!OPID_RE.test(clientOrderId)) throw new Error("bad operation id");
  return Object.freeze({
    client_order_id: clientOrderId,
    type: "market" as const,
    account_id: closed.accountId,
    market_id: closed.marketId,
    side: closed.side === "long" ? ("sell" as const) : ("buy" as const), // a long reverses into a short
    size,
    expected_price: mid,
    leverage: closed.leverage,
    margin_mode: closed.marginMode,
    reduce_only: false,
  });
}

// For the confirmation sheet only: leg 2 as it would look. NOT sendable -
// it is never registered, so assertMfpWrite refuses it.
export function previewMfpReverseOpen(closed: MfpPosition, mid: number): OpenWire {
  return reverseOpenBody(closed, closed.size, mid, "preview");
}

// The sendable leg 2. Takes only a pass mfpReverseGate issued; the size
// comes from the pass. The one place an opening body leaves this module.
export function buildMfpReverseOpen(
  pass: MfpReverseGatePass, closed: MfpPosition, mid: number, clientOrderId: string, idempotencyKey: string,
): MfpWrite {
  if (!pass || !PASSED_GATES.has(pass) || pass.ok !== true) throw new Error("an opening order needs a passed reverse gate");
  if (pass.accountId !== closed.accountId || pass.marketId !== closed.marketId || pass.side !== closed.side) {
    throw new Error("the gate pass was issued for a different position");
  }
  if (!OPID_RE.test(idempotencyKey)) throw new Error("bad operation id");
  PASSED_GATES.delete(pass); // single use: one pass, at most one opening body
  const write: MfpWrite = Object.freeze({
    kind: "open" as const,
    path: "/v1/orders" as const,
    body: reverseOpenBody(closed, pass.size, mid, clientOrderId),
    idempotencyKey,
  });
  BUILT_OPENS.add(write);
  assertMfpWrite(write);
  return write;
}

const keysExactly = (o: object, keys: string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};

const OPEN_KEYS = [
  "client_order_id", "type", "account_id", "market_id", "side", "size",
  "expected_price", "leverage", "margin_mode", "reduce_only",
];

// Runtime twin of the types: throws unless the value is exactly one of the
// two permitted writes with no extra keys. A close carries only an id,
// "market" and the reference price (no size: always a full close). An
// opening body is accepted only as the frozen object buildMfpReverseOpen
// registered.
export function assertMfpWrite(w: unknown): asserts w is MfpWrite {
  const o = obj(w);
  if (!o) throw new Error("write is not an object");
  if (!keysExactly(o, ["kind", "path", "body", "idempotencyKey"])) throw new Error("write has unexpected keys");
  if (typeof o.idempotencyKey !== "string" || !OPID_RE.test(o.idempotencyKey)) throw new Error("write needs an idempotency key");
  const b = obj(o.body);
  if (!b) throw new Error("write body is not an object");
  if (o.kind === "close") {
    if (typeof o.path !== "string" || !/^\/v1\/positions\/[A-Za-z0-9_%.-]{1,200}\/close$/.test(o.path)) throw new Error("close path not permitted");
    if (!keysExactly(b, ["client_order_id", "type", "expected_price"])) throw new Error("a close carries only client_order_id, type and expected_price");
    if (b.type !== "market") throw new Error("a close must be a market close");
    if (typeof b.expected_price !== "number" || !Number.isFinite(b.expected_price) || !(b.expected_price > 0)) throw new Error("a close needs a positive reference price");
    if (typeof b.client_order_id !== "string" || !OPID_RE.test(b.client_order_id)) throw new Error("close needs a client order id");
    return;
  }
  if (o.kind === "open") {
    if (o.path !== "/v1/orders") throw new Error("open path not permitted");
    if (!keysExactly(b, OPEN_KEYS)) throw new Error("opening body has unexpected keys");
    if (b.type !== "market" || b.reduce_only !== false) throw new Error("opening body must be a market order");
    if (!BUILT_OPENS.has(o) || !Object.isFrozen(o) || !Object.isFrozen(b)) {
      throw new Error("an opening order must come from buildMfpReverseOpen, unmodified");
    }
    return;
  }
  throw new Error("write kind not permitted: " + String(o.kind));
}
