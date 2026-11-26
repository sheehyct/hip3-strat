"use strict";

// Favorites-only alert scope in the rule engine (ALERT_FAVS_UNIVERSES).
//
// The gate: a coin is alert-eligible when its universe is in ALERT_UNIVERSES
// (broadcast, unchanged) OR its universe is in ALERT_FAVS_UNIVERSES and the
// coin matches the favorites union by the SAME rule delivery uses.
//
// The hazard the silent baseline exists for: this engine fires on TRANSITIONS,
// so a coin evaluated for the first time has no prior state and every signal
// already in force reads as brand new. Favoriting a perp mid-session would
// otherwise dump its whole in-force set into the operator's phone at once.
// node builtins only: node --test

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRuleEngine } = require("../src/rules.js");

function makeConfig(overrides) {
  const base = {
    ftfcTfs: ["1h"],
    quietHoursUtc: null,
    rules: {
      live_signal: { enabled: false, tfs: ["1h"], kinds: ["rev"] },
      invalidation: { enabled: false },
      score_cross: { enabled: false, threshold: 60, rearm: 45 },
      ftfc_flip: { enabled: false, rearmSec: 0 },
      price_level: { enabled: false, levels: {}, rearmPct: 0 },
      rvol_spike: { enabled: false, threshold: 3.0 },
      move_spike: { enabled: false, mult: 3, minPct: 0.75 }
    }
  };
  for (const k of Object.keys(overrides.rules || {})) {
    Object.assign(base.rules[k], overrides.rules[k]);
  }
  if (overrides.ftfcTfs) base.ftfcTfs = overrides.ftfcTfs;
  return base;
}

function makeEngine(configOverrides, engineOpts) {
  const sent = [];
  const opts = Object.assign({ statePath: null }, engineOpts || {});
  const engine = createRuleEngine(makeConfig(configOverrides), function (msg, meta) {
    sent.push(msg);
    sent.meta = meta;
    return true;
  }, opts);
  return { engine, sent };
}

// A coin whose 1h slot carries one live rev signal on the given forming bar.
// Advancing barT is a genuine new-bar transition (the dedup key includes it).
function liveCoin(name, sym, uni, barT) {
  return {
    name: name, sym: sym, uni: uni, mid: 199.0, hist: [], ctx: null,
    tf: {
      "1h": {
        closed: [{ t: 1, o: 197, h: 199, l: 196, c: 198 },
                 { t: 2, o: 198, h: 198.8, l: 197.6, c: 198.5 }],
        forming: { t: barT, T: barT + 3600000, o: 198.5, h: 199.1, l: 198.3, c: 199.0, v: 10 },
        an: {
          types: [null, "2U"], formingType: "2U", formingDir: "up", completed: null,
          setups: [], invalidated: false,
          live: [{ name: "2D-1-2U", dir: "up", entry: 198.88, stop: 197.59, target: 199.40, kind: "rev" }]
        }
      }
    }
  };
}

// One xyz coin (broadcast scope) + one perps coin (favorites scope).
function mixedState(barT) {
  return {
    order: ["xyz:NVDA", "BTC"],
    coins: {
      "xyz:NVDA": liveCoin("xyz:NVDA", "NVDA", "xyz", barT),
      "BTC": liveCoin("BTC", "BTC", "perps", barT)
    }
  };
}

const LIVE_ONLY = { rules: { live_signal: { enabled: true } } };

function favsOpts(favs) {
  return {
    alertUniverses: ["xyz"],
    alertFavsUniverses: ["perps"],
    favUnion: function () { return favs; }
  };
}

// ---- the scope gate ----

test("a FAVORITED perp fires on a genuine transition (after its baseline)", function () {
  const { engine, sent } = makeEngine(LIVE_ONLY, favsOpts(["BTC"]));
  engine.evaluateAll(mixedState(1000));
  assert.deepStrictEqual(sent.filter(function (m) { return / BTC /.test(m); }), [],
    "scope-entry pass is silent");
  engine.evaluateAll(mixedState(2000));            // new 1h bar = new signal
  const btc = sent.filter(function (m) { return /^\[LIVE\] BTC /.test(m); });
  assert.strictEqual(btc.length, 1);
});

