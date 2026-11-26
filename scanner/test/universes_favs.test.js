"use strict";

// ALERT_FAVS_UNIVERSES parsing (favorites-only alert scope). Mirrors
// parseAlertUniverses - unknown ids dropped with a log, untracked ids dropped
// with a log - plus the BROADCAST-WINS rule: an id already in ALERT_UNIVERSES
// is dropped from the favorites list, because narrowing a broadcast universe
// to favorites would be a silent LOSS of alerts. node builtins only: node --test

const test = require("node:test");
const assert = require("node:assert");
const { parseAlertUniverses, parseAlertFavsUniverses } = require("../src/universes.js");

function collectLog() {
  const lines = [];
  return { log: function (m) { lines.push(m); }, lines: lines };
}

const TRACKED_BOTH = ["xyz", "perps"];

test("defaults to [perps] ONLY when unset; explicit empty disables (review)", function () {
  // The feature ships on merge + deploy with NO env change (unset ->
  // default), but ALERT_FAVS_UNIVERSES="" is the operator's off switch and
  // must NOT silently re-enable the default.
  assert.deepStrictEqual(parseAlertFavsUniverses(undefined, TRACKED_BOTH, ["xyz"]), ["perps"]);
  assert.deepStrictEqual(parseAlertFavsUniverses(null, TRACKED_BOTH, ["xyz"]), ["perps"]);
  assert.deepStrictEqual(parseAlertFavsUniverses("", TRACKED_BOTH, ["xyz"]), [],
    "set-but-empty is OFF");
  assert.deepStrictEqual(parseAlertFavsUniverses("   ", TRACKED_BOTH, ["xyz"]), [],
    "whitespace is OFF");
});

test("the default is dropped when perps is not tracked (cannot alert unanalyzed)", function () {
  const c = collectLog();
  assert.deepStrictEqual(parseAlertFavsUniverses(undefined, ["xyz"], ["xyz"], c), []);
  assert.ok(c.lines.some(function (l) { return /'perps' not in tracked/.test(l); }));
});

test("an operator disables the feature with a value that yields no valid ids", function () {
  // Unlike parseUniverses there is NO fall-back-to-default rescue: alerting on
  // nothing is the safe outcome, so "off" must actually be reachable.
  const c = collectLog();
  assert.deepStrictEqual(parseAlertFavsUniverses("none", TRACKED_BOTH, ["xyz"], c), []);
  assert.ok(c.lines.some(function (l) { return /ignoring unknown id 'none'/.test(l); }));
});

test("drops unknown ids with a log, keeps known ones", function () {
  const c = collectLog();
  assert.deepStrictEqual(parseAlertFavsUniverses("bogus,perps", TRACKED_BOTH, ["xyz"], c), ["perps"]);
  assert.ok(c.lines.some(function (l) { return /ignoring unknown id 'bogus'/.test(l); }));
});

test("de-duplicates repeated ids", function () {
  assert.deepStrictEqual(
    parseAlertFavsUniverses("perps,perps", TRACKED_BOTH, ["xyz"]), ["perps"]);
});

// ---- broadcast wins ----

test("an id in BOTH lists is dropped from favorites scope - broadcast wins", function () {
  const c = collectLog();
  // Someone sets ALERT_UNIVERSES=xyz,perps AND ALERT_FAVS_UNIVERSES=perps.
  // perps already alerts on EVERY coin; applying favorites scoping would
  // silently narrow it. The wider behavior stands.
  assert.deepStrictEqual(
    parseAlertFavsUniverses("perps", TRACKED_BOTH, ["xyz", "perps"], c), []);
  assert.ok(c.lines.some(function (l) { return /broadcast wins/.test(l); }));
});

test("xyz can never be accidentally narrowed to favorites-only", function () {
  const c = collectLog();
  assert.deepStrictEqual(
    parseAlertFavsUniverses("xyz,perps", TRACKED_BOTH, ["xyz"], c), ["perps"]);
  assert.ok(c.lines.some(function (l) { return /'xyz' is already in ALERT_UNIVERSES/.test(l); }));
});

test("the two lists are disjoint by construction for every ordinary config", function () {
  const tracked = TRACKED_BOTH;
  const combos = [
    [undefined, undefined], ["xyz", undefined], ["xyz,perps", undefined],
    ["xyz", "perps"], ["xyz,perps", "perps"], ["perps", "xyz"], ["xyz", "xyz"]
  ];
  for (const pair of combos) {
    const alert = parseAlertUniverses(pair[0], tracked);
    const favs = parseAlertFavsUniverses(pair[1], tracked, alert);
    const overlap = favs.filter(function (f) { return alert.indexOf(f) >= 0; });
    assert.deepStrictEqual(overlap, [],
      "ALERT_UNIVERSES=" + pair[0] + " ALERT_FAVS_UNIVERSES=" + pair[1]);
  }
});

test("parseAlertUniverses is untouched by the new parser (broadcast scope unchanged)", function () {
  assert.deepStrictEqual(parseAlertUniverses(undefined, TRACKED_BOTH), ["xyz"]);
  assert.deepStrictEqual(parseAlertUniverses("xyz,perps", TRACKED_BOTH), ["xyz", "perps"]);
});
