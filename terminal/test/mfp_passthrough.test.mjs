// The MyFundedPerps pass-through (server/): what it will forward, where to,
// and what it refuses without sending. The upstream is a scripted fake; no
// request leaves this machine. Fake ids and fake fp_test_ keys only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { makeApp } from "../server/app.mjs";
import { makeMfpHandler } from "../server/mfp_passthrough.mjs";
import { MFP_UPSTREAM, mfpRoute, mfpUpstreamOk, mfpWriteBody } from "../server/mfp_route.mjs";
import { json, makeWorld } from "./helpers/world.mjs";

// The app's own builders and its runtime check, straight from source: the
// pass-through's body rule is held to them below.
const orders = await import("../src/lib/mfp_orders.ts");

const LIVE = "https://developers.myfundedperpetuals.com";
const SANDBOX = "https://sandbox.myfundedperpetuals.com";
const FAKE_KEY = "fp_test_" + "fake".repeat(6);

// One write of each kind, made by the app's builders.
const ORDER_INPUT = { accountId: "acct_1", marketId: "hyperliquid|BTC", side: "buy", type: "market", size: 0.01, limitPrice: null, reduceOnly: false, leverage: 5, marginMode: "cross", expectedPrice: 81000, slippage: 0.01, tp: null, sl: null };
const RAW_POS = (id) => ({
  id, account_id: "acct_1", market_id: "binance|BTCUSDT", provider: "binance", symbol: "BTC", coin: "BTCUSDT", side: "long", size: 0.001,
  entry_price: 81212.9, leverage: 1, margin_mode: "cross", status: "open", opened_at: 1, size_decimals: 3, liquidation_price: 40000, mark_price: 81300, unrealized_pnl: 0.09,
});
const POS = orders.parseMfpPositions({ data: [RAW_POS("pos_1")] })[0];
const BUILT = {
  order: orders.buildMfpOrder(ORDER_INPUT, "cid-1", "idem-1"),
  limit: orders.buildMfpOrder({ ...ORDER_INPUT, type: "limit", limitPrice: 80000, tp: 90000, sl: 70000 }, "cid-3", "idem-3"),
  modify: orders.buildMfpModify("ord_1", 80000, 0.002, "i"),
  cancel: orders.buildMfpCancel("ord_1", "i"),
  close: orders.buildMfpClose(POS, 81300, null, 0.01, "cid-2", "i"),
  exits: orders.buildMfpExits(POS, [{ orderId: "tp1", price: 90000, size: 0.001 }], [{ kind: "cancel", order_id: "tp1" }, { kind: "place", group: "sl", price: 70000, size: 0.001, execution_type: "market" }], "i"),
};
const ORDER_BODY = JSON.stringify(BUILT.order.body);

// ---- the route: exactly the docs/CONTRACT.md surface --------------------------------

test("the upstream hosts are MFP's two API hosts and nothing else", () => {
  assert.deepEqual({ ...MFP_UPSTREAM }, { live: LIVE, sandbox: SANDBOX });
});

test("every permitted read and write is forwarded to the same path on the right host", () => {
  const ok = [
    ["GET", "/v1/accounts"],
    ["GET", "/v1/accounts/acct_1"],
    ["GET", "/v1/accounts/acct_1/trading-policy"],
    ["GET", "/v1/positions?account_id=acct_1"],
    ["GET", "/v1/orders?account_id=acct_1&status=working"],
    ["GET", "/v1/orders?account_id=acct_1&client_order_id=tt-abc"],
    ["GET", "/v1/markets?venues=all"],
    ["GET", "/v1/markets/binance%7CBTCUSDT/quote"],
    ["GET", "/v1/fills?account_id=acct_1&limit=100"],
    ["POST", "/v1/orders"],
    ["PATCH", "/v1/orders/ord_1"],
    ["DELETE", "/v1/orders/ord_1"],
    ["POST", "/v1/positions/pos_1/close"],
    ["PUT", "/v1/positions/pos_1/exit-orders"],
  ];
  for (const [method, p] of ok) {
    for (const [env, host] of [["sandbox", SANDBOX], ["live", LIVE]]) {
      const r = mfpRoute(method, "/mfp/" + env + p);
      assert.equal(r.ok, true, method + " " + p);
      assert.equal(r.upstream, host + p, method + " " + p);
      assert.equal(r.hasBody, method === "POST" || method === "PATCH" || method === "PUT");
      assert.equal(r.write, { GET: null, DELETE: "cancel", PATCH: "modify", PUT: "exits", POST: p === "/v1/orders" ? "order" : "close" }[method], method + " " + p);
    }
  }
});

test("the address check accepts MFP's two hosts under /v1/ and nothing that could lead elsewhere", () => {
  for (const u of [LIVE + "/v1/orders", SANDBOX + "/v1/orders/ord_1?x=1", LIVE + "/v1/markets/hyperliquid%7Cxyz%3ANVDA/quote"]) assert.equal(mfpUpstreamOk(u), true, u);
  for (const u of [
    LIVE + ".example.org/v1/orders", "https://example.org/v1/orders", "http://developers.myfundedperpetuals.com/v1/orders",
    "https://user:pw@developers.myfundedperpetuals.com/v1/orders", "https://developers.myfundedperpetuals.com@example.org/v1/orders",
    LIVE + ":8443/v1/orders", LIVE + ":443/v1/orders", LIVE + "/v2/orders", LIVE + "/v1/orders#x", LIVE, LIVE + "/", "//example.org/v1/x", "/v1/orders", "", null, undefined, 7,
  ]) assert.equal(mfpUpstreamOk(u), false, String(u));
});

