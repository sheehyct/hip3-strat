// src/lib/venue_store.ts, the REAL store, loaded into a test world
// (test/helpers/world.mjs) and driven through whole writes: register,
// call the client, record the answer, re-read, settle. Hyperliquid tests
// run the real adapter and exchange client against a scripted venue; the
// others use a scripted VenueClient. These replay a second external
// review's store-level probes.
import { test } from "node:test";
import assert from "node:assert/strict";

import { cancelled, deferred, fakeHyperliquid, fakeSettings, filled, makeWorld, openOrder, TEST_KEY } from "./helpers/world.mjs";

const ticker = { midOf: () => null, resetTicker() {}, tickerMarketsChanged() {} };

// A scripted VenueClient: a book the snapshot reads, and write methods the
// test replaces one at a time.
function scripted(id, marketId = "BTC") {
  const market = { key: id + ":" + marketId, venue: id, id: marketId, symbol: "BTC", chartCoin: null, chartNote: null, szDecimals: 3, maxLeverage: 40, provider: null };
  const c = {
    id, market, positions: [], orders: [], lookups: [], leverageReads: 0,
    onLookup: async () => ({ status: "unreadable", full: false, filled: 0, message: null }),
    onLeverage: async () => null,
    async ready() { return true; },
    async tradeBlocked() { return null; },
    async markets() { return [market]; },
    async snapshot() { return { venue: id, positions: c.positions.map((p) => ({ ...p })), orders: c.orders.map((o) => ({ ...o })), balance: null, mids: { [marketId]: 100 }, chg24: {}, at: 0 }; },
    async history() { return []; },
    async quote() { return { bid: null, ask: null, mid: 100, at: 0 }; },
    lookup(ref) { c.lookups.push(ref); return c.onLookup(ref); },
    leverage(m) { c.leverageReads++; return c.onLeverage(m); },
  };
  for (const w of ["placeOrder", "closePosition", "flat", "reverse", "cancelOrder", "modifyOrder", "setExit", "cancelExit", "setLeverage"]) {
    c[w] = async () => { throw new Error("unscripted write: " + w); };
  }
  return c;
}

const position = (venue, side, size, marketId = "BTC") => ({
  key: venue + ":" + marketId, venue, marketId, symbol: "BTC", chartCoin: null, side, size, entry: 100, mark: 100, pnl: 0, notional: size * 100,
  liq: null, leverage: 10, marginMode: "cross", marginUsed: null,
  ref: venue === "hl" ? { kind: "hl", dex: "", szi: side === "long" ? size : -size } : { kind: "mfp", positionId: "pos_1", accountId: "acct", sizeDecimals: 3 },
});
const order = (venue, n, side, kind, price, marketId = "BTC") => ({
  key: venue + ":ord_" + n, venue, marketId, symbol: "BTC", side, kind, price, size: 1, reduceOnly: kind !== "limit", status: "resting", createdAt: null,
  ref: venue === "hl" ? { kind: "hl", dex: "", oid: n, cloid: null, isTrigger: kind !== "limit" } : { kind: "mfp", orderId: "ord_" + n, clientOrderId: null, positionId: null },
});

const intent = (over = {}) => ({ venue: "hl", marketId: "BTC", side: "buy", type: "market", size: 1, price: null, reduceOnly: false, postOnly: false, slippage: 0.01, tp: null, sl: null, leverage: 5, marginMode: "cross", ...over });

// The store over two scripted clients.
async function scriptedStore() {
  const hl = scripted("hl");
  const mfp = scripted("mfp");
  const settings = fakeSettings();
  const w = makeWorld({ mocks: { settings_store: settings, ticker_store: ticker, mode: { isMock: () => settings.getSettings().demo, mockScenario: () => "" }, hl_venue: { hlVenue: hl }, mfp_venue: { mfpVenue: mfp } } });
  const store = w.load("venue_store");
  return { w, clock: w.clock, store, hl, mfp, settings, start: async () => { await store.startVenues(); await w.clock.flush(); } };
}

