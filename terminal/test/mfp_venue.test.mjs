// src/lib/mfp_venue.ts (the real adapter, its exchange client scripted) and
// the session guard in src/lib/mfp_exchange.ts (the real client, fetch
// scripted), loaded into a test world (test/helpers/world.mjs). Second
// external review: R1, R3, R5, R6.
import { test } from "node:test";
import assert from "node:assert/strict";

import { json, makeWorld } from "./helpers/world.mjs";

// An obviously fake key in the shape the client accepts (never a real one).
const FAKE_KEY = "fp_test_" + "fake".repeat(6);
const MARKET = "binance|BTCUSDT";

const rawPos = (over = {}) => ({
  id: "pos_1", accountId: "acct_1", marketId: MARKET, provider: "binance", symbol: "BTC", coin: "BTCUSDT", side: "long", size: 1, entryPrice: 100,
  leverage: 5, marginMode: "cross", liquidationPrice: null, markPrice: 100, unrealizedPnl: 0, sizeDecimals: 3, openedAt: null, ...over,
});
const rawOrder = (id, over = {}) => ({
  id, clientOrderId: null, marketId: MARKET, positionId: null, status: "resting", type: "limit", side: "buy", size: 1, price: 90, triggerPrice: null,
  fillPrice: null, reduceOnly: false, positionSideAfter: null, positionSizeAfter: null, rejectReason: null, createdAt: null, takeProfitPrice: null, stopLossPrice: null, ...over,
});

// The real adapter over a scripted exchange client.
function adapter(exchange = {}) {
  const view = { positions: [rawPos()], working: [] };
  const calls = [];
  const ex = {
    fetchMfpBook: async () => ({ positions: view.positions, working: view.working, at: 0 }),
    fetchMfpAccount: async () => ({ id: "acct_1", accountNumber: "A1", name: "", stage: "evaluation", status: "active", startingBalance: null, balance: 10000, risk: null }),
    fetchMfpPolicy: async () => null,
    mfpReadWait: () => 0,
    fetchMfpQuote: async () => ({ bid: null, ask: null, mid: 100 }),
    fetchMfpFills: async () => [], fetchMfpRecentOrders: async () => [], lookupMfpOrder: async () => null,
    ...Object.fromEntries(["mfpPlaceOrder", "mfpClosePosition", "mfpReversePosition", "mfpCancelMarketOrders", "mfpCancelOrder", "mfpModifyOrder", "mfpReplaceExits"].map((n) => [n, async () => { throw new Error("unscripted: " + n); }])),
  };
  for (const [name, fn] of Object.entries(exchange)) ex[name] = (...a) => { calls.push({ name, session: a[0] }); return fn(...a); };
  const w = makeWorld({
    mocks: {
      mfp_exchange: ex,
      keys: { mfpTradeKey: async () => FAKE_KEY, mfpReadKey: async () => FAKE_KEY, mfpAccountId: async () => "acct_1" },
      agent_store: { getMfpMeta: async () => ({ accountId: "acct_1" }) },
      hl_venue: { hlCoinSet: async () => new Set() },
      mfp_market_list: { mfpListSnapshot: () => ({ rows: [] }), refreshMfpList: async () => undefined },
    },
  });
  const { mfpVenue } = w.load("mfp_venue");
  return { w, clock: w.clock, venue: mfpVenue, view, calls, session: w.load("session") };
}

const market = { key: "mfp:" + MARKET, venue: "mfp", id: MARKET, symbol: "BTC", chartCoin: null, chartNote: null, szDecimals: null, maxLeverage: null, provider: "binance" };
const intent = (over = {}) => ({ venue: "mfp", marketId: MARKET, side: "buy", type: "market", size: 1, price: null, reduceOnly: false, postOnly: false, slippage: 0.01, tp: 110, sl: 90, leverage: 5, marginMode: "cross", ...over });
const closeResult = (over = {}) => ({ marketId: MARKET, basis: 1, requested: 1, order: null, pending: false, residual: 0, error: null, ambiguous: false, clientOrderId: "tt-close-1", refused: false, ...over });

