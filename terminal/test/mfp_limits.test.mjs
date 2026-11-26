// MyFundedPerps' per-key GET limit, end to end on fakes: the REAL exchange
// client, adapter and store (test/helpers/world.mjs) against a scripted MFP
// that counts every request. What is pinned here:
// - the poll's cost per minute (it was 52 GETs; it is 17);
// - a 429 holds the key: background reads stop, trade-path reads still go,
//   the status says when the next read may go, and nothing spins;
// - the order lookup backs off and waits a hold out, then looks once more;
// - a reverse does not open after a long hold between its legs;
// - history keeps its rows when a read fails; unsettled writes take turns;
// - nothing is polled while the app is hidden.
// No key, account or venue here is real.
import { test } from "node:test";
import assert from "node:assert/strict";

import { fakeSettings, json, makeWorld } from "./helpers/world.mjs";

const MARKET = "binance|BTCUSDT";
const LIVE_KEY = "fp_live_" + "fake".repeat(6);
const TEST_KEY = "fp_test_" + "fake".repeat(6);
const ACCT = "acct_fake";

// A response with headers (the shared json() double has none).
const resp = (value, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status, json: async () => value,
  headers: { get: (n) => (Object.prototype.hasOwnProperty.call(headers, n.toLowerCase()) ? headers[n.toLowerCase()] : null) },
});
const limited = (retryAfter = "60") => resp({ error: { code: "rate_limited", message: "slow down" } }, 429, { "retry-after": retryAfter, "x-ratelimit-scope": "api_key", "x-ratelimit-limit": "30" });

const mpos = (side = "long", size = 1) => ({ id: "pos_fake", account_id: ACCT, market_id: MARKET, provider: "binance", symbol: "BTC", coin: "BTCUSDT", side, size, entry_price: 100, mark_price: 100, leverage: 5, margin_mode: "cross", size_decimals: 3 });
const mord = (id, status, over = {}) => ({ id, status, market_id: MARKET, side: "buy", type: "market", size: 1, limit_price: 90, reduce_only: false, ...over });
const policy = { manual_trading_blocked: false, opening_exposure_restricted: false, restriction: null, trading_halt: { platform: false }, limits: { order_cooldown_ms: 0, execution_delay_max_ms: 0 } };
const inert = { id: "hl", ready: async () => false, markets: async () => [], history: async () => [], lookup: async () => ({ status: "unreadable", full: false, filled: 0, message: null }) };
const intent = (over = {}) => ({ venue: "mfp", marketId: MARKET, side: "buy", type: "market", size: 1, price: null, reduceOnly: false, postOnly: false, slippage: 0.01, tp: null, sl: null, leverage: 5, marginMode: "cross", ...over });

// What a venue path is, for counting: "book" reads are positions and the
// working orders.
function kindOf(u) {
  if (u.pathname.endsWith("/trading-policy")) return "policy";
  if (u.pathname.endsWith("/quote")) return "quote";
  if (u.pathname === "/v1/positions") return "positions";
  if (u.pathname === "/v1/fills") return "fills";
  if (u.pathname === "/v1/orders") return u.searchParams.has("client_order_id") ? "lookup" : u.searchParams.get("status") === "working" ? "working" : "orders";
  if (u.pathname === "/v1/accounts/" + ACCT) return "account";
  return "other";
}

// The scripted MFP. `f.gets`: every GET as { kind, at }. `f.answer(kind, u)`
// may return a response to use instead of the default (a 429, a failure).
function scriptedMfp(clock) {
  const f = { positions: [], working: [], fills: [], recent: [], gets: [], sends: [], stream: null, streamAsks: [], latency: 0, answer: () => null, onWrite: async () => { throw new Error("unscripted write"); }, look: () => [] };
  f.fetch = async (url, init) => {
    // The account stream's relay: `f.stream(url, init)` answers it when a test
    // sets one; otherwise it is not there (the stream stays down). It is not a
    // REST GET and is not counted as one.
    if (String(url).includes("/v1/stream")) { f.streamAsks.push(String(url)); return f.stream ? f.stream(String(url), init) : resp({ error: { code: "stream_unavailable" } }, 502); }
    const u = new URL(String(url).replace(/^\/mfp\/(live|sandbox)(?=\/v1\/)/, ""), "https://mfp.test");
    if (init.method !== "GET") {
      const b = init.body ? JSON.parse(init.body) : null;
      f.sends.push({ path: u.pathname, method: init.method, body: b });
      return f.onWrite(u.pathname, b, init);
    }
    const kind = kindOf(u);
    f.gets.push({ kind, at: clock.now() });
    // a venue that takes time to answer (f.latency ms, on the test's clock)
    if (f.latency) await new Promise((r) => clock.setTimeout(r, f.latency));
    const special = await f.answer(kind, u);
    if (special) return special;
    let data;
    if (kind === "policy") data = policy;
    else if (kind === "quote") data = { bid: 99, ask: 101, mid: 100 };
    else if (kind === "positions") data = f.positions;
    else if (kind === "working") data = f.working;
    else if (kind === "orders") data = f.recent;
    else if (kind === "lookup") data = await f.look(u.searchParams.get("client_order_id"));
    else if (kind === "fills") data = f.fills;
    else if (kind === "account") data = { id: ACCT, balance: 10000 };
    else throw new Error("unscripted read: " + u.pathname);
    return resp({ data });
  };
  f.count = (from, to = Infinity) => f.gets.filter((g) => g.at > from && g.at <= to).length;
  f.kinds = (from, to = Infinity) => f.gets.filter((g) => g.at > from && g.at <= to).map((g) => g.kind);
  return f;
}

