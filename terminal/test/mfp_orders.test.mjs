// src/lib/mfp_orders.ts: exact request bodies for the five permitted
// writes, their refusals, the runtime guard, parsers and the reverse gates.
// Fake ids and fake fp_test_ keys only (docs/CONTRACT.md).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertMfpWrite, buildMfpCancel, buildMfpClose, buildMfpExits, buildMfpModify, buildMfpOrder, mfpEnvForKey,
  mfpForeignRows, mfpOpeningBlocked, mfpOperationId, mfpPickAccount, mfpReverseGate, mfpReversePreCheck, mfpTerminal, mfpWorkingBlocksReverse,
  parseMfpAccounts, parseMfpError, parseMfpFills, parseMfpOrderLookup, parseMfpPolicy, parseMfpPositions, parseMfpQuote,
  parseMfpWorkingOrders,
} from "../src/lib/mfp_orders.ts";

const rawPos = (over = {}) => ({
  id: "pos_1", account_id: "acct_1", market_id: "binance|BTCUSDT", provider: "binance", symbol: "BTC",
  coin: "BTCUSDT", side: "long", size: 0.001, entry_price: 81212.9, leverage: 1, margin_mode: "cross",
  status: "open", opened_at: 1, size_decimals: 3, liquidation_price: 40000, mark_price: 81300, unrealized_pnl: 0.09, ...over,
});
const pos = (over = {}) => parseMfpPositions({ data: [rawPos(over)] })[0];
const clearPolicy = {
  manualTradingBlocked: false, openingExposureRestricted: false, reduceOnlyRestricted: false,
  platformHalt: false, copyFollowerLocked: false, competitionOpeningRestricted: false,
  orderCooldownMs: 500, executionDelayMaxMs: 0, exposureCap: null, accountExposureCap: null,
};
const filledFlat = { id: "ord_1", clientOrderId: "c1", marketId: "binance|BTCUSDT", positionId: null, status: "filled", type: "market", side: "sell", size: 0.001, price: null, triggerPrice: null, fillPrice: 81000, reduceOnly: true, positionSideAfter: "flat", positionSizeAfter: 0, rejectReason: null, createdAt: null, takeProfitPrice: null, stopLossPrice: null };

const base = { accountId: "acct_1", marketId: "hyperliquid|BTC", side: "buy", type: "market", size: 0.01, limitPrice: null, reduceOnly: false, leverage: 5, marginMode: "cross", expectedPrice: 81000, slippage: 0.01, tp: null, sl: null };

test("key prefixes name the environment; anything else is refused", () => {
  assert.equal(mfpEnvForKey("fp_live_abcdefghijklmnop12345678"), "live");
  assert.equal(mfpEnvForKey("fp_test_abcdefghijklmnop12345678"), "sandbox");
  assert.equal(mfpEnvForKey("fp_test_short"), null);
  assert.equal(mfpEnvForKey(undefined), null);
});

test("market order body: exact fields, slippage as bps, reduce_only literal", () => {
  const w = buildMfpOrder(base, "cid-1", "idem-1");
  assert.equal(w.kind, "order"); assert.equal(w.method, "POST"); assert.equal(w.path, "/v1/orders");
  assert.deepEqual(w.body, {
    client_order_id: "cid-1", type: "market", account_id: "acct_1", market_id: "hyperliquid|BTC", side: "buy", size: 0.01,
    leverage: 5, margin_mode: "cross", reduce_only: false, expected_price: 81000, slippage_tolerance_bps: 100,
  });
  assert.ok(Object.isFrozen(w) && Object.isFrozen(w.body));
});

test("limit order body with attached TP / SL", () => {
  const w = buildMfpOrder({ ...base, type: "limit", limitPrice: 80000, tp: 85000, sl: 78000 }, "cid-2", "idem-2");
  assert.deepEqual(w.body, {
    client_order_id: "cid-2", type: "limit", account_id: "acct_1", market_id: "hyperliquid|BTC", side: "buy", size: 0.01,
    leverage: 5, margin_mode: "cross", reduce_only: false, limit_price: 80000, take_profit_price: 85000, stop_loss_price: 78000,
  });
  assert.equal("slippage_tolerance_bps" in w.body, false);
  // Live MFP, 2026-11-17: "expected_price: is not supported for limit orders".
  assert.equal("expected_price" in w.body, false);
  assert.doesNotThrow(() => assertMfpWrite(w));
  assert.throws(() => assertMfpWrite({ ...w, body: { ...w.body, expected_price: 81000 } }), /a limit order has no expected_price/);
  const market = buildMfpOrder(base, "cid-1", "idem-1");
  const { expected_price: _dropped, ...noMid } = market.body;
  assert.throws(() => assertMfpWrite({ ...market, body: noMid }), /a market order needs a positive expected_price/);
});