// ---- R6 ----------------------------------------------------------------------------

test("R6: every exit asked for is reported whatever a non-refused entry answered", async () => {
  const send = (kind, over = {}) => async () => ({ kind, order: kind === "filled" ? rawOrder("ord_9", { status: "filled", fillPrice: 100 }) : kind === "resting" ? rawOrder("ord_9") : null, clientOrderId: "tt-open-9", message: kind === "pending" ? "still pending on MFP" : null, ambiguous: false, ...over });
  const states = async (fn) => {
    const a = adapter({ mfpPlaceOrder: fn });
    const out = await a.clock.settle(a.venue.placeOrder(intent(), market, 100, () => {}));
    return [out.state, (out.legs ?? []).map((l) => l.kind + ":" + l.price + ":" + l.state)];
  };
  assert.deepEqual(await states(send("filled")), ["confirmed", ["sl:90:sent", "tp:110:sent"]]);
  // the three the old adapter dropped the exits for:
  assert.deepEqual(await states(send("resting")), ["confirmed", ["sl:90:waiting", "tp:110:waiting"]]);
  assert.deepEqual(await states(send("pending")), ["pending", ["sl:90:waiting", "tp:110:waiting"]]);
  assert.deepEqual(await states(send("unknown", { ambiguous: true, message: "answer lost" })), ["unknown", ["sl:90:waiting", "tp:110:waiting"]]);
  // a refusal the venue itself gave: nothing is in flight, nothing to track
  assert.deepEqual(await states(send("rejected", { message: "insufficient margin" })), ["rejected", []]);
});

// ---- R5 ----------------------------------------------------------------------------

test("R5: a reverse stopped on a close MFP is still working on reports that close as a live write", async () => {
  const a = adapter({ mfpReversePosition: async () => ({ close: closeResult({ pending: true, residual: 1, error: "close still pending on MFP", clientOrderId: "tt-rev-close-1" }), open: null, stopped: "the close is still pending; no opening order was sent" }) });
  await a.clock.settle(a.venue.snapshot());
  const pos = { key: "mfp:" + MARKET, venue: "mfp", marketId: MARKET, symbol: "BTC", side: "long", size: 1, ref: { kind: "mfp", positionId: "pos_1", accountId: "acct_1", sizeDecimals: 3 } };
  const out = await a.clock.settle(a.venue.reverse(pos, 0.01, () => {}, 1_000_000));
  assert.equal(out.state, "partial");
  assert.deepEqual(out.live, [{ kind: "close", state: "sent", ref: { venue: "mfp", clientOrderId: "tt-rev-close-1" }, message: "close still pending on MFP", deadAfter: null }]);
});

test("R5: Flat with a cancel whose answer was lost reports that cancel as a live write", async () => {
  const a = adapter({
    mfpClosePosition: async () => ({ close: closeResult({ order: rawOrder("ord_c", { status: "filled" }) }), stopped: null }),
    mfpCancelMarketOrders: async () => ({ count: 1, errors: ["transport: timed out; the order still works"], live: ["ord_7"] }),
  });
  await a.clock.settle(a.venue.snapshot());
  const pos = { key: "mfp:" + MARKET, venue: "mfp", marketId: MARKET, symbol: "BTC", side: "long", size: 1, ref: { kind: "mfp", positionId: "pos_1", accountId: "acct_1", sizeDecimals: 3 } };
  const out = await a.clock.settle(a.venue.flat(pos, 0.01, () => {}));
  assert.equal(out.state, "partial");
  assert.equal(out.ambiguous, true);
  assert.deepEqual(out.live, [{ kind: "cancel", orderKeys: ["mfp:ord_7"], message: "answer lost", deadAfter: null }]);
  // a cancel the venue refused is a finished failure, not a live write
  const b = adapter({
    mfpClosePosition: async () => ({ close: closeResult({ order: rawOrder("ord_c", { status: "filled" }) }), stopped: null }),
    mfpCancelMarketOrders: async () => ({ count: 0, errors: ["order_not_cancellable"], live: [] }),
  });
  await b.clock.settle(b.venue.snapshot());
  const refused = await b.clock.settle(b.venue.flat(pos, 0.01, () => {}));
  assert.equal(refused.state, "partial");
  assert.equal(refused.live, undefined);
});

