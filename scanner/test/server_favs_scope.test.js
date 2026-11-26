"use strict";

// Serving the favorites-only alert scope, and THE BUDGET INVARIANT.
//
// The invariant is the reason this feature is a second env var instead of a
// wider ALERT_UNIVERSES: server.js hands ALERT_UNIVERSES to the loop as the
// 15m volume true-up scope, and that scoping is what took total exchange
// demand from ~155% to ~95% of Hyperliquid's 1,200 weight/min per-IP budget
// (the demand cut, 2026-08-17). Favorites-scoped perps alerting is free ONLY while
// perps stays out of the true-up. This file pins that it does.
//
// Env is set BEFORE requiring server.js because the scopes resolve at module
// load; node --test gives each file its own process, so this cannot leak into
// another test file. Requiring server.js is side-effect-safe (it only listens
// and starts the loop under require.main === module).

process.env.UNIVERSES = "xyz,perps";
delete process.env.ALERT_UNIVERSES;             // default: broadcast xyz only
delete process.env.ALERT_FAVS_UNIVERSES;        // default: favorites perps

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const server = require("../server.js");
const { createRequestHandler } = server;

// --- THE BUDGET INVARIANT -------------------------------------------------

test("enabling the favorites universe does NOT widen the true-up coin set", function () {
  const s = server.scopes();
  assert.deepStrictEqual(s.alertUniverses, ["xyz"]);
  assert.deepStrictEqual(s.alertFavsUniverses, ["perps"], "the feature IS on by default");
  assert.deepStrictEqual(s.trueUpUniverses, ["xyz"],
    "perps alerts on favorites yet is still excluded from the 5-min volume true-up");
});

test("the true-up scope tracks ALERT_UNIVERSES only, never the favorites list", function () {
  const s = server.scopes();
  assert.deepStrictEqual(s.trueUpUniverses, s.alertUniverses);
  for (const u of s.alertFavsUniverses) {
    assert.strictEqual(s.trueUpUniverses.indexOf(u), -1,
      "'" + u + "' would add ~20 weight per coin per true-up burst");
  }
});

// --- additive serialization ----------------------------------------------

function get(handler, url, headers) {
  const req = new http.IncomingMessage(null);
  req.method = "GET";
  req.url = url;
  req.headers = headers || {};
  const chunks = [];
  const res = {
    statusCode: 0, headers: {},
    writeHead: function (c, h) { res.statusCode = c; Object.assign(res.headers, h || {}); },
    setHeader: function (k, v) { res.headers[k] = v; },
    end: function (b) { if (b) chunks.push(b); }
  };
  handler(req, res);
  return { statusCode: res.statusCode, body: Buffer.concat(chunks.map(function (c) {
    return Buffer.isBuffer(c) ? c : Buffer.from(String(c));
  })).toString("utf8") };
}

function makeHandler(deps) {
  const state = {
    order: ["FOO"],
    loaded: true,
    universes: ["xyz", "perps"],
    coins: { FOO: { name: "FOO", sym: "FOO", uni: "xyz", mid: 100, hist: [], ctx: {}, tf: {} } }
  };
  return createRequestHandler(Object.assign({
    loop: { state: state },
    rules: { alertsFired: function () { return 0; } },
    push: { count: function () { return 0; }, stats: function () { return {}; } },
    config: { ftfcTfs: ["15m", "1h", "4h", "1d"] }
  }, deps || {}));
}

test("/health and /api/state serve alert_favs_universes beside alertUniverses", function () {
  const handler = makeHandler({ alertUniverses: ["xyz"], alertFavsUniverses: ["perps"] });
  for (const url of ["/health", "/api/state"]) {
    const r = get(handler, url);
    assert.strictEqual(r.statusCode, 200, url);
    const body = JSON.parse(r.body);
    assert.deepStrictEqual(body.alertUniverses, ["xyz"], url);
    assert.deepStrictEqual(body.alert_favs_universes, ["perps"], url);
  }
});

test("alert_favs_universes defaults to [] when the dep is absent (never fabricated)", function () {
  const handler = makeHandler({ alertUniverses: ["xyz"] });
  for (const url of ["/health", "/api/state"]) {
    assert.deepStrictEqual(JSON.parse(get(handler, url).body).alert_favs_universes, [], url);
  }
});

test("the field is ADDITIVE: alertUniverses keeps its exact prior shape", function () {
  // The dashboard reads state.alertScope from alertUniverses alone and must
  // be unaffected until the UI hint ships with the wireframe work.
  const withFeature = makeHandler({ alertUniverses: ["xyz"], alertFavsUniverses: ["perps"] });
  const without = makeHandler({ alertUniverses: ["xyz"] });
  for (const url of ["/health", "/api/state"]) {
    const a = JSON.parse(get(withFeature, url).body);
    const b = JSON.parse(get(without, url).body);
    assert.deepStrictEqual(a.alertUniverses, b.alertUniverses, url);
    delete a.alert_favs_universes;
    delete b.alert_favs_universes;
    delete a.uptimeSec; delete b.uptimeSec;      // /health carries elapsed time
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(),
      url + ": no other field appeared or vanished");
  }
});