// The real store over the real adapter and exchange client.
async function mfpWorld(key = LIVE_KEY) {
  const appListeners = [];
  const w = makeWorld({
    mocks: {
      settings_store: fakeSettings(),
      ticker_store: { midOf: () => null, resetTicker() {}, tickerMarketsChanged() {} },
      mode: { isMock: () => false, mockScenario: () => "" },
      keys: { mfpReadKey: async () => key, mfpTradeKey: async () => key, mfpAccountId: async () => ACCT },
      agent_store: { getMfpMeta: async () => ({ accountId: ACCT }) },
      hl_venue: { hlVenue: inert, hlCoinSet: async () => new Set() },
      mfp_market_list: { refreshMfpList: async () => {}, mfpListSnapshot: () => ({ rows: [{ id: MARKET, symbol: "BTC", coin: "BTCUSDT", provider: "binance" }] }) },
    },
    packages: { "react-native": { __esModule: true, Platform: { OS: "web" }, AppState: { currentState: "active", addEventListener: (_e, fn) => { appListeners.push(fn); return { remove() {} }; } } } },
  });
  const f = scriptedMfp(w.clock);
  w.fetch = f.fetch;
  const store = w.load("venue_store");
  const appState = (s) => { for (const l of appListeners) l(s); };
  return { w, clock: w.clock, store, f, appState, market: () => store.marketByKey("mfp:" + MARKET), start: async () => { await store.startVenues(); await w.clock.flush(); } };
}

const tally = (kinds) => kinds.reduce((m, k) => { m[k] = (m[k] ?? 0) + 1; return m; }, {});

// ---- the poll's cost -----------------------------------------------------------

for (const [name, key] of [["live", LIVE_KEY], ["sandbox", TEST_KEY]]) {
  test("an idle minute of polling costs 17 GETs on a " + name + " key (it was 52)", async () => {
    const a = await mfpWorld(key);
    const t0 = a.clock.now();
    await a.start();
    // the first read: the book, the account, the policy, and the history
    assert.deepEqual(tally(a.f.kinds(-1, t0)), { positions: 1, working: 1, account: 1, policy: 1, fills: 1, orders: 1 });
    await a.clock.advance(60_000);
    // the book every 10 s, the account every 30 s, the policy and the history every 60 s
    assert.deepEqual(tally(a.f.kinds(t0, t0 + 60_000)), { positions: 6, working: 6, account: 2, policy: 1, fills: 1, orders: 1 });
    assert.equal(a.f.count(t0, t0 + 60_000), 17);
    await a.clock.advance(60_000);
    assert.equal(a.f.count(t0 + 60_000, t0 + 120_000), 17, "and the minute after");
    assert.equal(a.store.venueState().status.mfp.state, "ok");
    assert.equal(a.store.venueState().status.mfp.heldUntil, null, "the budget was never the limit");
  });
}

test("the balance shown between its reads is the last one read, and the account is re-read every 30 s", async () => {
  const a = await mfpWorld();
  let balance = 10000;
  a.f.answer = (kind) => (kind === "account" ? resp({ data: { id: ACCT, balance } }) : null);
  await a.start();
  assert.equal(a.store.venueState().balances.mfp.equity, 10000);
  balance = 9000;
  await a.clock.advance(20_000);
  assert.equal(a.store.venueState().balances.mfp.equity, 10000, "two book reads later: still the copy from the first read");
  await a.clock.advance(10_000);
  assert.equal(a.store.venueState().balances.mfp.equity, 9000);
});

test("an account read that fails keeps the last balance; the book is still read and shown", async () => {
  const a = await mfpWorld();
  await a.start();
  a.f.answer = (kind) => (kind === "account" ? resp({ error: { code: "internal", message: "no" } }, 500) : null);
  a.f.positions = [mpos()];
  await a.clock.advance(30_000);
  assert.equal(a.store.venueState().status.mfp.state, "ok");
  assert.equal(a.store.venueState().positions.length, 1, "the book did not wait for the account");
  assert.equal(a.store.venueState().balances.mfp.equity, 10000);
  // an account nobody could read for three minutes is no longer shown as the balance
  await a.clock.advance(180_000);
  assert.equal(a.store.venueState().balances.mfp, null);
  assert.equal(a.store.venueState().positions.length, 1);
});

