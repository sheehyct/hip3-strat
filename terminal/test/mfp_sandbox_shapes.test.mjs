// MFP payload shapes as the SANDBOX (paper) API actually returned them
// (read on 2026-11-11, read-only). Every id, account number and
// client_order_id below is replaced by a fake, and every price, size, fee,
// balance, PnL and time by a round stand-in; the field names, the types and
// which fields are present are the venue's. These pin items that were
// first written from the docs against a real payload.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMfpAccounts, parseMfpFills, parseMfpOrder, parseMfpPolicy, parseMfpRecentOrders, parseMfpWorkingOrders } from "../src/lib/mfp_orders.ts";
import { makeWorld } from "./helpers/world.mjs";

const ACCT = "acct_fake_sandbox";

// An entry stop-market resting with an attached stop (a working order).
const stopEntry = {
  account_id: ACCT, attached_stop_loss_price: 54, client_order_id: "fake-entry-1", coin: "LTCUSDT", expected_price: 60, filled_size: 0,
  id: "ord_fake_1", initial_size: 50, leverage: 1, margin_mode: "cross", market_id: "binance|LTCUSDT", mode: "stop_market", provider: "binance",
  reduce_only: false, requested_at: 1794400000000, side: "buy", size: 50, status: "resting", symbol: "LTC", time_in_force: "gtc",
  trigger_price: 60, type: "stop_market",
};
// A canceled entry.
const canceled = { ...stopEntry, id: "ord_fake_2", client_order_id: "fake-entry-2", status: "canceled", cancel_reason: "user", canceled_at: 1794300000000 };
// A filled entry that created its stop (filled in one execution: filled_size stays 0).
const filledEntry = {
  account_id: ACCT, attached_stop_loss_price: 6.5, client_order_id: "fake-entry-3", coin: "UNIUSDT", expected_price: 8, fee: 0.5,
  fill_price: 8, filled_size: 0, id: "ord_fake_3", initial_size: 200, leverage: 1, margin_mode: "cross", market_id: "binance|UNIUSDT",
  mode: "stop_market", notional: 1600, position_side_after: "long", position_size_after: 200, provider: "binance", realized_pnl: 0,
  reduce_only: false, requested_at: 1793700000000, settled_at: 1793800001000, side: "buy", size: 200, status: "filled",
  stop_loss_order_id: "ord_fake_4", symbol: "UNI", time_in_force: "gtc", trigger_price: 8, triggered_at: 1793800000000, type: "stop_market",
};
// The stop that entry's fill created, as a fill record.
const filledStop = {
  account_id: ACCT, bracket_role: "stop_loss", coin: "UNIUSDT", expected_price: 6.5, fee: 0.4, fill_price: 6.5, filled_size: 0,
  id: "ord_fake_4", initial_size: 200, leverage: 1, margin_mode: "cross", market_id: "binance|UNIUSDT", mode: "stop_market", notional: 1300,
  parent_order_id: "ord_fake_3", position_side_after: "flat", position_size_after: 0, provider: "binance", realized_pnl: -300,
  reduce_only: true, requested_at: 1793800001000, settled_at: 1793900000000, side: "sell", size: 200, status: "filled", symbol: "UNI",
  time_in_force: "gtc", trigger_price: 6.5, triggered_at: 1793900000000, type: "stop_market",
};

test("sandbox: a working stop-market entry parses, and is NOT taken for a stop loss", () => {
  const rows = parseMfpWorkingOrders({ data: [stopEntry] });
  assert.equal(rows.length, 1);
  const o = rows[0];
  assert.equal(o.status, "resting");
  assert.equal(o.reduceOnly, false);
  assert.equal(o.triggerPrice, 60);
  assert.equal(o.filledSize, 0);
  const w = makeWorld({ mocks: { hl_venue: { hlCoinSet: async () => new Set() }, mfp_market_list: { mfpListSnapshot: () => ({ rows: [] }), refreshMfpList: async () => undefined } } });
  const { mfpOrderKind } = w.load("mfp_venue");
  assert.equal(mfpOrderKind(o), "other");
  // a reduce-only stop, or one the venue names as an attached stop, is one
  assert.equal(mfpOrderKind({ ...o, reduceOnly: true }), "sl");
  assert.equal(mfpOrderKind(parseMfpOrder(filledStop)), "sl");
});

test("sandbox: filled_size stays 0 on an order that filled in one execution; size is what executed", () => {
  const o = parseMfpOrder(filledEntry);
  assert.equal(o.status, "filled");
  assert.equal(o.size, 200);
  assert.equal(o.filledSize, 0);
  assert.equal(o.positionSideAfter, "long");
  assert.equal(o.positionSizeAfter, 200);
  assert.equal(o.attachedStopLossPrice ?? o.stopLossPrice, 6.5);
});

test("sandbox: fills are filled order records; the exit names its role and its entry", () => {
  const fills = parseMfpFills({ data: [filledStop, filledEntry] });
  assert.equal(fills.length, 2);
  assert.equal(fills[0].orderId, "ord_fake_4");
  assert.equal(fills[0].price, 6.5);
  assert.equal(fills[0].size, 200);
  assert.equal(fills[0].time, 1793900000000);     // settled_at, milliseconds
  assert.equal(fills[0].realizedPnl, -300);
  const exit = parseMfpOrder(filledStop);
  assert.equal(exit.bracketRole, "stop_loss");
});

test("sandbox: recent orders keep canceled rows with their time", () => {
  const rows = parseMfpRecentOrders({ data: [stopEntry, canceled] });
  assert.deepEqual(rows.map((r) => r.status), ["resting", "canceled"]);
  assert.equal(rows[0].createdAt, 1794400000000);   // requested_at, milliseconds
});

test("sandbox: the account and the trading policy parse", () => {
  const accts = parseMfpAccounts({ data: [{ account_number: "FP-00000000", balance: 99000.5, created_at: 1792000000000.5, id: ACCT, name: "API Sandbox", stage: "evaluation", starting_balance: 100000, status: "active" }] });
  assert.equal(accts.length, 1);
  assert.equal(accts[0].balance, 99000.5);
  const p = parseMfpPolicy({ data: {
    account_id: ACCT, advisory: true, manual_trading_blocked: false, maximum_total_notional_usd: null, opening_exposure_restricted: false, restriction: null,
    trading_halt: { categories: [], platform: false }, stage: "evaluation", status: "active",
    limits: { execution_delay_max_ms: 0, execution_delay_min_ms: 0, max_position_value_usd: 99999999, max_resting_orders: 20, min_order_notional_usd: 10, order_cooldown_ms: 500, trades_per_minute: 30 },
  } });
  assert.ok(p);
  assert.equal(p.orderCooldownMs, 500);
  assert.equal(p.executionDelayMaxMs, 0);
  assert.equal(p.exposureCap, 99999999);
  assert.equal(p.accountExposureCap, null);
});
