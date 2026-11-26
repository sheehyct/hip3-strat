"use strict";

// Route-level content-negotiation tests for the shared JSON responder
// (server.js sendJson) as reached through /api/state and /api/bootstrap - not
// just as a pure serializer. Covers gzip accepted, gzip refused via q=0, the
// Vary: Accept-Encoding and Cache-Control: no-store headers, and round-trip
// equivalence of the gzipped and identity bodies. Plus exhaustive acceptsGzip
// unit cases. node builtins only: node --test
//
// Requiring server.js is side-effect-safe: it only boots (listen + loop) under
// require.main === module, so here we get the exports and inject a fake loop.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequestHandler, acceptsGzip } = require("../server.js");
const { createBriefingStore } = require("../src/briefing_store.js");
const { previousUsCashClose } = require("../src/briefing.js");
const { DISPLAY_V } = require("../src/apistate.js");

// --- acceptsGzip: qvalue-aware negotiation --------------------------------

test("acceptsGzip: literal gzip token (with or without other codings) accepts", function () {
  assert.strictEqual(acceptsGzip("gzip"), true);
  assert.strictEqual(acceptsGzip("gzip, deflate"), true);
  assert.strictEqual(acceptsGzip("deflate, gzip"), true);
  assert.strictEqual(acceptsGzip("GZIP"), true);              // case-insensitive
  assert.strictEqual(acceptsGzip("gzip;q=0.001"), true);
  assert.strictEqual(acceptsGzip("gzip;q=0.5"), true);
  assert.strictEqual(acceptsGzip("gzip;q=1"), true);
  assert.strictEqual(acceptsGzip("gzip;q=1.000"), true);
  assert.strictEqual(acceptsGzip("gzip; Q = 0.5"), true);
});

test("acceptsGzip: explicit q=0 opt-out is honored (the review nit)", function () {
  assert.strictEqual(acceptsGzip("gzip;q=0"), false);
  assert.strictEqual(acceptsGzip("gzip;q=0.0"), false);
  assert.strictEqual(acceptsGzip("gzip;q=0.000"), false);
  assert.strictEqual(acceptsGzip("gzip;q=0, identity;q=1"), false);
  assert.strictEqual(acceptsGzip("gzip; q=0"), false);        // OWS after ';'
  assert.strictEqual(acceptsGzip("br, gzip;q=0"), false);
});

test("acceptsGzip: absent / unrelated / wildcard codings do not enable gzip", function () {
  assert.strictEqual(acceptsGzip(undefined), false);
  assert.strictEqual(acceptsGzip(""), false);
  assert.strictEqual(acceptsGzip("identity"), false);
  assert.strictEqual(acceptsGzip("deflate"), false);
  assert.strictEqual(acceptsGzip("*"), false);                // conservative: literal gzip only
});

test("acceptsGzip: malformed literal-gzip members fail closed", function () {
  [
    "gzip;",
    "gzip;q=",
    "gzip;q=.5",
    "gzip;q=00.5",
    "gzip;q=0 .5",
    "gzip;q=0.1234",
    "gzip;q=0.5junk",
    "gzip;q=1.001",
    "gzip;q=1.0000",
    "gzip;q=2",
    "gzip;q=-0.5",
    "gzip;q=NaN",
    "gzip;q=0.5;q=0.2",
    "gzip;level=9"
  ].forEach(function (header) {
    assert.strictEqual(acceptsGzip(header), false, header);
  });
});

// --- Route-level negotiation on /api/state and /api/bootstrap -------------

// A fake loop.state minimal enough that the real buildApiState/buildBootstrap
// run without throwing: mid drives momentum's early-out guard, hist:[] guards
// its history scan, empty tf makes every metric return its null branch.
function makeHandler(alertUniverses) {
  const state = {
    order: ["FOO"],
    loaded: true,
    universes: ["xyz"],
    coins: { FOO: { name: "FOO", sym: "FOO", uni: "xyz", mid: 100, hist: [], ctx: {}, tf: {} } }
  };
  return createRequestHandler({
    loop: { state: state },
    rules: { alertsFired: function () { return 0; } },
    push: { count: function () { return 0; }, stats: function () { return {}; } },
    config: { ftfcTfs: ["15m", "1h", "4h", "1d"] },
    alertUniverses: alertUniverses
  });
}

// --- Alert scope: served in /health and /api/state (additive) --------------

test("/health and /api/state serve alertUniverses when the dep is wired", function () {
  const handler = makeHandler(["xyz"]);
  const h = get(handler, "/health");
  assert.strictEqual(h.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(h.body).alertUniverses, ["xyz"]);
  const s = get(handler, "/api/state");
  assert.strictEqual(s.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(s.body).alertUniverses, ["xyz"]);
});

test("alertUniverses defaults to [] when the dep is absent (never fabricated)", function () {
  const handler = makeHandler();
  assert.deepStrictEqual(JSON.parse(get(handler, "/health").body).alertUniverses, []);
  assert.deepStrictEqual(JSON.parse(get(handler, "/api/state").body).alertUniverses, []);
});

// --- Revision-keyed serialization cache (code review) -------------
// The bytes are built once per (endpoint, universe) per loop revision. The
// tests freeze the injected clock so the 30s honesty bucket can never flip
// mid-test, then prove caching by mutating state WITHOUT bumping the
// revision (masked) and WITH a bump (rebuilt).

function makeCacheHandler() {
  const state = {
    order: ["FOO"], loaded: true, universes: ["xyz"], revision: 1,
    coins: { FOO: { name: "FOO", sym: "FOO", uni: "xyz", mid: 100, hist: [], ctx: {}, tf: {} } }
  };
  const handler = createRequestHandler({
    loop: { state: state },
    rules: { alertsFired: function () { return 0; } },
    push: { count: function () { return 0; }, stats: function () { return {}; } },
    config: { ftfcTfs: ["15m", "1h", "4h", "1d"] },
    now: function () { return 123456789; }
  });
  return { handler: handler, state: state };
}

function addCoin(state, name) {
  state.coins[name] = { name: name, sym: name, uni: "xyz", mid: 1, hist: [], ctx: {}, tf: {} };
  state.order.push(name);
}