test("order refusals: slippage above 5 percent, exits on a reducing order, bad ids, missing limit price", () => {
  assert.throws(() => buildMfpOrder({ ...base, slippage: 0.06 }, "c", "i"), /slippage above 5%/);
  assert.doesNotThrow(() => buildMfpOrder({ ...base, slippage: 0.05 }, "c", "i"));
  assert.throws(() => buildMfpOrder({ ...base, reduceOnly: true, tp: 90000 }, "c", "i"), /reducing order/);
  assert.throws(() => buildMfpOrder({ ...base, type: "limit" }, "c", "i"), /limit order needs/);
  assert.throws(() => buildMfpOrder({ ...base, accountId: "../x" }, "c", "i"), /bad account/);
  assert.throws(() => buildMfpOrder({ ...base, size: 0 }, "c", "i"), /size/);
  assert.throws(() => buildMfpOrder({ ...base, expectedPrice: 0 }, "c", "i"), /no mid/);
  assert.throws(() => buildMfpOrder({ ...base, type: "chase" }, "c", "i"), /market or limit/);
  assert.throws(() => buildMfpOrder(base, "", "i"), /bad operation id/);
});

test("modify / cancel / close / exits bodies and paths", () => {
  assert.deepEqual(buildMfpModify("ord_7", 81500, null, "i"), { kind: "modify", method: "PATCH", path: "/v1/orders/ord_7", body: { price: 81500 }, idempotencyKey: "i" });
  assert.deepEqual(buildMfpModify("ord_7", 81500, 0.02, "i").body, { price: 81500, size: 0.02 });
  assert.throws(() => buildMfpModify("ord_7", 0, null, "i"), /price/);
  assert.deepEqual(buildMfpCancel("ord_7", "i"), { kind: "cancel", method: "DELETE", path: "/v1/orders/ord_7", body: null, idempotencyKey: "i" });
  assert.throws(() => buildMfpCancel("a b", "i"), /bad order id/);
  const full = buildMfpClose(pos(), 81000, null, 0.01, "cid", "i");
  assert.equal(full.path, "/v1/positions/pos_1/close");
  assert.deepEqual(full.body, { client_order_id: "cid", type: "market", expected_price: 81000, slippage_tolerance_bps: 100 });
  const whole = buildMfpClose(pos(), 81000, 0.001, 0.01, "cid", "i");
  assert.deepEqual(whole.body, { client_order_id: "cid", type: "market", expected_price: 81000, slippage_tolerance_bps: 100 }, "size = position is a full close, no size field");
  const part = buildMfpClose(pos(), 81000, 0.0005, 0.02, "cid", "i");
  assert.deepEqual(part.body, { client_order_id: "cid", type: "market", expected_price: 81000, slippage_tolerance_bps: 200, size: 0.0005 });
  assert.throws(() => buildMfpClose(pos(), 81000, 0.002, 0.01, "cid", "i"), /exceed the position/);
  assert.throws(() => buildMfpClose(pos({ id: "../cancel-all" }), 81000, null, 0.01, "cid", "i"), /bad position id/);
  assert.throws(() => buildMfpClose(pos(), 0, null, 0.01, "cid", "i"), /no mid/);
  assert.throws(() => buildMfpClose(pos(), 81000, null, 0.06, "cid", "i"), /slippage above 5%/);
  assert.throws(() => buildMfpClose(pos(), 81000, null, 0, "cid", "i"), /slippage cap/);
  const ex = buildMfpExits(pos(), [{ orderId: "tp1", price: 85000, size: 0.001 }], [{ kind: "modify", order_id: "tp1", price: 86000 }, { kind: "place", group: "sl", price: 78000, size: 0.001 }], "i");
  assert.equal(ex.method, "PUT"); assert.equal(ex.path, "/v1/positions/pos_1/exit-orders");
  assert.deepEqual(ex.body, {
    expected_position_size: 0.001,
    expected_orders: [{ order_id: "tp1", price: 85000, size: 0.001 }],
    operations: [{ kind: "modify", order_id: "tp1", price: 86000 }, { kind: "place", group: "sl", price: 78000, size: 0.001, execution_type: "market" }],
  });
  assert.deepEqual(buildMfpExits(pos(), [], [{ kind: "cancel", order_id: "tp1" }], "i").body.operations, [{ kind: "cancel", order_id: "tp1" }]);
  assert.throws(() => buildMfpExits(pos(), [], [{ kind: "place", group: "sl", price: 78000, size: 0.002 }], "i"), /exceed the position/);
  assert.throws(() => buildMfpExits(pos(), [], [], "i"), /no exit operations/);
});