test("one unsettled write keeps a sandbox key under its 30 a minute", async () => {
  const a = await mfpWorld(TEST_KEY);
  await a.start();
  a.f.onWrite = async (_p, b) => {
    const o = mord("pending_fake", "pending", { client_order_id: b.client_order_id, type: "limit" });
    a.f.working = [o];
    return json({ data: o });
  };
  a.f.look = (id) => a.f.working.filter((o) => o.client_order_id === id);
  await a.clock.settle(a.store.placeOrder(intent({ type: "limit", price: 90 }), a.market()));
  assert.equal(a.store.venueState().pending.length, 1);
  // from here: a quiet account with one write the venue has not settled
  await a.clock.advance(60_000);
  const from = a.clock.now();
  await a.clock.advance(60_000);
  const n = a.f.count(from, from + 60_000);
  assert.ok(n <= 26, "GETs in a minute with one unsettled write: " + n);
  assert.ok(a.f.kinds(from, from + 60_000).includes("lookup"), "the write is still being asked about");
  assert.equal(a.store.venueState().pending.length, 1);
});

// ---- a 429 ----------------------------------------------------------------------

test("a 429 holds the key: background reads stop for Retry-After, the status says so, and they resume", async () => {
  const a = await mfpWorld();
  await a.start();
  a.f.positions = [mpos()];
  await a.clock.advance(10_000);
  assert.equal(a.store.venueState().positions.length, 1);
  // the venue starts refusing: one read comes back 429
  let refuse = true;
  a.f.answer = () => (refuse ? limited("60") : null);
  const at = a.clock.now();
  await a.clock.advance(10_000);
  refuse = false;
  const st = a.store.venueState().status.mfp;
  assert.equal(st.state, "ok", "the venue is not in error: the last read that ran was fine");
  assert.ok(st.heldUntil > a.clock.now(), "the status carries when the next read may go");
  assert.equal(a.store.venueState().positions.length, 1, "the lists stay as they were");
  const sentInThatBeat = a.f.count(at, a.clock.now());
  assert.ok(sentInThatBeat >= 1 && sentInThatBeat <= 2, "the refused read itself: " + sentInThatBeat);
  // for the rest of the hold nothing in the background is sent at all
  const quietFrom = a.clock.now();
  await a.clock.advance(48_000);
  assert.equal(a.f.count(quietFrom, a.clock.now()), 0, "no read spins against the hold: " + a.f.kinds(quietFrom).join(","));
  // the hold ends: the next beat reads again and the status clears
  await a.clock.advance(15_000);
  assert.ok(a.f.count(quietFrom) >= 2);
  assert.equal(a.store.venueState().status.mfp.heldUntil, null);
  const rate = a.w.load("mfp_rate").rateNotice();
  assert.equal(rate.scope, "api_key");
  assert.equal(rate.limit, 30);
});

test("the venue's grace-period warning header reaches the status store", async () => {
  const a = await mfpWorld();
  a.f.answer = (kind) => (kind === "positions" ? resp({ data: [] }, 200, { "x-ratelimit-warning": "over the per-key GET limit; enforcement starts soon" }) : null);
  await a.start();
  const rate = a.w.load("mfp_rate");
  assert.equal(rate.rateNotice().warningText, "over the per-key GET limit; enforcement starts soon");
  assert.equal(rate.rateLine(rate.rateNotice(), a.clock.now()), "rate warning");
  assert.equal(a.store.venueState().status.mfp.state, "ok", "a warning is not an error: the read succeeded");
});

test("inside a hold a trade-path read is still sent (an exit is always attempted); a background read is not", async () => {
  const w = makeWorld();
  const f = scriptedMfp(w.clock);
  w.fetch = f.fetch;
  const ex = w.load("mfp_exchange");
  const { currentSession } = w.load("session");
  const { heldUntilOf } = w.load("venue");
  // one background read is refused: the key is held for a minute
  f.answer = () => limited("60");
  const e = await ex.fetchMfpBook(TEST_KEY, ACCT).then(() => null, (x) => x);
  assert.equal(heldUntilOf(e), w.clock.now() + 60_000);
  assert.match(e.message, /rate limited, next read in 60 s/);
  f.answer = () => null;
  const before = f.gets.length;
  // background and settle reads are not sent at all
  for (const read of [() => ex.fetchMfpBook(TEST_KEY, ACCT), () => ex.fetchMfpBook(TEST_KEY, ACCT, "settle"), () => ex.fetchMfpAccount(TEST_KEY, ACCT), () => ex.fetchMfpFills(TEST_KEY, ACCT), () => ex.lookupMfpOrder(TEST_KEY, ACCT, "tt-x")]) {
    assert.ok(heldUntilOf(await read().then(() => null, (x) => x)) !== null);
  }
  assert.equal(f.gets.length, before, "nothing went out");
  assert.ok(ex.mfpReadWait(TEST_KEY, 1) > 0);
  // a close in that same hold: its re-read, its policy, its price and its verify all go out
  f.positions = [mpos()];
  f.onWrite = async (_p, b) => { f.positions = []; return json({ data: mord("close_fake", "filled", { client_order_id: b.client_order_id, side: "sell", position_side_after: "flat", position_size_after: 0 }) }); };
  const shown = { id: "pos_fake", accountId: ACCT, marketId: MARKET, provider: "binance", symbol: "BTC", coin: "BTCUSDT", side: "long", size: 1, entryPrice: 100, leverage: 5, marginMode: "cross", liquidationPrice: null, markPrice: 100, unrealizedPnl: 0, sizeDecimals: 3, openedAt: null };
  const out = await w.clock.settle(ex.mfpClosePosition(currentSession(), TEST_KEY, shown, 1, 0.01));
  assert.equal(out.stopped, null);
  assert.equal(out.close.order.status, "filled");
  assert.equal(out.close.residual, 0);
  assert.deepEqual(f.gets.slice(before).map((g) => g.kind), ["positions", "policy", "quote", "positions"]);
  assert.equal(f.sends.length, 1, "the close was sent once");
  // another key is not held by this one's 429
  assert.equal(ex.mfpReadWait(LIVE_KEY, 1), 0);
});