// ---- R2 / R3 ------------------------------------------------------------------------

test("R2: a close reports the venue position it was sized on, not the shown one", async () => {
  // shown 1; the client re-read the venue at 0.5 and closed half of that
  const a = adapter({ mfpClosePosition: async () => ({ close: closeResult({ basis: 0.5, requested: 0.25, residual: 0.25, order: rawOrder("ord_c", { status: "filled" }) }), stopped: null }) });
  await a.clock.settle(a.venue.snapshot());
  const pos = { key: "mfp:" + MARKET, venue: "mfp", marketId: MARKET, symbol: "BTC", side: "long", size: 1, ref: { kind: "mfp", positionId: "pos_1", accountId: "acct_1", sizeDecimals: 3 } };
  const out = await a.clock.settle(a.venue.closePosition(pos, 0.5, 0.01, () => {}));
  assert.equal(out.state, "confirmed");
  assert.deepEqual(out.sized, { from: 0.5, size: 0.25 });
  assert.deepEqual(out.ref, { venue: "mfp", clientOrderId: "tt-close-1" });
});

test("R3: a moved order is watched by its own id and never offered as proof of the move", async () => {
  const a = adapter({ mfpModifyOrder: async () => ({ ok: false, message: "transport: timed out; the order is unchanged", ambiguous: true }) });
  const o = { key: "mfp:ord_1", venue: "mfp", marketId: MARKET, symbol: "BTC", side: "buy", kind: "limit", price: 90, size: 1, reduceOnly: false, status: "resting", createdAt: null, ref: { kind: "mfp", orderId: "ord_1", clientOrderId: "tt-open-1", positionId: null } };
  const out = await a.clock.settle(a.venue.modifyOrder(o, 95, null, null));
  assert.equal(out.ambiguous, true);
  assert.deepEqual(out.watch, { venue: "mfp", clientOrderId: "tt-open-1" });
  assert.equal(out.ref, undefined);       // the order existed before the move: its presence proves nothing
  const venueMade = { ...o, ref: { ...o.ref, clientOrderId: null } };
  assert.equal((await a.clock.settle(a.venue.modifyOrder(venueMade, 95, null, null))).watch, null);
});

// ---- R1 ----------------------------------------------------------------------------

test("R1: every MFP write hands the exchange client the session it began in", async () => {
  const a = adapter({
    mfpPlaceOrder: async () => ({ kind: "rejected", order: null, clientOrderId: "tt-open-1", message: "no", ambiguous: false }),
    mfpCancelOrder: async () => ({ ok: true, message: null, ambiguous: false }),
    mfpModifyOrder: async () => ({ ok: true, message: null, ambiguous: false }),
  });
  const o = { key: "mfp:ord_1", venue: "mfp", marketId: MARKET, symbol: "BTC", side: "buy", kind: "limit", price: 90, size: 1, reduceOnly: false, status: "resting", createdAt: null, ref: { kind: "mfp", orderId: "ord_1", clientOrderId: null, positionId: null } };
  const before = a.session.currentSession();
  const p = a.venue.placeOrder(intent(), market, 100, () => {});   // begins in `before` ...
  a.session.endSession();                                           // ... and the app leaves that session before the key resolves
  await a.clock.settle(p);
  await a.clock.settle(a.venue.cancelOrder(o));
  await a.clock.settle(a.venue.modifyOrder(o, 95, null, null));
  assert.deepEqual(a.calls.map((c) => c.name + ":" + (c.session === before ? "old" : c.session === a.session.currentSession() ? "current" : "?")), ["mfpPlaceOrder:old", "mfpCancelOrder:current", "mfpModifyOrder:current"]);
});

