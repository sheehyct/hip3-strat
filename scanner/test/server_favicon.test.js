"use strict";

// /favicon.ico route: desktop browsers request the path
// unprompted, and it used to fall through to the 404 tail. The route aliases
// to the SAME bytes as /icon-192.png, served as image/png - browsers accept a
// PNG at /favicon.ico, and with nosniff on every response the Content-Type
// must be the true type, never image/x-icon. node builtins only: node --test
//
// Requiring server.js is side-effect-safe: it only boots (listen + loop)
// under require.main === module.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createRequestHandler } = require("../server.js");

function makeHandler() {
  return createRequestHandler({
    loop: { state: { order: [], loaded: true, universes: ["xyz"], coins: {} } },
    rules: { alertsFired: function () { return 0; } },
    push: { count: function () { return 0; }, stats: function () { return {}; } },
    config: { ftfcTfs: ["1h"] }
  });
}

// The static branch answers via an async fs.readFile, so resolve on res.end
// (same pattern as the dashboard CSP test in server_routes.test.js).
function get(handler, url, method) {
  return new Promise(function (resolve) {
    const res = {
      statusCode: null, headers: null, body: null,
      writeHead: function (status, headers) { this.statusCode = status; this.headers = headers; return this; },
      end: function (chunk) { this.body = chunk; resolve(this); return this; }
    };
    handler({ method: method || "GET", url: url, headers: {} }, res);
  });
}

test("/favicon.ico is 200 image/png, byte-identical to /icon-192.png", async function () {
  const handler = makeHandler();
  const fav = await get(handler, "/favicon.ico");
  assert.strictEqual(fav.statusCode, 200);
  assert.strictEqual(fav.headers["Content-Type"], "image/png");
  assert.strictEqual(fav.headers["Cache-Control"], "public, max-age=3600");
  assert.strictEqual(fav.headers["X-Content-Type-Options"], "nosniff");
  assert.ok(Buffer.isBuffer(fav.body), "binary body is a Buffer");

  const icon = await get(handler, "/icon-192.png");
  assert.strictEqual(icon.statusCode, 200);
  assert.ok(fav.body.equals(icon.body), "favicon bytes === /icon-192.png bytes");

  const onDisk = fs.readFileSync(path.join(__dirname, "..", "public", "icon-192.png"));
  assert.ok(fav.body.equals(onDisk), "served bytes match public/icon-192.png on disk");
});

test("the favicon alias does not widen the static whitelist", async function () {
  const handler = makeHandler();
  assert.strictEqual((await get(handler, "/favicon.png")).statusCode, 404);
  assert.strictEqual((await get(handler, "/icon-192.ico")).statusCode, 404);
  assert.strictEqual((await get(handler, "/favicon.ico", "POST")).statusCode, 404);
});