test("a 429 on a write keeps its meaning: a refusal with the venue's envelope, never a hold on the key", async () => {
  const w = makeWorld();
  const f = scriptedMfp(w.clock);
  w.fetch = f.fetch;
  const ex = w.load("mfp_exchange");
  const { currentSession } = w.load("session");
  f.onWrite = async () => limited("60");
  const r = await w.clock.settle(ex.mfpCancelOrder(currentSession(), TEST_KEY, ACCT, "ord_1"));
  assert.equal(r.ok, false);
  assert.equal(r.ambiguous, false);
  assert.match(r.message, /rate_limited/);
  assert.equal(f.sends.length, 1);
  assert.equal(ex.mfpReadWait(TEST_KEY, 1), 0, "writes are not counted per key: no hold");
});

// ---- the order lookup -----------------------------------------------------------

async function placeWith(f, w, key = TEST_KEY) {
  const ex = w.load("mfp_exchange");
  const { currentSession } = w.load("session");
  f.onWrite = async (_p, b) => json({ data: mord("ord_fake", "pending", { client_order_id: b.client_order_id }) });
  return ex.mfpPlaceOrder(currentSession(), key, { accountId: ACCT, marketId: MARKET, side: "buy", type: "market", size: 1, limitPrice: null, reduceOnly: false, leverage: 5, marginMode: "cross", expectedPrice: 100, slippage: 0.01, tp: null, sl: null });
}

test("the order lookup backs off: nine looks in a 20 s deadline (it was twenty-eight), never a resend", async () => {
  const w = makeWorld();
  const f = scriptedMfp(w.clock);
  w.fetch = f.fetch;
  f.look = (id) => [mord("ord_fake", "pending", { client_order_id: id })];
  const t0 = w.clock.now();
  const out = await w.clock.settle(placeWith(f, w));
  assert.equal(out.kind, "pending");
  const looks = f.gets.filter((g) => g.kind === "lookup").map((g) => g.at - t0);
  assert.deepEqual(looks, [0, 700, 1700, 3200, 5200, 8200, 11_200, 14_200, 17_200]);
  assert.equal(f.sends.length, 1, "the order was sent once");
});

test("a lookup the venue rate limits waits the hold out and looks once more: it ends on the venue's answer", async () => {
  const w = makeWorld();
  const f = scriptedMfp(w.clock);
  w.fetch = f.fetch;
  let first = true;
  f.answer = (kind) => { if (kind === "lookup" && first) { first = false; return limited("60"); } return null; };
  f.look = (id) => [mord("ord_fake", "filled", { client_order_id: id })];
  const t0 = w.clock.now();
  const out = await w.clock.settle(placeWith(f, w));
  const looks = f.gets.filter((g) => g.kind === "lookup").map((g) => g.at - t0);
  assert.deepEqual(looks, [0, 60_250], "one refused look, nothing during the hold, one look just after it (past the 20 s deadline)");
  assert.equal(out.kind, "filled", "not 'no order found'");
  assert.equal(f.sends.length, 1);
});

test("a hold too long to leave time for a look ends the lookup AT ONCE - it never sleeps to its limit and leaves without looking", async () => {
  const w = makeWorld();
  const f = scriptedMfp(w.clock);
  w.fetch = f.fetch;
  f.answer = (kind) => (kind === "lookup" ? limited("300") : null);
  const t0 = w.clock.now();
  const out = await w.clock.settle(placeWith(f, w));
  assert.equal(f.gets.filter((g) => g.kind === "lookup").length, 1, "one look; the hold outlasts the deadline plus its extension");
  assert.ok(w.clock.now() - t0 <= 1000, "it stopped when the venue named a wait it cannot sit out: " + (w.clock.now() - t0) + " ms");
  assert.equal(out.kind, "pending", "the venue's own answer to the order stands: still pending");
  assert.equal(f.sends.length, 1);
});

// ---- the reverse ---------------------------------------------------------------

