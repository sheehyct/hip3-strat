// The MyFundedPerps account stream (see SECURITY.md): one
// authenticated WebSocket per watched account, on the Read Only VIEW key,
// used as a CHANGE SIGNAL. A frame that says the account's positions, orders
// or balance moved makes the Portfolio take its ordinary REST reading again;
// no frame is ever shown as venue state, and none settles a close or a
// reverse (those re-read the venue themselves, on the trade key).
//
// RECEIVE-ONLY: no frame ever leaves this file (scripts/check-exchange-guard.js
// fails if it names the socket's transmit methods at all, or any HTTP
// client). The key is read from the ungated view slot
// for each connection, travels only as the Authorization header of the
// upgrade request, and is never placed in a URL, stored or logged here.
//
// The socket is closed while the app is in the background and reopened when
// it returns. The venue holds a stream for about a minute, so a return after
// longer than that starts a new one and the app reads everything again.
// Native only: a browser cannot set the header, so on web this is a no-op
// (no MFP key is stored there either).
import { AppState, Platform } from "react-native";
import type { AppStateStatus } from "react-native";

import { getMfpKey } from "./agent_store";
import { mfpEnvForKey } from "./mfp_orders";
import type { MfpEnv } from "./mfp_orders";
import {
  mfpClosePolicy, mfpForgetResume, mfpResumeQuery, mfpRetryDelayMs, mfpStreamDead, mfpUpgradePolicy, newMfpStreamCursor,
  onMfpFrame,
} from "./mfp_stream_core";
import type { MfpClosePolicy, MfpStreamCursor, MfpStreamSignal } from "./mfp_stream_core";

const STREAM_ORIGIN = "wss://account-stream.myfundedperpetuals.com";
const STREAM_PATH: Record<MfpEnv, string> = { live: "/v1/stream", sandbox: "/v1/sandbox/stream" };
const WATCH_EVERY_MS = 10_000;
// A connection must have talked for this long before a later loss starts the
// reconnect ladder from its first rung again: a socket the venue accepts and
// drops at once would otherwise be retried every second for ever.
const STABLE_MS = 30_000;

// off: not connected and not trying (no key, web, background).
// refused: the venue rejected the key; not retried until the key changes.
export type MfpStreamStatus = "off" | "connecting" | "live" | "delayed" | "down" | "refused";

// React Native's WebSocket takes request headers as a third argument.
type HeaderSocket = new (url: string, protocols: string | string[] | null, options: { headers: Record<string, string> }) => WebSocket;

type Conn = {
  accountId: string;
  listeners: Set<(s: MfpStreamSignal) => void>;
  ws: WebSocket | null;
  cursor: MfpStreamCursor;
  attempt: number;
  retry: ReturnType<typeof setTimeout> | null;
  lastFrameAt: number; // the last frame, or the start of the current attempt (the silence watchdog's clock)
  heardAt: number;     // the last frame actually received on any socket of this connection (0 = never)
  liveSince: number;  // the first frame of the current socket (0 = none yet)
  status: MfpStreamStatus;
  opening: boolean;   // a connect is waiting on the key read
  gen: number;        // bumped by every teardown: a late callback of an old socket is ignored
};

const conns = new Map<string, Conn>();
const statusListeners = new Set<() => void>();
let appActive = AppState.currentState === "active";
let watchdog: ReturnType<typeof setInterval> | null = null;

function setStatus(c: Conn, s: MfpStreamStatus): void {
  if (c.status === s) return;
  c.status = s;
  for (const l of [...statusListeners]) l();
}

function teardown(c: Conn): void {
  c.gen++;
  c.opening = false;
  if (c.retry) { clearTimeout(c.retry); c.retry = null; }
  if (c.ws) {
    const old = c.ws;
    c.ws = null;
    old.onopen = null; old.onmessage = null; old.onclose = null; old.onerror = null;
    try { old.close(); } catch { /* already closed */ }
  }
}

function lost(c: Conn, policy: MfpClosePolicy): void {
  if (c.liveSince > 0 && Date.now() - c.liveSince >= STABLE_MS) c.attempt = 0;
  // An attempt that never heard a frame may have been refused for its resume
  // query: the next one asks for a fresh stream.
  if (c.liveSince === 0) c.cursor = mfpForgetResume(c.cursor);
  c.liveSince = 0;
  teardown(c);
  if (!conns.has(c.accountId)) return;
  if (policy === "stop") { setStatus(c, "refused"); return; }
  if (!appActive) { setStatus(c, "off"); return; }
  setStatus(c, "down");
  const wait = mfpRetryDelayMs(c.attempt, policy, Math.random());
  c.attempt++;
  c.retry = setTimeout(() => { c.retry = null; connect(c); }, wait);
}

