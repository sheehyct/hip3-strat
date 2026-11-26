"use strict";

// src/candle_feed.js: the WebSocket candle feed's connection layer (stage
// 1 of the feed migration). A fake socket and a fake clock drive every path: subscribe batching
// and ack bookkeeping, the 30 s ping, the silence watchdog, reconnect with
// backoff and resubscribe, the roster diff, and covers().

const test = require("node:test");
const assert = require("node:assert");
const feedMod = require("../src/candle_feed.js");

const T0 = Date.UTC(2026, 8, 21, 2, 0, 0);

function fakeTime(start) {
  let t = start;
  const pending = [];
  let seq = 0;
  return {
    now: function () { return t; },
    setTimeout: function (fn, ms) { const id = ++seq; pending.push({ id: id, at: t + ms, fn: fn }); return id; },
    clearTimeout: function (id) { const i = pending.findIndex(function (p) { return p.id === id; }); if (i >= 0) pending.splice(i, 1); },
    advance: function (ms) {
      const target = t + ms;
      for (;;) {
        pending.sort(function (a, b) { return a.at - b.at; });
        if (!pending.length || pending[0].at > target) break;
        const p = pending.shift();
        t = Math.max(t, p.at);
        p.fn();
      }
      t = target;
    },
    pendingCount: function () { return pending.length; }
  };
}

// Minimal WebSocket stand-in: the test opens it, feeds it messages and
// closes it; `sent` records every outbound frame (parsed).
const sockets = [];
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    this.listeners = {};
    sockets.push(this);
  }
  addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
  emit(name, ev) { (this.listeners[name] || []).forEach(function (fn) { fn(ev || {}); }); }
  send(text) { if (this.readyState !== 1) throw new Error("not open"); this.sent.push(JSON.parse(text)); }
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.emit("open"); }
  message(obj) { this.emit("message", { data: JSON.stringify(obj) }); }
  serverClose(code) { this.readyState = 3; this.closed = true; this.emit("close", { code: code || 1006 }); }
}

function make(ft, extra) {
  sockets.length = 0;
  const lines = [];
  const bars = [];
  const feed = feedMod.createCandleFeed(Object.assign({
    WebSocket: FakeSocket, now: ft.now, setTimeout: ft.setTimeout, clearTimeout: ft.clearTimeout,
    log: function (l) { lines.push(l); },
    onBar: function (coin, bar, interval, at) { bars.push({ coin: coin, bar: bar, interval: interval, at: at }); }
  }, extra || {}));
  feed.lines = lines;
  feed.bars = bars;
  return feed;
}

function subsOf(sock) { return sock.sent.filter(function (m) { return m.method === "subscribe"; }).map(function (m) { return m.subscription.coin; }); }
function ack(sock, coin) { sock.message({ channel: "subscriptionResponse", data: { method: "subscribe", subscription: { type: "candle", coin: coin, interval: "15m" } } }); }

test("connect: subscriptions go out 25 per 100 ms, acks mark coins covered, the roster is the wanted set", function () {
  const ft = fakeTime(T0);
  const feed = make(ft);
  const names = [];
  for (let i = 0; i < 60; i++) names.push("xyz:C" + i);
  feed.setCoins(names);
  assert.strictEqual(feed.covers("xyz:C1"), false, "nothing is covered before the socket opens");
  feed.start();
  assert.strictEqual(sockets.length, 1);
  const s = sockets[0];
  assert.strictEqual(s.url, feedMod.WS_URL);
  s.open();
  assert.strictEqual(subsOf(s).length, 25, "first batch at open");
  ft.advance(100);
  assert.strictEqual(subsOf(s).length, 50);
  ft.advance(100);
  assert.deepStrictEqual(subsOf(s), names, "all 60 subscribed, in roster order");
  assert.deepStrictEqual(s.sent[0].subscription, { type: "candle", coin: "xyz:C0", interval: "15m" });
  assert.strictEqual(feed.covers("xyz:C1"), false, "subscribed but not yet acknowledged");
  ack(s, "xyz:C1");
  assert.strictEqual(feed.covers("xyz:C1"), true);
  assert.strictEqual(feed.covers("xyz:C2"), false);
  const snap = feed.snapshot();
  assert.strictEqual(snap.connected, true);
  assert.strictEqual(snap.wanted, 60);
  assert.strictEqual(snap.acked, 1);
  assert.strictEqual(snap.pendingSubscribes, 0);
  assert.strictEqual(snap.connects, 1);
  assert.strictEqual(snap.reconnects, 0);
  feed.stop();
  assert.strictEqual(s.closed, true);
  assert.strictEqual(feed.covers("xyz:C1"), false, "stopped: nothing covered");
});

