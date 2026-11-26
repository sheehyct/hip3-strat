// server/mfp_stream_relay.mjs: the web build's way to MyFundedPerps' account
// stream. The relay is mounted on a loopback port and given a FAKE WebSocket
// class: no test here opens a connection to anything but 127.0.0.1, and
// every key is a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

import { makeApp } from "../server/app.mjs";
import { makeMfpHandler } from "../server/mfp_passthrough.mjs";
import { CLOSED_LINE, isMfpStreamPath, makeMfpStreamRelay, MAX_FRAME_BYTES, MFP_STREAM_UPSTREAM, mfpStreamRoute, mfpStreamUpstreamOk } from "../server/mfp_stream_relay.mjs";

const TEST_KEY = "fp_test_" + "fake".repeat(6);
const LIVE_KEY = "fp_live_" + "fake".repeat(6);
const HOST = "account-stream.myfundedperpetuals.com";

// A WebSocket double. It records how it was built and EVERY property the
// relay reads or calls on it, so a test can say "nothing was ever written
// upstream" without trusting the relay's own word for it.
function fakeSockets() {
  const made = [];
  class FakeSocket {
    constructor(url, options) {
      const self = { url, options, touched: [], closed: 0, onopen: null, onmessage: null, onclose: null, onerror: null };
      self.close = () => { self.closed++; };
      self.open = () => self.onopen && self.onopen({});
      self.text = (value) => self.onmessage && self.onmessage({ data: typeof value === "string" ? value : JSON.stringify(value) });
      self.binary = () => self.onmessage && self.onmessage({ data: new ArrayBuffer(4) });
      self.end = (code) => self.onclose && self.onclose({ code });
      self.fail = () => self.onerror && self.onerror({});
      made.push(self);
      return new Proxy(self, {
        get(target, prop) { if (typeof prop === "string") target.touched.push(prop); return target[prop]; },
        set(target, prop, value) { target[prop] = value; return true; },
      });
    }
  }
  return { FakeSocket, made };
}