test("a NON-favorited perp never fires and mints no rule state", function () {
  const { engine, sent } = makeEngine(LIVE_ONLY, favsOpts(["SOL"]));
  for (const barT of [1000, 2000, 3000]) engine.evaluateAll(mixedState(barT));
  assert.strictEqual(sent.some(function (m) { return /BTC/.test(m); }), false);
  const keys = Object.keys(engine._state.liveFired);
  assert.strictEqual(keys.some(function (k) { return k.indexOf("BTC|") === 0; }), false);
  assert.strictEqual("BTC" in engine._state.favScoped, false,
    "an out-of-scope coin is skipped before any state is created");
});

test("an EMPTY favorites union scopes in nothing (no phone with favs = no perps alerts)", function () {
  const { engine, sent } = makeEngine(LIVE_ONLY, favsOpts([]));
  engine.evaluateAll(mixedState(1000));
  engine.evaluateAll(mixedState(2000));
  assert.strictEqual(sent.some(function (m) { return /BTC/.test(m); }), false);
});

test("favorites match by coin NAME or SYM - the same rule delivery uses", function () {
  // The dashboard favorites by coin.name, the mobile app by sym; both must scope.
  for (const fav of ["xyz:NVDA", "NVDA"]) {
    const { engine, sent } = makeEngine(LIVE_ONLY, {
      alertUniverses: [],                    // nothing broadcasts
      alertFavsUniverses: ["xyz"],
      favUnion: function () { return [fav]; }
    });
    engine.evaluateAll(mixedState(1000));
    engine.evaluateAll(mixedState(2000));
    assert.strictEqual(sent.length, 1, "fav '" + fav + "' should scope the coin in");
    assert.match(sent[0], /^\[LIVE\] NVDA /);
  }
});

test("the union is intersected with the ROSTER - unknown favorites are inert", function () {
  // Favorites are client strings: a delisted coin, a typo, or a symbol the
  // worker does not track can all sit in the union forever. Scope is decided
  // by walking loopState.order, so a favorite with no matching coin simply
  // never selects anything - it cannot mint state or throw.
  const { engine, sent } = makeEngine(LIVE_ONLY,
    favsOpts(["DELISTED", "typo", "BTC", "xyz:NVDA"]));
  engine.evaluateAll(mixedState(1000));
  engine.evaluateAll(mixedState(2000));
  assert.deepStrictEqual(Object.keys(engine._state.favScoped), ["BTC"],
    "only the roster coin in a favorites universe was scoped in");
  const syms = sent.map(function (m) { return m.split(" ")[1]; }).sort();
  assert.deepStrictEqual(syms, ["BTC", "NVDA", "NVDA"],
    "xyz fires on both passes (broadcast); BTC fires once, after its baseline");
});

test("the documented sym sharp edge extends to SCOPE, not just delivery", function () {
  // push.js warns that sym matching is cross-universe. A favorite of "NVDA"
  // meant for the xyz coin also scopes in a perps coin that happens to carry
  // sym NVDA. Pinned so the behavior is a known cost, not a surprise: clients
  // that care must favorite by coin NAME.
  const state = mixedState(1000);
  state.coins.BTC.sym = "NVDA";
  const { engine } = makeEngine(LIVE_ONLY, favsOpts(["NVDA"]));
  engine.evaluateAll(state);
  assert.strictEqual("BTC" in engine._state.favScoped, true);
});

test("the union is re-read EVERY pass, so a mid-session favorite takes effect", function () {
  let favs = [];
  const { engine, sent } = makeEngine(LIVE_ONLY, {
    alertUniverses: ["xyz"],
    alertFavsUniverses: ["perps"],
    favUnion: function () { return favs; }
  });
  engine.evaluateAll(mixedState(1000));           // not favorited yet
  assert.strictEqual("BTC" in engine._state.favScoped, false);
  favs = ["BTC"];                                  // the phone re-registers
  engine.evaluateAll(mixedState(2000));           // scope entry -> baseline
  assert.strictEqual(sent.some(function (m) { return /BTC/.test(m); }), false);
  assert.strictEqual("BTC" in engine._state.favScoped, true);
  engine.evaluateAll(mixedState(3000));
  assert.strictEqual(sent.filter(function (m) { return /^\[LIVE\] BTC /.test(m); }).length, 1);
});

// ---- the silent baseline ----