function connect(c: Conn): void {
  if (Platform.OS === "web" || !appActive || c.ws || c.opening || c.retry || c.status === "refused") return;
  if (!conns.has(c.accountId)) return;
  c.opening = true;
  const gen = c.gen;
  setStatus(c, "connecting");
  getMfpKey("view").then((viewKey) => {
    if (gen !== c.gen) return;
    c.opening = false;
    const env = viewKey ? mfpEnvForKey(viewKey) : null;
    if (!viewKey || !env) { setStatus(c, "off"); return; }
    let sock: WebSocket;
    try {
      const Ctor = WebSocket as unknown as HeaderSocket;
      const resume = mfpResumeQuery(c.cursor, c.heardAt > 0 ? Date.now() - c.heardAt : 0);
      sock = new Ctor(STREAM_ORIGIN + STREAM_PATH[env] + resume, null, { headers: { Authorization: "Bearer " + viewKey } });
    } catch {
      lost(c, "backoff");
      return;
    }
    c.ws = sock;
    c.lastFrameAt = Date.now();
    sock.onopen = () => { if (c.ws === sock) c.lastFrameAt = Date.now(); };
    sock.onmessage = (ev) => {
      if (c.ws !== sock) return;
      c.lastFrameAt = Date.now();
      c.heardAt = c.lastFrameAt;
      let frame: unknown;
      try { frame = JSON.parse(String(ev.data)); } catch { return; }
      const r = onMfpFrame(c.cursor, frame, c.accountId);
      c.cursor = r.cursor;
      if (c.liveSince === 0) c.liveSince = c.lastFrameAt; // the venue accepted the key and is talking
      if (r.upstream === false) setStatus(c, "delayed");
      else if (r.upstream === true || c.status === "connecting" || c.status === "down") setStatus(c, "live");
      for (const s of r.signals) for (const l of [...c.listeners]) l(s);
      if (r.reconnect) lost(c, "now");
    };
    // React Native's error event carries no text; the close that always
    // follows it does. A refused upgrade arrives as code 1006 with the HTTP
    // status in its reason ("Expected HTTP 101 response but was '401 ...'"),
    // so the close decides, and a socket that errors without ever closing
    // is left to the silence watchdog.
    sock.onerror = () => undefined;
    sock.onclose = (ev) => {
      if (c.ws !== sock) return;
      const code = ev && typeof ev.code === "number" ? ev.code : null;
      const reason = ev && typeof ev.reason === "string" ? ev.reason : null;
      const byCode = mfpClosePolicy(code);
      lost(c, byCode === "backoff" ? mfpUpgradePolicy(reason) : byCode);
    };
  }).catch(() => {
    if (gen !== c.gen) return;
    c.opening = false;
    lost(c, "backoff");
  });
}

function ensureWatchdog(): void {
  if (watchdog || conns.size === 0) return;
  watchdog = setInterval(() => {
    const now = Date.now();
    for (const c of conns.values()) {
      // A phone's connection can go half-open without ever reporting a
      // close: silence past the venue's heartbeat means it is gone.
      if (c.ws && mfpStreamDead(c.lastFrameAt, now)) lost(c, "backoff");
    }
  }, WATCH_EVERY_MS);
}

function stopWatchdog(): void {
  if (watchdog && conns.size === 0) { clearInterval(watchdog); watchdog = null; }
}

AppState.addEventListener("change", (s: AppStateStatus) => {
  const active = s === "active";
  if (active === appActive) return;
  appActive = active;
  for (const c of conns.values()) {
    if (!active) { teardown(c); c.liveSince = 0; if (c.status !== "refused") setStatus(c, "off"); }
    else { c.attempt = 0; connect(c); }
  }
});

// Watch one account: `onSignal` is told when to read the venue again.
// Returns the unwatch. Several watchers of one account share its socket; the
// last unwatch closes it and forgets the stream (and a refusal of its key),
// so a caller that re-watches after the view key changed starts clean.
export function watchMfpAccount(accountId: string, onSignal: (s: MfpStreamSignal) => void): () => void {
  let c = conns.get(accountId);
  if (!c) {
    c = {
      accountId, listeners: new Set(), ws: null, cursor: newMfpStreamCursor(), attempt: 0, retry: null,
      lastFrameAt: 0, heardAt: 0, liveSince: 0, status: "off", opening: false, gen: 0,
    };
    conns.set(accountId, c);
  }
  const conn = c;
  conn.listeners.add(onSignal);
  ensureWatchdog();
  connect(conn);
  return () => {
    conn.listeners.delete(onSignal);
    if (conn.listeners.size > 0) return;
    teardown(conn);
    conns.delete(accountId);
    setStatus(conn, "off");
    stopWatchdog();
  };
}

// For useSyncExternalStore (React Compiler: module state is never read by a
// bare call during render).
export function subscribeMfpStream(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

export function mfpStreamStatus(accountId: string | null): MfpStreamStatus {
  if (accountId === null) return "off";
  return conns.get(accountId)?.status ?? "off";
}