test("the runtime guard refuses anything outside the five writes", () => {
  const ok = buildMfpOrder(base, "cid-1", "idem-1");
  assert.doesNotThrow(() => assertMfpWrite(ok));
  assert.throws(() => assertMfpWrite({ ...ok, body: { ...ok.body, type: "chase" } }), /market or limit/);
  assert.throws(() => assertMfpWrite({ ...ok, body: { ...ok.body, chase_offset: 1 } }), /unexpected keys/);
  assert.throws(() => assertMfpWrite({ ...ok, body: { ...ok.body, slippage_tolerance_bps: 600 } }), /slippage/);
  assert.throws(() => assertMfpWrite({ ...ok, body: { ...ok.body, reduce_only: true, take_profit_price: 1 } }), /reducing order/);
  assert.throws(() => assertMfpWrite({ ...ok, path: "/v1/twap" }), /path not permitted/);
  assert.throws(() => assertMfpWrite({ ...ok, method: "PUT" }), /path not permitted/);
  assert.throws(() => assertMfpWrite({ ...ok, idempotencyKey: "" }), /idempotency key/);
  const close = buildMfpClose(pos(), 81000, null, 0.01, "cid", "i");
  assert.throws(() => assertMfpWrite({ ...close, body: { ...close.body, type: "limit" } }), /market close/);
  assert.throws(() => assertMfpWrite({ ...close, body: { ...close.body, slippage_tolerance_bps: 600 } }), /slippage/);
  assert.throws(() => assertMfpWrite({ ...close, body: { client_order_id: "cid", type: "market", expected_price: 81000 } }), /slippage/);
  assert.throws(() => assertMfpWrite({ ...close, path: "/v1/accounts/acct_1/close-all" }), /close path/);
  assert.throws(() => assertMfpWrite({ kind: "cancel", method: "DELETE", path: "/v1/orders", body: null, idempotencyKey: "i" }), /cancel path/);
  assert.throws(() => assertMfpWrite({ kind: "cancel", method: "DELETE", path: "/v1/orders/x", body: {}, idempotencyKey: "i" }), /no body/);
  assert.throws(() => assertMfpWrite({ kind: "margin", method: "POST", path: "/v1/positions/x/margin", body: {}, idempotencyKey: "i" }), /not permitted/);
  assert.throws(() => assertMfpWrite({ kind: "exits", method: "PUT", path: "/v1/positions/x/exit-orders", body: { expected_position_size: 1, expected_orders: [], operations: [{ kind: "place", group: "tp", price: 1, size: 2, execution_type: "market" }] }, idempotencyKey: "i" }), /exceed/);
  assert.throws(() => assertMfpWrite({ kind: "exits", method: "PUT", path: "/v1/positions/x/exit-orders", body: { expected_position_size: 1, expected_orders: [], operations: [{ kind: "place", group: "tp", price: 1, size: 1, execution_type: "limit" }] }, idempotencyKey: "i" }), /bad place/);
  assert.throws(() => { "use strict"; ok.body.size = 1; }, TypeError);
});