test("SILENT BASELINE: a coin entering scope with an in-force signal fires NOTHING", function () {
  const { engine, sent } = makeEngine(LIVE_ONLY, favsOpts(["BTC"]));
  const st = mixedState(1000);
  engine.evaluateAll(st);
  assert.strictEqual(sent.filter(function (m) { return /BTC/.test(m); }).length, 0);
  // ...but the state IS recorded, which is what makes the next pass a
  // transition rather than another first sighting.
  assert.strictEqual("BTC|1h|1000|2D-1-2U" in engine._state.liveFired, true,
    "the dedup key is written even though nothing was delivered");
  engine.evaluateAll(st);                         // unchanged world
  assert.strictEqual(sent.filter(function (m) { return /BTC/.test(m); }).length, 0);
  engine.evaluateAll(mixedState(2000));           // NEXT genuine transition
  assert.strictEqual(sent.filter(function (m) { return /^\[LIVE\] BTC /.test(m); }).length, 1);
});

test("the baseline covers EVERY rule, not just live_signal", function () {
  // A coin entering scope already above the score threshold, already in full
  // FTFC alignment and already past a price level must arm all three silently.
  const cfg = {
    rules: {
      live_signal: { enabled: true },
      score_cross: { enabled: true, threshold: 0 },   // any score crosses
      ftfc_flip: { enabled: true },
      price_level: { enabled: true, levels: { BTC: [100] } }
    }
  };
  const { engine, sent } = makeEngine(cfg, favsOpts(["BTC"]));
  engine.evaluateAll(mixedState(1000));
  assert.deepStrictEqual(sent.filter(function (m) { return /BTC/.test(m); }), []);
  assert.strictEqual("BTC" in engine._state.scoreArm, true, "score_cross armed silently");
  assert.strictEqual("BTC" in engine._state.ftfcState, true, "ftfc_flip baselined");
  assert.strictEqual("BTC|100" in engine._state.levelSides, true, "price_level side recorded");
});

test("the baseline suppresses delivery but is not counted as a fired alert", function () {
  const { engine, sent } = makeEngine(LIVE_ONLY, favsOpts(["BTC"]));
  engine.evaluateAll(mixedState(1000));
  assert.strictEqual(engine.alertsFired(), 1, "only the xyz coin actually alerted");
  assert.strictEqual(sent.length, 1);
});

test("leaving scope keeps dedup state; RE-entry baselines again", function () {
  // Decision recorded here because the task text admits two readings: a
  // re-entering coin has not been evaluated while it was out of scope, so its
  // recorded verdict has aged. Re-baselining can only ever COST one alert;
  // skipping the baseline could fire off a stale verdict - the same hazard
  // dropCoins guards against for re-listed names. The safe branch wins.
  let favs = ["BTC"];
  const { engine, sent } = makeEngine(LIVE_ONLY, {
    alertUniverses: ["xyz"],
    alertFavsUniverses: ["perps"],
    favUnion: function () { return favs; }
  });
  engine.evaluateAll(mixedState(1000));                 // baseline
  favs = [];                                            // un-favorited
  engine.evaluateAll(mixedState(2000));
  assert.strictEqual("BTC" in engine._state.favScoped, false, "marker cleared on exit");
  assert.strictEqual("BTC|1h|1000|2D-1-2U" in engine._state.liveFired, true,
    "dedup state is KEPT so a re-favorite cannot replay an already-alerted bar");
  favs = ["BTC"];                                       // re-favorited
  engine.evaluateAll(mixedState(3000));
  assert.strictEqual(sent.some(function (m) { return /BTC/.test(m); }), false,
    "re-entry baselines rather than firing on a verdict formed while out of scope");
  engine.evaluateAll(mixedState(4000));
  assert.strictEqual(sent.filter(function (m) { return /^\[LIVE\] BTC /.test(m); }).length, 1);
});

