// The Hyperliquid info client, exchange client and venue adapter, loaded
// from source into a test world (test/helpers/world.mjs): fake clock, fake
// fetch, the SDK's published test key. These are a second external
// review's findings (R1, R2, R4, R5, R7, R8 and R9) at the module boundary
// where they were found.
import { test } from "node:test";
import assert from "node:assert/strict";

import { cancelled, deferred, fakeHyperliquid, fakeSettings, FAKE_WALLET, filled, json, makeWorld, openOrder, TEST_KEY } from "./helpers/world.mjs";

const CLOID = "0x0123456789abcdef0123456789abcdef";

function world(over = {}) {
  const hl = fakeHyperliquid();
  const w = makeWorld({
    fetch: (url, init) => hl.fetch(url, init),
    mocks: {
      settings_store: fakeSettings(),
      keys: { hlTradeKey: async () => TEST_KEY },
      agent_store: { getAgentMeta: async () => ({ address: "0x" + "2".repeat(40) }) },
      ...over,
    },
  });
  return { w, hl, clock: w.clock };
}

const orderRecord = (status, over = {}) => ({
  status: "order",
  order: { order: { coin: "BTC", side: "B", limitPx: "100", sz: "0", oid: 7, timestamp: 1, origSz: "1", cloid: CLOID, ...over }, status, statusTimestamp: 2 },
});

// ---- R9: the read deadline covers the body ------------------------------------------

test("R9: a response whose body never arrives is cut off, not waited on for ever", async () => {
  const { w, clock } = world();
  let calls = 0;
  w.fetch = async () => { calls++; return { ok: true, status: 200, json: () => new Promise(() => {}) }; };
  const { infoPost } = w.load("hyperliquid");
  await assert.rejects(clock.settle(infoPost({ type: "clearinghouseState" })), /timed out/);
  assert.equal(calls, 4);                 // the first attempt and its three retries, each cut off
  assert.equal(clock.pending(), 0);       // and no timer is left behind
});

test("R9: a read that answers clears its deadline", async () => {
  const { w, clock } = world();
  w.fetch = async () => json({ BTC: "100" });
  const { infoPost } = w.load("hyperliquid");
  assert.deepEqual(await clock.settle(infoPost({ type: "allMids" })), { BTC: "100" });
  assert.equal(clock.pending(), 0);
});

test("R9: an exchange post whose body stalls is a lost answer after the post timeout", async () => {
  const { w, hl, clock } = world();
  hl.positions = [{ coin: "BTC", szi: 1 }];
  const { fetch: scripted } = hl;
  w.fetch = async (url, init) => {
    if (String(url).endsWith("/exchange")) { hl.sends.push(JSON.parse(init.body)); return { ok: true, status: 200, json: () => new Promise(() => {}) }; }
    return scripted(url, init);
  };
  const { hlVenue } = w.load("hl_venue");
  const market = (await clock.settle(hlVenue.markets()))[0];
  const intent = { venue: "hl", marketId: "BTC", side: "buy", type: "market", size: 1, price: null, reduceOnly: false, postOnly: false, slippage: 0.01, tp: null, sl: null, leverage: 5, marginMode: "cross" };
  const out = await clock.settle(hlVenue.placeOrder(intent, market, 100, () => {}));
  assert.equal(hl.sends.length, 1);       // sent once, never resent
  assert.equal(out.state, "unknown");
  assert.equal(out.ambiguous, true);
});

// ---- R4: a malformed status is unreadable, never "the venue does not know it" ----------

test("R4: only the venue's explicit unknownOid reads as 'not known'", () => {
  const { w } = world();
  const { parseOrderStatus } = w.load("hyperliquid");
  assert.equal(parseOrderStatus({ status: "unknownOid" }), null);
  assert.equal(parseOrderStatus(orderRecord("filled")).status, "filled");
  for (const bad of [
    { status: "order", order: {} },                                   // the audit's fixture
    { status: "order" },
    { status: "order", order: { order: { coin: "BTC" } } },           // no status
    orderRecord("filled", { origSz: undefined }),                     // a size that would default to zero
    orderRecord("canceled", { sz: "abc" }),
    orderRecord("filled", { oid: undefined }),
    { status: "weird" }, null, "order",
  ]) {
    assert.throws(() => parseOrderStatus(bad), /order status unreadable/, JSON.stringify(bad));
  }
});