// The relay behind a real http server on a loopback port.
async function world({ max, Socket } = {}) {
  const sockets = fakeSockets();
  const logs = [];
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const host = "127.0.0.1:" + port;
  handler = makeMfpStreamRelay({ hosts: [host, "localhost:" + port], Socket: Socket === undefined ? sockets.FakeSocket : Socket, log: (l) => logs.push(l), ...(max ? { max } : {}) });
  // An open request: the status and headers as they arrive, the body as it grows.
  const open = ({ method = "GET", path: p = "/mfp/sandbox/v1/stream", headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host, authorization: "Bearer " + TEST_KEY, ...headers } }, (res) => {
      const r = { status: res.statusCode, headers: res.headers, text: "", ended: false, req, res };
      res.setEncoding("utf8");
      res.on("data", (c) => { r.text += c; });
      res.on("error", () => undefined);     // a connection torn down by the test itself
      r.done = new Promise((done) => { res.on("end", () => { r.ended = true; done(r); }); res.on("close", () => done(r)); });
      resolve(r);
    });
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
  // A short pause, for "and nothing more happened" checks.
  const settle = () => new Promise((r) => setTimeout(r, 25));
  // Wait for something that must happen (never a fixed sleep: the suite runs in parallel).
  const until = async (cond, what = "a condition") => {
    const end = Date.now() + 5000;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out waiting for " + what);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const socket = async (n = 1) => { await until(() => sockets.made.length >= n, "socket " + n); return sockets.made[n - 1]; };
  return { ...sockets, logs, open, settle, until, socket, origin: "http://" + host, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
const lines = (text) => text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

// ---- the decision, pure -------------------------------------------------------

test("the route: two paths, GET only, a key whose prefix matches the environment, and the resume query alone", () => {
  const auth = (k) => "Bearer " + k;
  assert.deepEqual(mfpStreamRoute("GET", "/mfp/live/v1/stream", auth(LIVE_KEY)), { ok: true, env: "live", upstream: "wss://" + HOST + "/v1/stream" });
  assert.deepEqual(mfpStreamRoute("GET", "/mfp/sandbox/v1/stream", auth(TEST_KEY)), { ok: true, env: "sandbox", upstream: "wss://" + HOST + "/v1/sandbox/stream" });
  // the resume query is checked piece by piece and written out again, in a fixed order
  assert.equal(mfpStreamRoute("GET", "/mfp/live/v1/stream?since=1700000000000&resume=strm_Ab-1&last_seq=42", auth(LIVE_KEY)).upstream, "wss://" + HOST + "/v1/stream?resume=strm_Ab-1&last_seq=42&since=1700000000000");
  const no = (method, target, authorization, status) => {
    const r = mfpStreamRoute(method, target, authorization);
    assert.equal(r.ok, false, method + " " + target);
    if (status) assert.equal(r.status, status, method + " " + target + ": " + r.message);
  };
  // a key for the other environment, no key, something that is not an MFP key
  no("GET", "/mfp/live/v1/stream", auth(TEST_KEY), 403);
  no("GET", "/mfp/sandbox/v1/stream", auth(LIVE_KEY), 403);
  no("GET", "/mfp/live/v1/stream", undefined, 401);
  no("GET", "/mfp/live/v1/stream", "Bearer nope", 401);
  no("GET", "/mfp/live/v1/stream", LIVE_KEY, 401);
  no("GET", "/mfp/live/v1/stream", auth(LIVE_KEY) + " extra", 401);
  // any other method, any other path
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT"]) no(m, "/mfp/live/v1/stream", auth(LIVE_KEY), 405);
  for (const p of ["/mfp/live/v1/stream/", "/mfp/live/v1/streams", "/mfp/other/v1/stream", "/mfp/live/v2/stream", "/mfp/live/v1/sandbox/stream", "/mfp/sandbox/v1/sandbox/stream", "/mfp/live/v1/stream/../orders", "/v1/stream", "//elsewhere.example/mfp/live/v1/stream"]) no("GET", p, auth(LIVE_KEY), 404);
  // a query that is anything but the three, each once, each its shape - the key can never ride in the URL
  for (const q of ["token=abc", "key=" + LIVE_KEY, "resume=a&resume=b", "resume=", "resume=a/b", "resume=a%2Fb", "resume=" + "a".repeat(129), "last_seq=-1", "last_seq=1.5", "last_seq=abc", "since=1e9", "since=" + "1".repeat(17), "resume=a&x=1", "&", "resume", "resume=a&&since=1", "resume=a@elsewhere.example", "resume=a#b"]) {
    no("GET", "/mfp/live/v1/stream?" + q, auth(LIVE_KEY), 400);
  }
  no("GET", "/mfp/live/v1/stream?resume=a b", auth(LIVE_KEY), 400);
  no(null, "/mfp/live/v1/stream", auth(LIVE_KEY), 400);
});

test("the upstream check holds the address to the stream host and its two paths", () => {
  assert.equal(mfpStreamUpstreamOk(MFP_STREAM_UPSTREAM.live), true);
  assert.equal(mfpStreamUpstreamOk(MFP_STREAM_UPSTREAM.sandbox + "?resume=a&last_seq=1&since=2"), true);
  for (const bad of ["ws://" + HOST + "/v1/stream", "wss://" + HOST + "/v1/orders", "wss://" + HOST + ".elsewhere.example/v1/stream", "wss://user:pw@" + HOST + "/v1/stream", "wss://" + HOST + ":8443/v1/stream", "wss://" + HOST + "/v1/stream#x", "wss://elsewhere.example/v1/stream", "https://developers.myfundedperpetuals.com/v1/stream", "", null]) {
    assert.equal(mfpStreamUpstreamOk(bad), false, String(bad));
  }
  assert.equal(isMfpStreamPath("/mfp/live/v1/stream?resume=a"), true);
  assert.equal(isMfpStreamPath("/mfp/sandbox/v1/stream"), true);
  assert.equal(isMfpStreamPath("/mfp/live/v1/orders"), false);
  assert.equal(isMfpStreamPath("/mfp/live/v1/stream/x"), false);
});

// ---- the relay ----------------------------------------------------------------

test("one upstream socket, the key in its Authorization header, each text frame handed down as one line", async () => {
  const w = await world();
  try {
    const pending = w.open({ path: "/mfp/sandbox/v1/stream?resume=strm_1&last_seq=7&since=1700000000000", headers: { origin: w.origin, "sec-fetch-site": "same-origin", cookie: "sid=1" } });
    const up = await w.socket(1);
    assert.equal(w.made.length, 1, "one socket");
    assert.equal(up.url, "wss://" + HOST + "/v1/sandbox/stream?resume=strm_1&last_seq=7&since=1700000000000");
    assert.deepEqual(up.options, { headers: { Authorization: "Bearer " + TEST_KEY } }, "the key goes in the header and nothing else goes with it");
    assert.ok(!up.url.includes("fp_"), "never in the address");
    up.open();
    const r = await pending;
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "application/x-ndjson");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["access-control-allow-origin"], undefined);
    up.text({ type: "hello", stream_id: "strm_1", resumed: false });
    up.text('{"type":"snapshot",\n  "account_id":"acct_1",\n  "seq":1}');     // a frame with line breaks in it is still ONE line
    up.text("not json at all");                                                  // dropped
    up.text('"a string"');                                                       // not an object: dropped
    up.binary();                                                                 // not text: dropped
    up.text({ type: "heartbeat" });
    await w.until(() => r.text.split("\n").filter(Boolean).length >= 3, "three lines");
    await w.settle();
    assert.deepEqual(lines(r.text), [{ type: "hello", stream_id: "strm_1", resumed: false }, { type: "snapshot", account_id: "acct_1", seq: 1 }, { type: "heartbeat" }]);
    assert.equal(r.text.split("\n").filter(Boolean).length, 3);
    // the venue closes: one last line says with what code, and the response ends
    up.end(1012);
    await r.done;
    assert.deepEqual(lines(r.text).at(-1), { type: CLOSED_LINE, code: 1012 });
    assert.equal(w.made.length, 1, "it never reconnects: the app decides");
    // RECEIVE-ONLY: the only things ever done to the socket were the four handlers and close
    const touched = [...new Set(up.touched)].filter((p) => !["onopen", "onmessage", "onclose", "onerror", "close"].includes(p));
    assert.deepEqual(touched, [], "the relay touched: " + touched.join(", "));
    assert.ok(!up.touched.includes("send") && !up.touched.includes("ping"));
    // the log: method, path, status, and how the stream ended. No key, no query, no frame.
    assert.equal(w.logs[0], "GET /mfp/sandbox/v1/stream -> 200");
    assert.match(w.logs[1], /^GET \/mfp\/sandbox\/v1\/stream -> 200 ended \(code 1012, \d+ s, 3 frames\)$/);
    assert.ok(w.logs.every((l) => !/fp_|resume|strm_|acct_|hello|Bearer/.test(l)), w.logs.join(" | "));
  } finally { await w.close(); }
});