test("boot is a scope-ENTRY event: a restart re-baselines silently (review)", function () {
  // Task 025 lists boot beside new-favorite and env change as baseline events.
  // Reloading favScoped made the first post-restart evaluation LIVE, so
  // transitions accumulated during downtime burst at startup. The dedup maps
  // still persist: an already-alerted bar can never replay either way.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "favscope-"));
  const statePath = path.join(dir, "rule_state.json");
  try {
    const a = makeEngine(LIVE_ONLY, Object.assign(favsOpts(["BTC"]), { statePath: statePath }));
    a.engine.evaluateAll(mixedState(1000));
    a.engine.persistNow();

    const b = makeEngine(LIVE_ONLY, Object.assign(favsOpts(["BTC"]), { statePath: statePath }));
    assert.strictEqual(Object.keys(b.engine._state.favScoped).length, 0,
      "favScoped never survives a reload");
    assert.strictEqual("BTC|1h|1000|2D-1-2U" in b.engine._state.liveFired, true,
      "dedup state DOES survive - no replay of the already-alerted bar");
    b.engine.evaluateAll(mixedState(2000));
    assert.strictEqual(b.sent.filter(function (m) { return /^\[LIVE\] BTC /.test(m); }).length, 0,
      "the downtime transition (bar 1000 -> 2000) is absorbed by the boot baseline");
    b.engine.evaluateAll(mixedState(3000));
    assert.strictEqual(b.sent.filter(function (m) { return /^\[LIVE\] BTC /.test(m); }).length, 1,
      "the next LIVE transition after the baseline fires normally");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty-tf favored coin does NOT consume its baseline (review)", function () {
  // Roster recovery registers coins with tf:{}. Marking favScoped then would
  // make the first REAL observation - candles arriving with an already-live
  // signal - fire as if it were a transition. Same class as the 2026-08-07
  // ftfc_flip empty-tf finding.
  const { engine, sent } = makeEngine(LIVE_ONLY, favsOpts(["BTC"]));
  const empty = { order: ["BTC"], coins: { "BTC": {
    name: "BTC", sym: "BTC", uni: "perps", mid: 199, hist: [], ctx: null, tf: {}
  } } };
  engine.evaluateAll(empty);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(engine._state.favScoped, "BTC"), false,
    "no analysis, no baseline consumed");
  const withData = { order: ["BTC"], coins: { "BTC": liveCoin("BTC", "BTC", "perps", 1000) } };
  engine.evaluateAll(withData);
  assert.strictEqual(sent.filter(function (m) { return /^\[LIVE\] BTC /.test(m); }).length, 0,
    "the first evaluable pass is the silent baseline, not a fire");
  engine.evaluateAll({ order: ["BTC"], coins: { "BTC": liveCoin("BTC", "BTC", "perps", 2000) } });
  assert.strictEqual(sent.filter(function (m) { return /^\[LIVE\] BTC /.test(m); }).length, 1,
    "the next genuine transition fires");
});

test("a favorite named 'constructor' still baselines silently (review)", function () {
  const { engine, sent } = makeEngine(LIVE_ONLY, favsOpts(["constructor"]));
  const state = { order: ["constructor"], coins: {
    "constructor": liveCoin("constructor", "constructor", "perps", 1000)
  } };
  engine.evaluateAll(state);
  assert.strictEqual(sent.length, 0,
    "prototype members must not read as an already-consumed baseline");
});

test("rules null rvol outside the loop's true-up scope (review)", function () {
  // A favorited perp's volume is frozen at the roll-time sample, so a raw
  // rvol15 is a decayed number apistate already refuses to serve. The rules
  // engine must feed heatScore and rvol_spike the same null via the SHARED
  // predicate (universes.volumeFresh), keyed off loopState.trueUpUniverses.
  // barIdx advances the forming 15m bar between passes: the silent baseline
  // pass records the rvol dedup key for ITS bar, so only a NEW bar can prove
  // a fire (rvol15's elapsed clamps to a full bar, so the epoch-anchored
  // timestamps still yield rvol = 100/10 = 10 under the real clock).
  function volCoin(uni, barIdx) {
    const closes = [];
    for (let i = 0; i < barIdx; i++) {
      closes.push({ t: i * 900000, T: (i + 1) * 900000 - 1, o: 100, h: 101, l: 99, c: 100, v: 10 });
    }
    const barT = barIdx * 900000;
    return { name: "BTC", sym: "BTC", uni: uni, mid: 102, hist: [], ctx: null, tf: {
      "15m": { closed: closes,
               forming: { t: barT, T: barT + 900000, o: 100, h: 102, l: 100, c: 102, v: 100 },
               an: null }
    } };
  }
  const mk = function () {
    return makeEngine({ rules: { rvol_spike: { enabled: true, threshold: 3.0 } } },
      favsOpts(["BTC"]));
  };
  // Scoped state: perps outside trueUpUniverses -> rv null -> no RVOL alert,
  // on the SECOND pass either (the first is the scope-entry baseline).
  const scoped = mk();
  scoped.engine.evaluateAll({ order: ["BTC"], coins: { "BTC": volCoin("perps", 25) },
    trueUpUniverses: ["xyz"] });
  scoped.engine.evaluateAll({ order: ["BTC"], coins: { "BTC": volCoin("perps", 26) },
    trueUpUniverses: ["xyz"] });
  assert.strictEqual(scoped.sent.filter(function (m) { return /^\[RVOL\]/.test(m); }).length, 0,
    "frozen-volume rvol must not fire rvol_spike");
  // Same fixture INSIDE the scope: the spike fires on the post-baseline bar
  // (proves the fixture and that the gate - not the data - discriminates).
  const fresh = mk();
  fresh.engine.evaluateAll({ order: ["BTC"], coins: { "BTC": volCoin("perps", 25) },
    trueUpUniverses: ["xyz", "perps"] });
  fresh.engine.evaluateAll({ order: ["BTC"], coins: { "BTC": volCoin("perps", 26) },
    trueUpUniverses: ["xyz", "perps"] });
  assert.strictEqual(fresh.sent.filter(function (m) { return /^\[RVOL\]/.test(m); }).length, 1,
    "in-scope volume still fires - the gate discriminates, not the fixture");
});

