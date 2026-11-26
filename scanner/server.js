"use strict";

// HIP-3 alert worker entrypoint.
//   GET /            serves the dashboard HTML (read from disk per request,
//                    so UI updates need no restart)
//   GET /health      JSON health - answers immediately, even during initial load
//   GET /api/state   JSON snapshot of the loop's analyzed state (consumed by
//                    the mobile app - detection stays server-side, the
//                    app is a render surface, never a third implementation)
//   GET /api/briefing/latest.{json,csv}  canonical normalized briefing snapshot
//   GET /api/briefing/latest.{compact.json,html}  adapter-safe projections
//   GET /api/briefing/health    lightweight snapshot identity/freshness JSON,
//                    no rows (all five briefing routes serve ONE materialized
//                    snapshot per universe - see src/briefing_store.js; HEAD
//                    is honored on them and on /health)
//   POST /api/push/register     {token, favs?} - register an Expo push token
//   POST /api/push/unregister   {token}        - remove it
//   POST /api/continuity_at     [{coin, t}, ...] - served continuity at past
//                    times (CONTINUITY_LEDGER=1; 503 while disabled)
//   GET /manifest.webmanifest, /sw.js, /icon-*.png   PWA assets (public/)
//   GET /favicon.ico   alias of /icon-192.png (desktop browsers ask unprompted)
// The data loop + rule engine run in-process.
//
// Binds process.env.PORT || 8787 on process.env.HOST || 127.0.0.1
// (the local default is loopback; the container image sets HOST=0.0.0.0).

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const config = require("./config.json");
const { createLoop } = require("./src/loop.js");
const { createRuleEngine } = require("./src/rules.js");
const { deliver, deliverStats } = require("./src/deliver.js");
const { buildApiState, buildBootstrap, DISPLAY_V } = require("./src/apistate.js");
const {
  DEFAULT_UNIVERSE: DEFAULT_BRIEFING_UNIVERSE,
  briefingFilename
} = require("./src/briefing.js");
const { createBriefingStore } = require("./src/briefing_store.js");
const { SCORE_V } = require("./src/metrics.js");
const { createTelemetry } = require("./src/telemetry.js");
const { parseUniverses, parseAlertUniverses, parseAlertFavsUniverses } = require("./src/universes.js");
const { createPushStore } = require("./src/push.js");
const { createContinuityLedger } = require("./src/continuity_ledger.js");

const DASHBOARD = path.join(__dirname, "hip3_strat_screener.html");
const PUBLIC_DIR = path.join(__dirname, "public");
// Exact-path whitelist: no directory traversal surface, no MIME guessing.
const STATIC = {
  "/manifest.webmanifest": "application/manifest+json",
  "/sw.js": "text/javascript; charset=utf-8",
  "/icon-192.png": "image/png",
  "/icon-512.png": "image/png"
};
// Desktop browsers request /favicon.ico unprompted (P4-1: it 404ed). Alias it
// to the 192px PWA icon: browsers accept a PNG at this path, but the
// Content-Type must be the TRUE type (image/png, never image/x-icon) because
// every response carries nosniff. Exact-match like STATIC, so the closed
// whitelist property is unchanged.
const STATIC_ALIAS = { "/favicon.ico": "/icon-192.png" };
const STATE_PATH = path.join(__dirname, "data", "rule_state.json");
const PUSH_PATH = path.join(__dirname, "data", "push_tokens.json");
const BODY_LIMIT = 32 * 1024; // register payloads are a token + a favs list
// /api/continuity_at: at most this many {coin, t} items per request. One
// request is one phone opening its Performance view; 200 bounds the work a
// single call on this public route can ask for.
const CONTINUITY_MAX_ITEMS = 200;
const PORT = parseInt(process.env.PORT, 10) || 8787;
const HOST = process.env.HOST || "127.0.0.1";
const startedAt = Date.now();

function log(msg) {
  console.log("[" + new Date().toISOString() + "] " + msg);
}

// Multi-universe wiring (env-driven, opt-in). UNIVERSES selects which perp
// namespaces are TRACKED (fetched + analyzed + served); ALERT_UNIVERSES selects
// which of those fire alerts. Both default to "xyz", so an unset environment is
// byte-for-byte the single-universe worker. See src/universes.js.
const universes = parseUniverses(process.env.UNIVERSES, { default: ["xyz"], log: log });
// BUDGET_PER_MIN: the client-side exchange request budget in weight per
// minute (src/budget.js; default 2,000 = 100 requests/min, the measured
// safe share of a ~150-request per clock-minute window when the egress IP
// is shared with another client of the exchange). An ops knob for
// re-sizing after a re-measurement, never a tuning by feel.
if (process.env.BUDGET_PER_MIN) {
  config.budgetPerMin = parseInt(process.env.BUDGET_PER_MIN, 10) || undefined;
}
// CANDLE_FEED=1: the WebSocket candle feed for the 15m slot (stage 1 of the
// feed migration). Default OFF - the worker is then
// byte-for-byte the REST-only worker. FEED_RECONCILE_MS overrides the hourly
// REST reconciliation pass (the parity gate) for local verification.
config.candleFeed = process.env.CANDLE_FEED === "1";
if (process.env.FEED_RECONCILE_MS) {
  config.feedReconcileMs = parseInt(process.env.FEED_RECONCILE_MS, 10) || undefined;
}
const alertUniverses = parseAlertUniverses(
  process.env.ALERT_UNIVERSES, universes.map(function (u) { return u.id; }), { default: ["xyz"], log: log });