test("a reverse whose re-read runs into a long hold stops closed: no opening order after a minute's wait", async () => {
  const w = makeWorld();
  const f = scriptedMfp(w.clock);
  w.fetch = f.fetch;
  const ex = w.load("mfp_exchange");
  const { currentSession } = w.load("session");
  f.positions = [mpos()];
  let closed = false;
  f.onWrite = async (path, b) => {
    if (!path.endsWith("/close")) throw new Error("the opening order must not be sent");
    closed = true;
    f.positions = [];
    return json({ data: mord("close_fake", "filled", { client_order_id: b.client_order_id, side: "sell", position_side_after: "flat", position_size_after: 0 }) });
  };
  // the read that verifies the close is refused: the key is held for a minute
  let refused = 0;
  f.answer = (kind) => { if (closed && kind === "positions" && refused === 0) { refused++; return limited("60"); } return null; };
  const shown = { id: "pos_fake", accountId: ACCT, marketId: MARKET, provider: "binance", symbol: "BTC", coin: "BTCUSDT", side: "long", size: 1, entryPrice: 100, leverage: 5, marginMode: "cross", liquidationPrice: null, markPrice: 100, unrealizedPnl: 0, sizeDecimals: 3, openedAt: null };
  const t0 = w.clock.now();
  const after = f.gets.length;
  const out = await w.clock.settle(ex.mfpReversePosition(currentSession(), TEST_KEY, shown, 0.01, 1_000_000));
  assert.equal(f.sends.length, 1, "only the close was sent");
  assert.equal(out.open, null);
  assert.match(out.stopped, /rate limited for another \d+ s.*no opening order was sent/);
  assert.equal(out.close.order.status, "filled");
  assert.ok(w.clock.now() - t0 < 5_000, "it did not wait the hold out");
  const kinds = f.gets.slice(after).map((g) => g.kind);
  assert.equal(kinds.filter((k) => k === "positions").length, 2, "the pre-check and the refused verify; no pass was burned against the hold: " + kinds.join(","));
});

const SHOWN = { id: "pos_fake", accountId: ACCT, marketId: MARKET, provider: "binance", symbol: "BTC", coin: "BTCUSDT", side: "long", size: 1, entryPrice: 100, leverage: 5, marginMode: "cross", liquidationPrice: null, markPrice: 100, unrealizedPnl: 0, sizeDecimals: 3, openedAt: null };