test("/api/state cache: same revision serves cached bytes; a bump rebuilds", function () {
  const h = makeCacheHandler();
  assert.strictEqual(JSON.parse(get(h.handler, "/api/state").body).coins.length, 1);
  addCoin(h.state, "BAR");                    // mutate WITHOUT bumping the revision
  assert.strictEqual(JSON.parse(get(h.handler, "/api/state").body).coins.length, 1,
    "unchanged revision -> the cache masks the mutation");
  h.state.revision++;
  assert.strictEqual(JSON.parse(get(h.handler, "/api/state").body).coins.length, 2,
    "revision bump -> rebuilt payload");
});

test("/api/state cache: gzip and identity serve the SAME cached generation", function () {
  const h = makeCacheHandler();
  const idBody = get(h.handler, "/api/state").body;
  const gz = get(h.handler, "/api/state", "gzip");
  assert.strictEqual(gz.headers["Content-Encoding"], "gzip");
  assert.strictEqual(zlib.gunzipSync(gz.body).toString("utf8"), idBody);
  addCoin(h.state, "X");                      // no bump: both variants stay put
  assert.strictEqual(get(h.handler, "/api/state").body, idBody);
  assert.strictEqual(zlib.gunzipSync(get(h.handler, "/api/state", "gzip").body).toString("utf8"), idBody);
});

// The two tests below observe the compressor DIRECTLY: t.mock.method wraps
// zlib.gzipSync in place (server.js resolves the property at call time on the
// same module object), counting calls while delegating to the real
// implementation - so the served bytes are still genuine gzip and the gunzip
// round-trips remain meaningful. The wrapper is restored when each test ends.

test("/api/state cache: two gzip requests at one revision compress ONCE", function (t) {
  const h = makeCacheHandler();
  const gzipSpy = t.mock.method(zlib, "gzipSync");
  const first = get(h.handler, "/api/state", "gzip");
  const second = get(h.handler, "/api/state", "gzip");
  assert.strictEqual(gzipSpy.mock.callCount(), 1,
    "second gzip request reused the memoized bytes");
  // The identity request rides the same cached generation - it must not
  // trigger a rebuild (which would recompress) just to serve the JSON string.
  const idBody = get(h.handler, "/api/state", "gzip;q=0").body;
  assert.strictEqual(gzipSpy.mock.callCount(), 1, "identity serve did not recompress");
  assert.strictEqual(zlib.gunzipSync(first.body).toString("utf8"), idBody,
    "served gzip bytes gunzip to exactly the identity body");
  assert.strictEqual(zlib.gunzipSync(second.body).toString("utf8"), idBody);
});

test("/api/state cache: a revision bump produces freshly compressed bytes", function (t) {
  const h = makeCacheHandler();
  assert.strictEqual(decode(get(h.handler, "/api/state", "gzip")).coins.length, 1);
  addCoin(h.state, "BAR");
  h.state.revision++;
  const gzipSpy = t.mock.method(zlib, "gzipSync");
  const rebuilt = get(h.handler, "/api/state", "gzip");
  assert.strictEqual(gzipSpy.mock.callCount(), 1, "bump forced one fresh compression");
  const payload = JSON.parse(zlib.gunzipSync(rebuilt.body).toString("utf8"));
  assert.strictEqual(payload.coins.length, 2, "no stale cache serve after the bump");
  assert.strictEqual(payload.revision, 2);
});

test("unknown ?uni is never cached (public endpoint, bounded map)", function () {
  const h = makeCacheHandler();
  assert.strictEqual(JSON.parse(get(h.handler, "/api/state?uni=junk").body).coins.length, 0);
  h.state.coins.FOO.uni = "junk";             // no revision bump on purpose
  assert.strictEqual(JSON.parse(get(h.handler, "/api/state?uni=junk").body).coins.length, 1,
    "reflects the mutation immediately - a junk uni claimed no cache slot");
});

// --- Security headers (code review) --------------------------------

test("every route gets nosniff + no-referrer via the writeHead wrapper", function () {
  const handler = makeHandler();
  ["/api/state", "/health", "/api/bootstrap", "/nope-404"].forEach(function (url) {
    const r = get(handler, url);
    assert.strictEqual(r.headers["X-Content-Type-Options"], "nosniff", url);
    assert.strictEqual(r.headers["Referrer-Policy"], "no-referrer", url);
  });
});

test("the dashboard ships a hash-based CSP that matches its inline script", async function () {
  const handler = makeHandler();
  const dash = await new Promise(function (resolve) {
    const res = fakeRes();
    const origEnd = res.end.bind(res);
    res.end = function (chunk) { origEnd(chunk); resolve(res); };
    handler({ method: "GET", url: "/", headers: {} }, res);
  });
  assert.strictEqual(dash.statusCode, 200);
  const csp = dash.headers["Content-Security-Policy"];
  assert.ok(csp, "CSP header present");
  assert.ok(csp.indexOf("script-src 'sha256-") >= 0, "hash-based script-src: " + csp);
  assert.ok(csp.indexOf("frame-ancestors 'none'") >= 0);
  assert.ok(csp.indexOf("connect-src 'self' https://api.hyperliquid.xyz") >= 0,
    "the ?standalone=1 rollback pipeline must stay able to reach the exchange");
  assert.ok(csp.indexOf("worker-src 'self'") >= 0, "PWA service worker allowed");
  // The digest must match the ACTUAL inline script byte-for-byte, or the
  // deployed dashboard would render as a dead page with its script blocked.
  const html = fs.readFileSync(path.join(__dirname, "..", "hip3_strat_screener.html"), "utf8");
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  const want = "sha256-" + crypto.createHash("sha256").update(m[1], "utf8").digest("base64");
  assert.ok(csp.indexOf("'" + want + "'") >= 0, "CSP digest matches the served script");
});

test("/api/bootstrap rides the same cache; /health serves the revision uncached", function () {
  const h = makeCacheHandler();
  assert.strictEqual(JSON.parse(get(h.handler, "/api/bootstrap").body).revision, 1);
  addCoin(h.state, "BAR");
  assert.strictEqual(JSON.parse(get(h.handler, "/api/bootstrap").body).coins.length, 1, "cached");
  h.state.revision++;
  assert.strictEqual(JSON.parse(get(h.handler, "/api/bootstrap").body).coins.length, 2, "rebuilt");
  assert.strictEqual(JSON.parse(get(h.handler, "/health").body).revision, 2,
    "/health always reads the live revision");
});