// ALERT_FAVS_UNIVERSES: tracked universes that alert for FAVORITED coins only
// (default "perps"). Kept SEPARATE from alertUniverses on purpose - that list
// is also the true-up scope handed to the loop below, and widening it would
// re-break the exchange rate budget the demand cut repaired. Favorites-scoped alerting
// adds no fetch demand: those candles are already pulled for analysis.
const alertFavsUniverses = parseAlertFavsUniverses(
  process.env.ALERT_FAVS_UNIVERSES, universes.map(function (u) { return u.id; }),
  alertUniverses, { default: ["perps"], log: log });
log("universes tracked: " + universes.map(function (u) { return u.id; }).join(",")
  + " | alerting: " + (alertUniverses.join(",") || "(none)")
  + " | favorites-only alerting: " + (alertFavsUniverses.join(",") || "(none)"));

// CONTINUITY_LEDGER=1: the continuity checkpoint ledger (src/continuity_ledger.js).
// Default OFF - with the flag
// unset nothing is constructed: no timer, no data/continuity/ directory,
// /api/state unchanged, /health continuity_ledger null, the route 503.
const continuityEnabled = process.env.CONTINUITY_LEDGER === "1";

// Expo push rides ALONGSIDE the ALERT_BACKEND webhook: every fired alert goes
// to both. With zero registered tokens push.send is a no-op, so an unused
// store leaves delivery byte-for-byte as before. push.send never rejects.
const push = createPushStore({ statePath: PUSH_PATH, log: log });
function deliverAlert(msg, meta) {
  push.send(msg, meta);
  return deliver(msg, meta);
}

const rules = createRuleEngine(config, deliverAlert, {
  statePath: STATE_PATH, log: log, alertUniverses: alertUniverses,
  // Favorites-only scope. The union is read through a callback so each
  // evaluation pass sees the CURRENT registrations - a phone that re-registers
  // with a changed favorites list changes alert scope on the next tick.
  alertFavsUniverses: alertFavsUniverses,
  favUnion: function () { return push.favUnion(); }
});
const loop = createLoop(config, {
  log: log,
  universes: universes,
  // The 5-min volume true-up runs only for the BROADCAST alerting universes
  // (demand cut, design decision 2026-08-17): rvol_spike is the consumer that needs
  // intra-period volume, and it only runs where alerts run. Screener-only
  // universes refetch at bar rolls and serve rvol null (apistate).
  // alertFavsUniverses is deliberately NOT included: favorites-only alerting
  // exists precisely because it costs zero extra exchange demand. Outside
  // this scope BOTH consumers null rvol through the one shared predicate
  // (universes.volumeFresh) - apistate when serving, rules when scoring and
  // evaluating rvol_spike - so a favorited perp alerts without volume claims
  // rather than off frozen volume. An EMPTY list stays empty in the loop
  // (review HIGH: it previously expanded to all-tracked true-up).
  trueUpUniverses: alertUniverses,
  onTick: function () { rules.evaluateAll(loop.state); },
  // Roster reconciliation removed these coins: drop their rule state so a
  // later re-list of the same name baselines fresh (see rules.dropCoins).
  onRemove: function (names) { rules.dropCoins(names); }
});

// Component telemetry: 5-min JSONL series of
// score terms + D/W/M gate + exclusion counts under data/telemetry/.
// Passive reader of loop.state; TELEMETRY_DISABLED=1 turns it off. Durable
// only when data/ sits on a persistent volume.
const telemetry = createTelemetry({
  dir: path.join(__dirname, "data", "telemetry"),
  ftfcTfs: config.ftfcTfs,
  log: log
});

// Materialized briefing snapshots: one immutable, identified snapshot per
// tracked universe every 60s, served unchanged by every /api/briefing route
// until the next tick. Passive reader of loop.state - zero exchange demand,
// nothing on disk (design decision 2026-09-13: no persisted last-good fallback
// in this pass). BRIEFING_INTERVAL_MS is a test/ops knob, not a tuning.
const briefing = createBriefingStore({
  state: loop.state,
  ftfcTfs: config.ftfcTfs,
  intervalMs: parseInt(process.env.BRIEFING_INTERVAL_MS, 10) || undefined,
  log: log
});

// The continuity ledger (flag above). Passive reader of loop.state, like the
// two stores above - zero exchange demand. It stamps keyframes with the
// briefing store's boot id, so /health's briefing.boot_id names the boot a
// ledger keyframe came from.
const continuity = continuityEnabled ? createContinuityLedger({
  dir: path.join(__dirname, "data", "continuity"),
  state: loop.state,
  ftfcTfs: config.ftfcTfs,
  bootId: briefing.bootId,
  log: log
}) : null;