test("R1: the MFP client refuses to send for a stale session, and says nothing was sent", async () => {
  let fetches = 0;
  const w = makeWorld({ fetch: async () => { fetches++; return json({}, 204); } });
  const ex = w.load("mfp_exchange");
  const { currentSession, endSession } = w.load("session");
  const old = currentSession();
  endSession();
  const r = await w.clock.settle(ex.mfpCancelOrder(old, FAKE_KEY, "acct_1", "ord_1"));
  assert.equal(fetches, 0);
  assert.equal(r.ok, false);
  assert.equal(r.ambiguous, false);        // a definite "not sent", never an unknown to chase
  assert.match(r.message, /stale_session/);
  const m = await w.clock.settle(ex.mfpModifyOrder(old, FAKE_KEY, "acct_1", "ord_1", 95, null));
  assert.equal(fetches, 0);
  assert.equal(m.ambiguous, false);
  // the current session sends
  const ok = await w.clock.settle(ex.mfpCancelOrder(currentSession(), FAKE_KEY, "acct_1", "ord_1"));
  assert.equal(fetches, 1);
  assert.equal(ok.ok, true);
});

// ---- F12 ----------------------------------------------------------------------------

test("F12: an order present in both the fills and the recent orders is one history row, with its time", async () => {
  const filledOrder = rawOrder("ord_77", { status: "filled", type: "market", fillPrice: 100, createdAt: 1_762_000_000_000, settledAt: 1_762_000_000_450 });
  const a = adapter();
  a.w.mocks.mfp_exchange.fetchMfpFills = async () => [{ id: "ord_77", orderId: "ord_77", marketId: MARKET, symbol: "BTC", side: "buy", size: 1, price: 100, fee: 0.1, realizedPnl: 0, time: 1_762_000_000_450 }];
  a.w.mocks.mfp_exchange.fetchMfpRecentOrders = async () => [filledOrder, rawOrder("ord_78", { status: "canceled", createdAt: 1_762_000_100_000 })];
  const rows = await a.clock.settle(a.venue.history());
  assert.deepEqual(rows.map((r) => [r.key, r.status, r.time]), [
    ["mfp:ord:ord_78", "canceled", 1_762_000_100_000],
    ["mfp:fill:ord_77", "filled", 1_762_000_000_450],      // once, not once per list; and not at time 0
  ]);
});

// ---- the independent review of the R1-R9 repairs -----------------------------------------

test("R1: cancelExit keeps the session it began in when it falls back to cancelling the order itself", async () => {
  const a = adapter({ mfpCancelOrder: async () => ({ ok: true, message: null, ambiguous: false }) });
  // no snapshot was taken: the position is not in the adapter's last read
  const pos = { key: "mfp:" + MARKET, venue: "mfp", marketId: MARKET, symbol: "BTC", side: "long", size: 1, ref: { kind: "mfp", positionId: "pos_gone", accountId: "acct_1", sizeDecimals: 3 } };
  const o = { key: "mfp:ord_1", venue: "mfp", marketId: MARKET, symbol: "BTC", side: "sell", kind: "sl", price: 90, size: 1, reduceOnly: true, status: "resting", createdAt: null, ref: { kind: "mfp", orderId: "ord_1", clientOrderId: null, positionId: null } };
  const before = a.session.currentSession();
  const p = a.venue.cancelExit(pos, o);      // begins in `before`
  a.session.endSession();                    // the switch lands while the key is being unlocked
  await a.clock.settle(p);
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].session, before);  // the old code re-captured here and got the NEW session, which would send
});

