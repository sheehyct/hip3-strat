// src/lib/mfp_orders.ts: key environments, defensive parsing of the beta
// API, the two permitted writes, and the reverse's gates. Fake ids and fake
// fp_test_ keys only.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertMfpWrite, buildMfpClose, buildMfpReverseOpen, mfpEnvForKey, mfpOpeningBlocked, mfpOperationId,
  mfpReverseGate, mfpReversePreCheck, mfpTerminal, mfpWorkingBlocksReverse, parseMfpAccounts, parseMfpClosedPage, parseMfpError, parseMfpMid,
  parseMfpOrderLookup, parseMfpPolicy, parseMfpPositions, parseMfpWorkingOrders, previewMfpReverseOpen,
} from "../src/lib/mfp_orders.ts";

const rawPos = (over = {}) => ({
  id: "pos_1", account_id: "acct_1", market_id: "binance|BTCUSDT", provider: "binance", symbol: "BTC",
  coin: "BTCUSDT", side: "long", size: 0.001, entry_price: 81212.9, leverage: 1, margin_mode: "cross",
  isolated_margin_extra: 0, status: "open", opened_at: 1, size_decimals: 3, ...over,
});
const pos = (over = {}) => parseMfpPositions({ data: [rawPos(over)] })[0];
const clearPolicy = {
  manualTradingBlocked: false, openingExposureRestricted: false, reduceOnlyRestricted: false,
  platformHalt: false, copyFollowerLocked: false, competitionOpeningRestricted: false,
  orderCooldownMs: 500, executionDelayMaxMs: 0,
};
const filledFlat = { id: "ord_1", clientOrderId: "c1", marketId: "binance|BTCUSDT", status: "filled", side: "sell", size: 0.001, fillPrice: 81000, reduceOnly: true, positionSideAfter: "flat", positionSizeAfter: 0, rejectReason: null };

function passFor(pre) {
  // a clean close that filled the whole pre-close size
  const g = mfpReverseGate({ pre, close: { ...filledFlat, size: pre.size }, venueAfter: [], workingAfter: [], policy: clearPolicy });
  if (!g.ok) throw new Error(g.reason);
  return g;
}

test("key prefixes name the environment; anything else is refused", () => {
  assert.equal(mfpEnvForKey("fp_live_abcdefghijklmnop12345678"), "live");
  assert.equal(mfpEnvForKey("fp_test_abcdefghijklmnop12345678"), "sandbox");
  assert.equal(mfpEnvForKey("fp_test_short"), null);
  assert.equal(mfpEnvForKey("fp_test_abcdefgh12345678"), null); // 16 chars: under the 24 floor
  assert.equal(mfpEnvForKey(" fp_test_abcdefghijklmnop12345678"), null);
  assert.equal(mfpEnvForKey("0x" + "1".repeat(64)), null);
  assert.equal(mfpEnvForKey(undefined), null);
});

test("positions parse, and one malformed row makes the list unreadable (never silently shorter)", () => {
  const p = pos();
  assert.equal(p.side, "long");
  assert.equal(p.size, 0.001);
  assert.equal(p.marginMode, "cross");
  assert.equal(p.liquidationPrice, null);
  assert.equal(p.sizeDecimals, 3);
  assert.equal(parseMfpPositions({ data: [rawPos(), { id: "x" }] }), null);
  assert.equal(parseMfpPositions({ data: [rawPos({ side: "flat" })] }), null);
  assert.equal(parseMfpPositions({ data: [rawPos({ size: 0 })] }), null);
  assert.equal(parseMfpPositions({ data: {} }), null);
  assert.deepEqual(parseMfpPositions({ data: [] }), []);
});

test("accounts parse with their risk block; an unreadable list is null", () => {
  const list = parseMfpAccounts({ data: [{ id: "acct_1", account_number: "A1", name: "Eval", stage: "evaluation", status: "active", starting_balance: 100000, balance: 100000, created_at: 1, risk: { equity: 100010, unrealized_pnl: 10, margin_used: 81, available_balance: 99919, daily_loss_room: 4010, max_drawdown_room: 8010, remaining_profit_equity: 7990, marks_complete: true } }] });
  assert.equal(list.length, 1);
  assert.equal(list[0].risk.dailyLossRoom, 4010);
  assert.equal(list[0].risk.marksComplete, true);
  assert.equal(parseMfpAccounts({ data: [{ name: "no id" }] }), null);
  assert.equal(parseMfpAccounts({}), null);
});

