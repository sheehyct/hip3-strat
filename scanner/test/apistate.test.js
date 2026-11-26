"use strict";

// /api/state payload tests: the additive multi-universe fields (`uni` per coin,
// top-level `universes`), the ?uni filter, and backward-compat of the existing
// fields. node builtins only: node --test

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildApiState, buildBootstrap, DISPLAY_V } = require("../src/apistate.js");

// A minimal but realistic coin: enough ctx for the serialized fields, one 1h
// slot with an analyzeTF-shaped `an` so the tf branch is exercised.
function coin(name, sym, uni) {
  return {
    name: name, sym: sym, uni: uni, mid: 100, hist: [], ctx: { markPx: "100", prevDayPx: "99", dayNtlVlm: "1000" },
    tf: {
      "1h": {
        closed: [{ t: 1, o: 99, h: 101, l: 98, c: 100 }],
        forming: { t: 2, T: 3600002, o: 100, h: 101, l: 99, c: 100, v: 5 },
        an: { types: [null, "2U"], formingType: "2U", formingDir: "up", completed: null, setups: [], invalidated: false, live: [] }
      }
    }
  };
}

function stateOf() {
  const coins = {
    "xyz:NVDA": coin("xyz:NVDA", "NVDA", "xyz"),
    "BTC": coin("BTC", "BTC", "perps")
  };
  return { order: ["xyz:NVDA", "BTC"], coins: coins, loaded: true, universes: ["xyz", "perps"] };
}

const FTFC = ["1h"];
const NOW = 1000000;

test("buildApiState tags every coin with its universe and lists tracked universes", function () {
  const out = buildApiState(stateOf(), FTFC, null, NOW);
  assert.deepStrictEqual(out.universes, ["xyz", "perps"]);
  assert.strictEqual(out.coins.length, 2);
  const byName = {};
  out.coins.forEach(function (c) { byName[c.name] = c; });
  assert.strictEqual(byName["xyz:NVDA"].uni, "xyz");
  assert.strictEqual(byName["BTC"].uni, "perps");
});

test("buildApiState ?uni filter returns only the requested universe", function () {
  const perpsOnly = buildApiState(stateOf(), FTFC, "perps", NOW);
  assert.strictEqual(perpsOnly.coins.length, 1);
  assert.strictEqual(perpsOnly.coins[0].name, "BTC");
  assert.strictEqual(perpsOnly.coins[0].uni, "perps");

  const xyzOnly = buildApiState(stateOf(), FTFC, "xyz", NOW);
  assert.strictEqual(xyzOnly.coins.length, 1);
  assert.strictEqual(xyzOnly.coins[0].name, "xyz:NVDA");

  // unknown / no-match universe -> empty coins, but still a valid envelope
  const none = buildApiState(stateOf(), FTFC, "nope", NOW);
  assert.strictEqual(none.coins.length, 0);
  assert.deepStrictEqual(none.universes, ["xyz", "perps"]);
});

test("buildApiState stamps display_v matching the vendored DISPLAY-CORE block", function () {
  const out = buildApiState(stateOf(), FTFC, null, NOW);
  assert.match(out.display_v, /^[0-9a-f]{16}$/, "display_v is a 16-hex stamp");
  assert.strictEqual(out.display_v, DISPLAY_V);
  // Recompute independently: sha256 of the marker-delimited block inside
  // src/display_core.js, LF-normalized - the exact recipe consumers must use
  // on their vendored copy.
  const raw = fs.readFileSync(path.join(__dirname, "..", "src", "display_core.js"), "utf8");
  const lines = raw.split(/\r?\n/);
  const b = lines.findIndex(function (l) { return l.trim() === "// ==== DISPLAY-CORE-BEGIN ===="; });
  const e = lines.findIndex(function (l) { return l.trim() === "// ==== DISPLAY-CORE-END ===="; });
  assert.ok(b >= 0 && e > b, "markers present in the vendored file");
  const want = crypto.createHash("sha256")
    .update(lines.slice(b, e + 1).join("\n")).digest("hex").slice(0, 16);
  assert.strictEqual(out.display_v, want);
});

// Read the marker-delimited block out of a raw file body using the published
// recipe, so the two tests below exercise the SAME extraction consumers use.
function stampOf(raw) {
  const lines = raw.split(/\r?\n/);
  const b = lines.findIndex(function (l) { return l.trim() === "// ==== DISPLAY-CORE-BEGIN ===="; });
  const e = lines.findIndex(function (l) { return l.trim() === "// ==== DISPLAY-CORE-END ===="; });
  assert.ok(b >= 0 && e > b, "markers present");
  return crypto.createHash("sha256")
    .update(lines.slice(b, e + 1).join("\n")).digest("hex").slice(0, 16);
}

