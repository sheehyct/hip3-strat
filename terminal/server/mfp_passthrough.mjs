// The MyFundedPerps pass-through for a node http server: forwards the web
// build's /mfp/<env>/v1/... requests to MFP and hands the answer back.
// What may be forwarded is decided by mfp_route.mjs alone.
//
// Rules this file keeps (docs/CONTRACT.md "Order discipline" depends on
// them):
// - ONE upstream request per incoming request. Never retried, never
//   replayed, redirects never followed. The app sends each write once and
//   resolves an unknown result by looking the order up; a retry here would
//   break that.
// - A request refused here (not on the list, a body the app's builders
//   could not have made, wrong origin, too large) was never sent to MFP: it
//   answers 4xx in MFP's error envelope, which the app reads as a definite
//   refusal. Anything that fails AFTER the upstream request started answers
//   5xx, which the app reads as "unknown: look it up, do not resend".
// - Nothing is sent until the whole request has arrived: a write's body is
//   read to its end and checked first, and a request that takes no body (a
//   read, a cancel) is refused if it brings one. So no part of a request can
//   still be arriving, and fail, after the upstream request has started.
// - Same origin only. No CORS header is ever sent, a request from another
//   origin is refused, and the Host header must be this server's own.
// - Nothing is stored and nothing about a request is logged except its
//   method, path (no query) and status. Headers and bodies are never
//   logged. Only four request headers are forwarded.
// - Of MFP's answer, the status, the body and five headers come back: the
//   content type, and the four that carry its per-key GET limit (Retry-After
//   and X-RateLimit-Warning / -Scope / -Limit), which the app needs to hold
//   its reads back (src/lib/mfp_rate.ts). None of them is logged.
import { mfpRoute, mfpUpstreamOk, mfpWriteBody, refusalBody } from "./mfp_route.mjs";

const FORWARD_HEADERS = ["authorization", "accept", "content-type", "idempotency-key"];
// MFP's rate-limit headers, handed back to the app under these names.
const RETURN_HEADERS = Object.freeze({ "retry-after": "Retry-After", "x-ratelimit-warning": "X-RateLimit-Warning", "x-ratelimit-scope": "X-RateLimit-Scope", "x-ratelimit-limit": "X-RateLimit-Limit" });
const MAX_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;

function answer(res, status, body, contentType = "application/json") {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (c) => {
      if (over) return; // keep draining so the 413 can be answered
      size += c.length;
      if (size > MAX_BODY_BYTES) { over = true; chunks.length = 0; reject(new Error("too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// hosts: the Host header values this server answers to, e.g.
// ["localhost:8088", "127.0.0.1:8088"]. send: the fetch to use (tests pass a
// fake). log: one line per request, or null.
export function makeMfpHandler({ hosts, send = globalThis.fetch, log = null }) {
  const hostSet = new Set(hosts);
  const originSet = new Set(hosts.map((h) => "http://" + h));

  return async function handleMfp(req, res) {
    const started = Date.now();
    const pathOnly = String(req.url).split("?")[0];
    const done = (status, body, type) => {
      answer(res, status, body, type);
      if (log) log(req.method + " " + pathOnly + " -> " + status + " (" + (Date.now() - started) + " ms)");
    };
    const refuse = (status, message) => done(status, refusalBody("passthrough_refused", message));

    // Same origin only (and no DNS-rebinding: the Host must be ours).
    if (!hostSet.has(String(req.headers.host))) return refuse(403, "wrong host");
    const origin = req.headers.origin;
    if (origin !== undefined && !originSet.has(origin)) return refuse(403, "cross-origin request refused");
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") return refuse(403, "cross-site request refused");

    const route = mfpRoute(req.method, req.url);
    if (!route.ok) return refuse(route.status, route.message);

    const headers = {};
    for (const name of FORWARD_HEADERS) {
      const v = req.headers[name];
      if (typeof v === "string" && v.length) headers[name] = v;
    }
    let body;
    if (route.hasBody) {
      let raw;
      try { raw = await readBody(req); } catch { return refuse(413, "request body too large"); }
      // The body must be one the app's own builders can make (market or
      // limit only, no field outside the list); what goes on is the checked
      // value written out again, as JSON.
      const checked = mfpWriteBody(route.write, raw.toString("utf8"));
      if (!checked.ok) return refuse(400, "not a permitted MFP request body: " + checked.message);
      body = checked.text;
      headers["content-type"] = "application/json";
    } else if (req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) !== 0) {
      // A read or a cancel has no body. One that brings a body is refused
      // before anything is sent, so nothing of it is left to arrive later.
      return refuse(400, "this request takes no body");
    }
    if (!mfpUpstreamOk(route.upstream)) return refuse(400, "not an MFP address");

    // From here on the request may reach MFP: every failure is a 5xx.
    let upstream;
    try {
      upstream = await send(route.upstream, { method: req.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      return done(timedOut ? 504 : 502, refusalBody(timedOut ? "passthrough_timeout" : "passthrough_unreachable", timedOut ? "MFP did not answer in time" : "MFP could not be reached"));
    }
    if (upstream.status >= 300 && upstream.status < 400) return done(502, refusalBody("passthrough_redirect", "MFP answered with a redirect"));
    let payload;
    try { payload = Buffer.from(await upstream.arrayBuffer()); } catch {
      return done(502, refusalBody("passthrough_unreadable", "MFP's answer could not be read"));
    }
    const out = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    const type = upstream.headers.get("content-type");
    if (type) out["Content-Type"] = type;
    for (const [name, as] of Object.entries(RETURN_HEADERS)) {
      const value = upstream.headers.get(name);
      // Printable ASCII only: a header value node would refuse to write must
      // not turn MFP's answer into a failure of this server.
      if (typeof value === "string" && /^[\x20-\x7e]{1,512}$/.test(value)) out[as] = value;
    }
    res.writeHead(upstream.status, out);
    res.end(payload);
    if (log) log(req.method + " " + pathOnly + " -> " + upstream.status + " (" + (Date.now() - started) + " ms)");
  };
}