test("a candle push reaches onBar as numbers; unknown coins and malformed frames are counted, not delivered", function () {
  const ft = fakeTime(T0);
  const feed = make(ft);
  feed.setCoins(["BTC", "xyz:AAPL"]);
  feed.start();
  const s = sockets[0];
  s.open();
  ack(s, "BTC");
  s.message({ channel: "candle", data: { t: T0, T: T0 + 899999, s: "BTC", i: "15m", o: "100", c: "101.5", h: "102", l: "99.5", v: "12.25", n: 7 } });
  assert.strictEqual(feed.bars.length, 1);
  assert.deepStrictEqual(feed.bars[0].bar, { t: T0, T: T0 + 899999, o: 100, h: 102, l: 99.5, c: 101.5, v: 12.25, n: 7 });
  assert.strictEqual(feed.bars[0].coin, "BTC");
  assert.strictEqual(feed.bars[0].interval, "15m");
  assert.strictEqual(feed.bars[0].at, T0);
  s.message({ channel: "candle", data: { t: T0, T: T0 + 899999, s: "ETH", i: "15m", o: "1", c: "1", h: "1", l: "1", v: "0", n: 1 } });
  assert.strictEqual(feed.bars.length, 1, "a coin we did not subscribe is dropped");
  s.emit("message", { data: "{not json" });
  s.message({ channel: "candle", data: { t: T0, s: "BTC", o: "x", h: "1", l: "1", c: "1" } });
  assert.strictEqual(feed.bars.length, 1, "a non-numeric bar is dropped");
  s.message({ channel: "candle", data: { t: T0, T: "soon", s: "BTC", i: "15m", o: "1", c: "1", h: "1", l: "1", v: "1", n: 1 } });
  assert.strictEqual(feed.bars.length, 1, "a bar with a non-numeric T is dropped (T drives the roll clock)");
  s.message({ channel: "candle", data: { t: T0, T: T0 + 899999, s: "BTC", i: "15m", o: "1", c: "1", h: "1", l: "1", v: "1" } });
  assert.strictEqual(feed.bars.length, 2, "a missing n is 0, not a drop");
  assert.strictEqual(feed.bars[1].bar.n, 0);
  const snap = feed.snapshot();
  assert.strictEqual(snap.unparsable, 3);
  assert.strictEqual(snap.candles, 5);
  assert.strictEqual(snap.coinsPushed, 1);
  assert.strictEqual(snap.messages, 7);
  feed.stop();
});

