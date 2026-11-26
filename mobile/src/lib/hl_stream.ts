// Live candles for the ONE open position chart, over Hyperliquid's public
// WebSocket (read-only market data). One socket, at most one subscription:
// opening another chart replaces it, closing the chart ends it. The socket
// is closed while the app is in the background and reopened (and
// resubscribed) when it comes back. Updates are coalesced to at most one
// delivery per MIN_EMIT_MS - a busy coin trades many times a second and the
// chart only needs the latest state of the forming bar.
import { AppState } from "react-native";
import type { AppStateStatus } from "react-native";

import { Bar, parseHlWsCandle } from "./candles";
import { HL_WS_URL } from "./hyperliquid";

const MIN_EMIT_MS = 250;
const PING_MS = 20_000;          // the venue drops a silent socket after 60 s, and answers each ping
// No message of any kind (candle, pong, ack) for this long = a dead socket.
// A phone's connection can go half-open (a network switch, a NAT timeout)
// without the socket ever reporting a close: the chart then froze on its
// last bar for minutes with no sign of it (seen on an MFP
// CASHCAT chart while Hyperliquid traded every minute).
const STALE_MS = 50_000;
const RETRY_MS = [1000, 2000, 5000, 10000];
const IDLE_CLOSE_MS = 5_000;     // socket kept this long after the last unsubscribe

// onGap: the socket was (re)opened after this subscription had already been
// live - bars traded while it was down (background, network blip) never
// arrive (the venue sends no snapshot on subscribe), so the caller refetches.
// onLive: false while the socket is down or reconnecting, true once it is
// open and subscribed again, so the chart can say its bar is not live.
type Sub = {
  coin: string; interval: string; onBar: (b: Bar) => void; onGap?: () => void; onLive?: (live: boolean) => void; opened: boolean;
};

let sub: Sub | null = null;
let ws: WebSocket | null = null;
let ping: ReturnType<typeof setInterval> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
let pending: Bar | null = null;
let emitTimer: ReturnType<typeof setTimeout> | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let lastEmit = 0;
let lastMsgAt = 0;
let appActive = AppState.currentState === "active";

const subMsg = (s: Sub, method: "subscribe" | "unsubscribe") =>
  JSON.stringify({ method, subscription: { type: "candle", coin: s.coin, interval: s.interval } });

function flush() {
  emitTimer = null;
  if (!pending || !sub) return;
  const b = pending;
  pending = null;
  lastEmit = Date.now();
  sub.onBar(b);
}

function deliver(b: Bar) {
  // A new bar must never overwrite the previous bar's last update (its
  // final high/low/close): hand that over first, then queue the new one.
  if (pending && pending.time !== b.time) {
    if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
    flush();
  }
  pending = b;
  if (emitTimer) return;
  const wait = Math.max(0, lastEmit + MIN_EMIT_MS - Date.now());
  emitTimer = setTimeout(flush, wait);
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
}

function connect() {
  if (!sub || !appActive || ws) return;
  const sock = new WebSocket(HL_WS_URL);
  ws = sock;
  const lost = () => {
    if (ws !== sock) return;
    teardown();
    if (!sub || !appActive) return;
    sub.onLive?.(false);
    retry = setTimeout(connect, RETRY_MS[Math.min(retries, RETRY_MS.length - 1)]);
    retries++;
  };
  sock.onopen = () => {
    retries = 0;
    lastMsgAt = Date.now();
    if (sub) {
      sock.send(subMsg(sub, "subscribe"));
      if (sub.opened && sub.onGap) sub.onGap();
      sub.opened = true;
      sub.onLive?.(true);
    }
    ping = setInterval(() => {
      // The venue answers every ping, so silence means the socket is gone
      // even if it never said so: drop it and reconnect (onGap refills).
      if (Date.now() - lastMsgAt > STALE_MS) { lost(); return; }
      try { sock.send(JSON.stringify({ method: "ping" })); } catch { /* the next tick reconnects */ }
    }, PING_MS);
  };
  sock.onmessage = (ev) => {
    lastMsgAt = Date.now();
    let msg: unknown;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    const c = parseHlWsCandle(msg);
    if (c && sub && c.coin === sub.coin && c.interval === sub.interval) deliver(c.bar);
  };
  sock.onclose = lost;
  sock.onerror = lost;
}

// The chart saw Hyperliquid's REST candles move while this subscription
// delivered nothing: the stream is dead even if the socket still answers
// pings. Drop it and connect again now (onGap refills, onLive reports).
export function restartCandles(): void {
  if (!sub || !appActive) return;
  teardown();
  retries = 0;
  sub.onLive?.(false);
  connect();
}

AppState.addEventListener("change", (s: AppStateStatus) => {
  const active = s === "active";
  if (active === appActive) return;
  appActive = active;
  if (!active) teardown();
  else connect();
});

// Stream one coin/interval to `onBar`; returns the unsubscribe. A later
// call replaces the earlier subscription.
export function streamCandles(
  coin: string, interval: string, onBar: (b: Bar) => void, onGap?: () => void, onLive?: (live: boolean) => void,
): () => void {
  const prev = sub;
  const mine: Sub = { coin, interval, onBar, onGap, onLive, opened: false };
  sub = mine;
  pending = null;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      if (prev && (prev.coin !== coin || prev.interval !== interval)) ws.send(subMsg(prev, "unsubscribe"));
      ws.send(subMsg(mine, "subscribe"));
      mine.opened = true;
    } catch { teardown(); connect(); }
  } else if (!ws) {
    connect();
  } // CONNECTING: onopen subscribes whatever `sub` is then
  if (idle) { clearTimeout(idle); idle = null; }
  return () => {
    if (sub !== mine) return; // already replaced
    sub = null;
    pending = null;
    if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
    // Keep the socket a moment: a TF switch unsubscribes and resubscribes
    // back to back, and reconnecting for each chip tap is wasted latency.
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(subMsg(mine, "unsubscribe")); } catch { /* closing anyway */ }
    }
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { idle = null; if (!sub) teardown(); }, IDLE_CLOSE_MS);
  };
}