function makeBriefingHandler(options) {
  options = options || {};
  const now = Date.now();
  const close = previousUsCashClose(now);
  const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const hourly = [];
  for (let i = 30; i > 0; i--) {
    const T = close.target_ms - (i - 1) * 3600000 - 1;
    hourly.push({ t: T - 3599999, T: T, o: 99, h: 101, l: 98, c: 100, v: 1 });
  }
  const state = {
    order: options.empty ? [] : ["xyz:FOO"],
    loaded: true,
    universes: ["xyz"],
    expectedMarketsByUni: { xyz: ["xyz:FOO"] },
    lastMids: options.stale ? now - 901000 : now - 1000,
    lastCandles: options.stale ? now - 901000 : now - 2000,
    lastContexts: options.stale ? now - 901000 : now - 3000,
    coins: options.empty ? {} : {
      "xyz:FOO": {
        name: "xyz:FOO", sym: "FOO", uni: "xyz", mid: 105, hist: [],
        ctx: { markPx: "105", prevDayPx: "102", dayNtlVlm: "1000" },
        tf: {
          "1h": {
            closed: hourly.slice(-30), referenceClosed: hourly,
            forming: { t: now - 1800000, T: now + 1800000, o: 104, h: 106, l: 103, c: 105, v: 1 },
            an: { types: ["2D", "1", "2U"], formingType: "2U", formingDir: "up",
                  completed: null, setups: [], invalidated: false, live: [] }
          },
          "1d": {
            closed: [{ t: dayStart - 86400000, T: dayStart - 1, o: 99, h: 104, l: 98, c: 103, v: 1 }],
            forming: { t: dayStart, T: dayStart + 86400000 - 1, o: 103, h: 106, l: 102, c: 105, v: 1 },
            an: { types: ["2U"], formingType: "2U", formingDir: "up",
                  completed: null, setups: [], invalidated: false, live: [] }
          }
        }
      }
    }
  };
  return createRequestHandler({
    loop: { state: state },
    rules: { alertsFired: function () { return 0; } },
    push: { count: function () { return 0; }, stats: function () { return {}; } },
    config: { ftfcTfs: ["1h"] },
    now: options.now,
    log: options.log
  });
}

function fakeRes() {
  return {
    statusCode: null, headers: null, body: null, ended: false,
    writeHead: function (status, headers) { this.statusCode = status; this.headers = headers; return this; },
    end: function (chunk) { this.body = chunk; this.ended = true; return this; }
  };
}

// The /api/state and /api/bootstrap paths are fully synchronous (buildApiState,
// JSON.stringify, gzipSync are all sync), so res is populated when get returns.
function get(handler, url, acceptEncoding) {
  const headers = {};
  if (acceptEncoding !== undefined) headers["accept-encoding"] = acceptEncoding;
  const res = fakeRes();
  handler({ method: "GET", url: url, headers: headers }, res);
  return res;
}

function decodedText(res) {
  const buf = Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.body), "utf8");
  const raw = res.headers["Content-Encoding"] === "gzip" ? zlib.gunzipSync(buf) : buf;
  return raw.toString("utf8");
}

function decode(res) {
  return JSON.parse(decodedText(res));
}

test("real HTTP socket returns identity for a malformed gzip qvalue", async function (t) {
  const server = http.createServer(makeHandler());
  await new Promise(function (resolve, reject) {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(function () {
    return new Promise(function (resolve) { server.close(resolve); });
  });

  const response = await new Promise(function (resolve, reject) {
    const req = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      path: "/api/state",
      headers: { "Accept-Encoding": "gzip;q=0.5junk" }
    }, function (res) {
      const chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    req.end();
  });

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.headers["content-encoding"], undefined);
  assert.strictEqual(response.headers.vary, "Accept-Encoding");
  assert.strictEqual(JSON.parse(response.body.toString("utf8")).loaded, true);
});

["/api/state", "/api/bootstrap"].forEach(function (route) {
  test(route + ": gzip client gets a gzipped body with correct headers", function () {
    const res = get(makeHandler(), route, "gzip, deflate");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["Content-Encoding"], "gzip");
    assert.strictEqual(res.headers["Vary"], "Accept-Encoding");
    assert.strictEqual(res.headers["Cache-Control"], "no-store");
    assert.strictEqual(res.headers["Access-Control-Allow-Origin"], "*");
    assert.ok(Buffer.isBuffer(res.body), "gzip body is a Buffer");
    const obj = decode(res);
    assert.strictEqual(obj.loaded, true);
    assert.ok(Array.isArray(obj.coins) && obj.coins.length === 1);
  });

  test(route + ": gzip;q=0 opt-out gets identity, still with Vary + no-store", function () {
    const res = get(makeHandler(), route, "gzip;q=0, identity");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["Content-Encoding"], undefined);
    assert.strictEqual(res.headers["Vary"], "Accept-Encoding");
    assert.strictEqual(res.headers["Cache-Control"], "no-store");
    assert.strictEqual(typeof res.body, "string", "identity body is a raw JSON string");
    assert.strictEqual(decode(res).loaded, true);
  });

  test(route + ": malformed gzip qvalue gets identity", function () {
    const res = get(makeHandler(), route, "gzip;q=0.5junk");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers["Content-Encoding"], undefined);
    assert.strictEqual(res.headers["Vary"], "Accept-Encoding");
    assert.strictEqual(typeof res.body, "string");
    assert.strictEqual(decode(res).loaded, true);
  });

  test(route + ": no Accept-Encoding gets identity", function () {
    const res = get(makeHandler(), route, undefined);
    assert.strictEqual(res.headers["Content-Encoding"], undefined);
    assert.strictEqual(typeof res.body, "string");
  });

  test(route + ": gzipped and identity bodies decode to the same payload", function () {
    const gz = decode(get(makeHandler(), route, "gzip"));
    const id = decode(get(makeHandler(), route, "gzip;q=0"));
    // ts is Date.now()-stamped per call; compare everything else.
    delete gz.ts; delete id.ts;
    assert.deepStrictEqual(gz, id);
  });
});