test("positions, accounts, orders, policy, quote, fills parse", () => {
  const p = pos();
  assert.equal(p.side, "long"); assert.equal(p.markPrice, 81300); assert.equal(p.liquidationPrice, 40000);
  assert.equal(parseMfpPositions({ data: [rawPos(), { id: "x" }] }), null);
  assert.deepEqual(parseMfpPositions({ data: [] }), []);
  const list = parseMfpAccounts({ data: [{ id: "acct_1", account_number: "A1", name: "Eval", stage: "evaluation", status: "active", starting_balance: 100000, balance: 100000, risk: { equity: 100010, unrealized_pnl: 10, margin_used: 81, available_balance: 99919, daily_loss_room: 4010, max_drawdown_room: 8010, remaining_profit_equity: 7990, marks_complete: true } }] });
  assert.equal(list[0].risk.dailyLossRoom, 4010);
  const row = { id: "ord_9", client_order_id: "tt-open-x", status: "resting", type: "limit", side: "buy", limit_price: 80000, size: 0.01, market_id: "hyperliquid|BTC", reduce_only: false };
  assert.equal(parseMfpOrderLookup({ data: [row] }, "tt-open-x").price, 80000);
  assert.equal(parseMfpOrderLookup({ data: [row] }, "someone-else"), null);
  assert.equal(parseMfpWorkingOrders({ data: [row] }).length, 1);
  assert.equal(parseMfpWorkingOrders({ data: [{ ...row, market_id: undefined }] }), null);
  assert.equal(mfpTerminal("pending"), false); assert.equal(mfpTerminal("canceled"), true);
  const policyBase = { manual_trading_blocked: false, opening_exposure_restricted: false, restriction: null, copy_follower_locked: false, competition: null, trading_halt: { platform: false }, limits: { order_cooldown_ms: 500, execution_delay_max_ms: 0 } };
  assert.deepEqual(parseMfpPolicy({ data: policyBase }), clearPolicy);
  assert.equal(parseMfpPolicy({ data: { ...policyBase, restriction: { restriction: "reduce_only" } } }).reduceOnlyRestricted, true);
  assert.match(mfpOpeningBlocked(null), /could not be read/);
  assert.deepEqual(parseMfpQuote({ data: { bid: 80999, ask: 81001, mid: 81000 } }), { bid: 80999, ask: 81001, mid: 81000 });
  assert.deepEqual(parseMfpQuote({ data: { mid: null } }), { bid: null, ask: null, mid: null });
  assert.deepEqual(parseMfpError(422, { error: { code: "rule_violation", message: "cooldown", request_id: "r" } }), { status: 422, code: "rule_violation", message: "cooldown" });
  assert.equal(parseMfpFills({ data: [{ id: "f1", side: "buy", size: 1, price: 2, fee: 0.1, filled_at: 5 }, { nope: 1 }] }).length, 1);
});

test("operation ids are printable, bounded and distinct", () => {
  const a = mfpOperationId("open", 1792000000000, 0.123);
  assert.match(a, /^tt-open-[a-z0-9]+-[a-z0-9]+$/);
  assert.notEqual(a, mfpOperationId("open", 1792000000000, 0.124));
});

test("reverse gates (copied discipline)", () => {
  const shown = pos();
  assert.equal(mfpReversePreCheck(shown, [pos()]), null);
  assert.match(mfpReversePreCheck(shown, null), /could not be read/);
  assert.match(mfpReversePreCheck(shown, [pos({ size: 0.002 })]), /size changed/);
  assert.match(mfpWorkingBlocksReverse([{ ...filledFlat, status: "resting", reduceOnly: false }], "binance|BTCUSDT"), /could add/);
  assert.equal(mfpWorkingBlocksReverse([{ ...filledFlat, status: "resting", reduceOnly: true }], "binance|BTCUSDT"), null);
  const ok = mfpReverseGate({ pre: shown, close: filledFlat, venueAfter: [], workingAfter: [], policy: clearPolicy });
  assert.deepEqual(ok, { ok: true, size: 0.001 });
  assert.equal(mfpReverseGate({ pre: shown, close: { ...filledFlat, positionSideAfter: "long" }, venueAfter: [], workingAfter: [], policy: clearPolicy }).ok, false);
  assert.equal(mfpReverseGate({ pre: shown, close: filledFlat, venueAfter: [], workingAfter: [{ ...filledFlat, id: "tp", status: "resting" }], policy: clearPolicy }).ok, false);
  assert.equal(mfpReverseGate({ pre: shown, close: filledFlat, venueAfter: [], workingAfter: [], policy: { ...clearPolicy, reduceOnlyRestricted: true } }).ok, false);
});