test("R5: a reverse whose close was sent and left no order record keeps that close on the ledger", async () => {
  // the close's answer could not be read and nothing was found by its id; the position is unchanged
  const a = adapter({ mfpReversePosition: async () => ({ close: closeResult({ order: null, pending: false, refused: false, ambiguous: false, residual: 1, error: "no close order found after 20 s - check MFP before acting", clientOrderId: "tt-rev-close-3" }), open: null, stopped: "the close did not complete; no opening order was sent" }) });
  await a.clock.settle(a.venue.snapshot());
  const pos = { key: "mfp:" + MARKET, venue: "mfp", marketId: MARKET, symbol: "BTC", side: "long", size: 1, ref: { kind: "mfp", positionId: "pos_1", accountId: "acct_1", sizeDecimals: 3 } };
  const out = await a.clock.settle(a.venue.reverse(pos, 0.01, () => {}, 1_000_000));
  assert.equal(out.state, "partial");          // the old code answered rejected, ambiguous: false - and the ledger forgot it
  assert.equal(out.ambiguous, true);
  assert.deepEqual(out.live, [{ kind: "close", state: "unknown", ref: { venue: "mfp", clientOrderId: "tt-rev-close-3" }, message: "no close order found after 20 s - check MFP before acting", deadAfter: null }]);
  // a close the venue itself refused is still a plain refusal
  const b = adapter({ mfpReversePosition: async () => ({ close: closeResult({ order: null, refused: true, residual: 1, error: "rule_violation", clientOrderId: "tt-rev-close-4" }), open: null, stopped: "the close did not complete; no opening order was sent" }) });
  await b.clock.settle(b.venue.snapshot());
  const refused = await b.clock.settle(b.venue.reverse(pos, 0.01, () => {}, 1_000_000));
  assert.equal(refused.state, "rejected");
  assert.equal(refused.live, undefined);
});

test("the MFP lookup reports an executed part on an order that ended without a 'filled' status", async () => {
  const a = adapter();
  const look = async (o) => { a.w.mocks.mfp_exchange.lookupMfpOrder = async () => o; return a.clock.settle(a.venue.lookup({ venue: "mfp", clientOrderId: "tt-open-1" })); };
  assert.deepEqual(await look(rawOrder("ord_1", { status: "canceled", filledSize: 0.4 })), { status: "done", full: false, filled: 0.4, message: "canceled" });
  assert.equal((await look(rawOrder("ord_1", { status: "canceled", filledSize: null }))).filled, 0);
  assert.deepEqual(await look(rawOrder("ord_1", { status: "filled", size: 1 })), { status: "done", full: true, filled: 1, message: "filled" });
  assert.equal((await look(rawOrder("ord_1", { status: "resting" }))).resting, true);
  assert.equal((await look(rawOrder("ord_1", { status: "pending" }))).resting, false);
  assert.equal((await look(null)).status, "unseen");
});

// ---- one account per key (added 2026-11-17) ------------------------

const rawAccount = (id, over = {}) => ({ id, account_number: id.toUpperCase(), name: "", stage: "evaluation", status: "active", starting_balance: 100000, balance: 100000, ...over });
const LIVE_KEY = "fp_live_" + "fake".repeat(6);

test("a sandbox key that sees two accounts: the list first, then the picked account, asked of the venue each time", async () => {
  const seen = [];
  const w = makeWorld({ fetch: async (url, init) => { seen.push(init.method + " " + url); return json({ data: [rawAccount("acct_1"), rawAccount("acct_2")] }); } });
  const ex = w.load("mfp_exchange");
  const first = await ex.verifyMfpKey(FAKE_KEY);
  assert.equal(first.env, "sandbox");
  assert.equal(first.account, null, "nothing to store until an account is picked");
  assert.deepEqual(first.choose.map((a) => a.id), ["acct_1", "acct_2"]);
  const picked = await ex.verifyMfpKey(FAKE_KEY, "acct_2");
  assert.equal(picked.account.id, "acct_2");
  assert.equal(picked.sees, 2);
  await assert.rejects(ex.verifyMfpKey(FAKE_KEY, "acct_9"), /does not see the account that was picked/);
  assert.equal(seen.length, 3, "the account list is read again for every check");
  assert.ok(seen.every((s) => s.startsWith("GET ") && s.endsWith("/v1/accounts")), seen.join(" | "));
});

test("a live key that sees two accounts is refused, even with an account named", async () => {
  const w = makeWorld({ fetch: async () => json({ data: [rawAccount("acct_1"), rawAccount("acct_2")] }) });
  const ex = w.load("mfp_exchange");
  await assert.rejects(ex.verifyMfpKey(LIVE_KEY), /sees 2 accounts - scope it to ONE/);
  await assert.rejects(ex.verifyMfpKey(LIVE_KEY, "acct_1"), /sees 2 accounts - scope it to ONE/);
});