test("briefing JSON and CSV routes share normalized metadata and rows", function () {
  const handler = makeBriefingHandler();
  const jsonRes = get(handler, "/api/briefing/latest.json?uni=xyz", "gzip;q=0");
  assert.strictEqual(jsonRes.statusCode, 200);
  assert.strictEqual(jsonRes.headers["Content-Type"], "application/json; charset=utf-8");
  assert.strictEqual(jsonRes.headers["Cache-Control"], "no-store, no-cache, must-revalidate");
  assert.strictEqual(jsonRes.headers["Access-Control-Allow-Origin"], "*");
  assert.strictEqual(jsonRes.headers["X-Universe"], "xyz");
  assert.strictEqual(jsonRes.headers["X-Data-Complete"], "true");
  const snapshot = decode(jsonRes);
  assert.strictEqual(snapshot.schema_version, "1.0");
  assert.strictEqual(snapshot.row_count, 1);
  assert.strictEqual(snapshot.row_count, snapshot.rows.length);
  assert.strictEqual(new Set(snapshot.rows.map(function (row) { return row.symbol; })).size, snapshot.row_count);
  assert.strictEqual(snapshot.rows[0].symbol, "FOO");
  assert.strictEqual(snapshot.score_policy, "experimental_low_weight");
  assert.ok(snapshot.session_definitions.utc_session_change_pct.includes("00:00 UTC"));

  const csvRes = get(handler, "/api/briefing/latest.csv?uni=xyz", "gzip;q=0");
  assert.strictEqual(csvRes.statusCode, 200);
  assert.strictEqual(csvRes.headers["Content-Type"], "text/csv; charset=utf-8");
  assert.ok(csvRes.headers["Content-Disposition"].includes("hip3_briefing_xyz_"));
  assert.strictEqual(csvRes.headers["X-Generated-At"].length > 0, true);
  const csv = String(csvRes.body);
  const csvLines = csv.split("\n");
  const csvHeader = csvLines[0].split(",");
  const csvValues = csvLines[1].split(",");
  const csvRecord = {};
  csvHeader.forEach(function (field, index) { csvRecord[field] = csvValues[index]; });
  assert.strictEqual(csvHeader.length, 49);
  assert.strictEqual(csvRecord.symbol, snapshot.rows[0].symbol);
  assert.strictEqual(Number(csvRecord.last), snapshot.rows[0].last);
  assert.strictEqual(csvRecord["1d_seq"], snapshot.rows[0]["1d_seq"]);
  assert.deepStrictEqual(
    new Set([csvRecord.symbol]),
    new Set(snapshot.rows.map(function (row) { return row.symbol; }))
  );
  assert.strictEqual(jsonRes.headers["Set-Cookie"], undefined);
  assert.strictEqual(jsonRes.headers["WWW-Authenticate"], undefined);
});

test("compact briefing JSON preserves every symbol and selected canonical value", function () {
  const handler = makeBriefingHandler();
  const canonicalRes = get(handler, "/api/briefing/latest.json", "gzip;q=0");
  const compactRes = get(handler, "/api/briefing/latest.compact.json", "gzip;q=0");
  assert.strictEqual(compactRes.statusCode, 200);
  assert.strictEqual(compactRes.headers["Content-Type"], "application/json; charset=utf-8");
  assert.strictEqual(compactRes.headers["Cache-Control"], "no-store, no-cache, must-revalidate");
  assert.strictEqual(compactRes.headers["Access-Control-Allow-Origin"], "*");
  assert.strictEqual(compactRes.headers["Set-Cookie"], undefined);
  assert.strictEqual(compactRes.headers["WWW-Authenticate"], undefined);

  const canonical = decode(canonicalRes);
  const compact = decode(compactRes);
  assert.strictEqual(compact.format, "briefing_compact_v1");
  assert.strictEqual(compact.row_encoding, "array");
  assert.strictEqual(compact.row_count, compact.rows.length);
  assert.strictEqual(compact.row_count, canonical.row_count);
  assert.ok(Array.isArray(compact.row_fields));
  const symbolIndex = compact.row_fields.indexOf("symbol");
  const lastIndex = compact.row_fields.indexOf("last");
  assert.ok(symbolIndex >= 0);
  assert.ok(lastIndex >= 0);
  assert.deepStrictEqual(
    new Set(compact.rows.map(function (row) { return row[symbolIndex]; })),
    new Set(canonical.rows.map(function (row) { return row.symbol; }))
  );
  assert.strictEqual(compact.rows[0][lastIndex], canonical.rows[0].last);
  assert.strictEqual(compact.data_as_of_utc, canonical.data_as_of_utc);
  assert.strictEqual(compact.data_complete, canonical.data_complete);
});

test("HTML briefing compatibility route is public, script-free, and gzip-safe", function () {
  const handler = makeBriefingHandler();
  const identityRes = get(handler, "/api/briefing/latest.html", "gzip;q=0");
  assert.strictEqual(identityRes.statusCode, 200);
  assert.strictEqual(identityRes.headers["Content-Type"], "text/html; charset=utf-8");
  assert.strictEqual(identityRes.headers["Cache-Control"], "no-store, no-cache, must-revalidate");
  assert.strictEqual(identityRes.headers["Access-Control-Allow-Origin"], "*");
  assert.strictEqual(identityRes.headers["Set-Cookie"], undefined);
  assert.strictEqual(identityRes.headers["WWW-Authenticate"], undefined);
  const identity = decodedText(identityRes);
  assert.match(identity, /^<!doctype html>/);
  assert.doesNotMatch(identity, /<script/i);
  assert.match(identity, /data_as_of_utc/);
  assert.match(identity, /\bFOO\t105\t/);

  const gzipRes = get(handler, "/api/briefing/latest.html", "gzip");
  assert.strictEqual(gzipRes.headers["Content-Encoding"], "gzip");
  // generated_at_utc is now materialization time (same entry -> same value);
  // served_at_utc and age_seconds are per-request, so they are the fields
  // scrubbed before the gzip and identity bodies are compared.
  const scrubGeneratedAt = function (html) {
    return html
      .replace(/(<dt>generated_at_utc<\/dt><dd>)[^<]+/, "$1[request-time]")
      .replace(/(<dt>served_at_utc<\/dt><dd>)[^<]+/, "$1[request-time]")
      .replace(/(<dt>age_seconds<\/dt><dd>)[^<]+/, "$1[request-time]");
  };
  assert.strictEqual(scrubGeneratedAt(decodedText(gzipRes)), scrubGeneratedAt(identity));
});