test("order lookup returns only the row whose client_order_id matches", () => {
  const row = { id: "ord_9", client_order_id: "hip3m-close-x", status: "filled", side: "sell", position_side_after: "flat", position_size_after: 0 };
  assert.equal(parseMfpOrderLookup({ data: [row] }, "hip3m-close-x").id, "ord_9");
  assert.equal(parseMfpOrderLookup({ data: row }, "hip3m-close-x").positionSideAfter, "flat");
  assert.equal(parseMfpOrderLookup({ data: [row] }, "someone-else"), null);
  assert.equal(parseMfpOrderLookup({ data: [] }, "hip3m-close-x"), null);
  assert.equal(mfpTerminal("pending"), false);
  assert.equal(mfpTerminal("filled"), true);
  assert.equal(mfpTerminal("rejected"), true);
});

test("policy: only an explicit null restriction is clear; a missing halt counts as halted", () => {
  const base = { manual_trading_blocked: false, opening_exposure_restricted: false, restriction: null, copy_follower_locked: false, competition: null, trading_halt: { platform: false, categories: [] }, limits: { order_cooldown_ms: 500, execution_delay_max_ms: 0 } };
  const p = parseMfpPolicy({ data: base });
  assert.deepEqual(p, clearPolicy);
  assert.equal(mfpOpeningBlocked(p), null);
  assert.equal(parseMfpPolicy({ data: { ...base, restriction: { restriction: "reduce_only", reason: "x", flagged_at: 1 } } }).reduceOnlyRestricted, true);
  assert.equal(parseMfpPolicy({ data: { ...base, restriction: undefined } }).reduceOnlyRestricted, true);
  assert.equal(parseMfpPolicy({ data: { ...base, trading_halt: undefined } }).platformHalt, true);
  assert.equal(parseMfpPolicy({ data: { ...base, limits: {} } }).orderCooldownMs, 1000);
  assert.equal(parseMfpPolicy({ data: { restriction: null } }), null);
  assert.match(mfpOpeningBlocked(null), /could not be read/);
  assert.match(mfpOpeningBlocked({ ...clearPolicy, openingExposureRestricted: true }), /opening exposure/);
  assert.match(mfpOpeningBlocked({ ...clearPolicy, manualTradingBlocked: true }), /manual trading/);
  assert.equal(parseMfpPolicy({ data: { ...base, copy_follower_locked: true } }).copyFollowerLocked, true);
  assert.equal(parseMfpPolicy({ data: { ...base, competition: { opening_exposure_restricted: true, market_allowlist: [] } } }).competitionOpeningRestricted, true);
  assert.equal(parseMfpPolicy({ data: { ...base, limits: { order_cooldown_ms: 500, execution_delay_max_ms: 4000 } } }).executionDelayMaxMs, 4000);
  assert.match(mfpOpeningBlocked({ ...clearPolicy, copyFollowerLocked: true }), /copy follower/);
  assert.match(mfpOpeningBlocked({ ...clearPolicy, competitionOpeningRestricted: true }), /competition/);
});

test("quote mid and error envelope", () => {
  assert.equal(parseMfpMid({ data: { status: "ok", mid: 81212.85 } }), 81212.85);
  assert.equal(parseMfpMid({ data: { status: "ok", mid: null } }), null);
  assert.deepEqual(parseMfpError(422, { error: { code: "rule_violation", message: "cooldown", request_id: "r" } }), { status: 422, code: "rule_violation", message: "cooldown" });
  assert.deepEqual(parseMfpError(502, null), { status: 502, code: "http_502", message: "HTTP 502" });
});

test("operation ids are printable, bounded and distinct", () => {
  const a = mfpOperationId("close", 1792000000000, 0.123);
  const b = mfpOperationId("close", 1792000000000, 0.124);
  assert.match(a, /^hip3m-close-[a-z0-9]+-[a-z0-9]+$/);
  assert.ok(a.length <= 128);
  assert.notEqual(a, b);
});

