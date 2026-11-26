// The MyFundedPerps pass-through's whole decision, as one pure function.
//
// A browser cannot call MFP's API: its CORS policy names one origin (MFP's
// own docs site). The web build therefore sends its MFP requests to its OWN
// origin, under /mfp/<env>/v1/..., and the server that serves the app
// forwards them (server/mfp_passthrough.mjs). Android never comes here.
//
// This file decides what may be forwarded, and to where. It is the same
// surface docs/CONTRACT.md "Allowed venue writes" gives the app, written
// out as a list: a request that is not on it is refused HERE and never reaches MFP.
// So the pass-through cannot be used for anything the app itself may not do
// (cancel-all, close-all, TWAP, scaled orders, price alerts, isolated-margin
// top-ups, copy trading), whatever the page that calls it sends.
//
// A write's BODY is held to the same rule (mfpWriteBody): the fields, types
// and ranges the app's own builders may send (assertMfpWrite in
// src/lib/mfp_orders.ts), so an order type other than market or limit, or a
// field the app never sends, is refused here too. What is forwarded is the
// body as it was checked, written out again - never the bytes that came in.
//
// PURE and import-free: node --test loads it straight from source, and a
// hosted adapter (a Worker) can import it unchanged.

// The guard pins this declaration whole: frozen, these two hosts, no more.
export const MFP_UPSTREAM = Object.freeze({ live: "https://developers.myfundedperpetuals.com", sandbox: "https://sandbox.myfundedperpetuals.com" });

export const MFP_PREFIX = "/mfp/";

const ID = Symbol("id");

// method, then the path segments after /v1/, then the write it is (null: a
// read). ID is one venue id (an account, order, position or market id).
const ROUTES = Object.freeze([
  // reads
  ["GET", ["accounts"], null],
  ["GET", ["accounts", ID], null],
  ["GET", ["accounts", ID, "trading-policy"], null],
  ["GET", ["positions"], null],
  ["GET", ["orders"], null],
  ["GET", ["markets"], null],
  ["GET", ["markets", ID, "quote"], null],
  ["GET", ["fills"], null],
  // writes
  ["POST", ["orders"], "order"],
  ["PATCH", ["orders", ID], "modify"],
  ["DELETE", ["orders", ID], "cancel"],
  ["POST", ["positions", ID, "close"], "close"],
  ["PUT", ["positions", ID, "exit-orders"], "exits"],
]);

const METHODS = new Set(ROUTES.map((r) => r[0]));
// The writes that carry a body. A cancel and every read carry none.
const WITH_BODY = new Set(["order", "modify", "close", "exits"]);

// A venue id as MFP writes them ("ord_...", a uuid, "binance|BTCUSDT",
// "hyperliquid|xyz:NVDA"). Nothing that could re-shape the path once the
// venue decodes it: no slash, no backslash, no percent sign, no dot-only
// segment. The SAME characters and length the app's own builders accept
// (ID_RE in src/lib/mfp_orders.ts), so every write the app can build is one
// this forwards; a test holds the two together.
const ID_TEXT = /^[A-Za-z0-9_.:|-]{1,128}$/;

function decodeId(seg) {
  let text;
  try { text = decodeURIComponent(seg); } catch { return null; }
  if (!ID_TEXT.test(text) || text === "." || text === "..") return null;
  return text;
}

const refuse = (status, message) => ({ ok: false, status, code: "passthrough_refused", message });

// The address a request is about to be sent to is one of MFP's two API
// hosts, under /v1/, with nothing in it that could carry it elsewhere (no
// user:password@, no port, no fragment). The route checks what it built;
// the sender checks again on the last line before it sends.
export function mfpUpstreamOk(url) {
  if (typeof url !== "string") return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.origin !== MFP_UPSTREAM.live && u.origin !== MFP_UPSTREAM.sandbox) return false;
  if (u.username !== "" || u.password !== "" || u.hash !== "") return false;
  return url.startsWith(u.origin + "/v1/") && u.pathname.startsWith("/v1/");
}