test("stale briefing remains HTTP 200 by default and is labeled stale", function () {
  const res = get(makeBriefingHandler({ stale: true }),
    "/api/briefing/latest.json?uni=xyz", "gzip;q=0");
  assert.strictEqual(res.statusCode, 200);
  const snapshot = decode(res);
  assert.strictEqual(snapshot.row_count, 1);
  assert.strictEqual(snapshot.is_stale, true);
  assert.strictEqual(snapshot.data_complete, false);
});

test("stale compact and HTML briefing views remain HTTP 200 and disclose staleness", function () {
  const handler = makeBriefingHandler({ stale: true });
  const compactRes = get(handler, "/api/briefing/latest.compact.json", "gzip;q=0");
  assert.strictEqual(compactRes.statusCode, 200);
  assert.strictEqual(decode(compactRes).is_stale, true);

  const htmlRes = get(handler, "/api/briefing/latest.html", "gzip;q=0");
  assert.strictEqual(htmlRes.statusCode, 200);
  assert.match(decodedText(htmlRes), /<dt>is_stale<\/dt><dd>true<\/dd>/);
});

test("briefing strict mode returns 503 with a diagnostic snapshot when stale", function () {
  const res = get(makeBriefingHandler({ stale: true }),
    "/api/briefing/latest.json?uni=xyz&require_complete=1", "gzip;q=0");
  assert.strictEqual(res.statusCode, 503);
  const snapshot = decode(res);
  assert.strictEqual(snapshot.data_complete, false);
  assert.ok(snapshot.issues.includes("mids_stale_or_missing"));
});

test("no-snapshot briefing state returns machine-readable JSON 503", function () {
  const res = get(makeBriefingHandler({ empty: true }),
    "/api/briefing/latest.json", "gzip;q=0");
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.headers["Content-Type"], "application/json; charset=utf-8");
  const snapshot = decode(res);
  assert.strictEqual(snapshot.row_count, 0);
  assert.deepStrictEqual(snapshot.rows, []);
  assert.strictEqual(snapshot.data_complete, false);
  assert.strictEqual(snapshot.is_stale, true);
  assert.strictEqual(snapshot.error.code, "snapshot_unavailable");
  assert.ok(snapshot.warnings.includes("No completed scanner snapshot is currently available"));
});

test("no-snapshot compact and HTML briefing views return explicit HTTP 503 bodies", function () {
  const handler = makeBriefingHandler({ empty: true });
  const compactRes = get(handler, "/api/briefing/latest.compact.json", "gzip;q=0");
  assert.strictEqual(compactRes.statusCode, 503);
  const compact = decode(compactRes);
  assert.strictEqual(compact.row_count, 0);
  assert.deepStrictEqual(compact.rows, []);
  assert.strictEqual(compact.error.code, "snapshot_unavailable");

  const htmlRes = get(handler, "/api/briefing/latest.html", "gzip;q=0");
  assert.strictEqual(htmlRes.statusCode, 503);
  assert.strictEqual(htmlRes.headers["Content-Type"], "text/html; charset=utf-8");
  const html = decodedText(htmlRes);
  assert.match(html, /snapshot_unavailable/);
  assert.match(html, /No completed scanner snapshot is currently available/);
});

test("briefing route rejects an untracked universe", function () {
  const res = get(makeBriefingHandler(), "/api/briefing/latest.json?uni=perps", "gzip;q=0");
  assert.strictEqual(res.statusCode, 400);
  const body = decode(res);
  assert.strictEqual(body.requested_universe, "perps");
  assert.deepStrictEqual(body.available_universes, ["xyz"]);
});

// Review 2026-07-25 F1: the global mids/candles timestamps advance when ANY
// universe succeeds, so /health used to stay "ok" while one universe's mids
// were frozen. Freshness is now judged per tracked universe.
test("/health: a healthy universe cannot mask a stale one", function () {
  const now = Date.now();
  function healthHandler(midsByUni, candlesByUni) {
    return createRequestHandler({
      loop: { state: {
        order: [], loaded: true, universes: ["xyz", "perps"],
        lastMids: now - 1000, lastCandles: now - 2000,
        lastMidsByUni: midsByUni, lastCandlesByUni: candlesByUni,
        coins: {}
      } },
      rules: { alertsFired: function () { return 0; } },
      push: { count: function () { return 0; }, stats: function () { return {}; } },
      config: { ftfcTfs: ["1h"] }
    });
  }
  const freshCandles = { xyz: now - 60000, perps: now - 60000 };
  // both universes fresh -> ok, per-universe ages served additively
  let body = JSON.parse(get(healthHandler(
    { xyz: now - 4000, perps: now - 4000 }, freshCandles), "/health").body);
  assert.strictEqual(body.status, "ok");
  assert.ok(body.midsAgeMsByUni.xyz >= 4000);
  assert.ok(body.candlesAgeMsByUni.perps >= 60000);
  // perps mids frozen 5 min while xyz stays fresh -> degraded (was ok pre-fix,
  // because the GLOBAL lastMids kept advancing on xyz successes)
  body = JSON.parse(get(healthHandler(
    { xyz: now - 4000, perps: now - 300000 }, freshCandles), "/health").body);
  assert.strictEqual(body.status, "degraded");
  assert.ok(body.midsAgeMsByUni.perps >= 300000);
  // a universe that never delivered candles -> degraded with an honest null age
  body = JSON.parse(get(healthHandler(
    { xyz: now - 4000, perps: now - 4000 }, { xyz: now - 60000 }), "/health").body);
  assert.strictEqual(body.status, "degraded");
  assert.strictEqual(body.candlesAgeMsByUni.perps, null);
  // display_v rides beside score_v so the deployed display-math stamp can be
  // read WITHOUT /api/state, whose ~2MB body PowerShell 5.1 silently empties.
  // Must equal what /api/state serves - two stamps that can disagree would be
  // worse than one, since the cheap probe is the one a deploy check reads.
  assert.strictEqual(body.display_v, DISPLAY_V);
  assert.match(body.display_v, /^[0-9a-f]{16}$/);
});