test("a reverse does not start when the key has no room for the whole sequence, or is held: it would end flat between its legs", async () => {
  const w = makeWorld();
  const f = scriptedMfp(w.clock);
  w.fetch = f.fetch;
  const ex = w.load("mfp_exchange");
  const { currentSession } = w.load("session");
  f.positions = [mpos()];
  f.onWrite = async (path, b) => {
    if (path.endsWith("/close")) { f.positions = []; return json({ data: mord("close_fake", "filled", { client_order_id: b.client_order_id, side: "sell", position_side_after: "flat", position_size_after: 0 }) }); }
    f.positions = [mpos("short")];
    return json({ data: mord("open_fake", "filled", { client_order_id: b.client_order_id, side: "sell" }) });
  };
  // the sandbox key has sent 14 GETs this minute (seven book reads): 18 more would pass its 30
  for (let i = 0; i < 7; i++) await ex.fetchMfpBook(TEST_KEY, ACCT);
  const before = f.gets.length;
  const no = await w.clock.settle(ex.mfpReversePosition(currentSession(), TEST_KEY, SHOWN, 0.01, 1_000_000));
  assert.match(no.stopped, /no room this minute for a reverse \(about 18 reads.*on one key the poll shares that budget.*nothing was sent/);
  assert.doesNotMatch(no.stopped, /try again|in \d+ s/, "it promises no time: on one key room may not come while the app polls");
  assert.equal(no.close, null);
  assert.equal(f.gets.length, before, "not one read was spent on it");
  assert.equal(f.sends.length, 0);
  assert.ok(ex.mfpTradeWait(TEST_KEY, 18) > 0);
  // a plain close is never held back by the count
  const close = await w.clock.settle(ex.mfpClosePosition(currentSession(), TEST_KEY, SHOWN, 1, 0.01));
  assert.equal(close.close.order.status, "filled");
  assert.equal(f.sends.length, 1);
  // a minute later the same reverse runs, both legs
  f.positions = [mpos()];
  await w.clock.advance(61_000);
  const yes = await w.clock.settle(ex.mfpReversePosition(currentSession(), TEST_KEY, SHOWN, 0.01, 1_000_000));
  assert.equal(yes.stopped, null);
  assert.equal(yes.open.order.status, "filled");
  assert.equal(f.sends.length, 3);
  // a live key with the same history has the room (60 a minute)
  const w2 = makeWorld();
  const f2 = scriptedMfp(w2.clock);
  w2.fetch = f2.fetch;
  const ex2 = w2.load("mfp_exchange");
  for (let i = 0; i < 7; i++) await ex2.fetchMfpBook(LIVE_KEY, ACCT);
  assert.equal(ex2.mfpTradeWait(LIVE_KEY, 18), 0);
  // and a key the venue is holding has room for no reverse at all
  f2.answer = () => limited("30");
  await ex2.fetchMfpBook(LIVE_KEY, ACCT).catch(() => undefined);
  f2.answer = () => null;
  f2.positions = [mpos()];
  const held = await w2.clock.settle(ex2.mfpReversePosition(w2.load("session").currentSession(), LIVE_KEY, SHOWN, 0.01, 1_000_000));
  assert.match(held.stopped, /no room this minute for a reverse.*nothing was sent/);
  assert.equal(f2.sends.length, 0);
});

test("a reverse whose close was confirmed only after a rate-limit wait does not open: it would go out late, at another price", async () => {
  const w = makeWorld();
  const f = scriptedMfp(w.clock);
  w.fetch = f.fetch;
  const ex = w.load("mfp_exchange");
  const { currentSession } = w.load("session");
  f.positions = [mpos()];
  f.onWrite = async (path, b) => {
    if (!path.endsWith("/close")) throw new Error("the opening order must not be sent");
    f.positions = [];
    return json({ data: mord("close_fake", "pending", { client_order_id: b.client_order_id, side: "sell" }) });
  };
  // the first look at the close is rate limited for 3 s; the next shows it filled flat
  let first = true;
  f.answer = (kind) => { if (kind === "lookup" && first) { first = false; return limited("3"); } return null; };
  f.look = (id) => [mord("close_fake", "filled", { client_order_id: id, side: "sell", position_side_after: "flat", position_size_after: 0 })];
  const out = await w.clock.settle(ex.mfpReversePosition(currentSession(), TEST_KEY, SHOWN, 0.01, 1_000_000));
  assert.equal(out.close.order.status, "filled");
  assert.equal(out.close.waited, true);
  assert.equal(out.open, null);
  assert.match(out.stopped, /confirmed only after a rate-limit wait; no opening order was sent/);
  assert.equal(f.sends.length, 1, "only the close");
});

// ---- history ---------------------------------------------------------------------

test("history keeps its rows when a read fails, and when the key is held", async () => {
  const a = await mfpWorld();
  a.f.fills = [{ id: "ord_1", account_id: ACCT, market_id: MARKET, symbol: "BTC", side: "buy", size: 1, fill_price: 100, settled_at: 1_700_000_000_000 }];
  await a.start();
  assert.equal(a.store.venueState().history.length, 1);
  // both lists fail: the rows stay
  a.f.answer = (kind) => (kind === "fills" || kind === "orders" ? resp({ error: { code: "internal" } }, 500) : null);
  await a.clock.advance(61_000);
  assert.equal(a.store.venueState().history.length, 1, "it was replaced by an empty list before");
  // one list fails: its last good rows are used with the other's fresh ones
  a.f.recent = [mord("ord_2", "canceled", { account_id: ACCT, created_at: 1_700_000_100_000 })];
  a.f.answer = (kind) => (kind === "fills" ? resp({ error: { code: "internal" } }, 500) : null);
  await a.clock.advance(60_000);
  assert.deepEqual(a.store.venueState().history.map((h) => h.status).sort(), ["canceled", "filled"]);
  // the key is held: the history read is not sent, the rows stay
  a.f.answer = (kind) => (kind === "positions" ? limited("120") : null);
  await a.clock.advance(10_000);
  a.f.answer = () => null;
  const from = a.clock.now();
  await a.clock.advance(60_000);
  assert.equal(a.f.kinds(from).filter((k) => k === "fills" || k === "orders").length, 0);
  assert.equal(a.store.venueState().history.length, 2);
});

// ---- unsettled writes take turns --------------------------------------------------

test("several unsettled writes are asked about two per pass, in turn, and none is starved", async () => {
  const ticker = { midOf: () => null, resetTicker() {}, tickerMarketsChanged() {} };
  const settings = fakeSettings();
  const lookups = [];
  const markets = ["A", "B", "C", "D", "E"].map((id) => ({ key: "mfp:" + id, venue: "mfp", id, symbol: id, chartCoin: null, chartNote: null, szDecimals: 3, maxLeverage: 40, provider: null }));
  const mfp = {
    id: "mfp", maxLookups: 2,
    async ready() { return true; }, async tradeBlocked() { return null; }, async markets() { return markets; },
    async snapshot() { return { venue: "mfp", positions: [], orders: [], balance: null, mids: Object.fromEntries(markets.map((m) => [m.id, 100])), chg24: {}, at: 0 }; },
    async history() { return []; }, async quote() { return { bid: null, ask: null, mid: 100, at: 0 }; },
    async lookup(ref) { lookups.push(ref.clientOrderId); return { status: "open", full: false, filled: 0, message: "pending", resting: false }; },
    async leverage() { return null; },
    async placeOrder(_i, market) { return { state: "pending", message: "still pending on MFP", ambiguous: false, ref: { venue: "mfp", clientOrderId: "id-" + market.id } }; },
  };
  const w = makeWorld({ mocks: { settings_store: settings, ticker_store: ticker, mode: { isMock: () => false, mockScenario: () => "" }, hl_venue: { hlVenue: inert }, mfp_venue: { mfpVenue: mfp } } });
  const store = w.load("venue_store");
  await store.startVenues();
  await w.clock.flush();
  for (const m of markets) await w.clock.settle(store.placeOrder(intent({ marketId: m.id }), m));
  assert.equal(store.venueState().pending.length, 5);
  await w.clock.advance(5_000);
  lookups.length = 0;
  // five book reads: two lookups each, every write asked about twice
  await w.clock.advance(50_000);
  assert.equal(lookups.length, 10, "two per pass: " + lookups.join(","));
  const per = tally(lookups);
  assert.deepEqual(Object.keys(per).sort(), ["id-A", "id-B", "id-C", "id-D", "id-E"]);
  assert.ok(Object.values(per).every((n) => n === 2), JSON.stringify(per));
  assert.equal(store.venueState().pending.length, 5, "a write that was not asked about this pass is not settled by that");
});

// ---- the timer -------------------------------------------------------------------

test("a book read still out is not doubled by the next beat, and a run of taps costs one read", async () => {
  const a = await mfpWorld();
  await a.start();
  // the venue stops answering the book: the read stays out
  let release = [];
  a.f.answer = (kind) => (kind === "positions" || kind === "working" ? new Promise((res) => { release.push(() => res(resp({ data: [] }))); }) : null);
  const from = a.clock.now();
  await a.clock.advance(14_000);
  assert.equal(a.f.count(from), 2, "one book read went out at 10 s; the 15 s pace is not due yet either way");
  await a.clock.advance(10_000);
  assert.equal(a.f.count(from), 2, "the 20 s beat found the last read still out and sent nothing");
  for (const r of release) r();
  release = [];
  a.f.answer = () => null;
  await a.clock.flush();
  // taps on the status bar: the first reads, the rest within 2 s do not
  const t = a.clock.now();
  a.store.manualRefresh();
  a.store.manualRefresh();
  a.store.manualRefresh();
  await a.clock.flush();
  assert.equal(a.f.kinds(t - 1).filter((k) => k === "positions").length, 1);
  await a.clock.advance(2_100);
  a.store.manualRefresh();
  await a.clock.flush();
  assert.equal(a.f.kinds(t - 1).filter((k) => k === "positions").length, 2);
});

test("nothing is polled while the app is hidden; one read follows on return", async () => {
  const a = await mfpWorld();
  await a.start();
  a.appState("background");
  const from = a.clock.now();
  await a.clock.advance(120_000);
  assert.equal(a.f.count(from), 0, "hidden for two minutes: " + a.f.kinds(from).join(","));
  a.appState("active");
  await a.clock.flush();
  const back = tally(a.f.kinds(from));
  assert.equal(back.positions, 1);
  assert.equal(back.working, 1);
  assert.equal(back.fills, 1, "and the history, which was due");
  await a.clock.advance(60_000);
  assert.ok(a.f.count(from) > 10, "the timers carry on");
});

test("a write re-reads the venue even while the app is hidden", async () => {
  const a = await mfpWorld();
  await a.start();
  a.appState("background");
  a.f.onWrite = async (_p, b) => {
    const o = mord("ord_fake", "resting", { client_order_id: b.client_order_id, type: "limit" });
    a.f.working = [o];
    return json({ data: o });
  };
  const out = await a.clock.settle(a.store.placeOrder(intent({ type: "limit", price: 90 }), a.market()));
  assert.equal(out.state, "confirmed");
  assert.equal(a.store.venueState().orders.length, 1, "the resting order is shown: the write's own re-read ran");
});

// ---- the review of 2026-11-26 ---------------------------------------------------------------

// The 17 above is measured against a venue that answers at once. A real one
// does not, and the first version read the account and the policy TWICE
// whenever the book's timer and the balance's timer fired together (every
// 30 s): 20 a minute, which is the whole of a sandbox key's background share.
for (const [name, key] of [["live", LIVE_KEY], ["sandbox", TEST_KEY]]) {
  test("an idle minute still costs 17 GETs on a " + name + " key when the venue takes 150 ms to answer", async () => {
    const a = await mfpWorld(key);
    a.f.latency = 150;
    await a.start();
    await a.clock.advance(1_000);
    const from = a.clock.now();
    let heldSeconds = 0;
    for (let i = 0; i < 600; i++) {
      await a.clock.advance(1_000);
      const h = a.store.venueState().status.mfp.heldUntil;
      if (h !== null && h > a.clock.now()) heldSeconds++;
    }
    // ten minutes: the book every 10 s, the account every 30 s (once, not twice), the policy and the history every 60 s
    assert.deepEqual(tally(a.f.kinds(from)), { positions: 60, working: 60, account: 20, policy: 10, fills: 10, orders: 10 });
    assert.equal(a.f.count(from) / 10, 17);
    assert.equal(heldSeconds, 0, "the 'rate limited' line never showed on an idle account");
    // the most in any rolling 60 s
    const gets = a.f.gets.filter((g) => g.at > from);
    let rolling = 0;
    for (const g of gets) rolling = Math.max(rolling, gets.filter((x) => x.at > g.at - 60_000 && x.at <= g.at).length);
    assert.ok(rolling <= 20, "rolling 60 s maximum: " + rolling);
  });
}

test("with one write only its status can settle, a sandbox key stays under 30 and the book is never left unread for long (150 ms latency)", async () => {
  const a = await mfpWorld(TEST_KEY);
  a.f.latency = 150;
  await a.start();
  await a.clock.advance(60_000);
  // a market order whose answer is lost and that the venue never shows
  a.f.positions = [mpos()];
  await a.clock.advance(11_000);
  a.f.onWrite = async () => { throw new Error("socket hang up"); };
  a.f.look = () => [];
  await a.clock.settle(a.store.placeOrder(intent(), a.market()));
  assert.equal(a.store.venueState().pending.length, 1);
  await a.clock.advance(60_000);
  const from = a.clock.now();
  let heldSeconds = 0;
  for (let i = 0; i < 300; i++) {
    await a.clock.advance(1_000);
    const h = a.store.venueState().status.mfp.heldUntil;
    if (h !== null && h > a.clock.now()) heldSeconds++;
  }
  const gets = a.f.gets.filter((g) => g.at > from);
  let rolling = 0;
  for (const g of gets) rolling = Math.max(rolling, gets.filter((x) => x.at > g.at - 60_000 && x.at <= g.at).length);
  assert.ok(rolling <= 22, "rolling 60 s maximum with one unsettled write: " + rolling);
  const books = gets.filter((g) => g.kind === "positions").map((g) => g.at);
  let gap = 0;
  for (let i = 1; i < books.length; i++) gap = Math.max(gap, books[i] - books[i - 1]);
  assert.ok(gap <= 15_500, "longest gap between book reads: " + gap + " ms");
  assert.ok(gets.some((g) => g.kind === "lookup"), "the write is still asked about");
  assert.ok(heldSeconds <= 5, "seconds of 300 with the 'rate limited' line showing: " + heldSeconds);
});

test("a trade-path read answered 429 inside a hold does not push the hold out; with no hold running it sets one", async () => {
  const w = makeWorld();
  const f = scriptedMfp(w.clock);
  w.fetch = f.fetch;
  const ex = w.load("mfp_exchange");
  const { currentSession } = w.load("session");
  // a background read is refused: the key is held for 60 s
  f.answer = () => limited("60");
  await ex.fetchMfpBook(TEST_KEY, ACCT).catch(() => undefined);
  assert.equal(ex.mfpReadWait(TEST_KEY, 1), 60_000);
  // 40 s into the hold a Close is tried, and tried again: each of its reads is refused with another Retry-After: 60
  await w.clock.advance(40_000);
  f.positions = [mpos()];
  for (let i = 0; i < 3; i++) {
    const out = await w.clock.settle(ex.mfpClosePosition(currentSession(), TEST_KEY, SHOWN, 1, 0.01));
    assert.match(out.stopped, /could not be read; nothing was sent/, "the close fails closed while the venue refuses its reads");
  }
  assert.equal(f.sends.length, 0);
  assert.equal(ex.mfpReadWait(TEST_KEY, 1), 20_000, "the display's reads come back when the ORIGINAL hold ends, not a minute after the last close attempt");
  // the hold ends; a background 429 sets a new one as before
  await w.clock.advance(20_001);
  assert.equal(ex.mfpReadWait(TEST_KEY, 1), 0);
  // and a trade-path 429 with NO hold running sets one too
  const w2 = makeWorld();
  const f2 = scriptedMfp(w2.clock);
  w2.fetch = f2.fetch;
  const ex2 = w2.load("mfp_exchange");
  f2.answer = () => limited("60");
  await w2.clock.settle(ex2.mfpClosePosition(w2.load("session").currentSession(), TEST_KEY, SHOWN, 1, 0.01));
  assert.equal(ex2.mfpReadWait(TEST_KEY, 1), 60_000);
});

test("a look the budget did not let out is not a turn taken: unsettled writes still share the looks evenly", async () => {
  const ticker = { midOf: () => null, resetTicker() {}, tickerMarketsChanged() {} };
  const settings = fakeSettings();
  const sent = [];
  let asked = 0;
  const markets = ["A", "B"].map((id) => ({ key: "mfp:" + id, venue: "mfp", id, symbol: id, chartCoin: null, chartNote: null, szDecimals: 3, maxLeverage: 40, provider: null }));
  const none = { status: "unreadable", full: false, filled: 0, message: null };
  const mfp = {
    id: "mfp", maxLookups: 2,
    async ready() { return true; }, async tradeBlocked() { return null; }, async markets() { return markets; },
    async snapshot() { return { venue: "mfp", positions: [], orders: [], balance: null, mids: { A: 100, B: 100 }, chg24: {}, at: 0 }; },
    async history() { return []; }, async quote() { return { bid: null, ask: null, mid: 100, at: 0 }; },
    // a saturated budget: of the two looks a pass asks for, only the first goes out
    async lookup(ref) {
      asked++;
      if (asked % 2 === 0) return { ...none, held: true };
      sent.push(ref.clientOrderId);
      return { status: "open", full: false, filled: 0, message: "pending", resting: false };
    },
    async leverage() { return null; },
    async placeOrder(_i, market) { return { state: "pending", message: "still pending on MFP", ambiguous: false, ref: { venue: "mfp", clientOrderId: "id-" + market.id } }; },
  };
  const w = makeWorld({ mocks: { settings_store: settings, ticker_store: ticker, mode: { isMock: () => false, mockScenario: () => "" }, hl_venue: { hlVenue: inert }, mfp_venue: { mfpVenue: mfp } } });
  const store = w.load("venue_store");
  await store.startVenues();
  await w.clock.flush();
  for (const m of markets) await w.clock.settle(store.placeOrder(intent({ marketId: m.id }), m));
  await w.clock.advance(5_000);
  sent.length = 0;
  asked = 0;
  await w.clock.advance(200_000);
  const per = tally(sent);
  assert.ok(sent.length >= 18, "looks that went out: " + sent.length);
  assert.ok(Math.abs((per["id-A"] ?? 0) - (per["id-B"] ?? 0)) <= 1, "one each in turn, not two to one: " + JSON.stringify(per));
});