test("a venue id with a pipe or a colon is kept, re-encoded as one segment", () => {
  const r = mfpRoute("GET", "/mfp/live/v1/markets/hyperliquid%7Cxyz%3ANVDA/quote");
  assert.equal(r.ok, true);
  assert.equal(r.upstream, LIVE + "/v1/markets/hyperliquid%7Cxyz%3ANVDA/quote");
  const raw = mfpRoute("GET", "/mfp/live/v1/markets/hyperliquid|xyz:NVDA/quote");
  assert.equal(raw.upstream, LIVE + "/v1/markets/hyperliquid%7Cxyz%3ANVDA/quote");
});

test("everything docs/CONTRACT.md forbids is refused, whatever its method", () => {
  const banned = [
    "/v1/cancel-all-orders", "/v1/accounts/acct_1/cancel-all-orders", "/v1/close-all-positions", "/v1/accounts/acct_1/close-all-positions",
    "/v1/twap-orders", "/v1/twap-orders/tw_1", "/v1/scaled-orders", "/v1/scaled-orders/sc_1", "/v1/price-alerts", "/v1/price-alerts/pa_1",
    "/v1/positions/pos_1/isolated-margin", "/v1/orders/ord_1/attached-exits", "/v1/copy-trading", "/v1/copy-trading/configurations",
    "/v1/auth/token", "/v1/restricted-countries", "/v1/markets/binance%7CBTCUSDT", "/v1/positions/pos_1", "/v1/orders/ord_1/fills",
  ];
  for (const p of banned) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const r = mfpRoute(method, "/mfp/sandbox" + p);
      assert.equal(r.ok, false, method + " " + p + " must be refused");
      assert.ok(r.status >= 400 && r.status < 500, "a refusal is a 4xx (never sent)");
    }
  }
});

test("a write takes no query (no write the app builds has one); a read keeps its own", () => {
  for (const [method, p] of [["POST", "/v1/orders"], ["PATCH", "/v1/orders/ord_1"], ["DELETE", "/v1/orders/ord_1"], ["POST", "/v1/positions/pos_1/close"], ["PUT", "/v1/positions/pos_1/exit-orders"]]) {
    assert.equal(mfpRoute(method, "/mfp/sandbox" + p).ok, true, method + " " + p);
    for (const q of ["?x=1", "?cancel_all=true", "?account_id=acct_1"]) {
      const r = mfpRoute(method, "/mfp/sandbox" + p + q);
      assert.equal(r.ok, false, method + " " + p + q);
      assert.equal(r.status, 400);
    }
    assert.equal(mfpRoute(method, "/mfp/sandbox" + p + "?").ok, true, "an empty query is no query");
  }
  assert.equal(mfpRoute("GET", "/mfp/sandbox/v1/orders?account_id=acct_1&status=working").ok, true);
});

test("a permitted path with the wrong method is refused", () => {
  for (const [method, p] of [
    ["DELETE", "/v1/orders"], ["PUT", "/v1/orders"], ["PATCH", "/v1/orders"], ["POST", "/v1/orders/ord_1"], ["PUT", "/v1/orders/ord_1"],
    ["DELETE", "/v1/positions/pos_1/close"], ["POST", "/v1/positions/pos_1/exit-orders"], ["DELETE", "/v1/positions/pos_1/exit-orders"],
    ["POST", "/v1/accounts"], ["DELETE", "/v1/accounts/acct_1"], ["POST", "/v1/fills"], ["POST", "/v1/positions"],
  ]) {
    assert.equal(mfpRoute(method, "/mfp/live" + p).ok, false, method + " " + p);
  }
  for (const method of ["OPTIONS", "HEAD", "TRACE", "CONNECT", "get"]) {
    const r = mfpRoute(method, "/mfp/live/v1/accounts");
    assert.equal(r.ok, false);
    assert.equal(r.status, 405);
  }
});

test("an id cannot re-shape the path: traversal, encoded slashes, dots, backslashes", () => {
  const bad = [
    ["DELETE", "/mfp/sandbox/v1/orders/..%2Fscaled-orders"],
    ["DELETE", "/mfp/sandbox/v1/orders/..%2fscaled-orders%2Fsc_1"],
    ["DELETE", "/mfp/sandbox/v1/orders/%2e%2e"],
    ["DELETE", "/mfp/sandbox/v1/orders/.."],
    ["DELETE", "/mfp/sandbox/v1/orders/."],
    ["PATCH", "/mfp/sandbox/v1/orders/ord_1%252Fx"],
    ["PATCH", "/mfp/sandbox/v1/orders/ord_1%5Cx"],
    ["PATCH", "/mfp/sandbox/v1/orders/ord_1\\x"],
    ["PATCH", "/mfp/sandbox/v1/orders/ord%00"],
    ["PATCH", "/mfp/sandbox/v1/orders/%zz"],
    ["PATCH", "/mfp/sandbox/v1/orders/"],
    ["GET", "/mfp/sandbox/v1/orders/../fills"],
    ["GET", "/mfp/sandbox/v1//orders"],
    ["GET", "/mfp/sandbox/v1/orders/"],
    ["GET", "/mfp/sandbox/v1/orders#x"],
    ["GET", "/mfp/sandbox/v1/orders?a=b c"],
    ["GET", "/mfp/sandbox/v1/accounts/" + "a".repeat(129)],
    ["POST", "/mfp/sandbox/v1/positions/pos_1%2Fclose/close"],
  ];
  for (const [method, target] of bad) assert.equal(mfpRoute(method, target).ok, false, method + " " + JSON.stringify(target));
});

test("only /mfp/<live|sandbox>/v1/ is a pass-through path", () => {
  for (const target of [
    "/v1/accounts", "/mfp/v1/accounts", "/mfp/prod/v1/accounts", "/mfp/constructor/v1/accounts", "/mfp/__proto__/v1/accounts",
    "/mfp/sandbox/v2/accounts", "/mfp/sandbox/accounts", "/mfp/sandbox", "/mfp/", "/MFP/sandbox/v1/accounts",
    "https://sandbox.myfundedperpetuals.com/v1/accounts", "//evil.example/mfp/sandbox/v1/accounts",
  ]) {
    assert.equal(mfpRoute("GET", target).ok, false, target);
  }
  assert.equal(mfpRoute("GET", null).ok, false);
  assert.equal(mfpRoute(undefined, "/mfp/live/v1/accounts").ok, false);
});

