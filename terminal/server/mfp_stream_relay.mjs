// The MyFundedPerps account stream for the web build (docs/CONTRACT.md
// "The MFP account stream"). MFP's stream is a WebSocket that takes the key in the
// Authorization header of the upgrade request. A browser's WebSocket cannot
// carry that header, and the key must never go in a URL. So the web build
// asks its OWN origin for the stream (GET /mfp/<env>/v1/stream) and this
// file opens the socket for it, handing each frame down as one line of the
// response body (application/x-ndjson).
//
// Rules this file keeps:
// - RECEIVE-ONLY, by construction. The browser's side is an HTTP response
//   body: nothing can travel up it. This file never writes a frame to the
//   upstream socket, and no keep-alive either (the runtime answers the
//   venue's own by itself). The guard holds that by banning the two words
//   for it from this whole file, comments included.
// - ONE upstream socket per request, to MFP's stream host and one of its
//   two paths, and nowhere else. It never reconnects: when the socket ends
//   the response ends, and the app decides whether to ask again.
// - Nothing is connected for a request that is not exactly right: wrong
//   method, another origin, an unknown query parameter, a key whose prefix
//   does not match the environment, a body. Those answer 4xx.
// - A frame is forwarded only as JSON written out again (one line each), so
//   what the app reads is a line of JSON and nothing else. A frame that is
//   not JSON text is dropped. Nothing is stored.
// - A stuck reader is dropped, not buffered for: past MAX_BUFFERED_BYTES the
//   connection is closed. At most MAX_STREAMS relays run at once (a reload
//   loop must not use up the venue's eight sockets per key).
// - The log has the method, the path (no query), the status and, when a
//   stream ends, its close code, how long it ran and how many frames it
//   carried. Never a header, a query or a frame.
//
// Two limits of the runtime's WebSocket that this file cannot work around
// (it may import nothing: no dispatcher, no socket of its own):
// - a REFUSED upgrade reports close 1006 and no HTTP status. So a revoked
//   key (401), a lapsed sandbox (403) and "too many sockets on this key"
//   (429) all look like an unreachable venue here: the app is answered 502
//   and retries on its plain ladder, at most once a minute.
// - closing a socket whose peer has gone SILENT leaves it in its closing
//   state with the TCP connection still open, until the runtime gives up on
//   it. The relay has released its slot by then, so a venue that stops
//   answering altogether can leave closing sockets beyond the four that run.
//   They carry nothing (their handlers are removed) and end with the
//   process; they are not counted against MAX_STREAMS.
import { refusalBody } from "./mfp_route.mjs";

// The guard pins this declaration whole: frozen, this host, these two paths.
export const MFP_STREAM_UPSTREAM = Object.freeze({ live: "wss://account-stream.myfundedperpetuals.com/v1/stream", sandbox: "wss://account-stream.myfundedperpetuals.com/v1/sandbox/stream" });

// The app's own paths for it, and the key each environment takes.
const STREAM_PATHS = Object.freeze({ "/mfp/live/v1/stream": "live", "/mfp/sandbox/v1/stream": "sandbox" });
const KEY_SHAPE = Object.freeze({ live: /^Bearer fp_live_[A-Za-z0-9_-]{24,200}$/, sandbox: /^Bearer fp_test_[A-Za-z0-9_-]{24,200}$/ });
// The resume query, and nothing else: name -> what its value may be.
const QUERY = Object.freeze({ resume: /^[A-Za-z0-9_-]{1,128}$/, last_seq: /^[0-9]{1,16}$/, since: /^[0-9]{1,16}$/ });
const QUERY_ORDER = Object.freeze(["resume", "last_seq", "since"]);

export const MAX_STREAMS = 4;
const OPEN_TIMEOUT_MS = 20_000;
// The longest frame handed down, in characters, as it arrives AND as it is
// written out again. A longer one is left out (the app sees a gap in seq
// and reads the venue again); the stream itself goes on. The app reads lines
// up to twice this (MAX_FRAME_CHARS in src/lib/mfp_stream_core.ts; a test
// holds the two together), so nothing forwarded here makes it give up.
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
export const CLOSED_LINE = "tt_stream_closed";

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const refuse = (status, message) => ({ ok: false, status, message });

// Is this request line one of the two stream paths? (app.mjs asks, to pick
// the handler; everything else under /mfp/ is the pass-through's.)
export function isMfpStreamPath(target) {
  return typeof target === "string" && own(STREAM_PATHS, target.split("?")[0]);
}

// The address about to be connected to is MFP's stream host, on one of its
// two paths, with nothing that could carry it elsewhere.
export function mfpStreamUpstreamOk(url) {
  if (typeof url !== "string") return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  const base = url.split("?")[0];
  if (base !== MFP_STREAM_UPSTREAM.live && base !== MFP_STREAM_UPSTREAM.sandbox) return false;
  return u.protocol === "wss:" && u.username === "" && u.password === "" && u.hash === "" && u.port === "";
}

