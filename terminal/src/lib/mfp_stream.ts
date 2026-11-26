// MyFundedPerps' account stream: the ONLY file that connects to it
// (scripts/check-exchange-guard.js enforces it). Modelled on hl_stream.ts.
//
// What it is for (docs/CONTRACT.md "The MFP account stream"): to learn THAT the
// account changed, so the app can read the venue over REST when something
// happened instead of asking every few seconds. It is a change signal. No
// frame's payload is read here or anywhere (mfp_stream_core.ts reduces a
// frame to its envelope); nothing pushed is shown as venue state and
// nothing pushed settles a write.
//
// RECEIVE-ONLY. After the one request that opens the stream this file
// writes nothing to the venue: no frame of any kind, and no keep-alive
// either (the runtime answers the venue's own keep-alives by itself). The
// guard holds that by banning the two words for it from this whole file,
// comments included - which is why they do not appear here.
//
// Two transports, chosen by Platform.OS === "web" and nothing else:
// - Android connects to the venue's stream host with the key in the
//   Authorization header of the upgrade request (DIRECT);
// - the web build cannot (a browser's socket carries no such header, and
//   the key must never go in a URL), so it reads the stream from its OWN
//   origin (RELAY): the relay in server/ opens the socket and hands each
//   frame down as one line of an HTTP response body
//   (server/mfp_stream_relay.mjs). That request is this file's one HTTP
//   call, and it can only go to the app's own origin: RELAY holds two
//   relative paths.
// The key is the READ key (keys.ts mfpReadKey: the view key, or on web the
// trade key the tab already holds). It is asked for once per connection
// attempt, used for that request and kept nowhere here. This file imports
// neither the key store nor the REST client: it cannot unlock a gated key.
import { AppState, Platform } from "react-native";

import type { MfpEnv } from "./mfp_orders";
import { mfpEnvForKey } from "./mfp_orders";
import {
  closeCodeOf, isLive, MAX_FRAME_CHARS, newCore, onAttempt, onClosed, onFrame, onOpen, parseFrame, resumeQuery, statusOf, touch, watchdogDue,
} from "./mfp_stream_core";
import type { StreamCore, StreamSignal, StreamStatus } from "./mfp_stream_core";

// The guard pins both declarations whole, frozen, and the one use of each.
const RELAY: Readonly<Record<MfpEnv, string>> = Object.freeze({ live: "/mfp/live/v1/stream", sandbox: "/mfp/sandbox/v1/stream" });
const DIRECT: Readonly<Record<MfpEnv, string>> = Object.freeze({ live: "wss://account-stream.myfundedperpetuals.com/v1/stream", sandbox: "wss://account-stream.myfundedperpetuals.com/v1/sandbox/stream" });

const WATCH_EVERY_MS = 5_000;

// What the store is told. "live" / "down": whether the stream can be relied
// on right now (it polls less while it can).
export type StreamNote = StreamSignal | "live" | "down";

export type StreamOptions = {
  key: () => Promise<string | null>;        // the read key, for ONE connection attempt
  account: () => Promise<string | null>;    // the one account the app reads
  on: (note: StreamNote) => void;
};

// ---- what the status bar reads ----------------------------------------------

export type MfpStreamState = { status: StreamStatus; lastFrameAt: number };
let shownState: MfpStreamState = { status: "off", lastFrameAt: 0 };
const listeners = new Set<() => void>();
export function subscribeMfpStream(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export const mfpStreamState = (): MfpStreamState => shownState;
export const mfpStreamLive = (): boolean => shownState.status === "live";
function show(status: StreamStatus, lastFrameAt: number): void {
  // The frame time moves the shown state at most every few seconds: a
  // heartbeat must not re-render the status bar per frame.
  if (shownState.status === status && Math.abs(lastFrameAt - shownState.lastFrameAt) < WATCH_EVERY_MS) return;
  shownState = { status, lastFrameAt };
  for (const l of [...listeners]) l();
}

// ---- one stream at a time ---------------------------------------------------

let opts: StreamOptions | null = null;
// Bumps on every start / stop: a connection, a timer or a key read that
// belongs to an older run does nothing when it comes back.
let run = 0;
let core: StreamCore | null = null;
let hangUp: (() => void) | null = null;       // closes the open transport
let connected = false;
let wasLive = false;
let retry: ReturnType<typeof setTimeout> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
// Android only (the web build keeps its connection while the tab is hidden).
let appActive = Platform.OS === "web" || (AppState.currentState !== "background" && AppState.currentState !== "inactive");

function publish(): void {
  const live = connected && core !== null && isLive(core);
  show(statusOf(core, connected), core ? core.lastFrameAt : 0);
  if (live !== wasLive) {
    wasLive = live;
    if (opts) opts.on(live ? "live" : "down");
  }
}

function clearTimers(): void {
  if (retry) { clearTimeout(retry); retry = null; }
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
}

// onClose: the close code (null = none) and, when the platform gives one,
// the close's text (a refused upgrade names its HTTP status there).
type Handlers = { onOpen: () => void; onText: (text: string) => void; onClose: (code: number | null, reason: string | null) => void };

// The web build: the stream as lines of a response body, from the app's
// own origin. One request; aborting it is the hang-up.
function openRelayed(env: MfpEnv, query: string, key: string, h: Handlers): () => void {
  const ctl = new AbortController();
  (async () => {
    try {
      const res = await fetch(RELAY[env] + query, { method: "GET", headers: { Authorization: "Bearer " + key, Accept: "application/x-ndjson" }, signal: ctl.signal });
      if (res.status !== 200 || !res.body) { h.onClose(null, "HTTP " + res.status); return; }
      h.onOpen();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut = buf.indexOf("\n");
        while (cut >= 0) {
          const line = buf.slice(0, cut);
          buf = buf.slice(cut + 1);
          if (line.trim() !== "") h.onText(line);
          cut = buf.indexOf("\n");
        }
        // A line longer than the app reads has no end worth waiting for: the
        // connection is given up. (The relay forwards at most half of this.)
        if (buf.length > MAX_FRAME_CHARS) break;
      }
    } catch {
      // aborted, or the connection broke: the same ending as below
    }
    h.onClose(null, null);
  })();
  return () => { ctl.abort(); };
}