// ---- the handler: one request in, at most one request out -------------------

// A real http server on a loopback port around the handler, and a raw client
// (http.request sets any header, which fetch would not).
async function world(upstream) {
  const sends = [];
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const host = "127.0.0.1:" + port;
  const logs = [];
  const handler = makeMfpHandler({
    hosts: [host, "localhost:" + port],
    send: async (url, init) => { sends.push({ url, ...init }); return upstream(url, init); },
    log: (line) => logs.push(line),
  });
  const call = ({ method = "GET", path, headers = {}, body = null }) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
  return { sends, logs, call, origin: "http://" + host, close: () => new Promise((r) => server.close(r)) };
}

const jsonAnswer = (status, data, headers = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

test("a permitted write is forwarded once, with four headers only, and its answer handed back", async () => {
  const w = await world(() => jsonAnswer(201, { data: { id: "ord_1", status: "pending" } }, { "set-cookie": "sid=1", "access-control-allow-origin": "*" }));
  try {
    const body = ORDER_BODY;
    const r = await w.call({
      method: "POST", path: "/mfp/sandbox/v1/orders", body,
      headers: {
        authorization: "Bearer " + FAKE_KEY, accept: "application/json", "content-type": "application/json", "idempotency-key": "idem-1",
        cookie: "session=abc", "x-forwarded-for": "10.0.0.1", "user-agent": "browser", origin: w.origin, "sec-fetch-site": "same-origin", referer: w.origin + "/",
      },
    });
    assert.equal(r.status, 201);
    assert.deepEqual(JSON.parse(r.text), { data: { id: "ord_1", status: "pending" } });
    assert.equal(w.sends.length, 1, "sent exactly once");
    const s = w.sends[0];
    assert.equal(s.url, SANDBOX + "/v1/orders");
    assert.equal(s.method, "POST");
    assert.equal(s.redirect, "manual");
    assert.deepEqual(s.headers, { authorization: "Bearer " + FAKE_KEY, accept: "application/json", "content-type": "application/json", "idempotency-key": "idem-1" });
    assert.equal(s.body, body);
    // Nothing of the upstream's but its status, type and body comes back; no CORS header, ever.
    assert.equal(r.headers["set-cookie"], undefined);
    assert.equal(r.headers["access-control-allow-origin"], undefined);
    assert.equal(r.headers["cache-control"], "no-store");
    // The log names the method, path and status, never a header or the body.
    assert.equal(w.logs.length, 1);
    assert.match(w.logs[0], /^POST \/mfp\/sandbox\/v1\/orders -> 201 /);
    assert.ok(!w.logs.join("\n").includes("fp_test_") && !w.logs.join("\n").includes("hyperliquid|BTC") && !w.logs.join("\n").includes("cid-1"));
  } finally { await w.close(); }
});

test("a read keeps its query; the keyless market list needs no authorization", async () => {
  const w = await world(() => jsonAnswer(200, { data: [] }));
  try {
    const r = await w.call({ path: "/mfp/live/v1/markets?venues=all", headers: { accept: "application/json" } });
    assert.equal(r.status, 200);
    assert.equal(w.sends[0].url, LIVE + "/v1/markets?venues=all");
    assert.deepEqual(w.sends[0].headers, { accept: "application/json" });
    assert.equal(w.sends[0].body, undefined);
    // the query is not logged
    assert.match(w.logs[0], /^GET \/mfp\/live\/v1\/markets -> 200 /);
  } finally { await w.close(); }
});

test("MFP's own refusal (4xx), rate limit and 5xx pass through unchanged", async () => {
  for (const [status, extra] of [[422, {}], [409, {}], [429, { "retry-after": "3" }], [500, {}], [503, {}]]) {
    const w = await world(() => jsonAnswer(status, { error: { code: "venue_says", message: "no" } }, extra));
    try {
      const r = await w.call({ method: "DELETE", path: "/mfp/sandbox/v1/orders/ord_1", headers: { authorization: "Bearer " + FAKE_KEY, "idempotency-key": "i" } });
      assert.equal(r.status, status);
      assert.equal(JSON.parse(r.text).error.code, "venue_says");
      if (status === 429) assert.equal(r.headers["retry-after"], "3");
      assert.equal(w.sends.length, 1);
    } finally { await w.close(); }
  }
});

test("MFP's rate-limit headers come back to the app: Retry-After and the three X-RateLimit ones, nothing else", async () => {
  // the grace period: an over-limit GET succeeds and carries a warning
  const warn = await world(() => jsonAnswer(200, { data: [] }, { "x-ratelimit-warning": "over the per-key GET limit", "x-ratelimit-limit": "30", "set-cookie": "sid=1", "x-request-id": "req_1" }));
  try {
    const r = await warn.call({ path: "/mfp/sandbox/v1/positions?account_id=acct_1", headers: { authorization: "Bearer " + FAKE_KEY } });
    assert.equal(r.status, 200);
    assert.equal(r.headers["x-ratelimit-warning"], "over the per-key GET limit");
    assert.equal(r.headers["x-ratelimit-limit"], "30");
    assert.equal(r.headers["set-cookie"], undefined);
    assert.equal(r.headers["x-request-id"], undefined);
    assert.ok(warn.logs.every((l) => !/ratelimit|over the per-key/i.test(l)), "no header is logged");
  } finally { await warn.close(); }
  // enforcement: a 429 with all four
  const limited = await world(() => jsonAnswer(429, { error: { code: "rate_limited", message: "slow down" } }, { "retry-after": "60", "x-ratelimit-scope": "api_key", "x-ratelimit-limit": "30" }));
  try {
    const r = await limited.call({ path: "/mfp/sandbox/v1/positions?account_id=acct_1", headers: { authorization: "Bearer " + FAKE_KEY } });
    assert.equal(r.status, 429);
    assert.equal(r.headers["retry-after"], "60");
    assert.equal(r.headers["x-ratelimit-scope"], "api_key");
    assert.equal(r.headers["x-ratelimit-limit"], "30");
    assert.equal(JSON.parse(r.text).error.code, "rate_limited");
    assert.equal(limited.sends.length, 1, "sent once: the pass-through never retries a 429");
  } finally { await limited.close(); }
  // a header value this server could not write is left out; the answer still comes back
  const odd = await world(() => ({ status: 200, headers: { get: (n) => (n === "x-ratelimit-warning" ? "line one" + String.fromCharCode(13, 10) + "x-injected: 1" : n === "content-type" ? "application/json" : null) }, arrayBuffer: async () => new TextEncoder().encode('{"data":[]}').buffer }));
  try {
    const r = await odd.call({ path: "/mfp/sandbox/v1/positions?account_id=acct_1", headers: { authorization: "Bearer " + FAKE_KEY } });
    assert.equal(r.status, 200);
    assert.equal(r.headers["x-ratelimit-warning"], undefined);
    assert.equal(r.headers["x-injected"], undefined);
    assert.equal(r.text, '{"data":[]}');
  } finally { await odd.close(); }
});

test("a 204 passes through with no body", async () => {
  const w = await world(() => jsonAnswer(204, null));
  try {
    const r = await w.call({ method: "DELETE", path: "/mfp/sandbox/v1/orders/ord_1", headers: { authorization: "Bearer " + FAKE_KEY } });
    assert.equal(r.status, 204);
    assert.equal(r.text, "");
  } finally { await w.close(); }
});

test("a request that is not on the list answers 4xx in MFP's error envelope and sends nothing", async () => {
  const w = await world(() => { throw new Error("must not be reached"); });
  try {
    for (const [method, p] of [["POST", "/mfp/sandbox/v1/twap-orders"], ["DELETE", "/mfp/sandbox/v1/orders"], ["DELETE", "/mfp/sandbox/v1/orders/..%2Fscaled-orders"], ["OPTIONS", "/mfp/sandbox/v1/orders"], ["GET", "/mfp/prod/v1/accounts"]]) {
      const r = await w.call({ method, path: p, headers: { authorization: "Bearer " + FAKE_KEY } });
      assert.ok(r.status >= 400 && r.status < 500, method + " " + p + " -> " + r.status);
      assert.equal(JSON.parse(r.text).error.code, "passthrough_refused");
      assert.equal(r.headers["access-control-allow-origin"], undefined);
      assert.equal(r.headers["access-control-allow-headers"], undefined);
    }
    assert.equal(w.sends.length, 0);
  } finally { await w.close(); }
});

test("another origin, another site or another Host is refused before anything is sent", async () => {
  const w = await world(() => { throw new Error("must not be reached"); });
  try {
    const auth = { authorization: "Bearer " + FAKE_KEY };
    for (const headers of [
      { ...auth, origin: "https://evil.example" },
      { ...auth, origin: "null" },
      { ...auth, origin: w.origin.replace("http://", "https://") },
      { ...auth, "sec-fetch-site": "cross-site" },
      { ...auth, "sec-fetch-site": "same-site" },
      { ...auth, "sec-fetch-site": "none" },
      { ...auth, host: "evil.example" },
      { ...auth, host: "localhost:1" },
    ]) {
      const r = await w.call({ path: "/mfp/sandbox/v1/accounts", headers });
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.equal(JSON.parse(r.text).error.code, "passthrough_refused");
    }
    assert.equal(w.sends.length, 0);
  } finally { await w.close(); }
});

test("a body over the limit is refused (413) and nothing is sent", async () => {
  const w = await world(() => { throw new Error("must not be reached"); });
  try {
    const r = await w.call({ method: "POST", path: "/mfp/sandbox/v1/orders", headers: { authorization: "Bearer " + FAKE_KEY, "content-type": "application/json" }, body: "x".repeat(64 * 1024 + 1) });
    assert.equal(r.status, 413);
    assert.equal(w.sends.length, 0);
  } finally { await w.close(); }
});

test("once the upstream request has started, every failure is a 5xx (unknown), never retried", async () => {
  const cases = [
    [() => { throw new TypeError("fetch failed"); }, 502, "passthrough_unreachable"],
    [() => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; }, 504, "passthrough_timeout"],
    [() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }), 502, "passthrough_redirect"],
    [() => new Response(null, { status: 307, headers: { location: SANDBOX + "/v1/orders" } }), 502, "passthrough_redirect"],
  ];
  for (const [upstream, status, code] of cases) {
    const w = await world(upstream);
    try {
      const r = await w.call({ method: "POST", path: "/mfp/sandbox/v1/orders", headers: { authorization: "Bearer " + FAKE_KEY, "content-type": "application/json", "idempotency-key": "i" }, body: ORDER_BODY });
      assert.equal(r.status, status);
      assert.equal(JSON.parse(r.text).error.code, code);
      assert.equal(w.sends.length, 1, "one attempt, no retry");
    } finally { await w.close(); }
  }
});