// The stamp is what the mobile app compares its BUILD-TIME hash against, and
// mobile has no test runner - so the line-ending invariance of the recipe has
// to be pinned on the producing side. .gitattributes pins LF here, but a
// consumer checkout may be CRLF and nothing asserted that the two agree.
test("DISPLAY_V recipe is line-ending invariant (LF checkout == CRLF checkout)", function () {
  const raw = fs.readFileSync(path.join(__dirname, "..", "src", "display_core.js"), "utf8");
  const lf = raw.replace(/\r\n/g, "\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.notStrictEqual(lf, crlf, "the fixture must actually differ in bytes");
  assert.strictEqual(stampOf(crlf), stampOf(lf),
    "a CRLF checkout must produce the same display_v as an LF one");
  assert.strictEqual(stampOf(lf), DISPLAY_V);
});

// DRIFT GATE, not a correctness test. display_v is the ONLY signal that a
// consumer is rendering stale display math, and today it reaches the mobile app
// by a human relaying it - the runtime warn is the safety net, and a safety
// net should not be the primary notification channel. Pinning the value makes
// any DISPLAY-CORE edit fail here and land an `old -> new` line in the diff,
// which is the notification. Same idiom as the SCORE_TF_IDS and
// underlying_map drift gates.
test("display_v drift gate: the DISPLAY-CORE stamp is pinned", function () {
  assert.strictEqual(DISPLAY_V, "53b4dd264e56e480",
    "DISPLAY-CORE changed. This is EXPECTED for a deliberate edit - update the " +
    "pin above to the new stamp, and re-vendor the block in every client " +
    "that mirrors it (the mobile app), so the drift is handled at build time " +
    "instead of discovered at runtime on an already-shipped build.");
});

// maxLeverage is a FILTER input for candidate ranking, so the null case is the
// one that matters: a consumer asking "max leverage >= 10x" must be able to
// tell "the venue says 20x" from "we do not know", and a 0 would answer the
// filter confidently and wrongly.
test("buildApiState serves maxLeverage, and unknown stays null rather than 0", function () {
  const st = stateOf();
  st.coins["xyz:NVDA"].maxLeverage = 20;
  // BTC deliberately left without the field, as an older/never-refreshed coin
  const out = buildApiState(st, FTFC, null, NOW);
  const byName = {};
  out.coins.forEach(function (c) { byName[c.name] = c; });
  assert.strictEqual(byName["xyz:NVDA"].maxLeverage, 20);
  assert.strictEqual(byName["BTC"].maxLeverage, null, "absent means unknown, never 0");
  // a non-numeric that slipped through must not serialize as-is
  st.coins["BTC"].maxLeverage = "20";
  assert.strictEqual(buildApiState(st, FTFC, null, NOW).coins
    .find(function (c) { return c.name === "BTC"; }).maxLeverage, null);
});

test("buildApiState preserves the existing per-coin field contract", function () {
  const out = buildApiState(stateOf(), FTFC, null, NOW);
  const c = out.coins[0];
  // every field client apps read today must still be present
  ["name", "sym", "mid", "chg24", "vol", "funding", "score", "rvol",
   "premium", "mark", "oracle", "oiUsd", "ftfc", "dots", "mom",
   "liveCount", "setupCount", "tf"].forEach(function (k) {
    assert.ok(k in c, "missing field " + k);
  });
  assert.strictEqual(out.loaded, true);
  assert.ok("ts" in out && "ftfcTfs" in out);
  assert.ok(Number.isInteger(out.score_v), "score_v version stamp");
  assert.strictEqual(c.mid, 100);
  assert.ok("1h" in c.tf);           // tf branch serialized
  // score_v 3 additions (additive: consumers parse by key)
  assert.ok("atr1h" in c, "hourly yardstick served");
  assert.strictEqual(c.atr1h, null, "1 closed 1h bar -> yardstick null, never fake");
  assert.ok("r60Src" in c.mom, "momentum source label served");
});

// ---- per-coin readiness (design decision 2026-08-15: BOTH halves) ----------
// A coin whose configured timeframes are not all analyzed used to serialize
// as score 0 / ftfc "mixed" - indistinguishable from a genuinely neutral
// row. Now: additive ready/missingTfs flags AND null derived fields.

test("tf{} serves completed and shape (additive; null when the analyzer had none)", function () {
  const s = stateOf();
  const an = s.coins["xyz:NVDA"].tf["1h"].an;
  an.completed = { name: "2D-1-2U", dir: "up", cont: false };
  an.shape = { type: "hammer", confirming: true };
  const out = buildApiState(s, FTFC, "xyz", NOW);
  const tf = out.coins[0].tf["1h"];
  assert.deepStrictEqual(tf.completed, { name: "2D-1-2U", dir: "up", cont: false });
  assert.deepStrictEqual(tf.shape, { type: "hammer", confirming: true });
  const plain = buildApiState(stateOf(), FTFC, "xyz", NOW).coins[0].tf["1h"];
  assert.strictEqual(plain.completed, null, "absent -> null, never undefined");
  assert.strictEqual(plain.shape, null);
});

test("revision serializes from loop state (0 when absent) in state and bootstrap", function () {
  const s = stateOf();
  assert.strictEqual(buildApiState(s, FTFC, null, NOW).revision, 0, "absent -> 0, never undefined");
  s.revision = 7;
  assert.strictEqual(buildApiState(s, FTFC, null, NOW).revision, 7);
  assert.strictEqual(buildBootstrap(s, null, NOW).revision, 7, "bootstrap carries the same stamp");
});

test("readiness: a coin with ZERO candles serializes ready:false, nulls, and named gaps", function () {
  const s = stateOf();
  s.coins["xyz:EMPTY"] = { name: "xyz:EMPTY", sym: "EMPTY", uni: "xyz", mid: 50, hist: [], ctx: {}, tf: {} };
  s.order.push("xyz:EMPTY");
  const FT = ["15m", "1h", "4h", "1d"];
  const out = buildApiState(s, FT, null, NOW);
  const byName = {};
  out.coins.forEach(function (c) { byName[c.name] = c; });
  const empty = byName["xyz:EMPTY"];
  assert.strictEqual(empty.ready, false);
  assert.deepStrictEqual(empty.missingTfs, FT, "every configured timeframe is named as missing");
  assert.strictEqual(empty.score, null, "never a fake-neutral 0");
  assert.strictEqual(empty.ftfc, null, "never a fake \"mixed\"");
  assert.strictEqual(empty.heatComponents, null, "components cannot outlive the score");
});

test("readiness: a partial coin names exactly the missing timeframes", function () {
  const out = buildApiState(stateOf(), ["15m", "1h", "4h", "1d"], "xyz", NOW);
  const c = out.coins[0];   // fixture carries an analyzed 1h slot only
  assert.strictEqual(c.ready, false);
  assert.deepStrictEqual(c.missingTfs, ["15m", "4h", "1d"], "1h present, the rest missing");
  assert.strictEqual(c.score, null);
  assert.strictEqual(c.ftfc, null);
  assert.ok("1h" in c.tf, "the analyzed slot still serializes - raw data is never withheld");
  assert.strictEqual(c.dots.length, 4, "dots keep flat padding; missingTfs disambiguates");
});

test("readiness: a ready coin is unchanged - ready:true, empty gaps, real score and ftfc", function () {
  const out = buildApiState(stateOf(), FTFC, "xyz", NOW);   // FTFC = ["1h"], slot analyzed
  const c = out.coins[0];
  assert.strictEqual(c.ready, true);
  assert.deepStrictEqual(c.missingTfs, []);
  assert.notStrictEqual(c.score, null, "a ready coin keeps its real score");
  assert.strictEqual(c.ftfc, "up");
  assert.ok(c.heatComponents, "components served for a ready coin");
});

// Review 2026-07-25 F1/F3 at the /api/state call site: the serialized atr1h
// honors the yardstick freshness contract and mom.r60Src carries the stale
// endpoint label, so consumers see the same degraded-honest values the score
// used.
test("buildApiState serves a fresh yardstick, nulls an overdue one, labels a stale endpoint", function () {
  const NOW2 = 10 * 3600000;
  function tapedCoin(midAge, yEndAge) {
    const closed = [];
    for (let i = 0; i < 21; i++) {
      const T = NOW2 - yEndAge - (20 - i) * 3600000;
      closed.push({ t: T - 3600000, T: T, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 });
    }
    const c = coin("xyz:NVDA", "NVDA", "xyz");
    c.mid = 105;
    c.hist = [{ t: NOW2 - midAge - 3660000, m: 100 }, { t: NOW2 - midAge, m: 105 }];
    c.tf["1h"].closed = closed;
    return c;
  }
  function outFor(midAge, yEndAge) {
    const c = tapedCoin(midAge, yEndAge);
    const st = { order: ["xyz:NVDA"], coins: { "xyz:NVDA": c }, loaded: true, universes: ["xyz"] };
    return buildApiState(st, FTFC, null, NOW2).coins[0];
  }
  const fresh = outFor(4000, 60000);
  assert.ok(Math.abs(fresh.atr1h - 1) < 1e-9, "fresh 21-bar slot serves the live yardstick");
  assert.strictEqual(fresh.mom.r60Src, "exact");
  assert.ok(Math.abs(fresh.mom.r60 - 5) < 1e-9);
  const overdue = outFor(4000, 4500001);
  assert.strictEqual(overdue.atr1h, null, "overdue slot serves null, never a dead number");
  const stalled = outFor(300000, 60000);
  assert.strictEqual(stalled.mom.r60Src, "stale", "5-min mids gap labeled at the API surface");
  assert.strictEqual(stalled.mom.r5, null);
});

test("buildApiState single-universe payload adds only uni/universes (backward compat)", function () {
  const st = { order: ["xyz:NVDA"], coins: { "xyz:NVDA": coin("xyz:NVDA", "NVDA", "xyz") }, loaded: true, universes: ["xyz"] };
  const out = buildApiState(st, FTFC, null, NOW);
  assert.deepStrictEqual(out.universes, ["xyz"]);
  assert.strictEqual(out.coins[0].uni, "xyz");
  // top-level keys are exactly the pre-universe set plus `universes`, the
  // score_v formula stamp (consumer-contract split, design review 2026-07-20),
  // the display_v block stamp (DISPLAY-CORE step 4, 2026-08-06), the
  // feed ages (code review 2026-08-16 F4), and snapshot_id
  // (additive beside revision), and
  // the target_v rule-set stamp (target rules v2)
  assert.deepStrictEqual(Object.keys(out).sort(),
    ["candlesAgeMs", "coins", "display_v", "ftfcTfs", "loaded", "midsAgeMs",
     "revision", "score_v", "snapshot_id", "target_v", "ts", "universes"]);
  assert.strictEqual(out.target_v, 2);
});

// Code review 2026-08-16 F4: the hosted dashboard's status bar previously
// showed HTTP-receipt age as feed age - a stalled exchange feed rendered as
// fresh precisely when it needed attention. These are the LOOP's own ages,
// per requested universe when filtered, matching /health's math.
test("buildApiState serves worker feed ages; per-universe when filtered", function () {
  const st = stateOf();
  st.lastMids = NOW - 45000;
  st.lastCandles = NOW - 120000;
  st.lastMidsByUni = { xyz: NOW - 5000 };
  st.lastCandlesByUni = { xyz: NOW - 8000 };
  const all = buildApiState(st, FTFC, null, NOW);
  assert.strictEqual(all.midsAgeMs, 45000, "unfiltered uses the global stamp");
  assert.strictEqual(all.candlesAgeMs, 120000);
  const xyz = buildApiState(st, FTFC, "xyz", NOW);
  assert.strictEqual(xyz.midsAgeMs, 5000, "filtered uses that universe's stamp");
  assert.strictEqual(xyz.candlesAgeMs, 8000);
  const perps = buildApiState(st, FTFC, "perps", NOW);
  assert.strictEqual(perps.midsAgeMs, 45000,
    "a universe without its own stamp falls back to the global one");
});

test("buildApiState feed ages are null before any fetch, never 0 or fake", function () {
  const out = buildApiState(stateOf(), FTFC, null, NOW);
  assert.strictEqual(out.midsAgeMs, null);
  assert.strictEqual(out.candlesAgeMs, null);
});

test("buildApiState serves the D/W/M selection gate + reserved rank per coin", function () {
  const c = coin("xyz:NVDA", "NVDA", "xyz");
  ["1d", "1w", "1M"].forEach(function (id) {
    c.tf[id] = {
      closed: [{ t: 1, o: 99, h: 101, l: 98, c: 100 }],
      forming: { t: 2, T: 3, o: 100, h: 101, l: 99, c: 101, v: 1 },
      an: { types: ["2U"], formingType: "2U", formingDir: "up", completed: null,
            setups: [], invalidated: false, live: [] }
    };
  });
  const st = { order: ["xyz:NVDA"], coins: { "xyz:NVDA": c }, loaded: true, universes: ["xyz"] };
  const out = buildApiState(st, FTFC, null, NOW).coins[0];
  assert.deepStrictEqual(out.dwmContinuity, {
    complete: true, dir: "up", dots: { "1d": "up", "1w": "up", "1M": "up" }
  });
  assert.strictEqual(out.selectionRank, null, "reserved until separately validated");

  // without D/W/M analysis (the fixture default has only 1h): incomplete,
  // ineligible, and the missing TFs are null - not "flat" (review D6)
  const bare = buildApiState(stateOf(), FTFC, null, NOW).coins[0];
  assert.deepStrictEqual(bare.dwmContinuity, {
    complete: false, dir: null, dots: { "1d": null, "1w": null, "1M": null }
  });
});

test("buildApiState serves a 15m spark series (closes + live mid), null without 15m data", function () {
  const c = coin("BTC", "BTC", "perps");
  c.tf["15m"] = {
    closed: [
      { t: 1, o: 99, h: 100, l: 98, c: 99.5 },
      { t: 2, o: 99.5, h: 101, l: 99, c: 100.5 }
    ],
    forming: { t: 3, T: 4, o: 100.5, h: 101, l: 100, c: 100.8, v: 1 },
    an: null
  };
  const st = { order: ["BTC"], coins: { "BTC": c }, loaded: true, universes: ["perps"] };
  const out = buildApiState(st, FTFC, null, NOW);
  // closes oldest-first, then the live mid (100 from the fixture) as "now"
  assert.deepStrictEqual(out.coins[0].spark, [99.5, 100.5, 100]);

  // no 15m slot (fixture default) -> null, field still present
  const bare = buildApiState(stateOf(), FTFC, null, NOW);
  assert.strictEqual(bare.coins[0].spark, null);
  assert.ok("spark" in bare.coins[0]);
});

test("buildApiState serves the extracted PERP_CAT category for perps coins only", function () {
  const coins = {
    "xyz:NVDA": coin("xyz:NVDA", "NVDA", "xyz"),
    "BTC": coin("BTC", "BTC", "perps"),           // mapped -> majors
    "NEWLISTING": coin("NEWLISTING", "NEWLISTING", "perps") // unmapped -> other
  };
  const st = { order: Object.keys(coins), coins: coins, loaded: true, universes: ["xyz", "perps"] };
  const out = buildApiState(st, FTFC, null, NOW);
  const byName = {};
  out.coins.forEach(function (c) { byName[c.name] = c; });
  assert.strictEqual(byName["BTC"].cat, "majors");
  assert.strictEqual(byName["NEWLISTING"].cat, "other");
  assert.strictEqual(byName["xyz:NVDA"].cat, null, "xyz has no category map yet");
});

test("buildBootstrap ships raw candle slots, skips derived W/M and empty slots", function () {
  const c = coin("BTC", "BTC", "perps");
  c.ctx = { markPx: "100", prevDayPx: "99" };
  c.tf["1w"] = { closed: [{ t: 1, o: 1, h: 2, l: 0, c: 1 }], forming: null, an: null }; // derived - excluded
  c.tf["4h"] = { closed: [], forming: null, an: null };                                 // empty - excluded
  const st = { order: ["BTC"], coins: { "BTC": c }, loaded: true, universes: ["perps"] };
  const out = buildBootstrap(st, null, NOW);
  assert.strictEqual(out.ts, NOW);
  assert.strictEqual(out.loaded, true);
  assert.strictEqual(out.coins.length, 1);
  const b = out.coins[0];
  assert.strictEqual(b.name, "BTC");
  assert.strictEqual(b.uni, "perps");
  assert.strictEqual(b.mid, 100);
  assert.deepStrictEqual(Object.keys(b.tf), ["1h"], "only non-derived slots with closed bars");
  // raw bars pass through untouched (the dashboard's setCandles shape)
  assert.deepStrictEqual(b.tf["1h"].closed[0], { t: 1, o: 99, h: 101, l: 98, c: 100 });
  assert.strictEqual(b.tf["1h"].forming.t, 2);
  // NO analysis ships - the dashboard runs the canonical core itself
  assert.strictEqual("an" in b.tf["1h"], false);
  assert.strictEqual("live" in b.tf["1h"], false);
});

test("buildBootstrap ?uni filter scopes coins like /api/state", function () {
  const out = buildBootstrap(stateOf(), "xyz", NOW);
  assert.strictEqual(out.coins.length, 1);
  assert.strictEqual(out.coins[0].name, "xyz:NVDA");
  assert.strictEqual(buildBootstrap(stateOf(), "nope", NOW).coins.length, 0);
});