test("loop keeps a supplied EMPTY true-up scope empty (review)", function () {
  // An empty broadcast alert scope must not silently expand into all-tracked
  // true-up demand - that is the exact all-perps candle burst the demand cut removed.
  const { createLoop } = require("../src/loop.js");
  const scoped = createLoop({}, { universes: [{ id: "perps", dex: null }],
    trueUpUniverses: [], log: function () {} });
  assert.deepStrictEqual(scoped.state.trueUpUniverses, [],
    "[] means NO true-up universes, not all of them");
  const legacy = createLoop({}, { universes: [{ id: "perps", dex: null }],
    log: function () {} });
  assert.deepStrictEqual(legacy.state.trueUpUniverses, ["perps"],
    "unsupplied still resolves to all tracked (legacy single-universe behavior)");
});

test("dropCoins clears the scope marker so a re-listed name baselines fresh", function () {
  const { engine } = makeEngine(LIVE_ONLY, favsOpts(["BTC"]));
  engine.evaluateAll(mixedState(1000));
  assert.strictEqual("BTC" in engine._state.favScoped, true);
  engine.dropCoins(["BTC"]);
  assert.strictEqual("BTC" in engine._state.favScoped, false);
});

// ---- broadcast wins ----

test("broadcast wins at the gate too: a universe in BOTH lists never baselines", function () {
  // The parse already drops such an id from the favorites list; the gate
  // checks broadcast FIRST as well, so neither layer can narrow xyz.
  const { engine, sent } = makeEngine(LIVE_ONLY, {
    alertUniverses: ["xyz", "perps"],
    alertFavsUniverses: ["perps"],
    favUnion: function () { return []; }        // nobody favorited anything
  });
  engine.evaluateAll(mixedState(1000));
  assert.strictEqual(sent.length, 2, "both coins fire immediately, no baseline pass");
  assert.strictEqual("BTC" in engine._state.favScoped, false);
});

// ---- xyz is untouched ----

test("xyz alerting is byte-identical with the feature enabled", function () {
  const stream = [1000, 2000, 3000, 4000];
  const cfg = {
    rules: {
      live_signal: { enabled: true },
      score_cross: { enabled: true, threshold: 0 },
      ftfc_flip: { enabled: true },
      move_spike: { enabled: true }
    }
  };
  const before = makeEngine(cfg, { alertUniverses: ["xyz"] });
  const after = makeEngine(cfg, favsOpts([]));            // feature on, no perps favs
  for (const barT of stream) {
    before.engine.evaluateAll(mixedState(barT));
    after.engine.evaluateAll(mixedState(barT));
  }
  assert.ok(before.sent.length > 0, "the fixture stream actually produces alerts");
  assert.deepStrictEqual(after.sent, before.sent);
  assert.strictEqual(after.engine.alertsFired(), before.engine.alertsFired());
});

test("xyz alerting is byte-identical even WITH a perps favorite in scope", function () {
  const cfg = { rules: { live_signal: { enabled: true } } };
  const before = makeEngine(cfg, { alertUniverses: ["xyz"] });
  const after = makeEngine(cfg, favsOpts(["BTC"]));
  for (const barT of [1000, 2000, 3000]) {
    before.engine.evaluateAll(mixedState(barT));
    after.engine.evaluateAll(mixedState(barT));
  }
  const onlyXyz = function (m) { return /NVDA/.test(m); };
  assert.deepStrictEqual(after.sent.filter(onlyXyz), before.sent.filter(onlyXyz));
});

test("legacy callers (no scope opts at all) evaluate every coin, unchanged", function () {
  const { engine, sent } = makeEngine(LIVE_ONLY);
  engine.evaluateAll(mixedState(1000));
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(Object.keys(engine._state.favScoped).length, 0);
});