// The whole decision, pure: method, the request line's path and query, and
// the Authorization header. ok: the one address to connect to.
export function mfpStreamRoute(method, target, authorization) {
  if (typeof method !== "string" || typeof target !== "string") return refuse(400, "malformed request");
  if (method !== "GET") return refuse(405, "method not permitted: " + method);
  if (/[\u0000- \u007f\\#]/.test(target)) return refuse(400, "malformed path");
  const q = target.indexOf("?");
  const path = q === -1 ? target : target.slice(0, q);
  if (!own(STREAM_PATHS, path)) return refuse(404, "not a stream path");
  const env = STREAM_PATHS[path];
  // The query: resume, last_seq and since, each at most once, each exactly
  // its shape. It is written out again from the checked values.
  const seen = {};
  if (q !== -1) {
    for (const part of target.slice(q + 1).split("&")) {
      const eq = part.indexOf("=");
      const name = eq === -1 ? part : part.slice(0, eq);
      const value = eq === -1 ? "" : part.slice(eq + 1);
      if (!own(QUERY, name) || own(seen, name) || !QUERY[name].test(value)) return refuse(400, "not a permitted stream query");
      seen[name] = value;
    }
  }
  if (typeof authorization !== "string" || !/^Bearer fp_(live|test)_[A-Za-z0-9_-]{24,200}$/.test(authorization)) return refuse(401, "the stream needs an MFP key");
  if (!KEY_SHAPE[env].test(authorization)) return refuse(403, "this key is not for the " + env + " stream");
  const query = QUERY_ORDER.filter((n) => own(seen, n)).map((n) => n + "=" + seen[n]).join("&");
  const upstream = MFP_STREAM_UPSTREAM[env] + (query ? "?" + query : "");
  if (!mfpStreamUpstreamOk(upstream)) return refuse(400, "malformed path");
  return { ok: true, env, upstream };
}

// hosts: the Host header values this server answers to. Socket: the
// WebSocket class to connect with (Node's own; tests pass a fake). log: one
// line per request and one when a stream ends, or null.
export function makeMfpStreamRelay({ hosts, Socket = globalThis.WebSocket, log = null, max = MAX_STREAMS }) {
  const hostSet = new Set(hosts);
  const originSet = new Set(hosts.map((h) => "http://" + h));
  let running = 0;

  return function handleMfpStream(req, res) {
    const started = Date.now();
    const pathOnly = String(req.url).split("?")[0];
    const say = (text) => { if (log) log(req.method + " " + pathOnly + " -> " + text); };
    const answer = (status, code, message, extra = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
      res.end(refusalBody(code, message));
      say(String(status));
    };

    // Same origin only (and no DNS-rebinding: the Host must be ours).
    if (!hostSet.has(String(req.headers.host))) return answer(403, "passthrough_refused", "wrong host");
    const origin = req.headers.origin;
    if (origin !== undefined && !originSet.has(origin)) return answer(403, "passthrough_refused", "cross-origin request refused");
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") return answer(403, "passthrough_refused", "cross-site request refused");

    const authorization = req.headers.authorization;
    const route = mfpStreamRoute(req.method, req.url, authorization);
    if (!route.ok) return answer(route.status, "passthrough_refused", route.message);
    if (req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) !== 0) return answer(400, "passthrough_refused", "this request takes no body");
    if (running >= max) return answer(429, "stream_busy", "too many streams are open from this server", { "Retry-After": "10" });
    if (typeof Socket !== "function") return answer(502, "stream_unavailable", "this runtime has no WebSocket");
    if (!mfpStreamUpstreamOk(route.upstream)) return answer(400, "passthrough_refused", "not an MFP stream address");

    // From here ONE upstream socket exists for this request.
    running++;
    let upstream = null;
    let opened = false;
    let over = false;
    let frames = 0;
    const hangUp = () => {
      if (!upstream) return;
      const u = upstream;
      upstream = null;
      u.onopen = null; u.onmessage = null; u.onclose = null; u.onerror = null;
      try { u.close(); } catch { /* already closed */ }
    };
    // The one way out: `code` is the venue's close code (null = the browser
    // went away, or the reader was dropped).
    const finish = (code) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      running--;
      hangUp();
      if (!opened) {
        if (code !== null && !res.headersSent) answer(code === -1 ? 504 : 502, "stream_unavailable", code === -1 ? "MFP's stream did not open in time" : "MFP's stream could not be opened");
        else { if (!res.writableEnded) res.end(); say("gone before the stream opened"); }
        return;
      }
      if (code !== null && !res.writableEnded) res.end(JSON.stringify({ type: CLOSED_LINE, code }) + "\n");
      else if (!res.writableEnded) res.end();
      say("200 ended (" + (code === null ? "client gone" : "code " + code) + ", " + Math.round((Date.now() - started) / 1000) + " s, " + frames + " frames)");
    };
    const timer = setTimeout(() => finish(-1), OPEN_TIMEOUT_MS);
    // The browser went away (or the response was torn down): the socket goes too.
    res.on("close", () => finish(null));

    try {
      upstream = new Socket(route.upstream, { headers: { Authorization: authorization } });
    } catch {
      finish(1006);
      return;
    }
    upstream.onopen = () => {
      if (over) return;
      opened = true;
      clearTimeout(timer);
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      // The app must learn the stream is open now, not with its first frame.
      res.flushHeaders();
      say("200");
    };
    upstream.onmessage = (ev) => {
      if (over || !opened || typeof ev.data !== "string") return;
      if (ev.data.length > MAX_FRAME_BYTES) return;
      let value;
      try { value = JSON.parse(ev.data); } catch { return; }
      if (value === null || typeof value !== "object" || Array.isArray(value)) return;
      const line = JSON.stringify(value);
      if (line.length > MAX_FRAME_BYTES) return;
      frames++;
      res.write(line + "\n");
      // The reader has stopped reading: drop it rather than hold its backlog.
      if (res.writableLength > MAX_BUFFERED_BYTES) { finish(null); res.destroy(); }
    };
    upstream.onclose = (ev) => finish(ev && typeof ev.code === "number" ? ev.code : 1006);
    upstream.onerror = () => finish(1006);
  };
}