// ---- review F12: the parsers against the published schema --------------------------
// Fixtures in the shape of the public OpenAPI spec's Order and
// AccountTradingPolicy schemas (read 2026-11-11). Not live payloads.

const specOrder = (over = {}) => ({
  id: "ord_77", client_order_id: "tt-open-77", account_id: "acct_1", market_id: "hyperliquid|BTC", provider: "hyperliquid", symbol: "BTC", coin: "BTC",
  type: "market", mode: "market", side: "buy", size: 0.01, expected_price: 81000, fill_price: 81010, notional: 810.1, fee: 0.28, realized_pnl: 0,
  leverage: 5, margin_mode: "cross", reduce_only: false, status: "filled", position_side_after: "long", position_size_after: 0.01,
  requested_at: 1_762_000_000_000, settled_at: 1_762_000_000_450, ...over,
});

test("F12: a fill is a filled Order record - its id is the order id and its time is settled_at", () => {
  const [f] = parseMfpFills({ data: [specOrder()], has_more: false });
  assert.equal(f.id, "ord_77");
  assert.equal(f.orderId, "ord_77");                 // was null: the dedupe against recent orders never matched
  assert.equal(f.time, 1_762_000_000_450);           // was null: every row sorted to time 0
  assert.equal(f.price, 81010);
  assert.equal(f.size, 0.01);
  assert.equal(f.fee, 0.28);
  assert.equal(f.realizedPnl, 0);
  assert.equal(f.marketId, "hyperliquid|BTC");
  // requested_at when the record has no settled_at; seconds are read as seconds
  assert.equal(parseMfpFills({ data: [specOrder({ settled_at: undefined })] })[0].time, 1_762_000_000_000);
  assert.equal(parseMfpFills({ data: [specOrder({ settled_at: 1_762_000_000 })] })[0].time, 1_762_000_000_000);
});

test("F12: an order carries requested_at / settled_at, attached exits and its bracket role", () => {
  const o = parseMfpOrderLookup({ data: [specOrder({ attached_take_profit_price: 85000, attached_stop_loss_price: 78000 })] }, "tt-open-77");
  assert.equal(o.createdAt, 1_762_000_000_000);       // was null (the parser read created_at)
  assert.equal(o.settledAt, 1_762_000_000_450);
  assert.equal(o.takeProfitPrice, 85000);
  assert.equal(o.stopLossPrice, 78000);
  assert.equal(o.bracketRole, null);
  const stop = parseMfpWorkingOrders({ data: [specOrder({ id: "ord_78", client_order_id: undefined, type: "stop_market", status: "resting", reduce_only: true, trigger_price: 78000, bracket_role: "stop_loss", parent_order_id: "ord_77", target_position_id: "pos_1" })] })[0];
  assert.equal(stop.bracketRole, "stop_loss");
  assert.equal(stop.positionId, "pos_1");
  assert.equal(stop.triggerPrice, 78000);
});

test("F12: the policy's limits are read from their published names, each for what it is", () => {
  const policy = {
    account_id: "acct_1", manual_trading_blocked: false, opening_exposure_restricted: false, restriction: null, copy_follower_locked: false, competition: null,
    trading_halt: { platform: false, categories: [] },
    limits: { order_cooldown_ms: 500, execution_delay_min_ms: 0, execution_delay_max_ms: 0, max_open_positions: 10, max_position_value_usd: 150000, min_order_notional_usd: 10 },
    maximum_total_notional_usd: 400000,
  };
  const p = parseMfpPolicy({ data: policy });
  assert.equal(p.exposureCap, 150000);                // one position's value ceiling (was null)
  assert.equal(p.accountExposureCap, 400000);         // the account model / size total (was null)
  assert.equal(p.orderCooldownMs, 500);
  assert.equal(parseMfpPolicy({ data: { ...policy, maximum_total_notional_usd: null } }).accountExposureCap, null);
});