// Does the client accept gzip? A well-formed Accept-Encoding can DISABLE a
// coding with a zero quality value (RFC 9110 12.4.2: "gzip;q=0, identity"),
// which strict probes, curl wrappers and monitoring clients send on purpose.
// The prior naive /\bgzip\b/ test read that refusal as acceptance. We stay
// conservative otherwise: only the literal "gzip" token enables it (no "*"
// wildcard), so every ordinary browser / RN / curl request negotiates exactly
// as before.
const GZIP_MEMBER_RE = /^[ \t]*gzip[ \t]*(?:;[ \t]*q[ \t]*=[ \t]*(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)[ \t]*)?$/i;

function acceptsGzip(headerValue) {
  const header = String(headerValue || "");
  if (!header) return false;
  const codings = header.split(",");
  for (let i = 0; i < codings.length; i++) {
    const parts = codings[i].split(";");
    if (parts[0].trim().toLowerCase() !== "gzip") continue;
    const match = GZIP_MEMBER_RE.exec(codings[i]);
    if (!match) return false; // malformed literal-gzip member: fail closed
    return match[1] === undefined || Number(match[1]) > 0;
  }
  return false;
}

// JSON responder shared by the API endpoints. These payloads are the network
// hot path (~250 KB-2 MB raw, largely repeated JSON keys) - gzip cuts them
// ~7x. Browsers, RN fetch and Node decompress transparently; a raw curl
// (or an explicit gzip;q=0 opt-out) still gets identity encoding.
function sendJson(req, res, obj, options) {
  options = options || {};
  const body = JSON.stringify(obj);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",    // public market data, no secrets
    "Vary": "Accept-Encoding"
  };
  Object.keys(options.headers || {}).forEach(function (key) {
    headers[key] = options.headers[key];
  });
  const status = options.status || 200;
  const gz = acceptsGzip(req.headers["accept-encoding"]);
  if (gz) headers["Content-Encoding"] = "gzip";
  // HEAD: the headers a GET would carry, no body. A probe tool that asks
  // HEAD first used to get 404 here and report the endpoint missing.
  if (req.method === "HEAD") { res.writeHead(status, headers); res.end(); return; }
  res.writeHead(status, headers);
  res.end(gz ? zlib.gzipSync(body) : body);
}

// Diagnostic headers on every briefing response. The pre-existing names are
// kept verbatim (consumers already read them); X-Snapshot-ID, X-Age-Seconds,
// X-Producer-Status and X-Request-ID are additive. X-Is-Stale and
// X-Age-Seconds are SERVE-TIME values (briefing_store): they keep aging on a
// stalled producer instead of freezing at materialization. The stricter
// Cache-Control is belt-and-braces against any intermediary replaying an
// older snapshot; the identity headers are what would PROVE such a replay.
const BRIEFING_CACHE_CONTROL = "no-store, no-cache, must-revalidate";
const BRIEFING_EXPOSED = "Content-Disposition, X-Generated-At, X-Data-As-Of, X-Row-Count, "
  + "X-Expected-Row-Count, X-Universe, X-Data-Complete, X-Is-Stale, X-Score-Policy, "
  + "X-Snapshot-ID, X-Age-Seconds, X-Producer-Status, X-Request-ID";

function briefingHeaders(view, requestId) {
  // view.snapshot is ALWAYS present - the entry's snapshot, or the store's
  // synthetic unavailable document - so headers and body come from the
  // same metadata even when no entry exists (review L1: they used to
  // say "unknown" over a body that named the universe).
  const s = view.snapshot;
  return {
    "Cache-Control": BRIEFING_CACHE_CONTROL,
    "X-Request-ID": requestId,
    "X-Snapshot-ID": view.served.snapshot_id || "none",
    "X-Generated-At": s.generated_at_utc || "unknown",
    "X-Data-As-Of": s.data_as_of_utc || "unknown",
    "X-Age-Seconds": view.served.age_seconds === null ? "unknown" : String(view.served.age_seconds),
    "X-Row-Count": String(s.row_count),
    "X-Expected-Row-Count": String(s.expected_row_count),
    "X-Universe": s.universe,
    "X-Data-Complete": String(s.data_complete),
    "X-Is-Stale": String(view.served.is_stale),
    "X-Producer-Status": view.served.producer_status,
    "X-Score-Policy": s.score_policy,
    "Access-Control-Expose-Headers": BRIEFING_EXPOSED
  };
}

// Request identity for the briefing routes. A Railway edge stamps every
// request with x-railway-request-id; echoing it lets a consumer quote the id
// it saw and lets us find that exact request in the deploy logs. Inbound
// values are whitelisted to a token shape (never echoed raw into a header or
// a log line); anything else gets a locally generated id.
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function requestIdOf(req) {
  const inbound = req.headers["x-railway-request-id"] || req.headers["x-request-id"];
  if (typeof inbound === "string" && REQUEST_ID_RE.test(inbound)) return inbound;
  return "local-" + crypto.randomBytes(6).toString("hex");
}