// ---- the app side: where each platform sends ---------------------------------

const platform = (os) => ({ "react-native": { __esModule: true, Platform: { OS: os }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } } });

test("the app's MFP client sends to its own origin on the web and to MFP itself on Android", async () => {
  const cases = [
    ["web", FAKE_KEY, "/mfp/sandbox/v1/accounts"],
    ["web", "fp_live_" + "fake".repeat(6), "/mfp/live/v1/accounts"],
    ["android", FAKE_KEY, SANDBOX + "/v1/accounts"],
    ["android", "fp_live_" + "fake".repeat(6), LIVE + "/v1/accounts"],
    ["ios", FAKE_KEY, SANDBOX + "/v1/accounts"],
  ];
  for (const [os, key, want] of cases) {
    const seen = [];
    const w = makeWorld({ packages: platform(os), fetch: async (url, init) => { seen.push([init.method, url]); return json({ data: [] }); } });
    await w.load("mfp_exchange").verifyMfpKey(key).catch(() => undefined); // "sees no account": the request is what is checked
    assert.deepEqual(seen, [["GET", want]], os);
  }
});

test("the keyless market list goes through the app's own origin on the web only", async () => {
  for (const [os, want] of [["web", "/mfp/live/v1/markets?venues=all"], ["android", LIVE + "/v1/markets?venues=all"]]) {
    const seen = [];
    const w = makeWorld({ packages: platform(os), fetch: async (url, init) => { seen.push([init.method, url, Object.keys(init.headers)]); return json({ data: [] }); } });
    await w.load("mfp_market_list").refreshMfpList(0);
    assert.deepEqual(seen, [["GET", want, ["Accept"]]], os);
  }
});