test("T7: mfpSizeFloors accepts the venue's floor of a requested size, never a size above it or an unrelated one", async () => {
  const { mfpSizeFloors } = await import("../src/lib/mfp_orders.ts");
  assert.equal(mfpSizeFloors(0.12345, 0.123), true);     // step 0.001
  assert.equal(mfpSizeFloors(0.12345, 0.12), true);      // step 0.01
  assert.equal(mfpSizeFloors(0.12345, 0.12345), true);   // no rounding
  assert.equal(mfpSizeFloors(2.5, 2), true);             // step 1
  assert.equal(mfpSizeFloors(0.12345, 1), false);        // above: the old size
  assert.equal(mfpSizeFloors(0.25, 0.1), false);         // more than one unit of its last decimal below
  assert.equal(mfpSizeFloors(0.12345, 0.122), false);
  assert.equal(mfpSizeFloors(0.12345, 0), false);
  assert.equal(mfpSizeFloors(0, 0), false);
});

// ---- which account a key is stored for (added 2026-11-17) ---------

const acct = (id, over = {}) => ({ id, accountNumber: id.toUpperCase(), name: "", stage: "evaluation", status: "active", startingBalance: 100000, balance: 100000, risk: null, ...over });

test("a key that sees one account is stored for it, on either environment", () => {
  for (const env of ["live", "sandbox"]) {
    assert.deepEqual(mfpPickAccount(env, [acct("a1")], null), { account: acct("a1"), sees: 1 });
    assert.deepEqual(mfpPickAccount(env, [acct("a1")], "a1"), { account: acct("a1"), sees: 1 });
    assert.throws(() => mfpPickAccount(env, [acct("a1")], "a2"), /does not see the account that was picked/);
    assert.throws(() => mfpPickAccount(env, [], null), /sees no account/);
    assert.throws(() => mfpPickAccount(env, [], "a1"), /sees no account/);
  }
});

test("a LIVE key that sees more than one account is refused, with or without a pick", () => {
  const two = [acct("a1"), acct("a2")];
  assert.throws(() => mfpPickAccount("live", two, null), /sees 2 accounts - scope it to ONE/);
  assert.throws(() => mfpPickAccount("live", two, "a1"), /sees 2 accounts - scope it to ONE/);
  assert.throws(() => mfpPickAccount("live", two, "a2"), /sees 2 accounts - scope it to ONE/);
});

test("a SANDBOX key that sees several accounts is never stored for one the user did not pick", () => {
  const three = [acct("a1"), acct("a2"), acct("a3")];
  // no pick yet: the list comes back and there is no account to store
  const first = mfpPickAccount("sandbox", three, null);
  assert.equal(first.account, null);
  assert.deepEqual(first.choose.map((a) => a.id), ["a1", "a2", "a3"]);
  // the pick: that account and no other, and how many the key sees
  assert.deepEqual(mfpPickAccount("sandbox", three, "a2"), { account: acct("a2"), sees: 3 });
  // a pick the key does not see (the list changed, or a made-up id) is refused
  assert.throws(() => mfpPickAccount("sandbox", three, "a9"), /does not see the account that was picked/);
  assert.throws(() => mfpPickAccount("sandbox", three, ""), /does not see the account that was picked/);
  // a list that names an account twice is not trusted
  assert.throws(() => mfpPickAccount("sandbox", [acct("a1"), acct("a1")], "a1"), /names an account twice/);
});

test("rows that name another account are counted, whatever the answer's shape", () => {
  assert.equal(mfpForeignRows({ data: [{ id: "p1", account_id: "a1" }, { id: "p2", account_id: "a1" }] }, "a1"), 0);
  assert.equal(mfpForeignRows({ data: [{ id: "p1", account_id: "a1" }, { id: "p2", account_id: "a2" }] }, "a1"), 1);
  assert.equal(mfpForeignRows({ data: { account_id: "a2" } }, "a1"), 1);       // a single object (the policy, one order)
  assert.equal(mfpForeignRows({ data: { account_id: "a1" } }, "a1"), 0);
  assert.equal(mfpForeignRows({ data: [] }, "a1"), 0);
  assert.equal(mfpForeignRows({ data: [{ id: "f1" }] }, "a1"), 0);             // a row with no account named is the parser's business
  assert.equal(mfpForeignRows(null, "a1"), 0);
  assert.equal(mfpForeignRows({}, "a1"), 0);
});