test("a close is a FULL market close: id, market and the reference price, never a size", () => {
  const w = buildMfpClose(pos(), 81000, "cid-1", "idem-1");
  assert.equal(w.kind, "close");
  assert.equal(w.path, "/v1/positions/pos_1/close");
  assert.deepEqual(Object.keys(w.body).sort(), ["client_order_id", "expected_price", "type"]);
  assert.equal(w.body.type, "market");
  assert.equal(w.body.expected_price, 81000);
  assert.ok(Object.isFrozen(w) && Object.isFrozen(w.body));
  assert.throws(() => buildMfpClose(pos({ id: "../cancel-all" }), 81000, "cid", "idem"), /bad position id/);
  assert.throws(() => buildMfpClose(pos(), 81000, "", "idem"), /bad operation id/);
  assert.throws(() => buildMfpClose(pos(), 0, "cid", "idem"), /no mid/);
  assert.throws(() => buildMfpClose(pos(), NaN, "cid", "idem"), /no mid/);
});

test("validation details are folded into the error message", () => {
  const e = parseMfpError(400, { error: { code: "invalid_position_close", message: "One or more request fields are invalid.", request_id: "r", details: [{ field: "expected_price", issue: "is required for market closes" }] } });
  assert.equal(e.code, "invalid_position_close");
  assert.match(e.message, /\(expected_price: is required for market closes\)$/);
});

test("the runtime guard refuses anything it did not build", () => {
  const close = buildMfpClose(pos(), 81000, "cid-1", "idem-1");
  assert.doesNotThrow(() => assertMfpWrite(close));
  // a close that grew a size (partial close), lost its price, or changed type
  assert.throws(() => assertMfpWrite({ ...close, body: { ...close.body, size: 0.0005 } }), /only client_order_id, type and expected_price/);
  assert.throws(() => assertMfpWrite({ ...close, body: { client_order_id: "c", type: "market" } }), /only client_order_id, type and expected_price/);
  assert.throws(() => assertMfpWrite({ ...close, body: { client_order_id: "c", type: "limit", expected_price: 1 } }), /market close/);
  assert.throws(() => assertMfpWrite({ ...close, body: { client_order_id: "c", type: "market", expected_price: -1 } }), /positive reference price/);
  assert.throws(() => assertMfpWrite({ ...close, path: "/v1/accounts/acct_1/close-all-positions" }), /close path/);
  assert.throws(() => assertMfpWrite({ ...close, idempotencyKey: "" }), /idempotency key/);
  // a hand-built opening body, even a perfect copy of a real one
  const real = buildMfpReverseOpen(passFor(pos()), pos(), 81000, "cid-2", "idem-2");
  assert.doesNotThrow(() => assertMfpWrite(real));
  assert.throws(() => assertMfpWrite({ ...real }), /must come from buildMfpReverseOpen/);
  assert.throws(() => assertMfpWrite({ kind: "open", path: "/v1/orders", body: previewMfpReverseOpen(pos(), 81000), idempotencyKey: "i" }), /must come from buildMfpReverseOpen/);
  assert.throws(() => assertMfpWrite({ ...real, body: { ...real.body, reduce_only: true } }), /must come from|market order/);
  assert.throws(() => { real.body.size = 1; }, TypeError); // frozen
  assert.throws(() => assertMfpWrite({ kind: "cancel", path: "/v1/orders/x", body: {}, idempotencyKey: "i" }), /not permitted/);
});

test("pre-check: the venue must still hold the shown position, same id, side and size", () => {
  const shown = pos();
  assert.equal(mfpReversePreCheck(shown, [pos()]), null);
  assert.equal(mfpReversePreCheck(shown, [pos({ size: 0.0010004 })]), null); // inside half a size step
  assert.match(mfpReversePreCheck(shown, null), /could not be read/);
  assert.match(mfpReversePreCheck(shown, []), /no position/);
  assert.match(mfpReversePreCheck(shown, [pos({ side: "short" })]), /changed side/);
  assert.match(mfpReversePreCheck(shown, [pos({ size: 0.002 })]), /size changed/);
  assert.match(mfpReversePreCheck(shown, [pos(), pos({ id: "pos_2" })]), /more than one position/);
});