test("every write the app's builders can make is one the pass-through forwards to the same venue path", async () => {
  const o = await import("../src/lib/mfp_orders.ts");
  // Ids at the edge of what the builders accept (ID_RE): every permitted
  // character, and the longest permitted length.
  const ids = ["ord_1", "hyperliquid|xyz:NVDA", "a.b-c_d|e:f", "0f8fad5b-d9cb-469f-a165-70867728950e", "x".repeat(128), "...", "|", ":"];
  const order = { accountId: "acct_1", marketId: "hyperliquid|BTC", side: "buy", type: "market", size: 0.01, limitPrice: null, reduceOnly: false, leverage: 5, marginMode: "cross", expectedPrice: 81000, slippage: 0.01, tp: null, sl: null };
  const rawPos = (id) => ({
    id, account_id: "acct_1", market_id: "binance|BTCUSDT", provider: "binance", symbol: "BTC", coin: "BTCUSDT", side: "long", size: 0.001,
    entry_price: 81212.9, leverage: 1, margin_mode: "cross", status: "open", opened_at: 1, size_decimals: 3, liquidation_price: 40000, mark_price: 81300, unrealized_pnl: 0.09,
  });
  const writes = [o.buildMfpOrder(order, "cid-1", "idem-1")];
  for (const id of ids) {
    const pos = o.parseMfpPositions({ data: [rawPos(id)] })[0];
    writes.push(
      o.buildMfpModify(id, 80000, null, "i"),
      o.buildMfpCancel(id, "i"),
      o.buildMfpClose(pos, 81300, null, 0.01, "cid-2", "i"),
      o.buildMfpExits(pos, [], [{ kind: "cancel", order_id: "tp1" }], "i"),
    );
  }
  assert.equal(writes.length, 1 + ids.length * 4);
  const kinds = new Set();
  for (const wr of writes) {
    kinds.add(wr.kind);
    const r = mfpRoute(wr.method, "/mfp/sandbox" + wr.path);
    assert.equal(r.ok, true, wr.method + " " + wr.path);
    assert.equal(r.upstream, SANDBOX + wr.path, wr.method + " " + wr.path);
    assert.equal(r.hasBody, wr.body !== null || wr.method !== "DELETE");
    assert.equal(r.write, wr.kind);
    // and its body is one the pass-through forwards, byte for byte
    if (wr.body !== null) assert.deepEqual(mfpWriteBody(r.write, JSON.stringify(wr.body)), { ok: true, text: JSON.stringify(wr.body) }, wr.kind);
  }
  assert.deepEqual([...kinds].sort(), ["cancel", "close", "exits", "modify", "order"]);
  // And the other way: an id the builders refuse is one the route refuses.
  for (const id of ["../x", "a/b", "a%2Fb", "a b", "", "x".repeat(129), "a\\b", "a?b", "a#b"]) {
    assert.throws(() => o.buildMfpCancel(id, "i"), /bad order id/, JSON.stringify(id));
    assert.equal(mfpRoute("DELETE", "/mfp/sandbox/v1/orders/" + encodeURIComponent(id)).ok, false, JSON.stringify(id));
  }
});

test("every read the web build sends is one the pass-through forwards to the same venue path", async () => {
  // The app's own requests, captured on the web, fed to the route.
  const seen = [];
  const w = makeWorld({ packages: platform("web"), fetch: async (url, init) => { seen.push([init.method, url]); return json({ data: [] }); } });
  const ex = w.load("mfp_exchange");
  const quiet = (p) => p.catch(() => undefined);
  await quiet(ex.verifyMfpKey(FAKE_KEY));
  await quiet(ex.fetchMfpBook(FAKE_KEY, "acct_1"));
  await quiet(ex.fetchMfpAccount(FAKE_KEY, "acct_1"));
  await quiet(ex.fetchMfpPolicy(FAKE_KEY, "acct_1"));
  await quiet(ex.fetchMfpQuote(FAKE_KEY, "hyperliquid|xyz:NVDA"));
  await quiet(ex.fetchMfpFills(FAKE_KEY, "acct_1"));
  await quiet(ex.fetchMfpRecentOrders(FAKE_KEY, "acct_1"));
  await quiet(ex.lookupMfpOrder(FAKE_KEY, "acct_1", "tt-abc"));
  assert.ok(seen.length >= 9, "the reads were sent: " + seen.length);
  for (const [method, url] of seen) {
    const r = mfpRoute(method, url);
    assert.equal(r.ok, true, method + " " + url);
    assert.equal(r.upstream, SANDBOX + url.slice("/mfp/sandbox".length));
  }
});