test("R4: the adapter's lookup reports a malformed status as unreadable; unknownOid as unseen; open as resting", async () => {
  const { w, hl, clock } = world();
  const { hlVenue } = w.load("hl_venue");
  const ref = { venue: "hl", cloid: CLOID };
  hl.statuses[CLOID] = { status: "order", order: {} };
  assert.equal((await clock.settle(hlVenue.lookup(ref))).status, "unreadable");
  delete hl.statuses[CLOID];
  assert.equal((await clock.settle(hlVenue.lookup(ref))).status, "unseen");
  hl.statuses[CLOID] = orderRecord("open", { sz: "1" });
  assert.deepEqual(await clock.settle(hlVenue.lookup(ref)), { status: "open", full: false, filled: 0, message: "open", resting: true });
  hl.statuses[CLOID] = orderRecord("filled");
  assert.deepEqual(await clock.settle(hlVenue.lookup(ref)), { status: "done", full: true, filled: 1, message: "filled", resting: false });
});

// ---- R7: an incomplete read is never "flat" or "complete" ---------------------------------

test("R7: a position row with no coin makes the clearinghouse unreadable (it is not skipped)", () => {
  const { w } = world();
  const { sizeInClearinghouse } = w.load("hl_exchange");
  assert.equal(sizeInClearinghouse({ assetPositions: [] }, "BTC"), 0);
  assert.equal(sizeInClearinghouse({ assetPositions: [{ position: { coin: "ETH", szi: "2" } }] }, "BTC"), 0);
  assert.equal(sizeInClearinghouse({ assetPositions: [{ position: { coin: "BTC", szi: "-0.5" } }] }, "BTC"), -0.5);
  for (const bad of [
    { assetPositions: [{ position: { szi: "1" } }] },                 // the audit's fixture
    { assetPositions: [{ position: { coin: "", szi: "1" } }] },
    { assetPositions: [{}] },
    { assetPositions: [null] },
    { assetPositions: [{ position: { coin: "ETH", szi: "x" } }] },    // another coin's size unreadable: still not a complete read
    { assetPositions: [{ position: { coin: "BTC", szi: "" } }] },
    { assetPositions: [{ position: { coin: "BTC", szi: "1" } }, { position: { coin: "BTC", szi: "2" } }] },
    {}, null,
  ]) {
    assert.throws(() => sizeInClearinghouse(bad, "BTC"), /unreadable/, JSON.stringify(bad));
  }
});

test("R7: the dex list is exact or unreadable - never 'the main dex only'", () => {
  const { w } = world();
  const { parseDexList } = w.load("hyperliquid");
  assert.deepEqual(parseDexList([null]), [""]);
  assert.deepEqual(parseDexList([null, { name: "xyz" }, { name: "abc" }]), ["", "xyz", "abc"]);
  for (const bad of [null, undefined, {}, [], [{ name: "xyz" }], [null, null], [null, {}], [null, { name: "" }], [null, { name: 5 }], [null, { name: "xyz" }, { name: "xyz" }]]) {
    assert.throws(() => parseDexList(bad), /dex list unreadable/, JSON.stringify(bad));
  }
});

test("R7: a snapshot does not pass for complete when the dex list cannot be read", async () => {
  const { w, hl, clock } = world();
  hl.info.perpDexs = () => null;
  const { hlVenue } = w.load("hl_venue");
  await assert.rejects(clock.settle(hlVenue.snapshot()), /dex list unreadable/);
});

test("R7: a malformed read after the close never satisfies a reverse's 'flat' gate", async () => {
  const { w, hl, clock } = world();
  hl.positions = [{ coin: "BTC", szi: 1 }];
  let reads = 0;
  const good = hl.info.clearinghouseState;
  // the pre-read and the adapter's own reads are valid; every read after the close is malformed
  hl.info.clearinghouseState = (b) => (hl.sends.length === 0 ? good(b) : (reads++, { assetPositions: [{ position: { szi: "1" } }] }));
  hl.exchange = () => filled(1);
  const { reversePosition } = w.load("hl_exchange");
  const { currentSession } = w.load("session");
  const r = await clock.settle(reversePosition(currentSession(), FAKE_WALLET, { coin: "BTC", dex: "", szi: 1 }, TEST_KEY, 1_000_000));
  assert.ok(reads > 0);
  assert.equal(hl.sends.length, 1);                                    // the close only
  assert.equal(hl.sends[0].action.orders[0].r, true);                  // and it was reduce-only
  assert.equal(r.open, null);
  assert.match(r.stopped, /no opening order was sent/);
  assert.equal(r.close.residual, null);                                // unknown, not 0
});

