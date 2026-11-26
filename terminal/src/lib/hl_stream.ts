// Hyperliquid's public WebSocket (read-only market data): one shared socket,
// any number of subscriptions (the chart's candle stream, allMids for the
// watchlist and tags, bbo for the one-click panel). It keeps the
// lessons learned on a phone: a 20 s ping, a
// 50 s any-message watchdog (a phone's socket can go half-open without ever
// reporting a close), reconnect with backoff, a gap callback so the chart
// refetches what it missed, and candle updates coalesced to one delivery
// per MIN_EMIT_MS. The socket closes in the background and reopens (and
// resubscribes everything) when the app returns.
//
// This file may send nothing but subscribe / unsubscribe / ping
// (scripts/check-exchange-guard.js). It never carries a key.
import { AppState } from "react-native";
import type { AppStateStatus } from "react-native";

import { Bar, parseHlWsBbo, parseHlWsCandle, parseHlWsMids } from "./candles";
import { HL_WS_URL } from "./hyperliquid";

const MIN_EMIT_MS = 250;
const PING_MS = 20_000;
const STALE_MS = 50_000;
const RETRY_MS = [1000, 2000, 5000, 10000];
const IDLE_CLOSE_MS = 5_000;

export type StreamSpec =
  | { type: "candle"; coin: string; interval: string }
  | { type: "allMids"; dex: string }
  | { type: "bbo"; coin: string };

export type StreamMessage =
  | { type: "candle"; bar: Bar }
  | { type: "allMids"; mids: Record<string, number> }
  | { type: "bbo"; bid: number | null; ask: number | null };

type Listener = {
  onMsg: (m: StreamMessage) => void;
  onGap?: () => void;            // the socket (re)opened after this listener was already live
  onLive?: (live: boolean) => void;
};

type Sub = { key: string; spec: StreamSpec; listeners: Set<Listener>; opened: boolean; pending: Bar | null; emitTimer: ReturnType<typeof setTimeout> | null; lastEmit: number };

const subs = new Map<string, Sub>();
let ws: WebSocket | null = null;
let ping: ReturnType<typeof setInterval> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
let idle: ReturnType<typeof setTimeout> | null = null;
let lastMsgAt = 0;
let appActive = AppState.currentState === "active";
let socketLive = false;

const specKey = (s: StreamSpec) => JSON.stringify(s);
const venueSub = (s: StreamSpec): object =>
  s.type === "candle" ? { type: "candle", coin: s.coin, interval: s.interval }
    : s.type === "allMids" ? (s.dex ? { type: "allMids", dex: s.dex } : { type: "allMids" })
      : { type: "bbo", coin: s.coin };
const subMsg = (s: StreamSpec, method: "subscribe" | "unsubscribe") => JSON.stringify({ method, subscription: venueSub(s) });

function flush(sub: Sub) {
  sub.emitTimer = null;
  if (!sub.pending) return;
  const b = sub.pending;
  sub.pending = null;
  sub.lastEmit = Date.now();
  for (const l of sub.listeners) l.onMsg({ type: "candle", bar: b });
}

function deliverCandle(sub: Sub, b: Bar) {
  // A new bar must never overwrite the previous bar's last update (its
  // final high/low/close): hand that over first, then queue the new one.
  if (sub.pending && sub.pending.time !== b.time) {
    if (sub.emitTimer) { clearTimeout(sub.emitTimer); sub.emitTimer = null; }
    flush(sub);
  }
  sub.pending = b;
  if (sub.emitTimer) return;
  const wait = Math.max(0, sub.lastEmit + MIN_EMIT_MS - Date.now());
  sub.emitTimer = setTimeout(() => flush(sub), wait);
}

function setLive(live: boolean) {
  if (socketLive === live) return;
  socketLive = live;
  for (const s of subs.values()) for (const l of s.listeners) l.onLive?.(live);
}

function teardown() {
  if (ping) { clearInterval(ping); ping = null; }
  if (retry) { clearTimeout(retry); retry = null; }
  if (ws) {
    const old = ws;
    ws = null;
    old.onopen = null; old.onmessage = null; old.onclose = null; old.onerror = null;
    try { old.close(); } catch { /* already closed */ }
  }
  setLive(false);
}