test("a rejected key closes with 4001 and the app is told so", async () => {
  const w = await world();
  try {
    const pending = w.open();
    (await w.socket(1)).open();
    const r = await pending;
    w.made[0].end(4001);
    await r.done;
    assert.deepEqual(lines(r.text), [{ type: CLOSED_LINE, code: 4001 }]);
  } finally { await w.close(); }
});

test("the browser going away closes the upstream socket", async () => {
  const w = await world();
  try {
    const pending = w.open();
    const up = await w.socket(1);
    up.open();
    const r = await pending;
    up.text({ type: "hello" });
    await w.until(() => r.text.includes("hello"), "the first line");
    assert.equal(up.closed, 0);
    r.req.destroy();
    await w.until(() => up.closed === 1, "the hang-up");
    assert.equal(up.closed, 1, "hung up");
    assert.equal(up.onmessage, null, "and no longer listened to");
    assert.match(w.logs.at(-1), /200 ended \(client gone, \d+ s, 1 frames\)/);
    // the slot is free again: the next request connects
    const again = w.open();
    await w.socket(2);
    assert.equal(w.made.length, 2);
    w.made[1].open();
    (await again).req.destroy();
  } finally { await w.close(); }
});

test("a stream that cannot be opened answers 502 in the venue's error envelope, once", async () => {
  const w = await world();
  try {
    // a refused upgrade: Node reports an error and close 1006, no status
    const a = w.open();
    await w.socket(1);
    w.made[0].fail();
    w.made[0].end(1006);
    const r = await a;
    await r.done;
    assert.equal(r.status, 502);
    assert.deepEqual(JSON.parse(r.text).error.code, "stream_unavailable");
    assert.equal(w.made.length, 1, "no second attempt");
    assert.equal(w.logs.at(-1), "GET /mfp/sandbox/v1/stream -> 502");
  } finally { await w.close(); }
  // a constructor that throws, and a runtime with no WebSocket at all
  class Throws { constructor() { throw new Error("no"); } }
  for (const Socket of [Throws, null]) {
    const x = await world({ Socket });
    try {
      const r = await x.open();
      await r.done;
      assert.equal(r.status, 502);
      assert.equal(JSON.parse(r.text).error.code, "stream_unavailable");
    } finally { await x.close(); }
  }
});