// ---- a write's body: the app's own rule, held on this side too (review R4) ---

// [the write, a change to a builder-made body]. Each result is a body no
// builder can make.
const BAD_BODIES = [
  ["order", (b) => ({ ...b, type: "stop_market" })],
  ["order", (b) => ({ ...b, type: "stop_limit", limit_price: 80000 })],
  ["order", (b) => ({ ...b, type: "MARKET" })],
  ["order", (b) => ({ ...b, stop_price: 80000 })],
  ["order", (b) => ({ ...b, trigger_price: 80000 })],
  ["order", (b) => ({ ...b, time_in_force: "post_only" })],
  ["order", (b) => ({ ...b, twap: { duration: 60 } })],
  ["order", (b) => ({ ...b, slippage_tolerance_bps: 501 })],
  ["order", (b) => ({ ...b, size: "0.01" })],
  ["order", (b) => ({ ...b, size: -1 })],
  ["order", (b) => ({ ...b, size: 0 })],
  ["order", (b) => ({ ...b, side: "long" })],
  ["order", (b) => ({ ...b, reduce_only: "false" })],
  ["order", (b) => ({ ...b, reduce_only: true, take_profit_price: 90000 })],
  ["order", (b) => ({ ...b, margin_mode: "portfolio" })],
  ["order", (b) => ({ ...b, limit_price: 80000 })],            // a market order with a limit price
  ["order", (b) => ({ ...b, type: "limit", limit_price: 80000 })], // a limit order with expected_price (live MFP refuses it, 2026-11-17)
  ["order", (b) => { const { expected_price, ...rest } = b; return rest; }], // a market order without expected_price
  ["order", (b) => { const { client_order_id, ...rest } = b; return rest; }],
  ["order", (b) => ({ ...b, client_order_id: "has space" })],
  ["order", () => ({})],
  ["order", () => []],
  ["order", () => null],
  ["order", () => "market"],
  ["modify", (b) => ({ ...b, type: "stop_market" })],
  ["modify", (b) => ({ ...b, price: 0 })],
  ["modify", () => ({ size: 1 })],
  ["close", (b) => ({ ...b, type: "limit" })],
  ["close", (b) => ({ ...b, slippage_tolerance_bps: 5000 })],
  ["close", (b) => ({ ...b, reduce_only: false })],
  ["close", (b) => ({ ...b, size: -0.001 })],
  ["exits", (b) => ({ ...b, operations: [] })],
  ["exits", (b) => ({ ...b, operations: [{ kind: "place", group: "tp", price: 90000, size: 0.001, execution_type: "limit" }] })],
  ["exits", (b) => ({ ...b, operations: [{ kind: "place", group: "tp", price: 90000, size: 5, execution_type: "market" }] })],
  ["exits", (b) => ({ ...b, operations: [{ kind: "close_all" }] })],
  ["exits", (b) => ({ ...b, cancel_all: true })],
];

test("R4: every builder-made body passes the pass-through's rule and the app's own, unchanged", () => {
  for (const [name, wr] of Object.entries(BUILT)) {
    orders.assertMfpWrite(wr);
    if (wr.body === null) { assert.equal(name, "cancel"); continue; }
    const text = JSON.stringify(wr.body);
    assert.deepEqual(mfpWriteBody(wr.kind, text), { ok: true, text }, name);
  }
});

test("R4: a body no builder can make is refused by the pass-through's rule AND by the app's own", () => {
  const base = { order: BUILT.order, modify: BUILT.modify, close: BUILT.close, exits: BUILT.exits };
  for (const [kind, change] of BAD_BODIES) {
    const body = change(base[kind].body);
    const label = kind + " " + JSON.stringify(body);
    const r = mfpWriteBody(kind, JSON.stringify(body));
    assert.equal(r.ok, false, "the pass-through must refuse: " + label);
    assert.equal(typeof r.message, "string");
    assert.throws(() => orders.assertMfpWrite({ ...base[kind], body }), undefined, "the app must refuse: " + label);
  }
  // not JSON at all, an empty body, a body for a write that carries none
  for (const text of ["", " ", "{", "type=market", "<html>", "undefined", "NaN"]) assert.equal(mfpWriteBody("order", text).ok, false, JSON.stringify(text));
  assert.equal(mfpWriteBody("cancel", "{}").ok, false);
  assert.equal(mfpWriteBody(null, "{}").ok, false);
  assert.equal(mfpWriteBody("order", undefined).ok, false);
  // a number the venue would read and JSON cannot hold
  assert.equal(mfpWriteBody("modify", '{"price":1e999}').ok, false);
  // an inherited name is not a field
  assert.equal(mfpWriteBody("order", ORDER_BODY.replace("{", '{"__proto__":{"type":"limit"},')).ok, false);
});

test("R4: a duplicated key is forwarded the way it was checked, never the way it arrived", async () => {
  // Read here, the last "type" wins; another parser may take the first.
  const twice = ORDER_BODY.replace('"type":"market"', '"type":"stop_market","type":"market"');
  assert.notEqual(twice, ORDER_BODY);
  assert.deepEqual(mfpWriteBody("order", twice), { ok: true, text: ORDER_BODY });
  const w = await world(() => jsonAnswer(201, { data: { id: "ord_1" } }));
  try {
    const r = await w.call({ method: "POST", path: "/mfp/sandbox/v1/orders", headers: { authorization: "Bearer " + FAKE_KEY, "content-type": "text/plain", "idempotency-key": "i" }, body: twice });
    assert.equal(r.status, 201);
    assert.equal(w.sends.length, 1);
    assert.equal(w.sends[0].body, ORDER_BODY);
    assert.ok(!String(w.sends[0].body).includes("stop_market"));
    assert.equal(w.sends[0].headers["content-type"], "application/json", "what goes on is JSON, whatever the request called it");
  } finally { await w.close(); }
});

