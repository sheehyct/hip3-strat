"use strict";

// WebSocket candle feed (design decision 2026-09-21: option A,
// stage 1). One connection to the exchange's WS carrying one
// {type:"candle", coin, interval:"15m"} subscription per tracked coin; the
// loop consumes the pushes (loop.js applyFeedBar) and this module owns
// nothing but the connection: subscribe/unsubscribe bookkeeping, the 30 s
// ping the server requires, a watchdog that reconnects when the socket has
// gone silent, backoff, resubscribe, and the counters /health serves.
//
// Measured basis: 288
// subscriptions on one connection are acknowledged in ~1.5 s; there is NO
// snapshot on subscribe (the first message is the forming bar at the first
// trade); messages are coalesced ~1/s per active coin; a closed bar gets no
// late update; the server closes a connection it has not sent to for 60 s;
// documented per-IP caps: 10 connections, 30 new connections/min, 1,000
// subscriptions, 2,000 outbound messages/min. There is no resume: after a
// reconnect the client resubscribes and the loop re-snapshots (a
// reconciliation pass) to cover the gap.
//
// Everything time- and socket-related is injectable so the tests drive a
// fake socket with a fake clock; production passes nothing and gets the
// global WebSocket (node:22-slim ships it - no dependency).

const WS_URL = "wss://api.hyperliquid.xyz/ws";
const PING_MS = 30000;
// No inbound message of any kind (candle, pong, ack) for this long means the
// connection is dead as far as we can tell; 288 coins on a 24/7 venue never
// go 45 s without a trade, and the pong alone arrives every 30 s.
const STALE_MS = 45000;
const SUBSCRIBE_BATCH = 25;         // per SUBSCRIBE_TICK_MS - well under 2,000 messages/min
const SUBSCRIBE_TICK_MS = 100;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
// A connection attempt must resolve (open, error, or close) within this
// long, or it is dropped and retried. Added 2026-09-26: a production
// attempt fired 'error' with NO close event following and the feed stayed
// down 4.6 h with nothing pending - never assume the close arrives.
const CONNECT_TIMEOUT_MS = 20000;
// Last-resort liveness invariant, checked on a slow cadence: while started,
// the feed is connected, mid-attempt with a deadline, or reconnect-scheduled.
// If none of the three holds, recover. Belt and braces over the layers above.
const SELF_CHECK_MS = 60000;