function sendCsv(req, res, body, filename, options) {
  options = options || {};
  const headers = {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="' + filename + '"',
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Vary": "Accept-Encoding"
  };
  Object.keys(options.headers || {}).forEach(function (key) {
    headers[key] = options.headers[key];
  });
  const status = options.status || 200;
  const gz = acceptsGzip(req.headers["accept-encoding"]);
  if (gz) headers["Content-Encoding"] = "gzip";
  // HEAD: the headers a GET would carry, no body. A probe tool that asks
  // HEAD first used to get 404 here and report the endpoint missing.
  if (req.method === "HEAD") { res.writeHead(status, headers); res.end(); return; }
  res.writeHead(status, headers);
  res.end(gz ? zlib.gzipSync(body) : body);
}

function sendHtml(req, res, body, options) {
  options = options || {};
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Vary": "Accept-Encoding"
  };
  Object.keys(options.headers || {}).forEach(function (key) {
    headers[key] = options.headers[key];
  });
  const status = options.status || 200;
  const gz = acceptsGzip(req.headers["accept-encoding"]);
  if (gz) headers["Content-Encoding"] = "gzip";
  // HEAD: the headers a GET would carry, no body. A probe tool that asks
  // HEAD first used to get 404 here and report the endpoint missing.
  if (req.method === "HEAD") { res.writeHead(status, headers); res.end(); return; }
  res.writeHead(status, headers);
  res.end(gz ? zlib.gzipSync(body) : body);
}

// Collect a request body with a hard BYTE size cap. Buffers are concatenated
// once at the end (per-chunk stringification would corrupt a multi-byte UTF-8
// sequence split across chunks, and would count UTF-16 units, not bytes).
// cb receives {body} on success, {tooLarge} on overflow, {err} on a transport
// error (client abort) - the route maps those to 200-path / 413 / 400.
function readBody(req, limit, cb) {
  const chunks = [];
  let size = 0;
  let done = false;
  function finish(v) { if (!done) { done = true; cb(v); } }
  req.on("data", function (chunk) {
    if (done) return;
    size += chunk.length;
    if (size > limit) { finish({ tooLarge: true }); return; }
    chunks.push(chunk);
  });
  req.on("end", function () { finish({ body: Buffer.concat(chunks).toString("utf8") }); });
  req.on("error", function () { finish({ err: true }); });
}