// ---- R1: nothing is signed for a write whose session has ended ------------------------

test("R1: the exchange client refuses to sign for a stale session, on every write", async () => {
  const { w, hl, clock } = world();
  hl.positions = [{ coin: "BTC", szi: 1 }];
  const ex = w.load("hl_exchange");
  const { currentSession, endSession, StaleSession } = w.load("session");
  const { buildLimitOrder, newCloid } = w.load("hl_orders");
  const asset = await clock.settle(ex.assetFor("BTC"));
  const old = currentSession();
  endSession();
  const order = buildLimitOrder(asset, true, 1, 90, "Gtc", false, newCloid(clock.now()));
  await assert.rejects(clock.settle(ex.sendOrder(old, FAKE_WALLET, TEST_KEY, order)), StaleSession);
  await assert.rejects(clock.settle(ex.cancelOrders(old, FAKE_WALLET, TEST_KEY, [{ asset, oid: 5 }])), StaleSession);
  await assert.rejects(clock.settle(ex.modifyOrder(old, FAKE_WALLET, TEST_KEY, 5, order, "")), StaleSession);
  await assert.rejects(clock.settle(ex.setLeverage(old, TEST_KEY, asset, true, 5)), StaleSession);
  await assert.rejects(clock.settle(ex.closePosition(old, FAKE_WALLET, { coin: "BTC", dex: "", szi: 1 }, TEST_KEY, { cancelRest: true })), StaleSession);
  assert.equal(hl.sends.length, 0);
  // the session that is current still sends
  hl.exchange = () => ({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 9 } }] } } });
  assert.equal((await clock.settle(ex.sendOrder(currentSession(), FAKE_WALLET, TEST_KEY, order))).kind, "resting");
  assert.equal(hl.sends.length, 1);
});

test("R1: an order waiting on key access when the app leaves live mode is never sent", async () => {
  const gate = deferred();
  const { w, hl, clock } = world({ keys: { hlTradeKey: () => gate.promise } });
  const { hlVenue } = w.load("hl_venue");
  const { endSession } = w.load("session");
  const market = (await clock.settle(hlVenue.markets()))[0];
  const intent = { venue: "hl", marketId: "BTC", side: "buy", type: "market", size: 1, price: null, reduceOnly: false, postOnly: false, slippage: 0.01, tp: null, sl: null, leverage: 5, marginMode: "cross" };
  const p = hlVenue.placeOrder(intent, market, 100, () => {});
  await clock.flush();
  endSession();                           // demo is switched on while the fingerprint prompt is up
  gate.resolve(TEST_KEY);
  await assert.rejects(clock.settle(p), /switched between demo and live/);
  assert.equal(hl.sends.length, 0);
});

test("R1: a reverse whose session ends between its legs closes and does not open", async () => {
  const { w, hl, clock } = world();
  hl.positions = [{ coin: "BTC", szi: 1 }];
  const { endSession } = w.load("session");
  hl.exchange = () => { hl.positions = []; endSession(); return filled(1); };   // the switch lands while the close is answering
  const { hlVenue } = w.load("hl_venue");
  const pos = { key: "hl:BTC", venue: "hl", marketId: "BTC", symbol: "BTC", side: "long", size: 1, ref: { kind: "hl", dex: "", szi: 1 } };
  const out = await clock.settle(hlVenue.reverse(pos, 0.01, () => {}, 1_000_000));
  assert.equal(hl.sends.length, 1);
  assert.equal(hl.sends[0].action.orders[0].r, true);
  assert.equal(out.state, "partial");
  assert.match(out.message, /the opening order was not sent/);
});

// ---- R5: Flat's cancel, when its answer is lost, is still alive ------------------------------

