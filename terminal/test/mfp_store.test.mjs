// The REAL store over the REAL MFP adapter and exchange client, against a
// scripted MFP (fetch replaced; no key or account is real). These replay a
// third external review's probes (T1, T2, T4, T5 on MFP, T7) and pin the
// repaired behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";

import { fakeSettings, json, makeWorld } from "./helpers/world.mjs";

const MARKET = "binance|BTCUSDT";
// A LIVE-shaped fake: these tests are about the ledger, and a live key's
// request budget (40 background GETs a minute, mfp_rate.ts) stays out of
// their way. The budget has its own tests (test/mfp_rate.test.mjs).
const FAKE_MFP_KEY = "fp_live_" + "fake".repeat(6);
const mpos = (side = "long", size = 1) => ({ id: "pos_fake", account_id: "acct_fake", market_id: MARKET, provider: "binance", symbol: "BTC", coin: "BTCUSDT", side, size, entry_price: 100, mark_price: 100, leverage: 5, margin_mode: "cross", size_decimals: 3 });
const mord = (id, status, over = {}) => ({ id, status, market_id: MARKET, side: "buy", type: "market", size: 1, limit_price: 90, reduce_only: false, ...over });
const policy = { manual_trading_blocked: false, opening_exposure_restricted: false, restriction: null, trading_halt: { platform: false }, limits: { order_cooldown_ms: 0, execution_delay_max_ms: 0 } };
const inert = { id: "hl", ready: async () => false, markets: async () => [], history: async () => [], lookup: async () => ({ status: "unreadable", full: false, filled: 0, message: null }) };
const intent = (over = {}) => ({ venue: "mfp", marketId: MARKET, side: "buy", type: "market", size: 1, price: null, reduceOnly: false, postOnly: false, slippage: 0.01, tp: null, sl: null, leverage: 5, marginMode: "cross", ...over });

async function mfpWorld() {
  const f = { positions: [], working: [], sends: [], looks: [], onWrite: async () => { throw new Error("unscripted write"); }, look: () => [] };
  const w = makeWorld({
    mocks: {
      settings_store: fakeSettings(),
      ticker_store: { midOf: () => null, resetTicker() {}, tickerMarketsChanged() {} },
      mode: { isMock: () => false, mockScenario: () => "" },
      keys: { mfpReadKey: async () => FAKE_MFP_KEY, mfpTradeKey: async () => FAKE_MFP_KEY, mfpAccountId: async () => "acct_fake" },
      agent_store: { getMfpMeta: async () => ({ accountId: "acct_fake" }) },
      hl_venue: { hlVenue: inert, hlCoinSet: async () => new Set() },
      mfp_market_list: { refreshMfpList: async () => {}, mfpListSnapshot: () => ({ rows: [{ id: MARKET, symbol: "BTC", coin: "BTCUSDT", provider: "binance" }] }) },
    },
    fetch: async (url, init) => {
      // The account stream's relay: not there in these tests (the store then
      // polls at its full pace, as it does whenever the stream is down).
      if (String(url).includes("/v1/stream")) return json({ error: { code: "stream_unavailable" } }, 502);
      // The test world runs as the web build, which sends to its own origin
      // (/mfp/live/v1/...): read it as the venue path it stands for.
      const u = new URL(String(url).replace(/^\/mfp\/live(?=\/v1\/)/, ""), "https://live.mfp.test");
      if (init.method !== "GET") {
        const b = init.body ? JSON.parse(init.body) : null;
        f.sends.push({ path: u.pathname, method: init.method, body: b });
        return f.onWrite(u.pathname, b, init);
      }
      let data;
      if (u.pathname.endsWith("/trading-policy")) data = policy;
      else if (u.pathname.endsWith("/quote")) data = { bid: 99, ask: 101, mid: 100 };
      else if (u.pathname === "/v1/positions") data = f.positions;
      else if (u.pathname === "/v1/orders") {
        if (u.searchParams.has("client_order_id")) { const id = u.searchParams.get("client_order_id"); f.looks.push(id); data = await f.look(id); }
        else data = u.searchParams.get("status") === "working" ? f.working : [];
      } else if (u.pathname === "/v1/fills") data = [];
      else if (u.pathname === "/v1/accounts/acct_fake") data = { id: "acct_fake", balance: 10000 };
      else throw new Error("unscripted read: " + u.pathname);
      return json({ data });
    },
  });
  const store = w.load("venue_store");
  return { w, clock: w.clock, store, f, market: () => store.marketByKey("mfp:" + MARKET), start: async () => { await store.startVenues(); await w.clock.flush(); } };
}

const pendingOf = (store) => store.venueState().pending.map((p) => p.kind + ":" + p.state);
const logText = (store) => store.venueState().log.map((l) => l.state + ": " + l.text);

// ---- T1 ----------------------------------------------------------------------------