// --- Materialized briefing snapshots at the route level (briefing_store) ----
// One identified snapshot per universe behind all five briefing routes; HEAD
// honored; request ids echoed and logged; serve-time staleness visible from
// the routes under an injected clock.

function request(handler, method, url, headers) {
  const res = fakeRes();
  handler({ method: method, url: url, headers: headers || {} }, res);
  return res;
}

const BRIEFING_ROUTES = [
  "/api/briefing/latest.html", "/api/briefing/latest.json",
  "/api/briefing/latest.compact.json", "/api/briefing/latest.csv", "/api/briefing/health"
];

test("briefing: all five routes serve ONE snapshot id, in headers and bodies", function () {
  const handler = makeBriefingHandler();
  const responses = {};
  BRIEFING_ROUTES.forEach(function (route) {
    responses[route] = get(handler, route + "?uni=xyz", "gzip;q=0");
  });
  const id = responses["/api/briefing/latest.html"].headers["X-Snapshot-ID"];
  assert.match(id, /^[0-9a-f]{8}-\d{7}$/);
  BRIEFING_ROUTES.forEach(function (route) {
    const res = responses[route];
    assert.strictEqual(res.statusCode, 200, route);
    assert.strictEqual(res.headers["X-Snapshot-ID"], id, route + " header id");
    assert.strictEqual(res.headers["Cache-Control"], "no-store, no-cache, must-revalidate", route);
    assert.strictEqual(res.headers["X-Producer-Status"], "ok", route);
    assert.strictEqual(res.headers["X-Is-Stale"], "false", route);
    assert.match(res.headers["X-Age-Seconds"], /^\d+$/, route);
    assert.match(res.headers["X-Request-ID"], /^local-[0-9a-f]{12}$/, route);
    assert.match(res.headers["Access-Control-Expose-Headers"], /X-Snapshot-ID.*X-Request-ID/, route);
  });
  assert.strictEqual(decode(responses["/api/briefing/latest.json"]).snapshot_id, id);
  assert.strictEqual(decode(responses["/api/briefing/latest.compact.json"]).snapshot_id, id);
  assert.strictEqual(decode(responses["/api/briefing/health"]).snapshot_id, id);
  assert.match(decodedText(responses["/api/briefing/latest.html"]),
    new RegExp("<dt>snapshot_id</dt><dd>" + id + "</dd>"));
  // Pre-existing header names are untouched.
  ["X-Generated-At", "X-Data-As-Of", "X-Row-Count", "X-Expected-Row-Count",
    "X-Universe", "X-Data-Complete", "X-Score-Policy"].forEach(function (name) {
    assert.ok(responses["/api/briefing/latest.csv"].headers[name], name);
  });
  // generated_at is materialization time and therefore identical across the
  // representations of one snapshot (it used to be request time).
  assert.strictEqual(decode(responses["/api/briefing/latest.json"]).generated_at_utc,
    decode(responses["/api/briefing/latest.compact.json"]).generated_at_utc);
});

test("briefing health: ok / degraded / unavailable derive from the snapshot, with lightweight bodies", function () {
  let res = get(makeBriefingHandler(), "/api/briefing/health?uni=xyz", "gzip;q=0");
  assert.strictEqual(res.statusCode, 200);
  let body = decode(res);
  assert.strictEqual(body.status, "ok");
  assert.strictEqual(body.universe, "xyz");
  assert.strictEqual(body.schema_version, "1.0");
  assert.strictEqual(body.format, "briefing_compact_v1");
  assert.strictEqual(body.row_count, 1);
  assert.strictEqual(body.expected_row_count, 1);
  assert.strictEqual(body.data_complete, true);
  assert.strictEqual(body.is_stale, false);
  assert.deepStrictEqual(body.warnings, []);
  assert.deepStrictEqual(body.missing_symbols, []);
  assert.strictEqual(body.producer_status, "ok");
  assert.strictEqual(typeof body.age_seconds, "number");
  assert.strictEqual(body.rows, undefined, "no market rows");
  assert.match(body.request_id, /^local-/);
  assert.ok(body.producer && body.producer.boot_id);

  res = get(makeBriefingHandler({ stale: true }), "/api/briefing/health", "gzip;q=0");
  assert.strictEqual(res.statusCode, 200, "degraded is still 200 - the body says which");
  body = decode(res);
  assert.strictEqual(body.status, "degraded");
  assert.strictEqual(body.is_stale, true);
  assert.strictEqual(body.data_complete, false);
  assert.ok(body.issues.includes("mids_stale_or_missing"));

  res = get(makeBriefingHandler({ empty: true }), "/api/briefing/health", "gzip;q=0");
  assert.strictEqual(res.statusCode, 503);
  body = decode(res);
  assert.strictEqual(body.status, "unavailable");
  assert.strictEqual(body.row_count, 0);
  assert.notStrictEqual(res.headers["X-Snapshot-ID"], "none",
    "an unusable snapshot still has an id - it is a real materialization of an empty state");
});

test("briefing: HEAD returns the GET status and headers with no body (was 404)", function () {
  const handler = makeBriefingHandler();
  const ids = new Set();
  BRIEFING_ROUTES.forEach(function (route) {
    const head = request(handler, "HEAD", route + "?uni=xyz", { "accept-encoding": "gzip" });
    assert.strictEqual(head.statusCode, 200, route);
    assert.strictEqual(head.body, undefined, route + " carries no body");
    assert.strictEqual(head.headers["Content-Encoding"], "gzip", route + " advertises the coding a GET would use");
    assert.ok(head.headers["X-Snapshot-ID"], route);
    ids.add(head.headers["X-Snapshot-ID"]);
  });
  assert.strictEqual(ids.size, 1);
  const unavailable = request(makeBriefingHandler({ empty: true }), "HEAD", "/api/briefing/latest.html");
  assert.strictEqual(unavailable.statusCode, 503);
  assert.strictEqual(unavailable.body, undefined);
  const health = request(handler, "HEAD", "/health");
  assert.strictEqual(health.statusCode, 200);
  assert.strictEqual(health.body, undefined);
});