test("R4: the handler answers a body it does not permit with a 4xx in MFP's envelope and sends nothing", async () => {
  const w = await world(() => { throw new Error("must not be reached"); });
  try {
    const auth = { authorization: "Bearer " + FAKE_KEY, "content-type": "application/json", "idempotency-key": "i" };
    const cases = [
      ["POST", "/mfp/sandbox/v1/orders", JSON.stringify({ ...BUILT.order.body, type: "stop_market", stop_price: 80000, reduce_only: false })],   // the review's probe
      ["POST", "/mfp/sandbox/v1/orders", "{"],
      ["POST", "/mfp/sandbox/v1/orders", null],                                       // no body at all
      ["POST", "/mfp/live/v1/orders", JSON.stringify(BUILT.close.body)],               // a close's body on the orders path
      ["PATCH", "/mfp/sandbox/v1/orders/ord_1", JSON.stringify({ price: 1, type: "stop_market" })],
      ["POST", "/mfp/sandbox/v1/positions/pos_1/close", JSON.stringify({ ...BUILT.close.body, type: "limit" })],
      ["PUT", "/mfp/sandbox/v1/positions/pos_1/exit-orders", JSON.stringify({ ...BUILT.exits.body, cancel_all: true })],
    ];
    for (const [method, p, body] of cases) {
      const r = await w.call({ method, path: p, headers: auth, body });
      assert.equal(r.status, 400, method + " " + p + " " + body);
      const err = JSON.parse(r.text).error;
      assert.equal(err.code, "passthrough_refused");
      assert.match(err.message, /not a permitted MFP request body/);
      assert.equal(orders.mfpIsRefusal(JSON.parse(r.text)), true, "the app reads it as a definite refusal");
    }
    assert.equal(w.sends.length, 0);
    // the refusal's reason is not logged, and no body is
    assert.ok(w.logs.every((l) => /^(POST|PATCH|PUT) \/mfp\/[a-z]+\/v1\/[A-Za-z0-9_/-]+ -> 400 \(\d+ ms\)$/.test(l)), w.logs.join("\n"));
  } finally { await w.close(); }
});

// ---- nothing is sent until the whole request has arrived (review R1) --------

test("R1: a read or a cancel that brings a body is refused before anything is sent", async () => {
  const w = await world(() => { throw new Error("must not be reached"); });
  try {
    const auth = { authorization: "Bearer " + FAKE_KEY, "idempotency-key": "i" };
    for (const [method, p, headers, body] of [
      ["DELETE", "/mfp/sandbox/v1/orders/ord_1", { ...auth, "content-length": "2" }, "{}"],
      ["DELETE", "/mfp/sandbox/v1/orders/ord_1", { ...auth, "transfer-encoding": "chunked" }, "{}"],
      ["GET", "/mfp/sandbox/v1/accounts", { ...auth, "content-length": "2" }, "{}"],
      ["GET", "/mfp/sandbox/v1/accounts", { ...auth, "transfer-encoding": "chunked" }, "x"],
    ]) {
      const r = await w.call({ method, path: p, headers, body });
      assert.equal(r.status, 400, method + " " + JSON.stringify(headers));
      assert.equal(JSON.parse(r.text).error.code, "passthrough_refused");
    }
    assert.equal(w.sends.length, 0);
  } finally { await w.close(); }
  // a declared empty body is no body
  const ok = await world(() => jsonAnswer(204, null));
  try {
    const r = await ok.call({ method: "DELETE", path: "/mfp/sandbox/v1/orders/ord_1", headers: { authorization: "Bearer " + FAKE_KEY, "content-length": "0" } });
    assert.equal(r.status, 204);
    assert.equal(ok.sends.length, 1);
    assert.equal(ok.sends[0].body, undefined);
  } finally { await ok.close(); }
});

// The server as serve.mjs mounts it (app.mjs), on a loopback port, with a
// scripted upstream, and a raw socket for what no http client will send.
async function mounted(upstream) {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "tt-app-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>app</title>");
  fs.writeFileSync(path.join(dist, "bundle.js"), "/* bundle */");
  const sends = [];
  let handler = null;
  const server = makeApp({ dist, handleMfp: (req, res) => handler(req, res) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const host = "127.0.0.1:" + port;
  handler = makeMfpHandler({ hosts: [host], send: async (url, init) => { sends.push({ url, ...init }); return upstream(url, init); } });
  // Writes each piece, in order, and resolves with everything the server
  // wrote back once it closes the connection or `quietMs` pass in silence.
  const raw = (pieces, quietMs = 250) => new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let got = "";
    let closed = false;
    let timer = null;
    const finish = () => { clearTimeout(timer); sock.destroy(); resolve({ text: got, closed }); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(finish, quietMs); };
    sock.on("data", (c) => { got += c.toString("latin1"); arm(); });
    sock.on("close", () => { closed = true; finish(); });
    sock.on("error", (e) => { if (e.code === "ECONNRESET" || e.code === "EPIPE") { closed = true; finish(); } else reject(e); });
    sock.on("connect", async () => {
      for (const piece of pieces) {
        if (typeof piece === "function") await piece(); else sock.write(piece);
      }
      arm();
    });
  });
  const close = async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); fs.rmSync(dist, { recursive: true, force: true }); };
  return { sends, host, port, dist, raw, close };
}
const until = async (cond, ms = 2000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 5)); } };