test("a request that is not exactly right is refused with nothing opened", async () => {
  const w = await world();
  try {
    const cases = [
      [{ headers: { host: "elsewhere.example" } }, 403],
      [{ headers: { origin: "http://elsewhere.example" } }, 403],
      [{ headers: { "sec-fetch-site": "cross-site" } }, 403],
      [{ headers: { "sec-fetch-site": "same-site" } }, 403],
      [{ headers: { authorization: "Bearer " + LIVE_KEY } }, 403],                       // a live key on the sandbox path
      [{ path: "/mfp/live/v1/stream" }, 403],                                             // the sandbox key on the live path
      [{ headers: { authorization: "" } }, 401],
      [{ path: "/mfp/sandbox/v1/stream?token=" + TEST_KEY }, 400],
      [{ path: "/mfp/sandbox/v1/stream?resume=a&resume=b" }, 400],
      [{ path: "/mfp/sandbox/v1/stream?last_seq=x" }, 400],
      [{ method: "POST" }, 405],
      [{ method: "DELETE" }, 405],
      [{ method: "GET", body: "{}", headers: { "content-length": "2" } }, 400],
    ];
    for (const [req, status] of cases) {
      const r = await w.open(req);
      await r.done;
      assert.equal(r.status, status, JSON.stringify(req));
      assert.equal(typeof JSON.parse(r.text).error.code, "string", "the venue's error envelope");
      assert.equal(r.headers["access-control-allow-origin"], undefined);
    }
    assert.equal(w.made.length, 0, "no socket was ever built");
    assert.ok(w.logs.every((l) => !/fp_|token|resume/.test(l)), w.logs.join(" | "));
  } finally { await w.close(); }
});

test("at most four relays at once: the fifth is refused 429 with Retry-After, and a freed slot is usable", async () => {
  const w = await world();
  try {
    const open = [];
    for (let i = 0; i < 4; i++) { const p = w.open(); (await w.socket(i + 1)).open(); open.push(await p); }
    const fifth = await w.open();
    await fifth.done;
    assert.equal(fifth.status, 429);
    assert.equal(fifth.headers["retry-after"], "10");
    assert.equal(JSON.parse(fifth.text).error.code, "stream_busy");
    assert.equal(w.made.length, 4, "no fifth socket");
    w.made[0].end(1011);
    await open[0].done;
    const next = w.open();
    await w.socket(5);
    assert.equal(w.made.length, 5);
    w.made[4].open();
    assert.equal((await next).status, 200);
  } finally { await w.close(); }
});