// The store over the REAL Hyperliquid adapter and exchange client, against a
// scripted Hyperliquid; MFP is a scripted client with nothing on it.
async function hlStore(keys = { hlTradeKey: async () => TEST_KEY }) {
  const venue = fakeHyperliquid();
  const settings = fakeSettings();
  const w = makeWorld({
    fetch: (url, init) => venue.fetch(url, init),
    mocks: {
      settings_store: settings, ticker_store: ticker, keys, mode: { isMock: () => settings.getSettings().demo, mockScenario: () => "" },
      agent_store: { getAgentMeta: async () => ({ address: "0x" + "2".repeat(40) }) }, mfp_venue: { mfpVenue: scripted("mfp") },
    },
  });
  const store = w.load("venue_store");
  return { w, clock: w.clock, store, venue, settings, start: async () => { await store.startVenues(); await w.clock.flush(); } };
}

const logText = (store) => store.venueState().log.map((l) => l.state + ": " + l.text);
const pendingOf = (store) => store.venueState().pending.map((p) => p.kind + ":" + p.state);

// ---- R1 ----------------------------------------------------------------------------

test("R1: a live order waiting on key access is not sent after the switch to demo, and writes nothing into the demo log", async () => {
  const gate = deferred();
  const s = await hlStore({ hlTradeKey: () => gate.promise });
  await s.start();
  const market = s.store.marketByKey("hl:BTC");
  assert.ok(market, "the market list loaded");
  const p = s.store.placeOrder(intent(), market);
  await s.clock.flush();
  assert.deepEqual(pendingOf(s.store), ["order:working"]);

  s.settings.updateSettings({ demo: true });          // the switch, while the fingerprint prompt is still up
  await s.clock.flush();
  assert.equal(s.store.venueState().mock, true);
  const before = logText(s.store).length;

  gate.resolve(TEST_KEY);
  const out = await s.clock.settle(p);
  assert.equal(s.venue.sends.length, 0);              // nothing reached the exchange endpoint
  assert.equal(out.state, "unknown");                 // and the old write does not come back "confirmed"
  assert.match(out.message, /switched between demo and live/);
  assert.equal(logText(s.store).length, before);      // no "building the order" / "sending" in the demo log
  assert.ok(!logText(s.store).some((l) => /^step: (building the order|sending buy)/.test(l)));
  // the write that was in flight at the switch is named once, as no longer followed
  assert.ok(logText(s.store).some((l) => /^unknown: BUY 1 BTC: no longer followed here \(demo was switched on/.test(l)));
  assert.ok(!s.store.venueState().pending.some((x) => x.label.startsWith("BUY 1 BTC")));
  assert.equal(s.store.venueState().busy, 0);
});

// ---- R2 ----------------------------------------------------------------------------

test("R2: Close 50% on a stale shown size - the close is sized on the venue and a lost answer is never 'confirmed'", async () => {
  const s = await hlStore();
  s.venue.positions = [{ coin: "BTC", szi: 1 }];
  await s.start();
  assert.equal(s.store.positionByKey("hl:BTC").size, 1);
  s.venue.positions = [{ coin: "BTC", szi: 0.5 }];    // the venue shrank; the screen still shows 1
  s.venue.exchange = () => { throw new Error("network down"); };   // the close's answer is lost; it never arrived
  const out = await s.clock.settle(s.store.closePosition("hl:BTC", 0.5));
  assert.equal(s.venue.sends.length, 1);
  assert.equal(s.venue.sends[0].action.orders[0].s, "0.25");       // half of the venue's 0.5, not of the shown 1
  assert.notEqual(out.state, "confirmed");            // the old store answered "confirmed" here, on the shown size
  await s.clock.advance(10_000);
  const log = logText(s.store);
  assert.ok(!log.some((l) => l.startsWith("confirmed: close 50% BTC")), log.join("\n"));
  assert.ok(log.some((l) => /rejected: close 50% BTC: did not reach the venue/.test(l)), log.join("\n"));
  assert.ok(s.venue.infoCalls.some((c) => c.type === "orderStatus"));   // settled by asking the venue about THAT order
  assert.deepEqual(pendingOf(s.store), []);
});

test("R2: a close the venue answered is confirmed once the re-read shows it", async () => {
  const s = await hlStore();
  s.venue.positions = [{ coin: "BTC", szi: 1 }];
  await s.start();
  s.venue.exchange = () => { s.venue.positions = [{ coin: "BTC", szi: 0.5 }]; return filled(0.5); };
  const out = await s.clock.settle(s.store.closePosition("hl:BTC", 0.5));
  assert.equal(out.state, "confirmed");
  assert.deepEqual(pendingOf(s.store), []);
});

// ---- R5 ----------------------------------------------------------------------------

test("R5: Flat with a lost cancel keeps the cancel on the ledger; a move of the still-shown order is refused until it settles", async () => {
  const s = await hlStore();
  s.venue.positions = [{ coin: "BTC", szi: 1 }];
  s.venue.orders = [openOrder(11, 90), openOrder(12, 80)];
  await s.start();
  s.venue.exchange = (action) => {
    if (action.type === "order") { s.venue.positions = []; return filled(1); }
    throw new Error("network down");                  // the cancel's answer is lost; both orders still rest
  };
  const out = await s.clock.settle(s.store.flatPosition("hl:BTC"));
  assert.equal(out.state, "partial");
  assert.deepEqual(pendingOf(s.store), ["cancel:unknown"]);         // the old store had nothing pending here
  const sent = s.venue.sends.length;

  // re-arranging the orders would race the cancel: refused, nothing sent
  const move = await s.store.modifyOrder("hl:11", 95, null);
  assert.equal(move.state, "rejected");
  assert.match(move.message, /not settled/);
  assert.equal(s.venue.sends.length, sent);
  // cancelling is never locked behind it
  s.venue.exchange = () => { s.venue.orders = s.venue.orders.filter((o) => o.oid !== 11); return cancelled(1); };
  assert.equal((await s.clock.settle(s.store.cancelOrder("hl:11"))).state, "confirmed");
  // the lost cancel's payload expires with order 12 still resting: it did not apply
  await s.clock.advance(30_000);
  assert.deepEqual(pendingOf(s.store), []);
  assert.ok(logText(s.store).some((l) => /rejected: cancel orders on BTC: did not apply: the order still rests/.test(l)), logText(s.store).join("\n"));
});

// ---- R6 ----------------------------------------------------------------------------

test("R6: exits attached to an MFP entry that answered 'pending' are tracked, each by itself", async () => {
  const s = await scriptedStore();
  await s.start();
  const ref = { venue: "mfp", clientOrderId: "tt-open-1" };
  const legs = [
    { kind: "sl", price: 90, state: "waiting", message: null, orderKey: null, ref: null, deadAfter: null },
    { kind: "tp", price: 110, state: "waiting", message: null, orderKey: null, ref: null, deadAfter: null },
  ];
  s.mfp.placeOrder = async () => ({ state: "pending", message: "still pending on MFP", ambiguous: false, ref, legs });
  const out = await s.clock.settle(s.store.placeOrder(intent({ venue: "mfp", sl: 90, tp: 110 }), s.mfp.market));
  assert.equal(out.state, "pending");
  assert.deepEqual(pendingOf(s.store), ["order:verifying"]);
  assert.equal(s.store.venueState().pending[0].exits.length, 2);

  // a position appears, but the venue still calls the entry pending: it is
  // not credited to the entry (another order's fill would look the same)
  // (the MFP book is read every 10 s by the timer: mfp_rate / PACE in venue_store.ts)
  s.mfp.onLookup = async () => ({ status: "open", full: false, filled: 0, message: "pending", resting: false });
  s.mfp.positions = [position("mfp", "long", 1)];
  await s.clock.advance(11_000);
  assert.deepEqual(pendingOf(s.store), ["order:verifying"]);
  // the venue says the entry filled; it shows the position and NO exits (the audit's probe)
  s.mfp.onLookup = async () => ({ status: "done", full: true, filled: 1, message: "filled" });
  await s.clock.advance(11_000);
  assert.deepEqual(pendingOf(s.store), ["sl:verifying", "tp:verifying"]);   // the old store had nothing pending here
  assert.ok(logText(s.store).some((l) => l.startsWith("confirmed: BUY 1 BTC")));

  // the stop shows up; the take-profit never does
  s.mfp.orders = [order("mfp", 2, "sell", "sl", 90)];
  await s.clock.advance(11_000);
  assert.deepEqual(pendingOf(s.store), ["tp:verifying"]);
  await s.clock.advance(30_000);
  assert.deepEqual(pendingOf(s.store), ["tp:unknown"]);                     // flagged, never dropped
  assert.ok(logText(s.store).some((l) => /unknown: tp BTC at 110: not shown by the venue/.test(l)));
  // it holds the market for new exposure until it is dismissed
  s.mfp.placeOrder = async () => { throw new Error("must not be called"); };
  assert.match((await s.store.placeOrder(intent({ venue: "mfp" }), s.mfp.market)).message, /not settled/);
});

// ---- R8 ----------------------------------------------------------------------------

test("R8: a leverage change with no position is confirmed only by reading the venue's setting back", async () => {
  const s = await scriptedStore();
  await s.start();
  s.hl.setLeverage = async () => ({ state: "confirmed", message: "5x cross", ambiguous: false, deadAfter: s.clock.now() + 20_000 });
  s.hl.onLeverage = async () => { throw new Error("leverage unreadable"); };
  const out = await s.clock.settle(s.store.setLeverage("hl:BTC", 5, true));
  assert.notEqual(out.state, "confirmed");                                  // the old store confirmed on the answer alone
  assert.deepEqual(pendingOf(s.store), ["leverage:verifying"]);
  assert.ok(s.hl.leverageReads > 0);
  // new exposure waits for it
  s.hl.placeOrder = async () => { throw new Error("must not be called"); };
  assert.match((await s.store.placeOrder(intent(), s.hl.market)).message, /not settled/);
  // the venue still shows the old setting: not confirmed
  s.hl.onLeverage = async () => ({ leverage: 10, marginMode: "cross" });
  await s.clock.advance(6_000);
  assert.deepEqual(pendingOf(s.store), ["leverage:verifying"]);
  // the venue shows the new setting: confirmed
  s.hl.onLeverage = async () => ({ leverage: 5, marginMode: "cross" });
  await s.clock.advance(6_000);
  assert.deepEqual(pendingOf(s.store), []);
  assert.ok(logText(s.store).some((l) => l.startsWith("confirmed: 5x cross BTC")));
});

// ---- R9 ----------------------------------------------------------------------------

test("R9: a status lookup that never answers does not hold the venue's other writes", async () => {
  const s = await scriptedStore();
  s.hl.orders = [order("hl", 5, "buy", "limit", 90)];
  await s.start();
  // an order whose answer was lost, and a venue that never answers when asked about it
  s.hl.placeOrder = async () => ({ state: "unknown", message: "transport: timed out", ambiguous: true, ref: { venue: "hl", cloid: "0x" + "ab".repeat(16) }, deadAfter: s.clock.now() + 20_000 });
  s.hl.onLookup = () => new Promise(() => {});
  const lostOrder = s.store.placeOrder(intent(), s.hl.market);
  await s.clock.flush();
  // a cancel on the same venue must still be settled (exits are never locked)
  s.hl.cancelOrder = async () => { s.hl.orders = []; return { state: "confirmed", message: "cancelled", ambiguous: false }; };
  const t0 = s.clock.now();
  const out = await s.clock.settle(s.store.cancelOrder("hl:ord_5"), 60_000);
  assert.equal(out.state, "confirmed");
  assert.ok(s.clock.now() - t0 <= 30_000, "settled after the lookup's deadline, not never");
  assert.equal((await s.clock.settle(lostOrder, 60_000)).state, "unknown");
  assert.deepEqual(pendingOf(s.store), ["order:unknown"]);                  // the lost order is still there: unanswered is not settled
});

// ---- the lock, through the store -----------------------------------------------------

test("an unsettled write blocks new exposure on its market and never a close", async () => {
  const s = await scriptedStore();
  s.hl.positions = [position("hl", "long", 1)];
  await s.start();
  s.hl.placeOrder = async () => ({ state: "unknown", message: "transport: timed out", ambiguous: true, ref: { venue: "hl", cloid: "0x" + "cd".repeat(16) } });
  assert.equal((await s.clock.settle(s.store.placeOrder(intent(), s.hl.market))).state, "unknown");
  s.hl.placeOrder = async () => { throw new Error("must not be called"); };
  assert.match((await s.store.placeOrder(intent(), s.hl.market)).message, /not settled/);
  s.hl.closePosition = async () => { s.hl.positions = []; return { state: "confirmed", message: "closed 1", ambiguous: false, filled: 1, sized: { from: 1, size: 1 } }; };
  assert.equal((await s.clock.settle(s.store.closePosition("hl:BTC", 1))).state, "confirmed");
});

// ---- F2: a wallet change is a new session ----------------------------------------------

test("F2: changing the tracked wallet ends the session - an order waiting on its key is never sent, and the ledger is reset", async () => {
  const gate = deferred();
  const s = await hlStore({ hlTradeKey: () => gate.promise, hlKeyRefusal: async () => null });
  await s.start();
  const p = s.store.placeOrder(intent(), s.store.marketByKey("hl:BTC"));
  await s.clock.flush();
  assert.deepEqual(pendingOf(s.store), ["order:working"]);

  s.settings.updateSettings({ wallet: "0x" + "9".repeat(40) });   // another wallet, while the key prompt is up
  await s.clock.flush();
  assert.deepEqual(pendingOf(s.store), []);            // nothing of the old wallet stays on the ledger
  gate.resolve(TEST_KEY);
  const out = await s.clock.settle(p);
  assert.equal(s.venue.sends.length, 0);               // and nothing is signed for it
  assert.equal(out.state, "unknown");
  assert.equal(s.store.venueState().busy, 0);
  // reads now go to the new wallet
  assert.ok(s.venue.infoCalls.some((c) => c.user === "0x" + "9".repeat(40)));
});

test("F2: an unsettled live write is named in the log when the wallet changes under it", async () => {
  const s = await scriptedStore();
  await s.start();
  s.hl.placeOrder = async () => ({ state: "unknown", message: "transport: timed out", ambiguous: true, ref: { venue: "hl", cloid: "0x" + "ef".repeat(16) } });
  await s.clock.settle(s.store.placeOrder(intent(), s.hl.market));
  assert.deepEqual(pendingOf(s.store), ["order:unknown"]);
  s.settings.updateSettings({ wallet: "0x" + "9".repeat(40) });
  await s.clock.flush();
  assert.deepEqual(pendingOf(s.store), []);
  assert.ok(logText(s.store).some((l) => /unknown: BUY 1 BTC: no longer followed here \(the tracked wallet changed; .*\) - check the venue/.test(l)), logText(s.store).join("\n"));
  // the same wallet in another letter case is not a change
  const before = logText(s.store).length;
  s.settings.updateSettings({ wallet: "0X".toLowerCase() + "9".repeat(40) });
  await s.clock.flush();
  assert.equal(logText(s.store).length, before);
});

test("R6: exits attached to a RESTING MFP limit are checked when it fills, without locking the market meanwhile", async () => {
  const s = await scriptedStore();
  await s.start();
  const ref = { venue: "mfp", clientOrderId: "tt-open-2" };
  const legs = [{ kind: "sl", price: 90, state: "waiting", message: null, orderKey: null, ref: null, deadAfter: null }];
  s.mfp.placeOrder = async () => { s.mfp.orders = [order("mfp", 5, "buy", "limit", 95)]; return { state: "confirmed", message: "resting", ambiguous: false, orderKey: "mfp:ord_5", ref, legs }; };
  const out = await s.clock.settle(s.store.placeOrder(intent({ venue: "mfp", type: "limit", price: 95, sl: 90 }), s.mfp.market));
  assert.equal(out.state, "confirmed");
  assert.deepEqual(pendingOf(s.store), []);                       // settled: the resting order locks nothing
  assert.ok(logText(s.store).some((l) => /unknown: sl BTC at 90: attached to the resting order/.test(l)));
  await s.clock.advance(20_000);
  assert.equal(s.mfp.lookups.length, 0);                          // while it rests, the venue is not asked
  // hours later it fills: it leaves the book, and the venue says so
  s.mfp.orders = [];
  s.mfp.positions = [position("mfp", "long", 1)];
  s.mfp.onLookup = async () => ({ status: "done", full: true, filled: 1, message: "filled" });
  await s.clock.advance(11_000);
  assert.deepEqual(pendingOf(s.store), ["sl:verifying"]);         // the old code had nothing here, ever
  // the stop never shows: flagged for the user
  await s.clock.advance(30_000);
  assert.deepEqual(pendingOf(s.store), ["sl:unknown"]);
});

// ---- a lost answer does not hold the exits while the client waits it out ----------------

test("while a client waits out a lost answer, Close and Cancel are free and new exposure is not", async () => {
  const s = await scriptedStore();
  s.hl.positions = [position("hl", "long", 1)];
  s.hl.orders = [order("hl", 5, "buy", "limit", 90)];
  await s.start();
  const gate = deferred();
  let closes = 0;
  s.hl.closePosition = async (_p, _f, _sl, step) => {
    closes++;
    if (closes > 1) return { state: "rejected", message: "second close refused by the venue", ambiguous: false };
    step("answer lost (transport: timed out); waiting 20 s for the payload to expire, then looking it up - not resending", "lost");
    await gate.promise;
    step("reading the venue");
    return { state: "unknown", message: "answer lost", ambiguous: true, ref: { venue: "hl", cloid: "0x" + "aa".repeat(16) }, deadAfter: s.clock.now() };
  };
  const first = s.store.closePosition("hl:BTC", 0.5);
  await s.clock.flush();
  // the call has not come back, but it is no longer "in flight": it only waits
  assert.deepEqual(pendingOf(s.store), ["close:unknown"]);
  assert.deepEqual(s.store.marketLocks(s.store.venueState().pending, "hl", "BTC"), { reduce: false, open: true });
  // a second Close goes to the venue (the old store refused it: "a write is already in flight")
  assert.equal((await s.clock.settle(s.store.closePosition("hl:BTC", 0.5))).message, "second close refused by the venue");
  assert.equal(closes, 2);
  // so does a Cancel
  s.hl.cancelOrder = async () => { s.hl.orders = []; return { state: "confirmed", message: "cancelled", ambiguous: false }; };
  assert.equal((await s.clock.settle(s.store.cancelOrder("hl:ord_5"))).state, "confirmed");
  // new exposure still waits
  s.hl.placeOrder = async () => { throw new Error("must not be called"); };
  assert.match((await s.store.placeOrder(intent(), s.hl.market)).message, /not settled/);
  // it cannot be dismissed while its call is still out (it would only come back)
  const waiting = s.store.venueState().pending[0];
  assert.equal(s.store.canDismiss(waiting), false);
  s.store.dismissPending(waiting.id);
  assert.deepEqual(pendingOf(s.store), ["close:unknown"]);
  // the call comes back: the next step puts it in flight for its read, then it is answered
  gate.resolve();
  assert.equal((await s.clock.settle(first)).state, "unknown");
  assert.equal(s.store.canDismiss(s.store.venueState().pending[0]), true);
});

test("Hyperliquid: a close whose answer is lost frees Cancel within the wait, not after it", async () => {
  const s = await hlStore();
  s.venue.positions = [{ coin: "BTC", szi: 1 }];
  s.venue.orders = [openOrder(11, 90)];
  await s.start();
  s.venue.exchange = (action) => {
    if (action.type === "cancel") { s.venue.orders = []; return cancelled(1); }
    throw new Error("network down");
  };
  const close = s.store.closePosition("hl:BTC", 1);
  await s.clock.advance(3_000);                       // 3 s into a wait of about 20 s
  assert.deepEqual(pendingOf(s.store), ["close:unknown"]);
  const c = await s.clock.settle(s.store.cancelOrder("hl:11"));
  assert.equal(c.state, "confirmed");
  assert.deepEqual(s.venue.sends.map((x) => x.action.type), ["order", "cancel"]);
  assert.notEqual((await s.clock.settle(close)).state, "confirmed");
});

// ---- T5: a waiting sequence does not resume sending over another write ----------------

test("T5: a reverse whose close waited does not send its opening order once a Close started meanwhile", async () => {
  const s = await hlStore();
  s.venue.positions = [{ coin: "BTC", szi: 1 }];
  await s.start();
  let firstCloid = null, inFlight = 0, overlap = false;
  const release = deferred();
  s.venue.exchange = async (action) => {
    const o = action.orders[0];
    if (s.venue.sends.length === 1) { firstCloid = o.c; throw new Error("lost"); }
    if (s.venue.sends.length === 2) { inFlight++; await release.promise; inFlight--; return filled(0.5); }
    overlap = inFlight > 0;
    s.venue.positions = [{ coin: "BTC", szi: -1 }];
    return filled(1);
  };
  s.venue.info.orderStatus = (b) => {
    assert.equal(b.oid, firstCloid);
    s.venue.positions = [];
    return { status: "order", order: { order: { coin: "BTC", oid: 1, side: "A", sz: "0", origSz: "1", cloid: firstCloid }, status: "filled" } };
  };
  const rev = s.store.reversePosition("hl:BTC", true);
  await s.clock.flush();
  await s.clock.advance(19_000);
  assert.equal(s.store.venueState().pending[0].state, "unknown");   // the reverse only waits
  const closing = s.store.closePosition("hl:BTC", 0.5);             // allowed: Close is never locked behind a wait
  await s.clock.flush();
  assert.equal(inFlight, 1);
  await s.clock.advance(2_000);                                     // the reverse's close is found filled
  assert.equal(overlap, false);
  assert.deepEqual(s.venue.sends.map((x) => x.action.orders[0].r), [true, true]);   // the opening order was never signed
  release.resolve();
  const r = await s.clock.settle(rev);
  assert.equal(r.state, "partial");
  assert.match(r.message, /another write on this market started while this one was waiting/);
  await s.clock.settle(closing);
  assert.equal(s.venue.sends.length, 2);
});

test("T5: with nothing else started, a reverse whose close waited still opens", async () => {
  const s = await hlStore();
  s.venue.positions = [{ coin: "BTC", szi: 1 }];
  await s.start();
  let firstCloid = null;
  s.venue.exchange = async (action) => {
    const o = action.orders[0];
    if (s.venue.sends.length === 1) { firstCloid = o.c; throw new Error("lost"); }
    s.venue.positions = [{ coin: "BTC", szi: -1 }];
    return filled(1);
  };
  s.venue.info.orderStatus = () => {
    s.venue.positions = [];
    return { status: "order", order: { order: { coin: "BTC", oid: 1, side: "A", sz: "0", origSz: "1", cloid: firstCloid }, status: "filled" } };
  };
  const r = await s.clock.settle(s.store.reversePosition("hl:BTC", true));
  assert.deepEqual(s.venue.sends.map((x) => x.action.orders[0].r), [true, false]);
  assert.equal(r.state, "confirmed");
});

test("T5: an attached exit is not sent after a lost entry answer if a Cancel started meanwhile; it is reported NOT placed", async () => {
  const s = await hlStore();
  s.venue.orders = [openOrder(11, 90)];
  await s.start();
  let entryCloid = null;
  s.venue.exchange = async (action) => {
    if (action.type === "cancel") { s.venue.orders = []; return cancelled(1); }
    if (s.venue.sends.length === 1) { entryCloid = action.orders[0].c; throw new Error("lost"); }
    throw new Error("an exit must not be sent");
  };
  s.venue.info.orderStatus = () => {
    s.venue.positions = [{ coin: "BTC", szi: 1 }];
    return { status: "order", order: { order: { coin: "BTC", oid: 2, side: "B", sz: "0", origSz: "1", cloid: entryCloid }, status: "filled" } };
  };
  const entry = s.store.placeOrder(intent({ sl: 90 }), s.store.marketByKey("hl:BTC"));
  await s.clock.advance(5_000);
  assert.equal((await s.clock.settle(s.store.cancelOrder("hl:11"))).state, "confirmed");
  await s.clock.settle(entry);
  assert.deepEqual(s.venue.sends.map((x) => x.action.type), ["order", "cancel"]);
  assert.ok(logText(s.store).some((l) => /rejected: sl BTC at 90 NOT placed: another write on this market started/.test(l)), logText(s.store).join("\n"));
});

test("Hyperliquid: a new stop whose answer is lost frees Close within the wait, not after it", async () => {
  const s = await hlStore();
  s.venue.positions = [{ coin: "BTC", szi: 1 }];
  await s.start();
  s.venue.exchange = (action) => {
    if (action.orders[0].r && action.orders[0].t.limit) { s.venue.positions = []; return filled(1); }   // the close (IoC)
    throw new Error("network down");                                                                     // the stop's answer is lost
  };
  const sl = s.store.setExit("hl:BTC", "sl", 90);
  await s.clock.advance(3_000);                       // 3 s into a wait of about 20 s
  assert.deepEqual(pendingOf(s.store), ["sl:unknown"]);
  assert.deepEqual(s.store.marketLocks(s.store.venueState().pending, "hl", "BTC"), { reduce: false, open: true });
  const c = await s.clock.settle(s.store.closePosition("hl:BTC", 1));
  assert.equal(c.state, "confirmed");
  assert.ok(s.clock.now() < 1_700_000_000_000 + 15_000, "the close did not wait for the stop's payload to expire");
  await s.clock.settle(sl);
});