for (const external of [false, true]) {
  test("T1: a reverse whose opening order MFP still calls pending is never confirmed by " + (external ? "an unrelated short" : "time") + ", and settles on that order's status", async () => {
    const a = await mfpWorld();
    a.f.positions = [mpos()];
    await a.start();
    a.f.onWrite = async (path, b) => {
      if (path.endsWith("/close")) { a.f.positions = []; return json({ data: mord("close_fake", "filled", { client_order_id: b.client_order_id, side: "sell", position_side_after: "flat", position_size_after: 0 }) }); }
      if (path === "/v1/orders") { if (external) a.f.positions = [mpos("short")]; return json({ data: mord("open_fake", "pending", { client_order_id: b.client_order_id, side: "sell" }) }); }
      throw new Error("unexpected write " + path);
    };
    a.f.look = (id) => [mord("open_fake", "pending", { client_order_id: id, side: "sell" })];
    const out = await a.clock.settle(a.store.reversePosition("mfp:" + MARKET, true));
    assert.equal(a.f.sends.length, 2);
    assert.notEqual(out.state, "confirmed");
    const p = a.store.venueState().pending;
    assert.deepEqual(p.map((x) => x.kind), ["reverse"]);
    assert.ok(p[0].ref && p[0].ref.clientOrderId, "the opening order's id is kept");
    assert.deepEqual(p[0].expects, [{ type: "status" }]);
    // still pending at the venue: still pending here, whatever the position shows
    await a.clock.advance(10_000);
    assert.deepEqual(pendingOf(a.store).map((x) => x.split(":")[0]), ["reverse"]);
    // the venue rejects it: the reverse settles as closed, nothing reopened
    const before = a.f.looks.length;
    a.f.look = (id) => [mord("open_fake", "rejected", { client_order_id: id, side: "sell" })];
    await a.clock.advance(10_000);
    assert.ok(a.f.looks.length > before, "the venue is asked about the opening order");
    assert.deepEqual(pendingOf(a.store), []);
    assert.ok(logText(a.store).some((l) => /partial: reverse BTC: closed; the opening order did not execute/.test(l)), logText(a.store).join("\n"));
  });
}

// ---- T2 ----------------------------------------------------------------------------

test("T2: a limit MFP still calls pending is not taken as resting and does not free the market for another opening", async () => {
  const a = await mfpWorld();
  await a.start();
  a.f.onWrite = async (_path, b) => {
    const o = mord("pending_fake", "pending", { client_order_id: b.client_order_id, type: "limit" });
    a.f.working = [o];
    return json({ data: o });
  };
  a.f.look = (id) => a.f.working.filter((o) => o.client_order_id === id);
  const out = await a.clock.settle(a.store.placeOrder(intent({ type: "limit", price: 90, sl: 80, tp: 110 }), a.market()));
  assert.notEqual(out.state, "confirmed");
  assert.equal(a.store.venueState().pending.length, 1);
  assert.ok(!logText(a.store).some((l) => /attached to the resting order/.test(l)));
  const next = await a.clock.settle(a.store.placeOrder(intent({ type: "limit", price: 85 }), a.market()));
  assert.equal(next.state, "rejected");
  assert.equal(a.f.sends.length, 1);
  // it rests: now it is settled, and its exits go on the watch
  a.f.working = [{ ...a.f.working[0], status: "resting" }];
  await a.clock.advance(6_000);
  assert.deepEqual(pendingOf(a.store), []);
  assert.ok(logText(a.store).some((l) => /sl BTC at 80: attached to the resting order/.test(l)));
});

// ---- T4 ----------------------------------------------------------------------------

test("T4: an entry canceled after executing in part keeps its exits, each checked by itself", async () => {
  const a = await mfpWorld();
  await a.start();
  a.f.onWrite = async (_path, b) => {
    a.f.positions = [mpos("long", 0.4)];
    return json({ data: mord("partial_fake", "canceled", { client_order_id: b.client_order_id, type: "limit", size: 0.6, filled_size: 0.4 }) });
  };
  const out = await a.clock.settle(a.store.placeOrder(intent({ type: "limit", price: 90, sl: 80, tp: 110 }), a.market()));
  assert.equal(out.state, "partial");
  assert.match(out.message, /0\.4 executed/);
  assert.deepEqual(pendingOf(a.store).sort(), ["sl:verifying", "tp:verifying"]);
  // the venue shows the stop only
  a.f.working = [mord("sl_fake", "armed", { side: "sell", type: "stop_market", bracket_role: "stop_loss", trigger_price: 80, reduce_only: true, size: 0.4 })];
  await a.clock.advance(6_000);
  assert.deepEqual(pendingOf(a.store), ["tp:verifying"]);
  await a.clock.advance(30_000);
  assert.deepEqual(pendingOf(a.store), ["tp:unknown"]);
});