test("briefing: the edge request id is echoed when well-formed, replaced otherwise, and logged", function () {
  const lines = [];
  const handler = makeBriefingHandler({ log: function (l) { lines.push(l); } });
  let res = request(handler, "GET", "/api/briefing/latest.html?uni=xyz",
    { "x-railway-request-id": "7jyq-yY4SemsSt3snPRhug" });
  assert.strictEqual(res.headers["X-Request-ID"], "7jyq-yY4SemsSt3snPRhug");
  res = request(handler, "GET", "/api/briefing/latest.json", { "x-request-id": "abc_123-XYZ" });
  assert.strictEqual(res.headers["X-Request-ID"], "abc_123-XYZ", "generic x-request-id is honored too");
  res = request(handler, "GET", "/api/briefing/latest.json", { "x-railway-request-id": "bad value\r\nX-Injected: 1" });
  assert.match(res.headers["X-Request-ID"], /^local-[0-9a-f]{12}$/, "non-token inbound ids are never echoed");
  res = request(handler, "GET", "/api/briefing/latest.json?uni=nope", { "x-railway-request-id": "req-400" });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.headers["X-Request-ID"], "req-400");
  assert.strictEqual(res.headers["Cache-Control"], "no-store, no-cache, must-revalidate");
  assert.strictEqual(decode(res).request_id, "req-400");

  const prefix = "[briefing] request ";
  const reqLines = lines.filter(function (l) { return l.indexOf(prefix) === 0; })
    .map(function (l) { return JSON.parse(l.slice(prefix.length)); });
  assert.strictEqual(reqLines.length, 4);
  assert.strictEqual(reqLines[0].request_id, "7jyq-yY4SemsSt3snPRhug");
  assert.strictEqual(reqLines[0].route, "/api/briefing/latest.html");
  assert.strictEqual(reqLines[0].universe, "xyz");
  assert.strictEqual(reqLines[0].status, 200);
  assert.match(reqLines[0].snapshot_id, /^[0-9a-f]{8}-\d{7}$/);
  assert.strictEqual(typeof reqLines[0].ms, "number");
  assert.strictEqual(reqLines[3].status, 400);
  assert.strictEqual(reqLines[3].snapshot_id, null);
  assert.ok(lines.some(function (l) { return l.indexOf("[briefing] materialized ") === 0; }),
    "the on-demand materialization is logged like a timer one");
});

test("briefing: a stalled producer is visible from every route under an advancing clock", function () {
  const clock = { now: Date.now() };
  const handler = makeBriefingHandler({ now: function () { return clock.now; } });
  const first = get(handler, "/api/briefing/latest.html?uni=xyz", "gzip;q=0");
  assert.strictEqual(first.headers["X-Is-Stale"], "false");
  const id = first.headers["X-Snapshot-ID"];

  clock.now += 20 * 60000;                 // 20 min later, nothing materialized
  const health = get(handler, "/api/briefing/health?uni=xyz", "gzip;q=0");
  assert.strictEqual(health.statusCode, 200);
  const body = decode(health);
  assert.strictEqual(body.status, "degraded");
  assert.strictEqual(body.snapshot_id, id, "same snapshot...");
  assert.strictEqual(body.is_stale, true, "...now stale");
  assert.ok(body.age_seconds >= 1200);
  assert.strictEqual(body.producer_status, "stalled");
  assert.strictEqual(health.headers["X-Is-Stale"], "true");
  assert.strictEqual(health.headers["X-Producer-Status"], "stalled");

  const html = get(handler, "/api/briefing/latest.html?uni=xyz", "gzip;q=0");
  assert.strictEqual(html.statusCode, 200, "default mode keeps serving, labeled");
  const text = decodedText(html);
  assert.match(text, /<dt>is_stale<\/dt><dd>true<\/dd>/);
  assert.match(text, /<dt>producer_status<\/dt><dd>stalled<\/dd>/);
  assert.match(text, /seconds old at serve time/);
  const strict = get(handler, "/api/briefing/latest.html?uni=xyz&require_complete=1", "gzip;q=0");
  assert.strictEqual(strict.statusCode, 200,
    "require_complete gates on data_complete (a materialization-time fact), not on serve-time age");

  // /health carries the same per-universe summary.
  const root = JSON.parse(get(handler, "/health").body);
  assert.strictEqual(root.briefing.universes.xyz.snapshot_id, id);
  assert.strictEqual(root.briefing.universes.xyz.producer_status, "stalled");
  assert.strictEqual(root.briefing.universes.xyz.is_stale, true);
});

// --- audit 2026-09-13 F1 / F2 at the route level -----------------------------

function makeFailingHandler(buildImpl, extra) {
  const state = { loaded: true, universes: ["xyz"], order: [], coins: {}, expectedMarketsByUni: { xyz: [] } };
  const lines = [];
  const briefing = createBriefingStore({ state: state, ftfcTfs: [], build: buildImpl, log: function (l) { lines.push(l); },
    now: extra && extra.now });
  const handler = createRequestHandler({
    loop: { state: state },
    rules: { alertsFired: function () { return 0; } },
    push: { count: function () { return 0; }, stats: function () { return {}; } },
    config: { ftfcTfs: [] },
    briefing: briefing,
    log: function (l) { lines.push(l); },
    now: extra && extra.now
  });
  return { handler: handler, lines: lines, briefing: briefing };
}