test("a key that sees one account is stored for it as before", async () => {
  const w = makeWorld({ fetch: async () => json({ data: [rawAccount("acct_1")] }) });
  const ex = w.load("mfp_exchange");
  for (const key of [FAKE_KEY, LIVE_KEY]) {
    const v = await ex.verifyMfpKey(key);
    assert.equal(v.account.id, "acct_1");
    assert.equal(v.sees, 1);
  }
});

test("a read answered with another account's rows is unreadable, never shown as this account's", async () => {
  const venuePos = (account_id) => ({
    id: "pos_1", account_id, market_id: MARKET, provider: "binance", symbol: "BTC", coin: "BTCUSDT", side: "long", size: 0.001,
    entry_price: 81212.9, leverage: 1, margin_mode: "cross", status: "open", opened_at: 1, size_decimals: 3, liquidation_price: 40000, mark_price: 81300, unrealized_pnl: 0.09,
  });
  const venueOrder = (account_id) => ({ id: "ord_9", client_order_id: "tt-open-x", account_id, status: "resting", type: "limit", side: "buy", limit_price: 80000, size: 0.01, market_id: MARKET, reduce_only: false });
  // The venue's filter is ignored: each answer is scripted per case.
  const world = (answers) => makeWorld({
    fetch: async (url) => {
      const path = url.replace(/^https:\/\/[^/]+/, "").replace(/^\/mfp\/(sandbox|live)/, ""); // the venue host, or the web build's own path
      if (path.startsWith("/v1/accounts/acct_1/trading-policy")) return json({ data: {} });
      if (path.startsWith("/v1/accounts/")) return json({ data: answers.account ?? rawAccount("acct_1") });
      if (path.startsWith("/v1/positions")) return json({ data: answers.positions ?? [] });
      if (path.startsWith("/v1/orders")) return json({ data: answers.orders ?? [] });
      if (path.startsWith("/v1/fills")) return json({ data: answers.fills ?? [] });
      throw new Error("unscripted read: " + path);
    },
  }).load("mfp_exchange");

  // this account's own rows read as before
  const ok = await world({ positions: [venuePos("acct_1")], orders: [venueOrder("acct_1")] }).fetchMfpBook(FAKE_KEY, "acct_1");
  assert.equal(ok.positions.length, 1);
  assert.equal(ok.working.length, 1);

  await assert.rejects(world({ positions: [venuePos("acct_1"), venuePos("acct_2")] }).fetchMfpBook(FAKE_KEY, "acct_1"), /another account's rows/);
  await assert.rejects(world({ orders: [venueOrder("acct_2")] }).fetchMfpBook(FAKE_KEY, "acct_1"), /another account's rows/);
  await assert.rejects(world({ account: rawAccount("acct_2") }).fetchMfpAccount(FAKE_KEY, "acct_1"), /another account/);
  assert.equal((await world({}).fetchMfpAccount(FAKE_KEY, "acct_1")).id, "acct_1");
  // the client_order_id lookup: another account's order is not "this app's order"
  await assert.rejects(world({ orders: [venueOrder("acct_2")] }).lookupMfpOrder(FAKE_KEY, "acct_1", "tt-open-x"), /another account's rows/);
  assert.equal((await world({ orders: [venueOrder("acct_1")] }).lookupMfpOrder(FAKE_KEY, "acct_1", "tt-open-x")).id, "ord_9");
  // history is display only, and still not another account's
  await assert.rejects(world({ orders: [venueOrder("acct_2")] }).fetchMfpRecentOrders(FAKE_KEY, "acct_1"), /another account's rows/);
  await assert.rejects(world({ fills: [{ id: "f1", account_id: "acct_2", market_id: MARKET, side: "buy", size: 0.001, fill_price: 81000 }] }).fetchMfpFills(FAKE_KEY, "acct_1"), /another account's rows/);
});