test("gate: only a filled, flat, venue-confirmed close on an account that may open passes", () => {
  const pre = pos();
  const ok = mfpReverseGate({ pre, close: filledFlat, venueAfter: [], workingAfter: [], policy: clearPolicy });
  assert.equal(ok.ok, true);
  assert.equal(ok.size, 0.001);
  assert.ok(Object.isFrozen(ok));
  const no = (over) => mfpReverseGate({ pre, close: filledFlat, venueAfter: [], workingAfter: [], policy: clearPolicy, ...over });
  assert.match(no({ close: null }).reason, /never confirmed/);
  assert.match(no({ close: { ...filledFlat, status: "pending" } }).reason, /ended pending/);
  assert.match(no({ close: { ...filledFlat, status: "rejected", rejectReason: "cooldown" } }).reason, /rejected \(cooldown\)/);
  assert.match(no({ close: { ...filledFlat, positionSideAfter: "long" } }).reason, /not leave the market flat/);
  assert.match(no({ close: { ...filledFlat, positionSideAfter: null } }).reason, /not leave the market flat/);
  assert.match(no({ close: { ...filledFlat, positionSizeAfter: 0.0004 } }).reason, /residual/);
  assert.match(no({ venueAfter: null }).reason, /re-read/);
  assert.match(no({ venueAfter: [pos({ id: "pos_9" })] }).reason, /still shows a position/);
  assert.match(no({ policy: null }).reason, /could not be read/);
  assert.match(no({ policy: { ...clearPolicy, reduceOnlyRestricted: true } }).reason, /reducing orders/);
  assert.match(no({ workingAfter: null }).reason, /working orders/);
  assert.match(no({ workingAfter: [{ ...filledFlat, id: "tp", status: "resting", reduceOnly: true }] }).reason, /still work on this market/);
  assert.equal(no({ workingAfter: [{ ...filledFlat, id: "eth", marketId: "binance|ETHUSDT", status: "resting" }] }).ok, true); // another market
  assert.match(no({ close: { ...filledFlat, size: 0.0004 } }).reason, /filled less/);
  assert.equal(no({ close: { ...filledFlat, size: null } }).ok, true); // unreadable fill size: flat + venue decide
});

test("leg 2: opposite side, the pre-close size, leverage and margin copied, opening flag off, no TP/SL", () => {
  const long = pos();
  const w = buildMfpReverseOpen(passFor(long), long, 81000, "cid-3", "idem-3");
  assert.equal(w.path, "/v1/orders");
  assert.equal(w.body.side, "sell");
  assert.equal(w.body.size, 0.001);
  assert.equal(w.body.leverage, 1);
  assert.equal(w.body.margin_mode, "cross");
  assert.equal(w.body.reduce_only, false);
  assert.equal(w.body.account_id, "acct_1");
  assert.equal(w.body.market_id, "binance|BTCUSDT");
  assert.equal("take_profit_price" in w.body || "stop_loss_price" in w.body, false);
  const short = pos({ side: "short", leverage: 3, margin_mode: "isolated" });
  const ws = buildMfpReverseOpen(passFor(short), short, 81000, "cid-4", "idem-4");
  assert.equal(ws.body.side, "buy");
  assert.equal(ws.body.leverage, 3);
  assert.equal(ws.body.margin_mode, "isolated");
});

test("working orders: unreadable is null; only non-reduce-only orders on the market block a reverse", () => {
  const row = (over) => ({ id: "o1", client_order_id: "x", market_id: "binance|BTCUSDT", status: "resting", side: "sell", reduce_only: true, ...over });
  const list = parseMfpWorkingOrders({ data: [row(), row({ id: "o2", reduce_only: false }), row({ id: "o3", market_id: "binance|ETHUSDT", reduce_only: false })] });
  assert.equal(list.length, 3);
  assert.equal(list[0].marketId, "binance|BTCUSDT");
  assert.equal(parseMfpWorkingOrders({ data: [row({ market_id: undefined })] }), null);
  assert.equal(parseMfpWorkingOrders({ data: {} }), null);
  assert.match(mfpWorkingBlocksReverse(null, "binance|BTCUSDT"), /could not be read/);
  assert.match(mfpWorkingBlocksReverse(list, "binance|BTCUSDT"), /^1 working order/);           // o2 only; the TP (o1) does not block
  assert.equal(mfpWorkingBlocksReverse([list[0]], "binance|BTCUSDT"), null);
  assert.equal(mfpWorkingBlocksReverse(parseMfpWorkingOrders({ data: [row({ reduce_only: undefined })] }), "binance|BTCUSDT") !== null, true); // unknown flag blocks
});