test("R1: the review's probe - a cancel with an unfinished chunked body is refused before it is sent", async () => {
  const m = await mounted(() => { throw new Error("must not be reached"); });
  try {
    const head = "DELETE /mfp/sandbox/v1/orders/ord_1 HTTP/1.1\r\nHost: " + m.host + "\r\nAuthorization: Bearer " + FAKE_KEY + "\r\nIdempotency-Key: i\r\nTransfer-Encoding: chunked\r\n\r\n";
    const r = await m.raw([head, () => new Promise((res) => setTimeout(res, 60)), "Z\r\nmalformed\r\n"]);
    assert.equal(m.sends.length, 0, "nothing reached the upstream");
    // the one answer is this server's own refusal, in the envelope the app reads as "not sent"
    assert.match(r.text, /^HTTP\/1\.1 400 /);
    assert.match(r.text, /"code":"passthrough_refused"/);
    assert.equal((r.text.match(/HTTP\/1\.1 /g) || []).length, 1, "one answer only");
  } finally { await m.close(); }
});

test("R1: a parse failure on a connection whose write is waiting closes it - no 400 the app would read as a refusal", async () => {
  let release = null;
  const m = await mounted(() => new Promise((res) => { release = () => res(jsonAnswer(201, { data: { id: "ord_1" } })); }));
  try {
    const head = "POST /mfp/sandbox/v1/orders HTTP/1.1\r\nHost: " + m.host + "\r\nAuthorization: Bearer " + FAKE_KEY + "\r\nIdempotency-Key: i\r\nContent-Type: application/json\r\nContent-Length: " + Buffer.byteLength(ORDER_BODY) + "\r\n\r\n" + ORDER_BODY;
    const r = await m.raw([head, () => until(() => m.sends.length === 1), "\u0001\u0002 not http at all\r\n\r\n"]);
    assert.equal(m.sends.length, 1, "the write was sent once");
    assert.equal(r.closed, true, "the connection was closed");
    assert.ok(!/HTTP\/1\.1 4\d\d/.test(r.text), "no 4xx was written for the waiting write: " + JSON.stringify(r.text));
    release();
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(m.sends.length, 1, "and it was not sent again");
  } finally { if (release) release(); await m.close(); }
});

test("R1: a request node cannot parse gets no answer at all", async () => {
  const m = await mounted(() => { throw new Error("must not be reached"); });
  try {
    const r = await m.raw(["NOT A REQUEST\r\n\r\n"]);
    assert.equal(r.text, "");
    assert.equal(r.closed, true);
    assert.equal(m.sends.length, 0);
  } finally { await m.close(); }
});

// ---- the static side cannot stop the server (review R5) ----------------------

test("R5: a path that cannot be looked up, or a file that is gone, ends one response and the server goes on", async () => {
  const m = await mounted(() => jsonAnswer(200, { data: [] }));
  const get = (p) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: m.port, method: "GET", path: p, headers: { host: m.host } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    assert.equal((await get("/bundle.js")).text, "/* bundle */");
    // a name the file system refuses outright (the look throws): the app page, not a crash
    for (const p of ["/%00", "/a%00b.js", "/%E0%A4%A", "/..%2F..%2Fsecret", "/no/such/file.js", "/"]) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.text, /<title>app<\/title>/, p);
    }
    // the export is being rewritten: the files are gone mid-session
    fs.rmSync(path.join(m.dist, "bundle.js"));
    assert.match((await get("/bundle.js")).text, /<title>app<\/title>/);
    fs.rmSync(path.join(m.dist, "index.html"));
    assert.equal((await get("/")).status, 503);
    assert.equal((await get("/anything")).status, 503);
    // and the pass-through still answers
    const r = await get("/mfp/sandbox/v1/markets?venues=all");
    assert.equal(r.status, 200);
    assert.equal(m.sends.length, 1);
  } finally { await m.close(); }
});

// ---- the app's side of R1: what counts as the venue's refusal ----------------

const unreadable = (status) => ({ ok: false, status, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } });

test("R1: a 4xx is a definite refusal only with the venue's error body; any other 4xx is unknown and is looked up", async () => {
  // [the answer to the write, definite?]
  const cases = [
    [json({ error: { code: "order_not_found", message: "no such order" } }, 404), true],
    [json({ error: { code: "passthrough_refused", message: "not a permitted MFP request" } }, 403), true],
    [unreadable(400), false],                                   // node's own empty "400 Bad Request"
    [json("<html>blocked</html>", 403), false],                 // a proxy's page that parsed as a JSON string
    [json({ message: "Bad Request" }, 400), false],             // JSON, but not the venue's envelope
    [json({ error: "nope" }, 422), false],
    [json({ error: { message: "no code" } }, 422), false],
    [json(null, 429), false],
  ];
  for (const [answer, definite] of cases) {
    const seen = [];
    const w = makeWorld({ fetch: async (url, init) => {
      seen.push(init.method);
      if (init.method === "DELETE") return answer;
      return json({ data: [{ id: "ord_1", account_id: "acct_1", status: "working" }] });   // the order still works
    } });
    const ex = w.load("mfp_exchange");
    const { currentSession } = w.load("session");
    const r = await w.clock.settle(ex.mfpCancelOrder(currentSession(), FAKE_KEY, "acct_1", "ord_1"));
    const label = answer.status + " " + definite;
    assert.equal(r.ok, false, label);
    assert.equal(r.ambiguous, !definite, label);
    assert.equal(seen.filter((m) => m === "DELETE").length, 1, "sent once, never again: " + label);
    assert.equal(seen.filter((m) => m === "GET").length, definite ? 0 : 1, "an unknown answer is followed by a venue read: " + label);
  }
});

test("R1: the app's refusal test reads the venue's envelope and nothing else", () => {
  assert.equal(orders.mfpIsRefusal({ error: { code: "rule_violation", message: "cooldown" } }), true);
  assert.equal(orders.mfpIsRefusal({ error: { code: "x" } }), true);
  for (const v of [null, undefined, {}, [], "", "error", { error: null }, { error: "x" }, { error: {} }, { error: { code: "" } }, { error: { code: 7 } }, { error: [{ code: "x" }] }, { code: "x" }]) {
    assert.equal(orders.mfpIsRefusal(v), false, JSON.stringify(v));
  }
});