test("T4: an entry resting with a part already executed has its exits checked now", async () => {
  const a = await mfpWorld();
  await a.start();
  a.f.onWrite = async (_path, b) => {
    a.f.positions = [mpos("long", 0.4)];
    const o = mord("partial_fake", "resting", { client_order_id: b.client_order_id, type: "limit", size: 0.6, filled_size: 0.4 });
    a.f.working = [o];
    return json({ data: o });
  };
  const out = await a.clock.settle(a.store.placeOrder(intent({ type: "limit", price: 90, sl: 80, tp: 110 }), a.market()));
  assert.match(out.message, /0\.4 already executed/);
  assert.deepEqual(pendingOf(a.store).sort(), ["sl:verifying", "tp:verifying"]);
  await a.clock.advance(60_000);
  assert.deepEqual(pendingOf(a.store).sort(), ["sl:unknown", "tp:unknown"]);   // flagged, never silently waiting
});

test("T4: a watched resting entry that fills in part while it rests releases its exits for checking", async () => {
  const a = await mfpWorld();
  await a.start();
  a.f.onWrite = async (_path, b) => {
    const o = mord("rest_fake", "resting", { client_order_id: b.client_order_id, type: "limit" });
    a.f.working = [o];
    return json({ data: o });
  };
  await a.clock.settle(a.store.placeOrder(intent({ type: "limit", price: 90, sl: 80 }), a.market()));
  assert.deepEqual(pendingOf(a.store), []);
  await a.clock.advance(6_000);
  assert.deepEqual(pendingOf(a.store), []);
  a.f.positions = [mpos("long", 0.4)];
  a.f.working = [{ ...a.f.working[0], size: 0.6, filled_size: 0.4 }];
  await a.clock.advance(6_000);
  assert.deepEqual(pendingOf(a.store), ["sl:verifying"]);
});

// ---- T5 on MFP -----------------------------------------------------------------------

test("T5: an MFP reverse whose close MFP was still working on does not open once a Close started meanwhile", async () => {
  const a = await mfpWorld();
  a.f.positions = [mpos()];
  await a.start();
  let closeId = null;
  a.f.onWrite = async (path, b) => {
    if (path.endsWith("/close") && closeId === null) { closeId = b.client_order_id; return json({ data: mord("close_fake", "pending", { client_order_id: closeId, side: "sell" }) }); }
    if (path.endsWith("/close")) return json({ data: mord("close2_fake", "rejected", { client_order_id: b.client_order_id, side: "sell" }) });
    throw new Error("the opening order must not be sent");
  };
  let filled = false;
  a.f.look = (id) => [mord("close_fake", filled ? "filled" : "pending", { client_order_id: id, side: "sell", ...(filled ? { position_side_after: "flat", position_size_after: 0 } : {}) })];
  const rev = a.store.reversePosition("mfp:" + MARKET, true);
  await a.clock.advance(1_000);
  assert.equal(a.store.venueState().pending[0].state, "verifying");   // waiting on the venue: not in flight
  await a.clock.settle(a.store.closePosition("mfp:" + MARKET, 0.5));
  filled = true;
  a.f.positions = [];
  const r = await a.clock.settle(rev);
  assert.deepEqual(a.f.sends.map((s) => s.path.endsWith("/close") ? "close" : s.path), ["close", "close"]);
  assert.equal(r.state, "partial");
  assert.match(r.message, /another write on this market started while this one was waiting/);
});

// ---- T7 ----------------------------------------------------------------------------

test("T7: a size-only move the venue floors to its step settles at the floored size", async () => {
  const a = await mfpWorld();
  a.f.working = [mord("move_fake", "resting", { client_order_id: "original_fake", type: "limit" })];
  await a.start();
  a.f.onWrite = async (_path, b) => {
    a.f.working[0] = { ...a.f.working[0], size: Math.floor(b.size * 1000) / 1000, limit_price: b.price };
    return json({ data: a.f.working[0] });
  };
  a.f.look = () => a.f.working;
  const out = await a.clock.settle(a.store.modifyOrder("mfp:move_fake", 90, 0.12345));
  assert.equal(a.f.sends[0].body.size, 0.12345);
  assert.equal(out.state, "confirmed");
  assert.match(out.message, /size 0\.123/);
  assert.deepEqual(pendingOf(a.store), []);
});

test("T7: a move the venue answers with the order left at its old size is not settled", async () => {
  const a = await mfpWorld();
  a.f.working = [mord("move_fake", "resting", { client_order_id: "original_fake", type: "limit" })];
  await a.start();
  a.f.onWrite = async () => json({ data: a.f.working[0] });   // the answer shows size 1, unchanged
  a.f.look = () => a.f.working;
  await a.clock.settle(a.store.modifyOrder("mfp:move_fake", 90, 0.12345));
  await a.clock.advance(30_000);
  assert.deepEqual(pendingOf(a.store), ["modify:unknown"]);
});