// Android: the venue's stream host, the key in the upgrade's Authorization
// header (React Native's socket takes headers as a third argument). Its
// "error" event carries nothing, and a refused upgrade arrives as the close
// that follows it (code 1006, the HTTP status in its reason): so the close
// decides, the error event is left alone, and a socket that errors without
// ever closing is ended by the silence watchdog.
type HeaderSocket = new (url: string, protocols: null, options: { headers: Record<string, string> }) => WebSocket;
function openDirect(env: MfpEnv, query: string, key: string, h: Handlers): () => void {
  const sock = new (WebSocket as unknown as HeaderSocket)(DIRECT[env] + query, null, { headers: { Authorization: "Bearer " + key } });
  sock.onopen = () => { h.onOpen(); };
  sock.onmessage = (ev) => { if (typeof ev.data === "string") h.onText(ev.data); };
  sock.onclose = (ev) => { h.onClose(typeof ev.code === "number" ? ev.code : null, typeof ev.reason === "string" ? ev.reason : null); };
  sock.onerror = () => undefined;
  return () => {
    sock.onopen = null; sock.onmessage = null; sock.onclose = null; sock.onerror = null;
    try { sock.close(); } catch { /* already closed */ }
  };
}

async function connect(mine: number): Promise<void> {
  if (mine !== run || !opts || !appActive || hangUp) return;
  const o = opts;
  let key: string | null = null, accountId: string | null = null;
  try { key = await o.key(); accountId = await o.account(); } catch { key = null; }
  if (mine !== run || hangUp) return;
  const env = key ? mfpEnvForKey(key) : null;
  if (!key || !accountId || !env) {
    // Nothing to connect with. The store starts the stream again when a
    // key is stored (venuesChanged).
    core = null;
    publish();
    return;
  }
  if (!core || core.accountId !== accountId) core = newCore(accountId);
  if (core.stopped) { publish(); return; }
  let over = false;   // this connection has ended (its handlers may still fire once)
  const ended = (code: number | null, reason: string | null) => {
    if (over || mine !== run) return;
    over = true;
    if (hangUp) { const close = hangUp; hangUp = null; close(); }
    connected = false;
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    const r = onClosed(core ?? newCore(accountId as string), code, Date.now(), Math.random, reason);
    core = r.core;
    publish();
    if (r.delayMs !== null && appActive) retry = setTimeout(() => { retry = null; connect(mine); }, r.delayMs);
  };
  const handlers: Handlers = {
    onOpen: () => {
      if (over || mine !== run || !core) return;
      connected = true;
      core = onOpen(core, Date.now());
      publish();
    },
    onText: (text) => {
      if (over || mine !== run || !core) return;
      const now = Date.now();
      const frame = parseFrame(text);
      if (!frame) { core = touch(core, now); return; }
      const code = closeCodeOf(frame);
      if (code !== null) { ended(code, null); return; }
      const step = onFrame(core, frame, now);
      core = step.core;
      publish();
      for (const s of step.signals) o.on(s);
      if (step.reconnect) ended(null, null);
    },
    onClose: ended,
  };
  // The silence watchdog runs from the attempt itself: a connection that
  // never opens, or opens and says nothing, is ended like any dead one. A
  // stream the venue no longer holds is not asked for again (onAttempt).
  core = onAttempt(core, Date.now());
  // The address's only variable part: "" or the three checked resume
  // fields. The guard pins this line and the call below, so nothing else -
  // a path, a key - can be put in the address.
  const query = resumeQuery(core);
  watchdog = setInterval(() => { if (core && watchdogDue(core, Date.now())) ended(null, null); }, WATCH_EVERY_MS);
  show("connecting", core.lastFrameAt);
  hangUp = (Platform.OS === "web" ? openRelayed : openDirect)(env, query, key, handlers);
}

// Start (or restart) the stream. Returns the stop.
export function startMfpStream(o: StreamOptions): () => void {
  stopMfpStream();
  opts = o;
  connect(++run);
  return () => { if (opts === o) stopMfpStream(); };
}

export function stopMfpStream(): void {
  run++;
  clearTimers();
  if (hangUp) { const close = hangUp; hangUp = null; close(); }
  connected = false;
  core = null;
  const o = opts;
  opts = null;
  if (wasLive) { wasLive = false; if (o) o.on("down"); }
  show("off", 0);
}

// Android: no socket in the background; a fresh attempt on return (it
// resumes the stream when the venue still holds it). The web build keeps
// its connection while the tab is hidden.
AppState.addEventListener("change", (s) => {
  if (Platform.OS === "web") return;
  const active = s !== "background" && s !== "inactive";
  if (active === appActive) return;
  appActive = active;
  if (!active) {
    clearTimers();
    if (hangUp) { const close = hangUp; hangUp = null; close(); }
    connected = false;
    run++;
    publish();
  } else if (opts) {
    connect(++run);
  }
});