test("a gate pass is single use and bound to its position", () => {
  const p = pos();
  const pass = passFor(p);
  assert.equal(pass.marketId, "binance|BTCUSDT");
  assert.throws(() => buildMfpReverseOpen(passFor(p), pos({ market_id: "binance|ETHUSDT" }), 81000, "c", "i"), /different position/);
  assert.throws(() => buildMfpReverseOpen(passFor(p), pos({ side: "short" }), 81000, "c", "i"), /different position/);
  buildMfpReverseOpen(pass, p, 81000, "c1", "i1");
  assert.throws(() => buildMfpReverseOpen(pass, p, 81000, "c2", "i2"), /passed reverse gate/); // spent
});

test("leg 2 needs a real pass and can never exceed the closed position", () => {
  const p = pos();
  assert.throws(() => buildMfpReverseOpen({ ok: true, size: 0.001 }, p, 81000, "c", "i"), /passed reverse gate/);
  assert.throws(() => buildMfpReverseOpen(Object.freeze({ ok: true, size: 0.001 }), p, 81000, "c", "i"), /passed reverse gate/);
  const big = passFor(pos({ size: 0.005 }));
  assert.throws(() => buildMfpReverseOpen(big, p, 81000, "c", "i"), /cannot open more/);
  assert.throws(() => buildMfpReverseOpen(passFor(p), p, 0, "c", "i"), /no mid/);
});

// ---- closed positions --------------------------------------------------------
const rawClosed = (over = {}) => ({
  ...rawPos({ status: "closed" }), id: "cpos_1", closed_at: 1900, exit_price: 81187.8, realized_pnl: -0.0251,
  fees: 0.04872, funding: -0.001015, close_reason: "user", ...over,
});

test("closed positions parse with their money fields; the last page carries no cursor", () => {
  const p = parseMfpClosedPage({ data: [rawClosed(), rawClosed({ id: "cpos_2", close_reason: undefined })], has_more: false });
  assert.equal(p.rows.length, 2);
  assert.equal(p.hasMore, false);
  assert.equal(p.nextCursor, null);
  const r = p.rows[0];
  assert.equal(r.realizedPnl, -0.0251);
  assert.equal(r.fees, 0.04872);
  assert.equal(r.funding, -0.001015);
  assert.equal(r.closedAt, 1900);
  assert.equal(r.symbol, "BTC");
  assert.equal(r.coin, "BTCUSDT");
  assert.equal(p.rows[1].closeReason, null, "close_reason is absent on rows closed before the field existed");
  const more = parseMfpClosedPage({ data: [rawClosed()], has_more: true, next_cursor: "cur_1" });
  assert.equal(more.hasMore, true);
  assert.equal(more.nextCursor, "cur_1");
});

test("a closed page is unreadable, never shorter: a bad row, missing money, an open row, or more with no cursor", () => {
  assert.equal(parseMfpClosedPage({ data: [rawClosed(), rawClosed({ realized_pnl: "x" })] }), null);
  assert.equal(parseMfpClosedPage({ data: [rawClosed({ fees: undefined })] }), null, "fees move the balance: never read as zero");
  assert.equal(parseMfpClosedPage({ data: [rawClosed({ funding: null })] }), null);
  assert.equal(parseMfpClosedPage({ data: [rawClosed({ closed_at: undefined })] }), null);
  assert.equal(parseMfpClosedPage({ data: [rawClosed({ status: "open" })] }), null);
  assert.equal(parseMfpClosedPage({ data: [rawClosed()], has_more: true }), null);
  assert.equal(parseMfpClosedPage({ nope: [] }), null);
  assert.deepEqual(parseMfpClosedPage({ data: [] }), { rows: [], hasMore: false, nextCursor: null });
});
