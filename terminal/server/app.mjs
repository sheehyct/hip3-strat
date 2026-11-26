// The web build's local server: the exported app's files and the
// MyFundedPerps pass-through (/mfp/...) from ONE origin, so the browser's
// MFP requests are same-origin and need no CORS. serve.mjs starts it; the
// tests mount it on a loopback port with a scripted upstream.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { MFP_PREFIX } from "./mfp_route.mjs";
import { isMfpStreamPath } from "./mfp_stream_relay.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon",
  ".json": "application/json", ".ttf": "font/ttf", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".map": "application/json",
};

// The page's connections (fetch, XHR, WebSocket) may go to its own origin
// (the app's files and the pass-through) and to Hyperliquid, and nowhere
// else. This restricts connections only, not images, forms or navigation.
const CSP = "connect-src 'self' https://api.hyperliquid.xyz wss://api.hyperliquid.xyz";

// dist: the exported app (a directory holding index.html). handleMfp: the
// pass-through's handler (makeMfpHandler in mfp_passthrough.mjs).
// handleMfpStream: the account stream's relay (makeMfpStreamRelay in
// mfp_stream_relay.mjs); without it the two stream paths answer like any
// other request the pass-through does not permit. Returns the http server,
// not yet listening.
export function makeApp({ dist, handleMfp, handleMfpStream = null }) {
  const index = path.join(dist, "index.html");

  function serveFile(req, res) {
    let rel;
    try { rel = decodeURIComponent(String(req.url).split("?")[0]); } catch { rel = "/"; }
    let file = path.resolve(dist, "." + path.posix.normalize("/" + rel));
    // Never outside dist; anything that is not a file is the app (SPA). A
    // file that goes away between this look and the read (a re-export while
    // serving) is "not a file" as well: the look must not throw.
    let isFile = false;
    try { isFile = file.startsWith(dist + path.sep) && fs.statSync(file).isFile(); } catch { isFile = false; }
    if (!isFile) file = index;
    const type = MIME[path.extname(file)] || "application/octet-stream";
    const headers = { "Content-Type": type, "X-Content-Type-Options": "nosniff" };
    if (type.startsWith("text/html")) { headers["Content-Security-Policy"] = CSP; headers["Cache-Control"] = "no-cache"; }
    // A file that goes away mid-read ends this one response (503); it must
    // not take the server down.
    const stream = fs.createReadStream(file);
    stream.on("error", () => { if (!res.headersSent) res.writeHead(503); res.end(); });
    stream.once("open", () => { res.writeHead(200, headers); stream.pipe(res); });
  }

  const server = http.createServer((req, res) => {
    try {
      // The account stream (GET /mfp/<env>/v1/stream) is the relay's: one
      // upstream socket per request, receive-only. Everything else under
      // /mfp/ is the pass-through's.
      if (handleMfpStream && isMfpStreamPath(String(req.url))) { handleMfpStream(req, res); return; }
      if (String(req.url).startsWith(MFP_PREFIX)) {
        // Once per request. A failure the handler did not answer itself is a
        // 5xx: the app reads that as unknown and looks the order up.
        handleMfp(req, res).catch(() => { if (!res.headersSent) { res.writeHead(502, { "Content-Type": "application/json" }); res.end('{"error":{"code":"passthrough_failed","message":"the pass-through failed"}}'); } });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
      serveFile(req, res);
    } catch {
      // No request may stop the server (a stopped server answers nothing,
      // and every MFP request in flight would lose its answer).
      if (!res.headersSent) res.writeHead(503);
      res.end();
    }
  });

  // A request node cannot parse gets NO answer: the connection is closed.
  // Node's own default is to write "400 Bad Request" on the socket, and on a
  // connection where an MFP write is waiting for its answer the app would
  // read that 400 as the venue's refusal of a write that may have executed.
  // A closed connection reads as unknown, which is always the safe side.
  server.on("clientError", (_err, socket) => { socket.destroy(); });

  return server;
}