test("ping every 30 s while open; a pong records its latency; silence for 45 s closes the socket and reconnects with backoff and a full resubscribe", function () {
  const ft = fakeTime(T0);
  let reconnects = 0;
  const feed = make(ft, { onReconnect: function () { reconnects++; } });
  feed.setCoins(["BTC", "ETH"]);
  feed.start();
  const s1 = sockets[0];
  s1.open();
  ack(s1, "BTC"); ack(s1, "ETH");
  assert.strictEqual(s1.sent.filter(function (m) { return m.method === "ping"; }).length, 0);
  ft.advance(30000);
  assert.strictEqual(s1.sent.filter(function (m) { return m.method === "ping"; }).length, 1, "first ping at 30 s");
  ft.advance(150);
  s1.message({ channel: "pong" });
  assert.strictEqual(feed.snapshot().lastPongMs, 150);
  // Keep the socket alive with a candle every 20 s: no watchdog close.
  for (let i = 0; i < 6; i++) {
    ft.advance(20000);
    s1.message({ channel: "candle", data: { t: T0, T: T0 + 899999, s: "BTC", i: "15m", o: "1", c: "1", h: "1", l: "1", v: "1", n: 1 } });
  }
  assert.strictEqual(s1.closed, false);
  assert.strictEqual(feed.snapshot().watchdogCloses, 0);
  // Now silence: 45 s without any inbound frame.
  ft.advance(45000);
  assert.strictEqual(s1.closed, true, "watchdog closed the silent socket");
  assert.strictEqual(feed.snapshot().watchdogCloses, 1);
  assert.strictEqual(feed.covers("BTC"), false, "nothing is covered while down");
  assert.strictEqual(sockets.length, 1, "reconnect waits for the backoff");
  ft.advance(1000);
  assert.strictEqual(sockets.length, 2, "reconnected after 1 s");
  const s2 = sockets[1];
  // The second socket fails outright: the next wait doubles.
  s2.serverClose(1006);
  ft.advance(1999);
  assert.strictEqual(sockets.length, 2);
  ft.advance(1);
  assert.strictEqual(sockets.length, 3, "2 s backoff");
  const s3 = sockets[2];
  s3.open();
  assert.deepStrictEqual(subsOf(s3), ["BTC", "ETH"], "full resubscribe on the new socket");
  assert.strictEqual(reconnects, 1, "onReconnect fired once, for the socket that actually opened");
  assert.strictEqual(feed.covers("BTC"), false, "not covered until re-acknowledged");
  ack(s3, "BTC");
  assert.strictEqual(feed.covers("BTC"), true);
  const snap = feed.snapshot();
  assert.strictEqual(snap.connects, 2);
  assert.strictEqual(snap.reconnects, 1);
  assert.strictEqual(snap.coinsPushed, 0, "per-connection counter reset");
  // A late event from the dead socket is ignored.
  s1.emit("close", { code: 1000 });
  assert.strictEqual(feed.isConnected(), true);
  // Backoff resets after a successful open: a later drop reconnects in 1 s again.
  s3.serverClose(1001);
  ft.advance(1000);
  assert.strictEqual(sockets.length, 4);
  feed.stop();
  assert.strictEqual(ft.pendingCount(), 0, "stop() clears every timer");
});

test("backoff caps at 30 s", function () {
  const ft = fakeTime(T0);
  const feed = make(ft);
  feed.setCoins(["BTC"]);
  feed.start();
  let expect = 1000;
  for (let i = 0; i < 8; i++) {
    const s = sockets[sockets.length - 1];
    s.serverClose(1006);
    const before = sockets.length;
    ft.advance(Math.min(expect, 30000) - 1);
    assert.strictEqual(sockets.length, before, "not yet at " + expect);
    ft.advance(1);
    assert.strictEqual(sockets.length, before + 1);
    expect = Math.min(expect * 2, 30000);
  }
  feed.stop();
});