test("a reader that stops reading is dropped, not buffered for without bound", async () => {
  const w = await world();
  try {
    // a raw client that asks and then never reads
    const port = Number(w.origin.split(":").pop());
    const sock = net.connect(port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    sock.pause();
    sock.write("GET /mfp/sandbox/v1/stream HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nAuthorization: Bearer " + TEST_KEY + "\r\n\r\n");
    sock.on("error", () => undefined);
    const up = await w.socket(1);
    up.open();
    const big = { type: "snapshot", pad: "x".repeat(1024 * 1024) };
    for (let i = 0; i < 60 && up.closed === 0; i++) { up.text(big); await new Promise((r) => setImmediate(r)); }
    assert.equal(up.closed, 1, "the upstream socket was closed once the backlog passed its limit");
    assert.match(w.logs.at(-1), /200 ended \(client gone/);
    sock.destroy();
  } finally { await w.close(); }
});

// ---- mounted beside the pass-through ------------------------------------------

test("the app's server hands the two stream paths to the relay and everything else under /mfp/ to the pass-through", async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "tt-relay-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>t</title>");
  const sockets = fakeSockets();
  const sends = [];
  const handleMfp = makeMfpHandler({ hosts: [], send: async (url, init) => { sends.push({ url, method: init.method }); return new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } }); } });
  const server = makeApp({ dist, handleMfp: (req, res) => handleMfp(req, res), handleMfpStream: (req, res) => relay(req, res) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const hosts = ["127.0.0.1:" + port];
  const relay = makeMfpStreamRelay({ hosts, Socket: sockets.FakeSocket });
  const pass = makeMfpHandler({ hosts, send: async (url, init) => { sends.push({ url, method: init.method }); return new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } }); } });
  const get = (p, method = "GET") => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host: hosts[0], authorization: "Bearer " + TEST_KEY } }, (res) => { res.on("error", () => undefined); res.resume(); resolve({ status: res.statusCode, req }); });
    req.on("error", reject);
    req.end();
  });
  try {
    // the stream path: the relay, one socket, nothing through the pass-through's sender
    const s = get("/mfp/sandbox/v1/stream");
    for (let i = 0; i < 1000 && sockets.made.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(sockets.made.length, 1);
    sockets.made[0].open();
    const opened = await s;
    assert.equal(opened.status, 200);
    assert.equal(sends.length, 0);
    opened.req.destroy();
    // a write to the stream path is not a stream request: refused by the relay, no socket
    assert.equal((await get("/mfp/sandbox/v1/stream", "POST")).status, 405);
    assert.equal(sockets.made.length, 1);
    // without a relay mounted the stream paths are just something the pass-through does not permit
    const bare = makeApp({ dist, handleMfp: (req, res) => pass(req, res) });
    await new Promise((r) => bare.listen(0, "127.0.0.1", r));
    try {
      const bp = bare.address().port;
      const r = await new Promise((resolve, reject) => { const q = http.request({ host: "127.0.0.1", port: bp, path: "/mfp/sandbox/v1/stream", headers: { host: hosts[0], authorization: "Bearer " + TEST_KEY } }, (res) => { res.resume(); resolve(res.statusCode); }); q.on("error", reject); q.end(); });
      assert.equal(r, 403);
      assert.equal(sends.length, 0, "and it is not forwarded as a REST request either");
    } finally { bare.closeAllConnections(); await new Promise((r) => bare.close(r)); }
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

// ---- the review of 2026-11-26 ---------------------------------------------------------------

test("a frame longer than the relay hands down is left out; the stream goes on, and the app reads lines at least twice that long", async () => {
  const core = await import("../src/lib/mfp_stream_core.ts");
  assert.ok(core.MAX_FRAME_CHARS >= 2 * MAX_FRAME_BYTES, core.MAX_FRAME_CHARS + " vs " + MAX_FRAME_BYTES);
  const w = await world();
  try {
    const pending = w.open();
    const up = await w.socket(1);
    up.open();
    const r = await pending;
    up.text({ type: "hello", stream_id: "strm_1", resumed: false });
    up.text(JSON.stringify({ type: "snapshot", account_id: "acct_1", seq: 1, pad: "x".repeat(MAX_FRAME_BYTES) }));   // over the limit
    up.text({ type: "snapshot", account_id: "acct_1", seq: 2 });
    await w.until(() => r.text.split("\n").filter(Boolean).length >= 2, "two lines");
    await w.settle();
    assert.deepEqual(lines(r.text), [{ type: "hello", stream_id: "strm_1", resumed: false }, { type: "snapshot", account_id: "acct_1", seq: 2 }], "the long frame is not there; the next one is");
    assert.equal(up.closed, 0, "the stream was not dropped for it (the app sees a gap in seq and reads the venue)");
    // a frame AT the limit goes through, and is one the app's reader accepts
    const edge = JSON.stringify({ type: "snapshot", pad: "y".repeat(MAX_FRAME_BYTES - 40) });
    assert.ok(edge.length <= MAX_FRAME_BYTES);
    up.text(edge);
    await w.until(() => r.text.split("\n").filter(Boolean).length >= 3, "the frame at the limit");
    assert.equal(core.parseFrame(r.text.split("\n").filter(Boolean)[2]).type, "snapshot");
    up.end(1000);
    await r.done;
  } finally { await w.close(); }
});