test("R5: Flat with a lost cancel reports the cancel as a live write with its own expiry", async () => {
  const { w, hl, clock } = world();
  hl.positions = [{ coin: "BTC", szi: 1 }];
  hl.orders = [openOrder(11, 90), openOrder(12, 80)];
  hl.exchange = (action) => {
    if (action.type === "order") { hl.positions = []; return filled(1); }
    throw new Error("network down");      // the cancel's answer is lost; the orders still rest
  };
  const { hlVenue } = w.load("hl_venue");
  const pos = { key: "hl:BTC", venue: "hl", marketId: "BTC", symbol: "BTC", side: "long", size: 1, ref: { kind: "hl", dex: "", szi: 1 } };
  const out = await clock.settle(hlVenue.flat(pos, 0.01, () => {}));
  assert.deepEqual(hl.sends.map((s) => s.action.type), ["order", "cancel"]);
  assert.equal(out.state, "partial");
  assert.equal(out.ambiguous, true);       // the old code answered ambiguous: false here
  assert.equal(out.live.length, 1);
  assert.equal(out.live[0].kind, "cancel");
  assert.deepEqual(out.live[0].orderKeys, ["hl:11", "hl:12"]);
  assert.ok(out.live[0].deadAfter > clock.now());   // the cancel's payload is still valid
});

test("R5: a cancel the venue REFUSED is a finished failure, not a live write", async () => {
  const { w, hl, clock } = world();
  hl.positions = [{ coin: "BTC", szi: 1 }];
  hl.orders = [openOrder(11, 90)];
  hl.exchange = (action) => {
    if (action.type === "order") { hl.positions = []; return filled(1); }
    return { status: "ok", response: { type: "cancel", data: { statuses: [{ error: "Order was never placed" }] } } };
  };
  const { hlVenue } = w.load("hl_venue");
  const pos = { key: "hl:BTC", venue: "hl", marketId: "BTC", symbol: "BTC", side: "long", size: 1, ref: { kind: "hl", dex: "", szi: 1 } };
  const out = await clock.settle(hlVenue.flat(pos, 0.01, () => {}));
  assert.equal(out.state, "partial");
  assert.equal(out.live, undefined);
  assert.match(out.message, /orders still rest/);
});

test("Flat: the position closed and the orders cancelled is a claim for the ledger to verify", async () => {
  const { w, hl, clock } = world();
  hl.positions = [{ coin: "BTC", szi: 1 }];
  hl.orders = [openOrder(11, 90)];
  hl.exchange = (action) => {
    if (action.type === "order") { hl.positions = []; return filled(1); }
    hl.orders = [];
    return cancelled(1);
  };
  const { hlVenue } = w.load("hl_venue");
  const pos = { key: "hl:BTC", venue: "hl", marketId: "BTC", symbol: "BTC", side: "long", size: 1, ref: { kind: "hl", dex: "", szi: 1 } };
  const out = await clock.settle(hlVenue.flat(pos, 0.01, () => {}));
  assert.equal(out.state, "confirmed");
  assert.match(out.message, /flat; 1 order\(s\) cancelled/);
});

// ---- R2: a close is sized on the venue's position, and a smaller position is not its proof ----

test("R2: a close reports the position it was sized on and the size it sent", async () => {
  const { w, hl, clock } = world();
  hl.positions = [{ coin: "BTC", szi: 0.5 }];               // the venue; the screen still shows 1
  hl.exchange = () => { hl.positions = [{ coin: "BTC", szi: 0.25 }]; return filled(0.25); };
  const { hlVenue } = w.load("hl_venue");
  const shown = { key: "hl:BTC", venue: "hl", marketId: "BTC", symbol: "BTC", side: "long", size: 1, ref: { kind: "hl", dex: "", szi: 1 } };
  const out = await clock.settle(hlVenue.closePosition(shown, 0.5, 0.01, () => {}));
  assert.equal(hl.sends[0].action.orders[0].s, "0.25");      // half of what the venue holds
  assert.equal(out.state, "confirmed");
  assert.deepEqual(out.sized, { from: 0.5, size: 0.25 });
});

test("R2: a close whose answer was lost is not credited with a position that shrank for another reason", async () => {
  const { w, hl, clock } = world();
  hl.positions = [{ coin: "BTC", szi: 1 }];
  // the close never reaches the venue; something else halves the position meanwhile
  hl.exchange = () => { hl.positions = [{ coin: "BTC", szi: 0.5 }]; throw new Error("network down"); };
  const { hlVenue } = w.load("hl_venue");
  const shown = { key: "hl:BTC", venue: "hl", marketId: "BTC", symbol: "BTC", side: "long", size: 1, ref: { kind: "hl", dex: "", szi: 1 } };
  const out = await clock.settle(hlVenue.closePosition(shown, 0.5, 0.01, () => {}));
  assert.equal(hl.sends.length, 1);
  assert.equal(out.state, "unknown");                        // the old code answered "confirmed: closed 0.5"
  assert.equal(out.ambiguous, true);
  assert.equal(out.ref.venue, "hl");                         // the ledger can ask the venue about this order
  assert.deepEqual(out.sized, { from: 1, size: 0.5 });
});