test("setCoins diffs the roster: new names subscribe, dropped names unsubscribe and stop being covered; idempotent", function () {
  const ft = fakeTime(T0);
  const feed = make(ft);
  feed.setCoins(["A", "B"]);
  feed.start();
  const s = sockets[0];
  s.open();
  ack(s, "A"); ack(s, "B");
  const r1 = feed.setCoins(["A", "B"]);
  assert.deepStrictEqual(r1, { added: 0, dropped: 0 });
  const r2 = feed.setCoins(["B", "C"]);
  assert.deepStrictEqual(r2, { added: 1, dropped: 1 });
  assert.strictEqual(feed.covers("A"), false);
  const unsub = s.sent.filter(function (m) { return m.method === "unsubscribe"; });
  assert.strictEqual(unsub.length, 1);
  assert.deepStrictEqual(unsub[0].subscription, { type: "candle", coin: "A", interval: "15m" });
  assert.deepStrictEqual(subsOf(s).slice(-1), ["C"], "C subscribed immediately (nothing else pending)");
  ack(s, "C");
  assert.strictEqual(feed.covers("C"), true);
  assert.strictEqual(feed.covers("B"), true);
  // A push for the dropped coin is ignored.
  s.message({ channel: "candle", data: { t: T0, T: T0 + 899999, s: "A", i: "15m", o: "1", c: "1", h: "1", l: "1", v: "1", n: 1 } });
  assert.strictEqual(feed.bars.length, 0);
  assert.strictEqual(feed.snapshot().wanted, 2);
  feed.stop();
});

test("setCoins before the socket opens queues everything for the open; a name added while a batch is pending joins the pump", function () {
  const ft = fakeTime(T0);
  const feed = make(ft);
  const names = [];
  for (let i = 0; i < 30; i++) names.push("N" + i);
  feed.setCoins(names);
  feed.start();
  const s = sockets[0];
  s.open();
  assert.strictEqual(subsOf(s).length, 25);
  feed.setCoins(names.concat(["LATE"]));
  ft.advance(100);
  assert.strictEqual(subsOf(s).length, 31);
  assert.ok(subsOf(s).indexOf("LATE") >= 0);
  assert.strictEqual(feed.snapshot().pendingSubscribes, 0);
  feed.stop();
});

test("constants match the documented limits the brief re-read", function () {
  assert.strictEqual(feedMod.PING_MS, 30000);
  assert.strictEqual(feedMod.STALE_MS, 45000);
  assert.strictEqual(feedMod.SUBSCRIBE_BATCH, 25);
  assert.strictEqual(feedMod.SUBSCRIBE_TICK_MS, 100);
  assert.strictEqual(feedMod.BACKOFF_MIN_MS, 1000);
  assert.strictEqual(feedMod.BACKOFF_MAX_MS, 30000);
  assert.throws(function () { feedMod.createCandleFeed({ WebSocket: {} }); }, /no WebSocket/);
});

// -- Reconnect liveness (production incident 2026-09-26 08:32Z): the third
// connection closed (1006), the retry attempt fired its 'error' event with
// NO close event following, and the feed stayed down 4.6 h with no timer
// pending. The invariant these tests pin: while start()ed, the feed is
// always connected, mid-attempt with a deadline, or reconnect-scheduled.

test("an attempt that errors WITHOUT a close event still retries (2026-09-26 incident vector)", function () {
  const ft = fakeTime(T0);
  const feed = make(ft);
  feed.setCoins(["xyz:AAPL"]);
  feed.start();
  sockets[0].open();
  ack(sockets[0], "xyz:AAPL");
  sockets[0].serverClose(1006);            // the 08:32:21Z close
  ft.advance(1000);                        // backoff -> attempt #2
  assert.strictEqual(sockets.length, 2, "retry attempt created");
  sockets[1].emit("error", {});            // handshake failure: error, close never fires
  // The TERMINAL-ERROR layer must do the recovery, within its own backoff
  // (2 s here) - long before the 20 s attempt deadline could mask it
  // (code review 2026-09-26 LOW: the first version of this test waited
  // past the deadline, so removing the error handler still passed).
  ft.advance(2100);
  assert.strictEqual(sockets.length, 3, "retried within the backoff after error-without-close");
  assert.strictEqual(feed.snapshot().connectTimeouts, 0, "the deadline was not involved");
  sockets[2].open();
  assert.strictEqual(feed.snapshot().connected, true, "the recovery attempt can open");
  feed.stop();
});