function connect() {
  if (!subs.size || !appActive || ws) return;
  const sock = new WebSocket(HL_WS_URL);
  ws = sock;
  const lost = () => {
    if (ws !== sock) return;
    teardown();
    if (!subs.size || !appActive) return;
    retry = setTimeout(connect, RETRY_MS[Math.min(retries, RETRY_MS.length - 1)]);
    retries++;
  };
  sock.onopen = () => {
    retries = 0;
    lastMsgAt = Date.now();
    for (const s of subs.values()) {
      try { sock.send(subMsg(s.spec, "subscribe")); } catch { /* lost() follows */ }
      if (s.opened) for (const l of s.listeners) l.onGap?.();
      s.opened = true;
    }
    setLive(true);
    ping = setInterval(() => {
      if (Date.now() - lastMsgAt > STALE_MS) { lost(); return; }
      try { sock.send(JSON.stringify({ method: "ping" })); } catch { /* the next tick reconnects */ }
    }, PING_MS);
  };
  sock.onmessage = (ev) => {
    lastMsgAt = Date.now();
    let msg: unknown;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    const c = parseHlWsCandle(msg);
    if (c) {
      const s = subs.get(specKey({ type: "candle", coin: c.coin, interval: c.interval }));
      if (s) deliverCandle(s, c.bar);
      return;
    }
    const mids = parseHlWsMids(msg);
    if (mids) {
      // Every allMids subscription (main dex and each builder dex) answers on
      // the same channel; coin names are unique across dexes, so every
      // listener gets every update.
      for (const s of subs.values()) if (s.spec.type === "allMids") for (const l of s.listeners) l.onMsg({ type: "allMids", mids });
      return;
    }
    const bbo = parseHlWsBbo(msg);
    if (bbo) {
      const s = subs.get(specKey({ type: "bbo", coin: bbo.coin }));
      if (s) for (const l of s.listeners) l.onMsg({ type: "bbo", bid: bbo.bid, ask: bbo.ask });
    }
  };
  sock.onclose = lost;
  sock.onerror = lost;
}

// The chart saw REST candles move while the stream delivered nothing: the
// stream is dead even if the socket still answers pings. Reconnect now
// (onGap refills, onLive reports).
export function restartStream(): void {
  if (!subs.size || !appActive) return;
  teardown();
  retries = 0;
  connect();
}

AppState.addEventListener("change", (s: AppStateStatus) => {
  const active = s === "active";
  if (active === appActive) return;
  appActive = active;
  if (!active) teardown();
  else connect();
});

export function streamLive(): boolean {
  return socketLive;
}

// Subscribe a listener to `spec`; returns the unsubscribe. Listeners on the
// same spec share one venue subscription.
export function subscribeStream(spec: StreamSpec, listener: Listener): () => void {
  const key = specKey(spec);
  let s = subs.get(key);
  const fresh = !s;
  if (!s) {
    s = { key, spec, listeners: new Set(), opened: false, pending: null, emitTimer: null, lastEmit: 0 };
    subs.set(key, s);
  }
  s.listeners.add(listener);
  if (idle) { clearTimeout(idle); idle = null; }
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (fresh) {
      try { ws.send(subMsg(spec, "subscribe")); s.opened = true; } catch { teardown(); connect(); }
    }
    if (socketLive) listener.onLive?.(true);
  } else if (!ws) {
    connect();
  } // CONNECTING: onopen subscribes whatever is in `subs` then
  return () => {
    const cur = subs.get(key);
    if (!cur) return;
    cur.listeners.delete(listener);
    if (cur.listeners.size) return;
    subs.delete(key);
    if (cur.emitTimer) { clearTimeout(cur.emitTimer); cur.emitTimer = null; }
    cur.pending = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(subMsg(spec, "unsubscribe")); } catch { /* closing anyway */ }
    }
    if (!subs.size) {
      // Keep the socket a moment: a TF switch unsubscribes and resubscribes
      // back to back.
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => { idle = null; if (!subs.size) teardown(); }, IDLE_CLOSE_MS);
    }
  };
}

// The chart's candle stream (the shape chart-data.ts uses).
export function streamCandles(
  coin: string, interval: string, onBar: (b: Bar) => void, onGap?: () => void, onLive?: (live: boolean) => void,
): () => void {
  return subscribeStream({ type: "candle", coin, interval }, {
    onMsg: (m) => { if (m.type === "candle") onBar(m.bar); },
    onGap, onLive,
  });
}