// ---- R8: the venue's leverage setting can be read with no position -------------------------

test("R8: the adapter reads a market's leverage from the venue, and an unreadable answer throws", async () => {
  const { w, hl, clock } = world();
  const { hlVenue } = w.load("hl_venue");
  const market = (await clock.settle(hlVenue.markets()))[0];
  assert.deepEqual(await clock.settle(hlVenue.leverage(market)), { leverage: 10, marginMode: "cross" });
  assert.deepEqual(hl.infoCalls.at(-1), { type: "activeAssetData", user: FAKE_WALLET, coin: "BTC" });
  hl.info.activeAssetData = (b) => ({ coin: b.coin, leverage: { type: "isolated", value: 3, rawUsd: "0.0" } });
  assert.deepEqual(await clock.settle(hlVenue.leverage(market)), { leverage: 3, marginMode: "isolated" });
  for (const bad of [null, {}, { coin: "ETH", leverage: { type: "cross", value: 3 } }, { coin: "BTC", leverage: { type: "cross" } }, { coin: "BTC", leverage: { type: "portfolio", value: 3 } }]) {
    hl.info.activeAssetData = () => bad;
    await assert.rejects(clock.settle(hlVenue.leverage(market)), /leverage unreadable/);
  }
});

// ---- a reverse's opening order is judged on the order, not on the position ---------------

const longPos = { key: "hl:BTC", venue: "hl", marketId: "BTC", symbol: "BTC", side: "long", size: 1, ref: { kind: "hl", dex: "", szi: 1 } };

test("reverse: a lost opening answer with a position on the new side is NOT 'now short' - the order is asked about", async () => {
  const { w, hl, clock } = world();
  hl.positions = [{ coin: "BTC", szi: 1 }];
  let n = 0;
  hl.exchange = () => {
    n++;
    if (n === 1) { hl.positions = []; return filled(1); }             // the close
    hl.positions = [{ coin: "BTC", szi: -1 }];                         // a short appears, from elsewhere
    throw new Error("network down");                                   // the opening order's answer is lost; the venue never saw it
  };
  const { hlVenue } = w.load("hl_venue");
  const out = await clock.settle(hlVenue.reverse(longPos, 0.01, () => {}, 1_000_000));
  assert.equal(hl.sends.length, 2);                                    // close, open: once each, never resent
  assert.equal(out.state, "unknown");                                  // the old code answered confirmed "now short 1"
  assert.equal(out.ref.venue, "hl");
  assert.match(out.message, /the venue has not said what happened to the opening order/);
  assert.ok(hl.infoCalls.some((c) => c.type === "orderStatus"));
});

test("reverse: a lost opening answer the venue's order status then shows filled is a claim of 'reopened'", async () => {
  const { w, hl, clock } = world();
  hl.positions = [{ coin: "BTC", szi: 1 }];
  let n = 0;
  hl.exchange = (_action, body) => {
    n++;
    if (n === 1) { hl.positions = []; return filled(1); }
    const cloid = body.action.orders[0].c;
    hl.statuses[cloid] = { status: "order", order: { order: { coin: "BTC", side: "A", limitPx: "99", sz: "0", oid: 9, timestamp: 1, origSz: "1", cloid }, status: "filled", statusTimestamp: 2 } };
    hl.positions = [{ coin: "BTC", szi: -1 }];
    throw new Error("network down");
  };
  const { hlVenue } = w.load("hl_venue");
  const out = await clock.settle(hlVenue.reverse(longPos, 0.01, () => {}, 1_000_000));
  assert.equal(out.state, "confirmed");
  assert.match(out.message, /now short 1/);
});

test("reverse: the venue answers both legs - closed and reopened", async () => {
  const { w, hl, clock } = world();
  hl.positions = [{ coin: "BTC", szi: 1 }];
  let n = 0;
  hl.exchange = () => { n++; hl.positions = n === 1 ? [] : [{ coin: "BTC", szi: -1 }]; return filled(1); };
  const { hlVenue } = w.load("hl_venue");
  const out = await clock.settle(hlVenue.reverse(longPos, 0.01, () => {}, 1_000_000));
  assert.deepEqual(hl.sends.map((x) => x.action.orders[0].r), [true, false]);
  assert.equal(out.state, "confirmed");
  assert.match(out.message, /now short 1/);
});
