"use strict";

// Universe env parsing tests: UNIVERSES / ALERT_UNIVERSES defaults, "xyz,perps"
// selection, unknown-id handling (ignored with a log), de-dup, and the
// alert-must-be-a-subset-of-tracked safety rule. node builtins only: node --test

const test = require("node:test");
const assert = require("node:assert");
const { REGISTRY, parseUniverses, parseAlertUniverses } = require("../src/universes.js");

function collectLog() {
  const lines = [];
  return { log: function (m) { lines.push(m); }, lines: lines };
}
function ids(list) { return list.map(function (u) { return u.id; }); }

// ---- parseUniverses ----

test("parseUniverses defaults to [xyz] when unset/empty/whitespace", function () {
  assert.deepStrictEqual(ids(parseUniverses(undefined)), ["xyz"]);
  assert.deepStrictEqual(ids(parseUniverses("")), ["xyz"]);
  assert.deepStrictEqual(ids(parseUniverses("   ")), ["xyz"]);
  assert.deepStrictEqual(ids(parseUniverses(null)), ["xyz"]);
});

test("parseUniverses parses 'xyz,perps' (order + whitespace tolerant)", function () {
  assert.deepStrictEqual(ids(parseUniverses("xyz,perps")), ["xyz", "perps"]);
  assert.deepStrictEqual(ids(parseUniverses(" perps , xyz ")), ["perps", "xyz"]);
  // resolves to the shared registry objects (so dex mapping is authoritative)
  assert.strictEqual(parseUniverses("perps")[0], REGISTRY.perps);
  assert.strictEqual(REGISTRY.perps.dex, null);   // main dex: no dex field
  assert.strictEqual(REGISTRY.xyz.dex, "xyz");
});

test("parseUniverses drops unknown ids with a log, keeps known ones", function () {
  const c = collectLog();
  assert.deepStrictEqual(ids(parseUniverses("xyz,bogus,perps", c)), ["xyz", "perps"]);
  assert.ok(c.lines.some(function (l) { return /unknown id 'bogus'/.test(l); }));
});

test("parseUniverses de-duplicates repeated ids", function () {
  assert.deepStrictEqual(ids(parseUniverses("xyz,xyz,perps,perps")), ["xyz", "perps"]);
});

test("parseUniverses falls back to default when every id is unknown", function () {
  const c = collectLog();
  assert.deepStrictEqual(ids(parseUniverses("nope,bad", c)), ["xyz"]);
  assert.ok(c.lines.length >= 2);
});

// ---- parseAlertUniverses ----

test("parseAlertUniverses defaults to [xyz] and requires it be tracked", function () {
  assert.deepStrictEqual(parseAlertUniverses(undefined, ["xyz"]), ["xyz"]);
  assert.deepStrictEqual(parseAlertUniverses("", ["xyz", "perps"]), ["xyz"]);
});

test("parseAlertUniverses parses 'xyz,perps' when both are tracked", function () {
  assert.deepStrictEqual(parseAlertUniverses("xyz,perps", ["xyz", "perps"]), ["xyz", "perps"]);
});

test("parseAlertUniverses drops an id that is not tracked (cannot alert unanalyzed)", function () {
  const c = collectLog();
  // perps requested for alerting but only xyz is tracked -> dropped
  assert.deepStrictEqual(parseAlertUniverses("xyz,perps", ["xyz"], c), ["xyz"]);
  assert.ok(c.lines.some(function (l) { return /'perps' not in tracked/.test(l); }));
});

test("parseAlertUniverses default xyz with only perps tracked yields [] (safe: no surprise fire)", function () {
  const c = collectLog();
  // The safety default is xyz-only alerts; if xyz is not tracked, alert on
  // nothing rather than surprise-firing perps.
  assert.deepStrictEqual(parseAlertUniverses(undefined, ["perps"], c), []);
});

test("parseAlertUniverses drops unknown ids with a log", function () {
  const c = collectLog();
  assert.deepStrictEqual(parseAlertUniverses("xyz,bogus", ["xyz", "perps"], c), ["xyz"]);
  assert.ok(c.lines.some(function (l) { return /ignoring unknown id 'bogus'/.test(l); }));
});