test("alertFavsUniverses without a favUnion callback is simply off", function () {
  const { engine, sent } = makeEngine(LIVE_ONLY, {
    alertUniverses: ["xyz"], alertFavsUniverses: ["perps"]
  });
  engine.evaluateAll(mixedState(1000));
  engine.evaluateAll(mixedState(2000));
  assert.strictEqual(sent.some(function (m) { return /BTC/.test(m); }), false);
});

// ---- rvol_spike stays inert for perps ----

// A perps coin with 21 quiet closed 15m bars and a forming bar carrying huge
// volume. `closedVol` 0 makes the trailing average 0, which is how rvol15
// reports "no usable volume baseline" - null.
function volCoin(closedVol, formingVol, barT) {
  const closed = [];
  for (let i = 0; i < 21; i++) {
    closed.push({ t: i * 900000, o: 100, h: 100.05, l: 99.95, c: 100, v: closedVol });
  }
  return {
    name: "BTC", sym: "BTC", uni: "perps", mid: 100, hist: [], ctx: null,
    tf: {
      "15m": {
        closed: closed,
        forming: { t: barT, T: barT + 900000, o: 100, h: 100, l: 100, c: 100, v: formingVol },
        an: null
      }
    }
  };
}
function volState(coin) {
  return { order: ["BTC"], coins: { BTC: coin } };
}

test("rvol_spike does NOT fire for a favs-scoped perp when rvol is null", function () {
  const { engine, sent } = makeEngine(
    { rules: { rvol_spike: { enabled: true, threshold: 3.0 } } }, favsOpts(["BTC"]));
  engine.evaluateAll(volState(volCoin(0, 1e9, 1000)));     // baseline pass
  engine.evaluateAll(volState(volCoin(0, 1e9, 2000)));     // new bar, still null
  assert.deepStrictEqual(sent, [],
    "the rule self-gates on rv !== null, so threshold-beating volume is irrelevant");
  assert.deepStrictEqual(Object.keys(engine._state.rvolFired), []);
});

test("rvol_spike stays below threshold on the frozen roll-time volume sample", function () {
  // Perps is outside the 15m true-up scope, so its forming-bar volume is
  // frozen at whatever the bar-roll refetch sampled - a small slice of a bar.
  // That is the mechanism that keeps rvol_spike quiet for perps in production
  // (apistate serves rvol null for the same reason).
  const { engine, sent } = makeEngine(
    { rules: { rvol_spike: { enabled: true, threshold: 3.0 } } }, favsOpts(["BTC"]));
  engine.evaluateAll(volState(volCoin(1000, 60, 1000)));   // baseline
  engine.evaluateAll(volState(volCoin(1000, 60, 2000)));
  assert.deepStrictEqual(sent, []);
});

test("rvol_spike DOES still fire for a broadcast xyz coin (rule not disabled globally)", function () {
  const { engine, sent } = makeEngine(
    { rules: { rvol_spike: { enabled: true, threshold: 3.0 } } },
    { alertUniverses: ["xyz"], alertFavsUniverses: ["perps"], favUnion: function () { return []; } });
  const coin = volCoin(1000, 1e6, 1000);
  coin.name = "xyz:NVDA"; coin.sym = "NVDA"; coin.uni = "xyz";
  engine.evaluateAll({ order: ["xyz:NVDA"], coins: { "xyz:NVDA": coin } });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^\[RVOL\] NVDA /);
});

// ---- move_spike and the transition rules DO fire for favs-scoped perps ----

test("move_spike fires for a favs-scoped perp (mid/candle inputs, already fetched)", function () {
  const { engine, sent } = makeEngine(
    { rules: { move_spike: { enabled: true, mult: 3, minPct: 0.75 } } }, favsOpts(["BTC"]));
  const quiet = volCoin(1000, 100, 1000);
  engine.evaluateAll(volState(quiet));                     // baseline, mid == last close
  const spiked = volCoin(1000, 100, 2000);
  spiked.mid = 102;                                        // +2% off the 100 close
  spiked.tf["15m"].forming.h = 102;
  engine.evaluateAll(volState(spiked));
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /^\[SPIKE\] BTC \+2\.0% in 15m/);
});

test("the alert meta carries the coin identity delivery scopes on", function () {
  const { engine, sent } = makeEngine(LIVE_ONLY, favsOpts(["BTC"]));
  engine.evaluateAll(mixedState(1000));
  engine.evaluateAll(mixedState(2000));
  assert.deepStrictEqual(sent.meta, { coin: "BTC", sym: "BTC" },
    "so push.recipients can run the SAME favMatches the scope gate ran");
});