function createCandleFeed(opts) {
  opts = opts || {};
  const log = opts.log || function () {};
  const now = opts.now || Date.now;
  const setT = opts.setTimeout || setTimeout;
  const clearT = opts.clearTimeout || clearTimeout;
  const WS = opts.WebSocket || globalThis.WebSocket;
  const url = opts.url || WS_URL;
  const interval = opts.interval || "15m";
  const onBar = opts.onBar || function () {};
  const onReconnect = opts.onReconnect || function () {};
  const connectTimeoutMs = opts.connectTimeoutMs || CONNECT_TIMEOUT_MS;
  const selfCheckMs = opts.selfCheckMs || SELF_CHECK_MS;
  if (typeof WS !== "function") throw new Error("candle feed: no WebSocket implementation");

  // coin -> {acked: bool}
  const wanted = new Map();
  let sock = null;
  let connected = false;
  let connectedSince = null;
  let stopped = false;
  let backoff = BACKOFF_MIN_MS;
  let lastInbound = 0;
  let lastPingAt = null;
  let pingTimer = null, watchdogTimer = null, reconnectTimer = null, subTimer = null;
  let connectTimer = null, selfCheckTimer = null;
  let pendingSubs = [];               // coins whose subscribe message is still to be sent
  let generation = 0;                 // bumps per connection; stale socket events are ignored
  const stats = {
    connects: 0, reconnects: 0, messages: 0, bytes: 0, candles: 0, acks: 0,
    unparsable: 0, lastPongMs: null, watchdogCloses: 0, errors: 0,
    connectTimeouts: 0, stalledRecoveries: 0
  };
  const pushedThisConnection = new Set();

  function send(obj) {
    if (!sock || sock.readyState !== 1) return false;
    try { sock.send(JSON.stringify(obj)); return true; }
    catch (e) { log("candle feed: send failed: " + (e && e.message)); return false; }
  }

  function armWatchdog(delay) {
    if (watchdogTimer) clearT(watchdogTimer);
    watchdogTimer = setT(function () {
      watchdogTimer = null;
      if (stopped || !connected) return;
      const silent = now() - lastInbound;
      if (silent >= STALE_MS) {
        stats.watchdogCloses++;
        log("candle feed: no inbound message for " + Math.round(silent / 1000) + " s - reconnecting");
        dropSocket();
        scheduleReconnect();
      } else {
        armWatchdog(STALE_MS - silent);   // fire exactly when the silence would reach the limit
      }
    }, delay || STALE_MS);
  }

  function dropSocket() {
    connected = false;
    connectedSince = null;
    generation++;
    if (pingTimer) { clearT(pingTimer); pingTimer = null; }
    if (watchdogTimer) { clearT(watchdogTimer); watchdogTimer = null; }
    if (connectTimer) { clearT(connectTimer); connectTimer = null; }
    if (subTimer) { clearT(subTimer); subTimer = null; }
    pendingSubs = [];
    wanted.forEach(function (rec) { rec.acked = false; });
    pushedThisConnection.clear();
    const s = sock;
    sock = null;
    if (s) { try { s.close(); } catch (e) { /* already closed */ } }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const wait = backoff;
    backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    reconnectTimer = setT(function () { reconnectTimer = null; connect(); }, wait);
  }

  function pumpSubscriptions() {
    subTimer = null;
    if (!connected || !pendingSubs.length) return;
    const batch = pendingSubs.splice(0, SUBSCRIBE_BATCH);
    for (let i = 0; i < batch.length; i++) {
      send({ method: "subscribe", subscription: { type: "candle", coin: batch[i], interval: interval } });
    }
    if (pendingSubs.length) subTimer = setT(pumpSubscriptions, SUBSCRIBE_TICK_MS);
  }

  function queueSubscribe(names) {
    for (let i = 0; i < names.length; i++) if (pendingSubs.indexOf(names[i]) < 0) pendingSubs.push(names[i]);
    if (connected && !subTimer) pumpSubscriptions();
  }

  function handleMessage(text) {
    const t = now();
    lastInbound = t;
    stats.messages++;
    stats.bytes += (typeof text === "string" ? text.length : 0);
    let m;
    try { m = JSON.parse(text); } catch (e) { stats.unparsable++; return; }
    const ch = m && m.channel;
    if (ch === "pong") {
      if (lastPingAt !== null) { stats.lastPongMs = t - lastPingAt; lastPingAt = null; }
      return;
    }
    if (ch === "subscriptionResponse") {
      const s = m.data && m.data.subscription;
      if (s && s.type === "candle" && wanted.has(s.coin)) { wanted.get(s.coin).acked = true; stats.acks++; }
      return;
    }
    if (ch === "candle") {
      const d = m.data;
      if (!d || typeof d.s !== "string") return;
      stats.candles++;
      if (!wanted.has(d.s)) return;            // unsubscribed meanwhile
      pushedThisConnection.add(d.s);
      const bar = { t: +d.t, T: +d.T, o: +d.o, h: +d.h, l: +d.l, c: +d.c, v: +d.v, n: d.n === undefined ? 0 : +d.n };
      // Every field the loop stores or times on must be a number: T drives
      // the roll clock, v and n are served (review 2026-09-22 LOW).
      if (!isFinite(bar.t) || !isFinite(bar.T) || !isFinite(bar.o) || !isFinite(bar.h) || !isFinite(bar.l)
          || !isFinite(bar.c) || !isFinite(bar.v) || !isFinite(bar.n)) { stats.unparsable++; return; }
      try { onBar(d.s, bar, d.i, t); }
      catch (e) { stats.errors++; log("candle feed: onBar threw: " + (e && e.message)); }
      return;
    }
    if (ch === "error") { stats.errors++; log("candle feed: server error: " + JSON.stringify(m.data).slice(0, 200)); }
  }

  function connect() {
    if (stopped || sock) return;
    const gen = ++generation;
    let s;
    try { s = new WS(url); }
    catch (e) { log("candle feed: connect failed: " + (e && e.message)); scheduleReconnect(); return; }
    sock = s;
    const isCurrent = function () { return gen === generation && sock === s; };
    // The attempt's deadline: an attempt that neither opens nor dies within
    // the timeout (a socket stuck in CONNECTING, or an error whose close
    // never arrives) is dropped and retried.
    connectTimer = setT(function () {
      connectTimer = null;
      if (stopped || !isCurrent() || connected) return;
      stats.connectTimeouts++;
      log("candle feed: connect attempt timed out after " + Math.round(connectTimeoutMs / 1000) + " s - retrying");
      dropSocket();
      scheduleReconnect();
    }, connectTimeoutMs);
    s.addEventListener("open", function () {
      if (!isCurrent()) return;
      if (connectTimer) { clearT(connectTimer); connectTimer = null; }
      connected = true;
      connectedSince = now();
      lastInbound = now();
      const first = stats.connects === 0;
      stats.connects++;
      if (!first) stats.reconnects++;
      backoff = BACKOFF_MIN_MS;
      log("candle feed: connected (" + wanted.size + " subscriptions to send" + (first ? "" : ", reconnect " + stats.reconnects) + ")");
      pendingSubs = Array.from(wanted.keys());
      pumpSubscriptions();
      pingTimer = setT(function ping() {
        if (!isCurrent() || !connected) return;
        lastPingAt = now();
        send({ method: "ping" });
        pingTimer = setT(ping, PING_MS);
      }, PING_MS);
      armWatchdog();
      if (!first) { try { onReconnect(); } catch (e) { log("candle feed: onReconnect threw: " + (e && e.message)); } }
    });
    s.addEventListener("message", function (ev) {
      if (!isCurrent()) return;
      handleMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
    });
    s.addEventListener("close", function (ev) {
      if (!isCurrent()) return;
      log("candle feed: socket closed (" + (ev && ev.code) + ")");
      dropSocket();
      scheduleReconnect();
    });
    s.addEventListener("error", function (ev) {
      if (!isCurrent()) return;
      stats.errors++;
      // Never assume the close event follows: on 2026-09-26 a failed
      // attempt fired 'error' alone and the feed stayed down 4.6 h.
      // Treat the error as terminal; if a close does follow, the
      // generation bump makes it a no-op.
      const detail = ev && (ev.message || (ev.error && ev.error.message));
      log("candle feed: socket error" + (detail ? ": " + detail : "") + " - reconnecting");
      dropSocket();
      scheduleReconnect();
    });
  }

  // The liveness invariant, on a slow cadence: while started, the feed is
  // connected, mid-attempt (connectTimer pending), or reconnect-scheduled.
  // Layers above should make this unreachable; if it fires, something new
  // broke and it both recovers and says so.
  function armSelfCheck() {
    if (selfCheckTimer) clearT(selfCheckTimer);   // a repeated start() must not stack chains
    selfCheckTimer = setT(function () {
      selfCheckTimer = null;
      if (stopped) return;
      if (!connected && !reconnectTimer && !connectTimer) {
        stats.stalledRecoveries++;
        log("candle feed: reconnect stalled (not connected, no attempt, no timer) - recovering");
        dropSocket();
        scheduleReconnect();
      }
      armSelfCheck();
    }, selfCheckMs);
  }

  function start() { stopped = false; armSelfCheck(); connect(); }

  function stop() {
    stopped = true;
    if (reconnectTimer) { clearT(reconnectTimer); reconnectTimer = null; }
    if (selfCheckTimer) { clearT(selfCheckTimer); selfCheckTimer = null; }
    dropSocket();
  }

  // Reconcile the subscription set with the roster: subscribe new names,
  // unsubscribe dropped ones. Idempotent.
  function setCoins(names) {
    const next = new Set(names);
    const add = [];
    next.forEach(function (n) { if (!wanted.has(n)) { wanted.set(n, { acked: false }); add.push(n); } });
    const drop = [];
    wanted.forEach(function (rec, n) { if (!next.has(n)) drop.push(n); });
    drop.forEach(function (n) {
      wanted.delete(n);
      pushedThisConnection.delete(n);
      const i = pendingSubs.indexOf(n);
      if (i >= 0) pendingSubs.splice(i, 1);
      send({ method: "unsubscribe", subscription: { type: "candle", coin: n, interval: interval } });
    });
    if (add.length) queueSubscribe(add);
    return { added: add.length, dropped: drop.length };
  }

  // A coin is COVERED when the socket is open and its subscription is
  // acknowledged; the loop's timer and true-up consult this and fall back
  // to the REST path for everything else.
  function covers(name) {
    if (!connected) return false;
    const rec = wanted.get(name);
    return !!(rec && rec.acked);
  }

  function snapshot(t) {
    t = t || now();
    let acked = 0;
    wanted.forEach(function (rec) { if (rec.acked) acked++; });
    return {
      connected: connected,
      connectedSince: connectedSince ? new Date(connectedSince).toISOString() : null,
      wanted: wanted.size,
      acked: acked,
      pendingSubscribes: pendingSubs.length,
      coinsPushed: pushedThisConnection.size,
      messages: stats.messages,
      bytes: stats.bytes,
      candles: stats.candles,
      lastMessageAgeMs: lastInbound ? t - lastInbound : null,
      lastPongMs: stats.lastPongMs,
      connects: stats.connects,
      reconnects: stats.reconnects,
      watchdogCloses: stats.watchdogCloses,
      unparsable: stats.unparsable,
      errors: stats.errors,
      connectTimeouts: stats.connectTimeouts,
      stalledRecoveries: stats.stalledRecoveries
    };
  }

  return { start: start, stop: stop, setCoins: setCoins, covers: covers, snapshot: snapshot,
           isConnected: function () { return connected; } };
}

module.exports = { createCandleFeed, WS_URL, PING_MS, STALE_MS, SUBSCRIBE_BATCH, SUBSCRIBE_TICK_MS,
                   BACKOFF_MIN_MS, BACKOFF_MAX_MS, CONNECT_TIMEOUT_MS, SELF_CHECK_MS };