// The request handler is built via a factory so route behavior (content
// negotiation, cache headers, fallbacks) can be exercised in tests without
// binding a port or starting the data loop. deps = {loop, rules, push, config}.
function createRequestHandler(deps) {
  const loop = deps.loop, rules = deps.rules, push = deps.push, config = deps.config;
  const nowFn = deps.now || Date.now;   // injectable for deterministic cache tests
  const logFn = deps.log || function () {};
  // The materialized briefing store. server.js injects the started one; a
  // handler built without it (tests) gets a passive store over the same fake
  // state that materializes on first request and never ticks.
  const briefing = deps.briefing || createBriefingStore({
    state: loop.state, ftfcTfs: config.ftfcTfs, now: nowFn, log: logFn
  });

  // Revision-keyed serialization cache (code review 2026-08-14,
  // shipped together with the loop revision as one unit). The big JSON
  // payloads (~330KB-2MB raw) were re-stringified and re-gzipped
  // SYNCHRONOUSLY on every request; now the bytes are built once per
  // (endpoint, universe) per loop revision and reused until the loop
  // actually mutates. One entry per endpoint+universe keeps the map bounded
  // by the tracked-universe count - and callers only cache KNOWN universes,
  // so junk ?uni values from the public internet cannot grow it. The 30s
  // TIME BUCKET bounds honesty-label drift: if the loop stalls (revision
  // frozen), staleness labels inside the payload (mom.r60Src, overdue
  // atr1h) are recomputed at most 30s late instead of freezing at stall
  // time. Per-handler, not module-level: test handlers carry independent
  // fake loops that would otherwise collide on (key, revision).
  const payloadCache = new Map(); // "state|xyz" -> {rev, bucket, body, gz}
  function serveJsonCached(req, res, kind, uniKey, build) {
    const rev = loop.state.revision || 0;
    const bucket = Math.floor(nowFn() / 30000);
    const key = kind + "|" + uniKey;
    let ent = payloadCache.get(key);
    if (!ent || ent.rev !== rev || ent.bucket !== bucket) {
      const body = JSON.stringify(build());
      ent = { rev: rev, bucket: bucket, body: body, gz: zlib.gzipSync(body) };
      payloadCache.set(key, ent);
    }
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",    // public market data, no secrets
      "Vary": "Accept-Encoding"
    };
    if (acceptsGzip(req.headers["accept-encoding"])) {
      headers["Content-Encoding"] = "gzip";
      res.writeHead(200, headers);
      res.end(ent.gz);
      return;
    }
    res.writeHead(200, headers);
    res.end(ent.body);
  }

  return function (req, res) {
  // Blanket security headers on EVERY response (code review):
  // nosniff and a no-referrer policy are safe for all routes, so they ride
  // a writeHead wrapper instead of being repeated - and forgotten - at each
  // call site. CSP is per-route: the dashboard needs its script hash, the
  // briefing HTML is script-free, and the JSON routes need none.
  const rawWriteHead = res.writeHead;
  res.writeHead = function (status, headers) {
    headers = headers || {};
    if (!("X-Content-Type-Options" in headers)) headers["X-Content-Type-Options"] = "nosniff";
    if (!("Referrer-Policy" in headers)) headers["Referrer-Policy"] = "no-referrer";
    return rawWriteHead.call(this, status, headers);
  };
  const raw = req.url || "/";
  const qIdx = raw.indexOf("?");
  const url = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const query = qIdx >= 0 ? new URLSearchParams(raw.slice(qIdx + 1)) : null;

  if (req.method === "GET" && url === "/") {
    fs.readFile(DASHBOARD, function (err, buf) {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("dashboard file not found");
        return;
      }
      // no-cache = always revalidate: UI updates ship on deploy, and a
      // heuristically-cached stale shell hides them (seen 2026-07-07 with a
      // PWA serving an old page). The SW is network-first; this closes the
      // plain-browser-cache side.
      //
      // Hash-based CSP (code review): the page's ONE inline script
      // is allowed by digest, so injected script text cannot execute even
      // though the dashboard is a single self-contained file. Recomputed per
      // read - the file is already read per request so UI ships on deploy,
      // and hashing ~100KB is microseconds. style-src stays 'unsafe-inline'
      // because the renderers set style="" attributes (progress-bar widths),
      // which no hash can cover. connect-src includes the exchange because
      // ?standalone=1 - the rollback pipeline - polls it directly. If the
      // script tag ever fails to parse, fail OPEN to a working page rather
      // than shipping a dashboard whose own script is blocked.
      const m = /<script>([\s\S]*?)<\/script>/.exec(buf.toString("utf8"));
      const scriptSrc = m
        ? "'sha256-" + crypto.createHash("sha256").update(m[1], "utf8").digest("base64") + "'"
        : "'unsafe-inline'";
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "Content-Security-Policy":
          "default-src 'none'; script-src " + scriptSrc + "; style-src 'unsafe-inline'; "
          + "img-src 'self' data:; connect-src 'self' https://api.hyperliquid.xyz; "
          + "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; "
          + "frame-ancestors 'none'"
      });
      res.end(buf);
    });
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url === "/health") {
    const now = nowFn();
    // "ok" requires FRESH CANDLES, not just fresh mids: pattern detection
    // runs on candles, and lastCandles only advances on a successful fetch
    // (the 15m true-up attempts one at least every 5 min, so > 15 min stale
    // means candle fetching is genuinely broken even while mids flow).
    // Freshness is judged PER TRACKED UNIVERSE (review 2026-07-25 F1): the
    // global timestamps advance when ANY universe succeeds, so one healthy
    // universe used to mask a stale alerting universe behind "ok".
    const uniIds = loop.state.universes || [];
    const midsAgeMsByUni = {}, candlesAgeMsByUni = {};
    let midsFresh = uniIds.length > 0, candlesFresh = uniIds.length > 0;
    for (let i = 0; i < uniIds.length; i++) {
      const mTs = (loop.state.lastMidsByUni || {})[uniIds[i]];
      const cTs = (loop.state.lastCandlesByUni || {})[uniIds[i]];
      midsAgeMsByUni[uniIds[i]] = mTs ? now - mTs : null;
      candlesAgeMsByUni[uniIds[i]] = cTs ? now - cTs : null;
      if (!(mTs && now - mTs < 30000)) midsFresh = false;
      if (!(cTs && now - cTs < 900000)) candlesFresh = false;
    }
    // Per-universe coin counts (additive; `coins` stays the total across all
    // tracked universes so existing consumers are unaffected).
    const coinsByUni = {};
    for (let i = 0; i < loop.state.order.length; i++) {
      const c = loop.state.coins[loop.state.order[i]];
      const u = (c && c.uni) || "?";
      coinsByUni[u] = (coinsByUni[u] || 0) + 1;
    }
    const health = {
      status: !loop.state.loaded ? "loading" : (midsFresh && candlesFresh ? "ok" : "degraded"),
      coins: loop.state.order.length,
      coinsByUni: coinsByUni,
      universes: loop.state.universes,
      // Which tracked universes FIRE ALERTS (ALERT_UNIVERSES; additive).
      // Distinct from `universes` (tracked + served): viewing a universe
      // implies nothing about alerting, and serving the scope is what lets a
      // surface SAY so instead of implying it.
      alertUniverses: deps.alertUniverses || [],
      // Additive: tracked universes that alert for FAVORITED coins only
      // (ALERT_FAVS_UNIVERSES). Disjoint from alertUniverses by construction -
      // an id in both resolves to broadcast at parse time. A surface reading
      // only alertUniverses is unaffected; one that reads both can say
      // "alerts: xyz, favorites: perps" instead of implying it.
      alert_favs_universes: deps.alertFavsUniverses || [],
      // Opaque snapshot revision (additive): matches /api/state and
      // /api/bootstrap; resets on restart. A frozen revision across polls
      // means the loop has stopped mutating state.
      revision: loop.state.revision || 0,
      midsAgeMs: loop.state.lastMids ? now - loop.state.lastMids : null,
      candlesAgeMs: loop.state.lastCandles ? now - loop.state.lastCandles : null,
      // Additive (review F1): per-universe ages behind the fresh checks above.
      midsAgeMsByUni: midsAgeMsByUni,
      candlesAgeMsByUni: candlesAgeMsByUni,
      contextsAgeMs: loop.state.lastContexts ? now - loop.state.lastContexts : null,
      candleFetchFailures: loop.state.candleFailures,
      // Additive (demand cut): the mids tape feeds momentum AND rule evaluation,
      // and until this counter its failures were only stderr lines - the
      // same silence class as the webhook-delivery gap (P0 item 7).
      midsFetchFailures: loop.state.midsFailures || 0,
      // Additive: exchange request accounting by kind (candle/ctx/mids) and
      // outcome (ok/429/http/net), lifetime plus the last completed and the
      // in-progress clock minute (budget.js). The per-minute log line is
      // the measurement channel; this is the same picture for a probe.
      requests: loop.ledger ? loop.ledger.stats(now) : null,
      // Additive: the client-side request budget (A1) - current and
      // configured rate (weight/min), tokens, lane queue depths, 429 holds
      // and the mids polls the bucket could not cover at that instant.
      budget: loop.limiter ? loop.limiter.stats(now) : null,
      // Additive (demand cut): which universes get the 5-min volume
      // true-up. A misconfigured scope must be visible, not inferred.
      trueUpUniverses: loop.state.trueUpUniverses || loop.state.universes,
      // Additive: the WebSocket candle feed (null when CANDLE_FEED is off):
      // connection state, coverage, push/roll counters and the
      // reconciliation comparator - the stage-1 parity gate.
      candleFeed: loop.feedHealth ? loop.feedHealth(now) : null,
      // alertsFired counts alerts that FIRED. It says NOTHING about whether
      // they were delivered - `webhook` and `push` are the per-channel
      // delivery truth, and they can disagree (push is scoped to a token's
      // favs list, the webhook receives every alert).
      alertsFired: rules.alertsFired(),
      pushTokens: push.count(),
      push: push.stats(),
      webhook: deliverStats(),
      score_v: SCORE_V,
      // display_v mirrors /api/state so the DEPLOYED display-math stamp is
      // readable from the cheap endpoint. /api/state is ~2MB, which PowerShell
      // 5.1 silently returns as an empty object, so verifying a stamp after a
      // deploy used to need a node fetch of the whole payload.
      display_v: DISPLAY_V,
      telemetry: deps.telemetry ? deps.telemetry.stats() : null,
      // Additive: per-universe briefing snapshot identity + freshness, so the
      // cheap endpoint shows the same picture /api/briefing/health does.
      briefing: briefing.stats(now),
      // Additive: the continuity checkpoint ledger (null when
      // CONTINUITY_LEDGER is off, as candleFeed is null when its flag is).
      continuity_ledger: deps.continuity ? deps.continuity.health() : null,
      uptime: Math.round((now - startedAt) / 1000)
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(health));
    return;
  }

  const isBriefingRoute = url === "/api/briefing/latest.json"
    || url === "/api/briefing/latest.csv"
    || url === "/api/briefing/latest.compact.json"
    || url === "/api/briefing/latest.html"
    || url === "/api/briefing/health";
  if ((req.method === "GET" || req.method === "HEAD") && isBriefingRoute) {
    // Every briefing response carries a request id and lands in the log
    // with its status, snapshot id and duration - the line a consumer's
    // report is matched against. Low volume by construction (scheduled
    // tasks and manual probes), so unthrottled.
    const t0 = nowFn();
    const requestId = requestIdOf(req);
    const uni = (query && query.get("uni")) || DEFAULT_BRIEFING_UNIVERSE;
    const available = loop.state.universes || [];
    function done(status, snapshotId) {
      logFn("[briefing] request " + JSON.stringify({
        request_id: requestId, method: req.method, route: url, universe: uni,
        status: status, snapshot_id: snapshotId, ms: Math.max(0, nowFn() - t0)
      }));
    }
    if (available.indexOf(uni) < 0) {
      sendJson(req, res, {
        error: "universe is not tracked",
        requested_universe: uni,
        available_universes: available,
        request_id: requestId
      }, { status: 400, headers: { "Cache-Control": BRIEFING_CACHE_CONTROL, "X-Request-ID": requestId } });
      done(400, null);
      return;
    }
    // ONE clock reading and ONE view per response: headers, body and the
    // health document all derive from `view`, so they cannot disagree
    // (audit 2026-09-13 F2). The view always carries a serializable
    // snapshot - a synthetic unavailable one when no entry exists - so a
    // failing first build is a 503, never a thrown TypeError in the HTTP
    // listener (audit F1). The catch below is the last line: any fault in
    // this block becomes a logged 500 with the request id, not a crash.
    try {
      const view = briefing.view(uni, t0);
      const headers = briefingHeaders(view, requestId);
      if (url === "/api/briefing/health") {
        // 200 for ok AND degraded (the body says which), 503 only when no
        // usable snapshot exists - so a status-only probe still sees outages
        // while a body-reading one sees the gradient.
        const body = briefing.healthOf(view);
        body.request_id = requestId;
        const status = body.status === "unavailable" ? 503 : 200;
        sendJson(req, res, body, { status: status, headers: headers });
        done(status, body.snapshot_id);
        return;
      }
      const requireComplete = query && query.get("require_complete") === "1";
      const status = !view.usable ? 503 : (requireComplete && !view.snapshot.data_complete ? 503 : 200);
      if (url === "/api/briefing/latest.csv") {
        sendCsv(req, res, briefing.csv(view), briefingFilename(view.snapshot), {
          status: status,
          headers: headers
        });
      } else if (url === "/api/briefing/latest.compact.json") {
        sendJson(req, res, briefing.compact(view), { status: status, headers: headers });
      } else if (url === "/api/briefing/latest.html") {
        sendHtml(req, res, briefing.html(view), {
          status: status,
          // Script-free server-rendered document: the strictest CSP costs
          // nothing and pins the script-free property at the transport layer.
          headers: Object.assign({
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"
          }, headers)
        });
      } else {
        sendJson(req, res, briefing.canonical(view), { status: status, headers: headers });
      }
      done(status, view.served.snapshot_id);
    } catch (e) {
      const message = (e && e.message) || String(e);
      logFn("[briefing] request failed " + JSON.stringify({
        request_id: requestId, method: req.method, route: url, universe: uni, error: message
      }));
      if (!res.headersSent) {
        sendJson(req, res, { error: "briefing_route_failure", message: message, request_id: requestId },
          { status: 500, headers: { "Cache-Control": BRIEFING_CACHE_CONTROL, "X-Request-ID": requestId } });
      } else {
        try { res.end(); } catch (e2) { /* the socket is already gone */ }
      }
      done(500, null);
    }
    return;
  }

  if (req.method === "GET" && url === "/api/state") {
    const uni = query ? query.get("uni") : null;   // optional single-universe filter
    const build = function () {
      const payload = buildApiState(loop.state, config.ftfcTfs, uni);
      // Additive: which tracked universes fire alerts. Attached at the
      // route, not in buildApiState - alert scope is server environment
      // (ALERT_UNIVERSES), not loop state, and the builder stays a pure
      // serializer of the loop.
      payload.alertUniverses = deps.alertUniverses || [];
      payload.alert_favs_universes = deps.alertFavsUniverses || [];
      // Additive, ONLY when the ledger is enabled (absent otherwise, so the
      // flag-off payload is byte-identical): how far back
      // /api/continuity_at reaches and at what grain.
      if (deps.continuity) payload.continuity_ledger = deps.continuity.summary();
      return payload;
    };
    // Cache only the unfiltered view and KNOWN universes; an unknown ?uni
    // builds its (tiny, empty-coins) payload fresh and never claims a slot.
    const cacheable = !uni || (loop.state.universes || []).indexOf(uni) >= 0;
    if (cacheable) serveJsonCached(req, res, "state", uni || "all", build);
    else sendJson(req, res, build());
    return;
  }

  // One-shot candle bootstrap for the dashboard served at "/": raw closed +
  // forming bars per coin/TF from the loop's memory, so the browser seeds in
  // seconds instead of re-downloading Hyperliquid candles for minutes (and
  // each dashboard visitor stops burning exchange rate budget). Raw data
  // only - the dashboard still runs the canonical STRAT-CORE itself.
  if (req.method === "GET" && url === "/api/bootstrap") {
    const uni = query ? query.get("uni") : null;
    const cacheable = !uni || (loop.state.universes || []).indexOf(uni) >= 0;
    const build = function () { return buildBootstrap(loop.state, uni); };
    if (cacheable) serveJsonCached(req, res, "boot", uni || "all", build);
    else sendJson(req, res, build());
    return;
  }

  if (req.method === "POST" && (url === "/api/push/register" || url === "/api/push/unregister")) {
    readBody(req, BODY_LIMIT, function (r) {
      try {
        if (r.err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "request aborted" }));
          return;
        }
        if (r.tooLarge) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "body too large" }));
          return;
        }
        const key = req.headers["x-push-key"];
        const out = url === "/api/push/register"
          ? push.handleRegister(r.body, key)
          : push.handleUnregister(r.body, key);
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out.body));
      } catch (e) {
        // the socket may already be gone after a transport error
        log("push endpoint response failed: " + (e && e.message));
      }
    });
    return;
  }

  // Served continuity at past times (continuity ledger). No auth, decided
  // 2026-09-23: the answer is market-derived state this worker already
  // publishes live on /api/state, and the request carries no wallet. The
  // request DOES carry the caller's trade coins and times, so neither the
  // body nor any per-item coin/time is ever logged - only counts.
  if (req.method === "POST" && url === "/api/continuity_at") {
    const ledger = deps.continuity;
    const t0 = nowFn();
    function reply(status, obj) {
      sendJson(req, res, obj, { status: status });
      logFn("[continuity] request " + JSON.stringify({
        status: status, items: Array.isArray(obj) ? obj.length : 0,
        covered: Array.isArray(obj) ? obj.filter(function (r) { return r.covered; }).length : 0,
        ms: Math.max(0, nowFn() - t0)
      }));
    }
    if (!ledger) {
      // Answered before the body is read; Node discards the unread body.
      reply(503, { error: "continuity ledger disabled" });
      return;
    }
    readBody(req, BODY_LIMIT, function (r) {
      try {
        if (r.err) { reply(400, { error: "request aborted" }); return; }
        if (r.tooLarge) { reply(413, { error: "body too large" }); return; }
        let items;
        try { items = JSON.parse(r.body); } catch (e) {
          reply(400, { error: "malformed JSON" });
          return;
        }
        if (!Array.isArray(items)) { reply(400, { error: "body must be an array of {coin, t}" }); return; }
        if (items.length > CONTINUITY_MAX_ITEMS) {
          reply(400, { error: "at most " + CONTINUITY_MAX_ITEMS + " items per request" });
          return;
        }
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (!it || typeof it !== "object" || typeof it.coin !== "string" || !it.coin
              || typeof it.t !== "number" || !Number.isFinite(it.t)) {
            reply(400, { error: "item " + i + " must be {coin: string, t: finite ms}" });
            return;
          }
        }
        // A client that disconnects stops its queued work before the next
        // item (audit F6); nothing is written to a closed socket.
        let gone = false;
        res.on("close", function () { if (!res.writableFinished) gone = true; });
        ledger.continuityAt(items.map(function (it) { return { coin: it.coin, t: it.t }; }),
          { isCancelled: function () { return gone; } })
          .then(function (out) { reply(200, out); }, function (e) {
            const code = e && e.code;
            if (code === "cancelled" || gone) return;
            if (code === "busy" || code === "timeout") {
              // Overload is a 503 with a retry hint - the route's
              // unavailable status, not a server fault.
              sendJson(req, res, { error: code }, { status: 503, headers: { "Retry-After": "5" } });
              logFn("[continuity] request " + JSON.stringify({ status: 503, reason: code, ms: Math.max(0, nowFn() - t0) }));
              return;
            }
            logFn("[continuity] lookup failed: " + (e && e.message));
            reply(500, { error: "continuity lookup failed" });
          });
      } catch (e) {
        log("continuity endpoint response failed: " + (e && e.message));
      }
    });
    return;
  }

  const staticUrl = STATIC_ALIAS[url] || url;
  if (req.method === "GET" && STATIC[staticUrl]) {
    fs.readFile(path.join(PUBLIC_DIR, staticUrl.slice(1)), function (err, buf) {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": STATIC[staticUrl], "Cache-Control": "public, max-age=3600" });
      res.end(buf);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
  };
}

const server = http.createServer(createRequestHandler({
  loop: loop, rules: rules, push: push, config: config, telemetry: telemetry,
  alertUniverses: alertUniverses, alertFavsUniverses: alertFavsUniverses,
  briefing: briefing, continuity: continuity, log: log
}));

// Initial load happens AFTER the server is listening so /health responds
// immediately. Retries with a flat 30s backoff - process restarts are not
// needed for a transient API outage at boot.
function startLoop() {
  loop.start().catch(function (e) {
    log("loop start failed: " + (e && e.message) + " - retrying in 30s");
    setTimeout(startLoop, 30000);
  });
}

function shutdown(sig) {
  log("received " + sig + ", shutting down");
  telemetry.stop();
  briefing.stop();
  if (continuity) continuity.stop();
  loop.stop();
  try { rules.persistNow(); } catch (e) { log("final persist failed: " + (e && e.message)); }
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 2000).unref();
}