// target: the request line's path and query, e.g.
// "/mfp/sandbox/v1/orders?account_id=acct_1&status=working".
export function mfpRoute(method, target) {
  if (typeof method !== "string" || typeof target !== "string") return refuse(400, "malformed request");
  if (!METHODS.has(method)) return refuse(405, "method not permitted: " + method);
  if (!target.startsWith(MFP_PREFIX)) return refuse(404, "not an MFP pass-through path");
  // No control characters, spaces, backslashes or fragments anywhere.
  if (/[\u0000- \u007f\\#]/.test(target)) return refuse(400, "malformed path");
  const q = target.indexOf("?");
  const pathPart = q === -1 ? target : target.slice(0, q);
  const query = q === -1 ? "" : target.slice(q + 1);
  const segs = pathPart.slice(MFP_PREFIX.length).split("/");
  const env = segs[0];
  if (!Object.prototype.hasOwnProperty.call(MFP_UPSTREAM, env)) return refuse(404, "unknown MFP environment");
  if (segs[1] !== "v1") return refuse(404, "not a /v1 path");
  const rest = segs.slice(2);
  for (const [m, shape, write] of ROUTES) {
    if (m !== method || shape.length !== rest.length) continue;
    const out = [];
    let hit = true;
    for (let i = 0; i < shape.length; i++) {
      if (shape[i] === ID) {
        const id = decodeId(rest[i]);
        if (id === null) { hit = false; break; }
        out.push(encodeURIComponent(id));
      } else if (shape[i] === rest[i]) {
        out.push(shape[i]);
      } else { hit = false; break; }
    }
    if (!hit) continue;
    // A write is its path and its body. No write the app builds has a
    // query, so one that brings a query is not one of them.
    if (write !== null && query !== "") return refuse(400, "a write takes no query");
    const venuePath = "/v1/" + out.join("/");
    const upstream = MFP_UPSTREAM[env] + venuePath + (query ? "?" + query : "");
    // What was built must read back as the same host and the same path.
    if (!mfpUpstreamOk(upstream) || new URL(upstream).origin !== MFP_UPSTREAM[env] || new URL(upstream).pathname !== venuePath) return refuse(400, "malformed path");
    return { ok: true, env, upstream, write, hasBody: WITH_BODY.has(write) };
  }
  return refuse(403, "not a permitted MFP request: " + method + " " + pathPart.slice(MFP_PREFIX.length + env.length));
}

// ---- a write's body -----------------------------------------------------
//
// The same rule as assertMfpWrite (src/lib/mfp_orders.ts), which the app
// runs on every write before it sends. It is repeated here because server/
// imports nothing from src/; test/mfp_passthrough.test.mjs holds the two
// together (every builder-made write passes both, every refused body is
// refused by both).

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const posNum = (x) => typeof x === "number" && Number.isFinite(x) && x > 0;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const keysExactly = (o, keys) => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};
const keysWithin = (o, required, optional) => {
  const k = Object.keys(o);
  return required.every((x) => k.includes(x)) && k.every((x) => required.includes(x) || optional.includes(x));
};

const OPID_TEXT = /^[\x21-\x7e]{1,128}$/;
const MAX_SLIPPAGE_BPS = 500; // 5 percent
const ORDER_REQUIRED = ["client_order_id", "type", "account_id", "market_id", "side", "size", "leverage", "margin_mode", "reduce_only"];
const ORDER_OPTIONAL = ["expected_price", "limit_price", "slippage_tolerance_bps", "take_profit_price", "stop_loss_price"];

// Why the body is not one this write may carry, or null when it is.
function bodyRefusal(write, b) {
  if (!isObj(b)) return "the body is not a JSON object";
  if (write === "order") {
    if (!keysWithin(b, ORDER_REQUIRED, ORDER_OPTIONAL)) return "order body has unexpected keys";
    if (b.type !== "market" && b.type !== "limit") return "order type must be market or limit";
    if (b.side !== "buy" && b.side !== "sell") return "order side must be buy or sell";
    if (typeof b.reduce_only !== "boolean") return "reduce_only must be boolean";
    if (!posNum(b.size) || !posNum(b.leverage)) return "order needs positive size and leverage";
    if (b.type === "market" && !posNum(b.expected_price)) return "a market order needs a positive expected_price";
    if (b.type === "limit" && has(b, "expected_price")) return "a limit order has no expected_price";
    if (b.margin_mode !== "cross" && b.margin_mode !== "isolated") return "bad margin mode";
    if (typeof b.client_order_id !== "string" || !OPID_TEXT.test(b.client_order_id)) return "order needs a client order id";
    if (b.type === "limit" && !posNum(b.limit_price)) return "a limit order needs limit_price";
    if (b.type === "market" && has(b, "limit_price")) return "a market order has no limit_price";
    if (has(b, "slippage_tolerance_bps") && (!posNum(b.slippage_tolerance_bps) || b.slippage_tolerance_bps > MAX_SLIPPAGE_BPS)) return "slippage above 5% is refused";
    if (has(b, "take_profit_price") && !posNum(b.take_profit_price)) return "bad take profit";
    if (has(b, "stop_loss_price") && !posNum(b.stop_loss_price)) return "bad stop loss";
    if (b.reduce_only === true && (has(b, "take_profit_price") || has(b, "stop_loss_price"))) return "a reducing order cannot carry attached exits";
    return null;
  }
  if (write === "modify") {
    if (!keysWithin(b, ["price"], ["size"])) return "modify body has unexpected keys";
    if (!posNum(b.price) || (has(b, "size") && !posNum(b.size))) return "modify needs a positive price (and size)";
    return null;
  }
  if (write === "close") {
    if (!keysWithin(b, ["client_order_id", "type", "expected_price", "slippage_tolerance_bps"], ["size"])) return "a close carries only client_order_id, type, expected_price, slippage_tolerance_bps and an optional size";
    if (b.type !== "market") return "a close must be a market close";
    if (!posNum(b.expected_price)) return "a close needs a positive reference price";
    if (!posNum(b.slippage_tolerance_bps) || b.slippage_tolerance_bps > MAX_SLIPPAGE_BPS) return "slippage above 5% is refused";
    if (has(b, "size") && !posNum(b.size)) return "a partial close needs a positive size";
    if (typeof b.client_order_id !== "string" || !OPID_TEXT.test(b.client_order_id)) return "close needs a client order id";
    return null;
  }
  if (write === "exits") {
    if (!keysExactly(b, ["expected_position_size", "expected_orders", "operations"])) return "exits body has unexpected keys";
    if (!posNum(b.expected_position_size)) return "exits need the expected position size";
    if (!Array.isArray(b.expected_orders) || !Array.isArray(b.operations) || !b.operations.length) return "exits need expected_orders and operations";
    for (const x of b.expected_orders) {
      if (!isObj(x) || !keysExactly(x, ["order_id", "price", "size"]) || typeof x.order_id !== "string" || !posNum(x.price) || !posNum(x.size)) return "bad expected order";
    }
    for (const x of b.operations) {
      if (!isObj(x)) return "bad exit operation";
      if (x.kind === "cancel") { if (!keysExactly(x, ["kind", "order_id"]) || typeof x.order_id !== "string") return "bad cancel operation"; }
      else if (x.kind === "modify") { if (!keysWithin(x, ["kind", "order_id", "price"], ["size"]) || typeof x.order_id !== "string" || !posNum(x.price) || (has(x, "size") && !posNum(x.size))) return "bad modify operation"; }
      else if (x.kind === "place") {
        if (!keysExactly(x, ["kind", "group", "price", "size", "execution_type"])) return "bad place operation";
        if ((x.group !== "tp" && x.group !== "sl") || !posNum(x.price) || !posNum(x.size) || x.execution_type !== "market") return "bad place operation";
        if (x.size > b.expected_position_size + 1e-12) return "an exit cannot exceed the position";
      } else return "exit operation kind not permitted";
    }
    return null;
  }
  return "not a write that carries a body";
}

// write: the route's `write`. text: the request body as it arrived.
// ok: `text` is the body to forward - the checked value written out again,
// so what MFP reads is what was checked (a duplicated key cannot be read one
// way here and another way there).
export function mfpWriteBody(write, text) {
  if (typeof text !== "string") return { ok: false, message: "malformed body" };
  let value;
  try { value = JSON.parse(text); } catch { return { ok: false, message: "the body is not JSON" }; }
  const why = bodyRefusal(write, value);
  return why ? { ok: false, message: why } : { ok: true, text: JSON.stringify(value) };
}

// The error body, in MFP's own envelope, so the app's parser reads it.
export function refusalBody(code, message) {
  return JSON.stringify({ error: { code, message } });
}