test("briefing F1: a first-build failure is a 503 on every format and HEAD, logged, never a thrown TypeError", function () {
  // Frozen clock: the body/header agreement below compares TWO requests
  // (latest.json and health) that each stamp their own request time, so
  // under a real clock the assertion is a millisecond race (flaked once,
  // 2026-09-19: .109Z vs .108Z).
  const h = makeFailingHandler(function () { throw new Error("first-build failure"); }, { now: function () { return Date.UTC(2026, 8, 13, 12, 0); } });
  BRIEFING_ROUTES.forEach(function (route) {
    const res = request(h.handler, "GET", route + "?uni=xyz", { "accept-encoding": "gzip;q=0" });
    assert.strictEqual(res.statusCode, 503, route);
    assert.strictEqual(res.ended, true, route + " response completed");
    assert.strictEqual(res.headers["X-Snapshot-ID"], "none", route);
    assert.strictEqual(res.headers["X-Producer-Status"], "error", route);
    assert.match(res.headers["X-Request-ID"], /^local-/, route);
  });
  const jsonRes = get(h.handler, "/api/briefing/latest.json?uni=xyz", "gzip;q=0");
  const json = decode(jsonRes);
  assert.strictEqual(json.error.code, "snapshot_unavailable");
  assert.ok(json.issues.includes("build_failed"));
  assert.strictEqual(json.producer_status, "error");
  // Headers and the unavailable body come from the SAME synthetic snapshot
  // (review L1: headers used to say "unknown" over a body naming xyz).
  assert.strictEqual(jsonRes.headers["X-Universe"], json.universe);
  assert.strictEqual(jsonRes.headers["X-Universe"], "xyz");
  assert.strictEqual(jsonRes.headers["X-Generated-At"], json.generated_at_utc);
  assert.strictEqual(jsonRes.headers["X-Score-Policy"], json.score_policy);
  assert.strictEqual(jsonRes.headers["X-Row-Count"], String(json.row_count));
  assert.strictEqual(jsonRes.headers["X-Data-As-Of"], "unknown");
  assert.strictEqual(json.data_as_of_utc, null);
  const healthRes = get(h.handler, "/api/briefing/health?uni=xyz", "gzip;q=0");
  const health = decode(healthRes);
  assert.strictEqual(health.status, "unavailable");
  assert.strictEqual(health.producer_status, "error");
  // Health's body agrees with its own headers over the unavailable
  // document, like every other format (review LOW: it used to null
  // generated_at_utc under an X-Generated-At that named the request time).
  assert.strictEqual(healthRes.headers["X-Generated-At"], health.generated_at_utc);
  assert.strictEqual(health.generated_at_utc, json.generated_at_utc);
  assert.strictEqual(healthRes.headers["X-Universe"], health.universe);
  assert.strictEqual(healthRes.headers["X-Row-Count"], String(health.row_count));
  assert.ok(health.producer.build_errors >= 5, "every request attempted a build: " + health.producer.build_errors);
  assert.match(decodedText(get(h.handler, "/api/briefing/latest.html?uni=xyz", "gzip;q=0")), /snapshot_unavailable/);
  const head = request(h.handler, "HEAD", "/api/briefing/latest.csv?uni=xyz");
  assert.strictEqual(head.statusCode, 503);
  assert.strictEqual(head.body, undefined);
  const reqLines = h.lines.filter(function (l) { return l.indexOf("[briefing] request ") === 0; });
  assert.ok(reqLines.length >= BRIEFING_ROUTES.length + 4, "every request logged: " + reqLines.length);
  assert.ok(reqLines.every(function (l) { return JSON.parse(l.slice("[briefing] request ".length)).status === 503; }));
});

test("briefing F2A: health headers and body come from ONE view - a build that throws once then succeeds", function () {
  let calls = 0;
  const real = require("../src/briefing.js").buildBriefingSnapshot;
  const h = makeFailingHandler(function (s, tfs, uni, at) {
    calls++;
    if (calls === 1) throw new Error("once");
    return real(s, tfs, uni, at);
  });
  const res = get(h.handler, "/api/briefing/health?uni=xyz", "gzip;q=0");
  const body = decode(res);
  assert.strictEqual(calls, 1, "one response, one build attempt");
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.headers["X-Snapshot-ID"], "none");
  assert.strictEqual(body.snapshot_id, null, "body agrees with the header");
  assert.strictEqual(res.headers["X-Row-Count"], String(body.row_count));
  // The next request recovers on its own ensure().
  const next = get(h.handler, "/api/briefing/health?uni=xyz", "gzip;q=0");
  assert.strictEqual(calls, 2);
  assert.strictEqual(decode(next).snapshot_id, next.headers["X-Snapshot-ID"]);
  assert.notStrictEqual(next.headers["X-Snapshot-ID"], "none");
});

test("briefing F2B: the staleness boundary cannot fall between a response's headers and its body", function () {
  // The clock advances on EVERY read; a response that read it twice would
  // straddle the 900s boundary between its headers and its body.
  const T0 = Date.UTC(2026, 8, 13, 12, 0);
  let reads = 0;
  const clock = { base: T0 };
  const nowFn = function () { reads++; return clock.base + reads; };   // +1ms per read
  const snap = {
    schema_version: "1.0", generated_at_utc: new Date(T0).toISOString(), data_as_of_utc: new Date(T0).toISOString(),
    universe: "xyz", row_count: 1, expected_row_count: 1, data_complete: true, is_stale: false, stale_after_seconds: 900,
    score_policy: "experimental_low_weight", issues: [], warnings: [], missing_symbols: [], unexpected_symbols: [],
    duplicate_symbols: [], field_coverage: {}, freshness: {}, session_definitions: {}, score_v: 3,
    rows: [{ symbol: "FOO", last: 1 }]
  };
  const h = makeFailingHandler(function () { return JSON.parse(JSON.stringify(snap)); }, { now: nowFn });
  h.briefing.materialize("xyz", T0);
  // Land the response's first clock read EXACTLY at the boundary (age == 900s, not stale);
  // any second read inside the response would be 1ms past it (stale).
  clock.base = T0 + 900000 - (reads + 1);
  ["/api/briefing/health", "/api/briefing/latest.json", "/api/briefing/latest.compact.json", "/api/briefing/latest.html"].forEach(function (route) {
    const res = get(h.handler, route + "?uni=xyz", "gzip;q=0");
    const headerStale = res.headers["X-Is-Stale"];
    const bodyStale = route.endsWith(".html")
      ? /<dt>is_stale<\/dt><dd>(\w+)<\/dd>/.exec(decodedText(res))[1]
      : String(decode(res).is_stale);
    assert.strictEqual(bodyStale, headerStale, route + ": body and header read the same clock");
    clock.base = T0 + 900000 - (reads + 1);   // re-arm for the next route
  });
});