// Boot only when run as the entrypoint (node server.js). Requiring this module
// - e.g. from test/server_routes.test.js - yields the exports below WITHOUT
// binding a port or starting the loop.
if (require.main === module) {
  server.listen(PORT, HOST, function () {
    log("hip3-strat-scanner listening on http://" + HOST + ":" + PORT
      + (process.env.LOG_ONLY === "1" ? " (LOG_ONLY mode - alerts are logged, not sent)" : ""));
    startLoop();
    briefing.start();
    if (process.env.TELEMETRY_DISABLED !== "1") telemetry.start(loop.state);
    if (continuity) continuity.start();
  });
  process.on("SIGINT", function () { shutdown("SIGINT"); });
  process.on("SIGTERM", function () { shutdown("SIGTERM"); });
}

// Read-only view of the resolved alert / fetch scopes, for tests. It reports
// the true-up scope the LOOP actually received (not a re-derivation), which is
// what pins THE budget invariant: enabling a favorites universe must never
// widen the set of coins the 15m true-up fetches. Returns copies; nothing here
// is writable from outside.
function scopes() {
  return {
    alertUniverses: alertUniverses.slice(),
    alertFavsUniverses: alertFavsUniverses.slice(),
    trueUpUniverses: (loop.state.trueUpUniverses || []).slice()
  };
}

module.exports = {
  scopes: scopes,
  createRequestHandler: createRequestHandler,
  acceptsGzip: acceptsGzip,
  sendJson: sendJson,
  sendCsv: sendCsv,
  sendHtml: sendHtml
};