test("an attempt that never opens, errors, or closes is timed out and retried", function () {
  const ft = fakeTime(T0);
  const feed = make(ft);
  feed.setCoins(["xyz:AAPL"]);
  feed.start();                            // attempt #1 hangs in CONNECTING forever
  ft.advance(feedMod.CONNECT_TIMEOUT_MS + feedMod.BACKOFF_MAX_MS + 1000);
  assert.ok(sockets.length >= 2, "a hung CONNECTING attempt must be dropped and retried (got " + sockets.length + " sockets)");
  const snap = feed.snapshot();
  assert.ok(snap.connectTimeouts >= 1, "connectTimeouts counted");
  feed.stop();
});

test("error followed by close schedules exactly one retry (no double-connect)", function () {
  const ft = fakeTime(T0);
  const feed = make(ft);
  feed.setCoins(["xyz:AAPL"]);
  feed.start();
  sockets[0].open();
  sockets[0].emit("error", {});
  sockets[0].serverClose(1006);            // close follows the error, as the old comment assumed
  ft.advance(1500);                        // past the 1 s backoff, before any attempt deadline
  assert.strictEqual(sockets.length, 2, "exactly one retry attempt");
  sockets[1].open();
  assert.strictEqual(feed.snapshot().connected, true);
  ft.advance(feedMod.STALE_MS - 5000);     // inside the silence watchdog's window
  assert.strictEqual(sockets.length, 2, "no spurious retry while connected");
  feed.stop();
});

test("self-check recovers a genuine orphan state (a lost reconnect timer) and counts it", function () {
  const ft = fakeTime(T0);
  // Force the state the self-check exists for: not connected, no attempt,
  // no timer pending. The close handler's scheduleReconnect dies before it
  // can store a handle (the scheduling call throws once - the class of
  // hole the other layers cannot know about), so only the self-check can
  // recover. (code review 2026-09-26 LOW: the first version of this test
  // recovered via the connect deadline instead, and its
  // stalledRecoveries >= 0 assertion was vacuous.)
  let throwNext = false;
  const setT = function (fn, ms) {
    if (throwNext && ms === feedMod.BACKOFF_MIN_MS) { throwNext = false; throw new Error("simulated scheduling hole"); }
    return ft.setTimeout(fn, ms);
  };
  const feed = make(ft, { setTimeout: setT });
  feed.setCoins(["xyz:AAPL"]);
  feed.start();
  sockets[0].open();
  throwNext = true;
  assert.throws(function () { sockets[0].serverClose(1006); }, /simulated scheduling hole/);
  ft.advance(feedMod.BACKOFF_MIN_MS + 1000);
  assert.strictEqual(sockets.length, 1, "orphaned: nothing reconnects on its own");
  ft.advance(feedMod.SELF_CHECK_MS + feedMod.BACKOFF_MAX_MS);
  assert.ok(sockets.length >= 2, "self-check recovered the orphan (got " + sockets.length + " sockets)");
  assert.strictEqual(feed.snapshot().stalledRecoveries, 1, "recovery counted");
  assert.ok(feed.lines.some(function (l) { return /reconnect stalled/.test(l); }), "recovery logged");
  feed.stop();
});

test("a repeated start() does not stack self-check chains or leak timers past stop()", function () {
  const ft = fakeTime(T0);
  const feed = make(ft);
  feed.setCoins(["xyz:AAPL"]);
  feed.start();
  feed.start();                            // second start: must not arm a second chain
  sockets[sockets.length - 1].open();
  feed.stop();
  assert.strictEqual(ft.pendingCount(), 0, "no timer survives stop()");
});

test("socket error is logged, never silent", function () {
  const ft = fakeTime(T0);
  const feed = make(ft);
  feed.setCoins(["xyz:AAPL"]);
  feed.start();
  sockets[0].open();
  sockets[0].emit("error", { message: "getaddrinfo ENOTFOUND" });
  assert.ok(feed.lines.some(function (l) { return /socket error/.test(l); }),
    "the error event must leave a log line (the 2026-09-26 outage was invisible)");
  feed.stop();
});
