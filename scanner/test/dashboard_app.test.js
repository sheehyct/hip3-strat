"use strict";

// Headless regression tests for the DASHBOARD's app layer (the JS above the
// STRAT-CORE block in hip3_strat_screener.html): favorites pinning, breadth,
// magnitude progress, signal chips, view modes, sparklines, per-TF % change,
// CSV export, chart SVG, and the universe switcher plumbing. The DOM/localStorage/fetch are stubbed
// just enough to load the inline script; assertions drive the pure logic with
// synthetic coins. STRAT-CORE itself is covered by extract_core --check and
// the parity harness - this file deliberately never exercises detection.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const HTML_PATH = path.resolve(__dirname, "..", "hip3_strat_screener.html");

function loadApp(initialStore) {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const store = Object.assign({}, initialStore || {});
  const elements = {};
  const el = (id) => {
    if (!elements[id]) elements[id] = {
      innerHTML: "", style: {}, textContent: "",
      addEventListener: () => {}, getAttribute: () => null, appendChild: () => {},
      classList: { toggle: () => {}, add: () => {}, remove: () => {} }
    };
    return elements[id];
  };
  const sandbox = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    },
    document: {
      getElementById: el, querySelectorAll: () => [], hidden: true,
      createElement: () => ({ className: "", textContent: "", title: "",
        addEventListener: () => {}, setAttribute: () => {}, appendChild: () => {} })
    },
    // Delegating fetch: tests swap sandbox.fetchImpl AFTER load to script
    // response sequences (the hostedTick single-flight and re-seed tests).
    fetch: (...a) => sandbox.fetchImpl(...a),
    fetchImpl: () => Promise.reject(new Error("offline test")),
    navigator: {},
    setInterval: () => 0,
    setTimeout: () => 0,
    URL: { createObjectURL: () => "blob:", revokeObjectURL: () => {} },
    Blob: function () {}
  };
  // The inline script references these as bare globals.
  const fn = new Function(
    "window", "localStorage", "document", "fetch", "navigator",
    "setInterval", "setTimeout", "URL", "Blob",
    src + `
;return {state:state, UNIS:UNIS, curUni:curUni, dexBody:dexBody,
 coinCategory:coinCategory, rowsSorted:rowsSorted, renderBreadth:renderBreadth,
 renderHead:renderHead, toggleFav:toggleFav, isFav:isFav, starSpan:starSpan,
 coinSummary:coinSummary, sigChips:sigChips, magProgress:magProgress, heatScore:heatScore,
 momentum:momentum, tr1hAvgPct:tr1hAvgPct, tfNeeded:tfNeeded,
 simpleCandidate:simpleCandidate, simpleFocusRank:simpleFocusRank,
 simpleTrendPct:simpleTrendPct, simpleProgressHTML:simpleProgressHTML, trendTF:trendTF,
 targetRankItem:targetRankItem, simpleDistRank:simpleDistRank,
 simpleMagLeftRank:simpleMagLeftRank, simpleToTargetHTML:simpleToTargetHTML,
 distToTargetPct:distToTargetPct, magRemaining:magRemaining,
 colVisible:colVisible, COL_KEYS:COL_KEYS, saveHiddenCols:saveHiddenCols,
 patFamily:patFamily, PAT_IDS:PAT_IDS,
 simpleRowHTML:simpleRowHTML, sparkSVG:sparkSVG, setView:setView, render:render,
 tfPct:tfPct, csvString:csvString, chartSVG:chartSVG, chartBlock:chartBlock,
 detailHTML:detailHTML, TFS:TFS, coinDominoChains:coinDominoChains,
 renderDominos:renderDominos, activeTFs:activeTFs,
 setUniverse:setUniverse, jsonApiHref:jsonApiHref, syncJsonLink:syncJsonLink,
 alertScopeSpan:alertScopeSpan, loadAlertScope:loadAlertScope,
 defaultFilters:defaultFilters, applyPreset:applyPreset, saveFilters:saveFilters,
 favNames:favNames, coinUni:coinUni,
 tvSymbol:tvSymbol, tvHref:tvHref, openDrawer:openDrawer, closeDrawer:closeDrawer,
 sigStage:sigStage, matchedItems:matchedItems, sigDimsActive:sigDimsActive,
 maxLevMeta:maxLevMeta, parseVolAmount:parseVolAmount, volDimsInView:volDimsInView,
 syncVolControls:syncVolControls,
 hostedApplyState:hostedApplyState, hostedRebuildDerivedBars:hostedRebuildDerivedBars,
 hostedTick:hostedTick, hostedPollCtl:hostedPollCtl, hostedLoad:hostedLoad,
 hostedPoll:hostedPoll, hostedTickUni:hostedTickUni, otherUni:otherUni,
 toggleTF:toggleTF, slowLayer:slowLayer, slowFtfcRank:slowFtfcRank,
 applySort:applySort, sortKeyLabel:sortKeyLabel, syncSortChip:syncSortChip,
 loadLayouts:loadLayouts, layouts:layouts, applyLayout:applyLayout,
 saveNamedLayout:saveNamedLayout, TF_DEFAULT_IDS:TF_DEFAULT_IDS,
 chgUtcLocal:chgUtcLocal, snapshotLayout:snapshotLayout,
 forcedStandalone:forcedStandalone, dataModeSpan:dataModeSpan,
 SCORE_TF_IDS:SCORE_TF_IDS, scoreTFs:scoreTFs};`
  );
  const app = fn(
    sandbox, sandbox.localStorage, sandbox.document, sandbox.fetch,
    sandbox.navigator, sandbox.setInterval, sandbox.setTimeout,
    sandbox.URL, sandbox.Blob
  );
  return { app, el, store, sandbox };
}

function mkCoin(name, formingType, dir) {
  return {
    name: "xyz:" + name, sym: name,
    ctx: { prevDayPx: "100", markPx: "101", dayNtlVlm: "5000" },
    mid: 101, hist: [],
    tf: {
      "1d": {
        closed: [{ t: 0, T: 1, o: 100, h: 102, l: 99, c: 100, v: 10 }],
        forming: { t: 1, T: 9e15, o: 100, h: 102, l: 99, c: 101, v: 10 },
        an: { types: ["2U", "1"], formingType: formingType, formingDir: dir,
              live: [], setups: [], invalidated: false, completed: null }
      }
    }
  };
}

function seedXyz(app) {
  app.state.coins["xyz:AAA"] = mkCoin("AAA", "2U", "up");
  app.state.coins["xyz:BBB"] = mkCoin("BBB", "2D", "down");
  app.state.coins["xyz:CCC"] = mkCoin("CCC", "1", "flat");
  app.UNIS.xyz.order = ["xyz:AAA", "xyz:BBB", "xyz:CCC"];
  app.state.order = app.UNIS.xyz.order;
  app.TFS.forEach((tf) => { tf.active = tf.id === "1d"; });
}

test("favorites: pin floats to top of any sort, Favs filter, persistence", () => {
  const { app, store } = loadApp();
  seedXyz(app);
  assert.equal(app.state.favs.length, 0);
  app.toggleFav("xyz:CCC");
  assert.ok(app.isFav("xyz:CCC"));
  assert.equal(JSON.parse(store["hip3-favs"])[0], "xyz:CCC");
  assert.equal(app.rowsSorted()[0].coin.name, "xyz:CCC");
  app.state.filters.favs = true;
  const rows = app.rowsSorted();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].coin.sym, "CCC");
  app.state.filters.favs = false;
  app.toggleFav("xyz:CCC");
  assert.ok(!app.isFav("xyz:CCC"));
  assert.ok(app.starSpan("xyz:AAA").indexOf('class="star"') >= 0);
});

test("breadth: forming-type distribution across the universe", () => {
  const { app, el } = loadApp();
  seedXyz(app);
  app.renderBreadth();
  const html = el("breadth").innerHTML;
  assert.ok(html.indexOf('class="b-tf">D<') >= 0);
  assert.ok(html.indexOf("2U 1") >= 0);
  assert.ok(html.indexOf("2D 1") >= 0);
  assert.equal((html.match(/33\.3%/g) || []).length, 3);
});

test("magProgress: direction-aware, trigger fallback, null without target", () => {
  const { app } = loadApp();
  assert.equal(Math.round(app.magProgress({ dir: "up", entry: 100, target: 110 }, 104)), 40);
  assert.equal(Math.round(app.magProgress({ dir: "down", entry: 100, target: 90 }, 96)), 40);
  assert.ok(app.magProgress({ dir: "up", entry: 100, target: 110 }, 98) < 0);
  assert.equal(app.magProgress({ dir: "up", entry: 100, target: null }, 104), null);
  assert.equal(Math.round(app.magProgress({ dir: "up", trigger: 100, target: 110 }, 105)), 50);
  // negative leg is scaled to the STOP distance: -100% = at the stop
  // (design decision 2026-07-07; target-scaled fallback when stop unusable)
  assert.equal(Math.round(app.magProgress({ dir: "up", entry: 100, target: 110, stop: 95 }, 97.5)), -50);
  assert.equal(Math.round(app.magProgress({ dir: "down", entry: 100, target: 90, stop: 105 }, 102.5)), -50);
  assert.equal(Math.round(app.magProgress({ dir: "up", entry: 100, target: 110, stop: 95 }, 95)), -100);
});

test("chips: live magnitude + named per-TF setup chips", () => {
  const { app } = loadApp();
  seedXyz(app);
  const aaa = app.state.coins["xyz:AAA"];
  aaa.tf["1d"].an.live = [{ name: "2D-1-2U", dir: "up", kind: "rev", entry: 100, stop: 99, target: 110 }];
  aaa.tf["1d"].an.setups = [{ name: "3-1-2D", dir: "down", kind: "rev", trigger: 99, stop: 102, target: 95 }];
  aaa.mid = 104;
  const sum = app.coinSummary(aaa);
  assert.equal(sum.setupList.length, 1);
  assert.equal(sum.setupList[0].tf, "D");
  const chips = app.sigChips(sum, aaa.mid);
  assert.ok(chips.indexOf("40%") >= 0 && chips.indexOf('class="mag"') >= 0);
  assert.ok(chips.indexOf("D 3-1-2D") >= 0);
});

test("view modes: Regular stays dense; Simple persists and reuses scan data", () => {
  const { app, el, store } = loadApp();
  seedXyz(app);
  const aaa = app.state.coins["xyz:AAA"];
  aaa.tf["1d"].an.live = [
    { name: "2D-1-2U", dir: "up", kind: "rev", entry: 100, stop: 98, target: 110 }
  ];
  aaa.mid = 104;
  aaa.tf["15m"] = {
    closed: [
      { c: 99 }, { c: 100 }, { c: 101 }, { c: 103 }
    ], forming: null, an: null
  };

  app.renderHead();
  app.render();
  const regularCount = app.rowsSorted().length;
  assert.equal(app.state.view, "regular");
  assert.ok(el("thead").innerHTML.includes("Funding/hr"));
  assert.ok(el("thead").innerHTML.includes("5m %"));
  assert.ok(!el("tbody").innerHTML.includes("simple-row"));

  app.setView("simple");
  assert.equal(app.state.view, "simple");
  assert.equal(app.state.sortKey, "focus");
  assert.equal(store["hip3-view"], "simple");
  assert.equal(app.rowsSorted().length, regularCount);
  // D2-c: the Command header carries the six wireframe groups; the levels
  // live under the Levels group (Entry/Stop/Target headers retired).
  assert.ok(el("thead").innerHTML.includes("Trend"));
  assert.ok(el("thead").innerHTML.includes("Levels"));
  assert.ok(el("thead").innerHTML.includes("Tgt %"));
  assert.ok(el("thead").innerHTML.includes("Attention"));
  assert.ok(!el("thead").innerHTML.includes("Funding/hr"));
  assert.ok(el("tbody").innerHTML.includes("simple-row"));
  assert.ok(el("tbody").innerHTML.includes("simple-spark"));
  assert.ok(el("tbody").innerHTML.includes("2D-1-2U"));
  assert.ok(el("tbody").innerHTML.includes("40%"));
  assert.equal(el("breadth").innerHTML, "");
  assert.equal(el("dominos").innerHTML, "");

  aaa.mid = 99;
  const oofRow = app.rowsSorted().find((row) => row.coin.name === "xyz:AAA");
  assert.match(app.simpleRowHTML(oofRow), /scan-focus oof/);
  assert.match(app.simpleRowHTML(oofRow), /signal not currently in force/);

  app.setView("regular");
  assert.equal(app.state.sortKey, "vol");
  assert.equal(store["hip3-view"], "regular");
  assert.ok(el("thead").innerHTML.includes("Funding/hr"));
  assert.ok(!el("tbody").innerHTML.includes("simple-row"));
});

test("Simple view restores preference and falls back from live to standing setup", () => {
  const { app } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);
  assert.equal(app.state.view, "simple");
  const aaa = app.state.coins["xyz:AAA"];
  aaa.tf["1d"].an.live = [];
  aaa.tf["1d"].an.setups = [
    { name: "3-1-2D", dir: "down", kind: "rev", trigger: 99, stop: 102, target: 95 }
  ];
  const item = app.simpleCandidate(app.coinSummary(aaa));
  assert.equal(item.status, "setup");
  assert.equal(item.sig.target, 95);
  assert.match(app.simpleProgressHTML(item, aaa.mid), /% away/);
});

test("Simple sort metrics match rendered trend and focus priority", () => {
  const { app } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);
  const aaa = app.state.coins["xyz:AAA"];
  const bbb = app.state.coins["xyz:BBB"];
  const ccc = app.state.coins["xyz:CCC"];
  [aaa, bbb, ccc].forEach((coin) => {
    coin.tf["15m"] = { closed: [{ c: 100 }], forming: null, an: null };
  });
  aaa.mid = 104;
  bbb.mid = 101;
  ccc.mid = 99;
  app.state.sortKey = "trend";
  app.state.sortDir = -1;
  assert.deepEqual(app.rowsSorted().map((row) => row.coin.sym), ["AAA", "BBB", "CCC"]);
  assert.equal(Math.round(app.simpleTrendPct(aaa)), 4);

  aaa.tf["1d"].an.live = [
    { name: "2D-1-2U", dir: "up", kind: "rev", entry: 100, stop: 98, target: 110 }
  ];
  bbb.tf["1d"].an.setups = [
    { name: "3-1-2D", dir: "down", kind: "rev", trigger: 99, stop: 102, target: 95 }
  ];
  ccc.tf["1d"].an.live = [
    { name: "2U-1-2D", dir: "down", kind: "rev", entry: 100, stop: 102, target: 95 }
  ];
  ccc.tf["1d"].an.invalidated = true;
  app.state.sortKey = "focus";
  app.state.sortDir = -1;
  assert.deepEqual(app.rowsSorted().map((row) => row.coin.sym), ["AAA", "BBB", "CCC"]);

  ccc.tf["1d"].an.live[0].rev3 = true;
  const rev3 = app.simpleCandidate(app.coinSummary(ccc));
  assert.equal(rev3.status, "live");
});

test("tfPct + pct_ sort + CSV export of the current view", () => {
  const { app, el } = loadApp();
  seedXyz(app);
  const ddd = mkCoin("DDD", "2U", "up");
  ddd.mid = 102;
  app.state.coins["xyz:DDD"] = ddd;
  app.UNIS.xyz.order.push("xyz:DDD");
  assert.ok(Math.abs(app.tfPct(ddd, "1d") - 2) < 1e-9);
  assert.equal(app.tfPct(mkCoin("X", "1", "flat"), "1w"), null);
  app.state.sortKey = "pct_1d"; app.state.sortDir = -1;
  assert.equal(app.rowsSorted()[0].coin.sym, "DDD");
  app.state.sortKey = "vol";
  const csv = app.csvString();
  assert.ok(csv.split("\n")[0].indexOf("D_seq") >= 0);
  assert.ok(csv.indexOf("D_chg_pct") >= 0);
  assert.equal(csv.split("\n").length, app.rowsSorted().length + 1);
  app.renderHead();
  assert.ok(el("thead").innerHTML.indexOf('data-k="pct_1d"') >= 0);
  assert.ok(el("thead").innerHTML.indexOf('title="') >= 0);
});

test("server CSV export and public JSON briefing link stay discoverable", () => {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  assert.match(html, /id="exportbtn"[^>]*>Export CSV<\/button>/);
  assert.match(html, /\/api\/briefing\/latest\.csv\?uni=/);
  assert.match(html, /id="jsonapi" href="\/api\/briefing\/latest\.json\?uni=xyz"/);
  assert.match(html, /served by this worker at \/api\/briefing\/latest\.json/);
});

test("JSON API link follows the active universe (boot + switch)", () => {
  const { app, el } = loadApp();
  seedXyz(app);
  // boot wiring already synced the link for the default universe
  assert.equal(el("jsonapi").href, "/api/briefing/latest.json?uni=xyz");
  app.setUniverse("perps");
  assert.equal(el("jsonapi").href, "/api/briefing/latest.json?uni=perps");
  assert.equal(app.jsonApiHref(), "/api/briefing/latest.json?uni=perps");
});

test("alert-scope chip: unknown renders nothing; scope renders; mismatch warns", () => {
  const { app, el } = loadApp();
  seedXyz(app);
  assert.equal(app.alertScopeSpan(), "");                    // null = unknown, chip absent
  app.state.alertScope = ["xyz"];
  assert.ok(app.alertScopeSpan().indexOf("alerts: xyz") >= 0);
  app.render();
  assert.ok(el("statusbar").innerHTML.indexOf("alerts: xyz") >= 0);
  app.state.universe = "perps";                              // viewing a non-alerting universe
  const warn = app.alertScopeSpan();
  assert.ok(warn.indexOf("alerts off for this universe") >= 0);
  assert.ok(warn.indexOf('class="warn"') >= 0);
  app.state.alertScope = [];                                 // real value: worker alerts on nothing
  assert.ok(app.alertScopeSpan().indexOf("scope: none") >= 0);
});

test("loadAlertScope: a failed /health fetch leaves the scope unknown (standalone-safe)", async () => {
  const { app } = loadApp();
  await app.loadAlertScope();          // sandbox fetch always rejects
  assert.equal(app.state.alertScope, null);
});

// ------------------------- Tier 1: composable filters -------------------------

test("coin dimensions: leverage floor and price ceiling compose; unknown lev never matches", () => {
  const { app } = loadApp();
  seedXyz(app);
  app.state.coins["xyz:AAA"].maxLeverage = 25;
  app.state.coins["xyz:BBB"].maxLeverage = null;   // venue did not say - honest unknown
  app.state.coins["xyz:CCC"].maxLeverage = 5;
  app.state.filters.levMin = 10;
  let rows = app.rowsSorted();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].coin.sym, "AAA");           // null NEVER passes a numeric floor
  app.state.filters.levMin = null;
  app.state.filters.pxMax = 100;                   // every seeded mid is 101
  assert.equal(app.rowsSorted().length, 0);
  app.state.filters.pxMax = 200;
  assert.equal(app.rowsSorted().length, 3);
  app.state.filters.levMin = 10;                   // dimensions COMPOSE
  rows = app.rowsSorted();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].coin.sym, "AAA");
});

test("signal dimensions match items, exclude rows, and Focus shows the MATCHED signal", () => {
  const { app } = loadApp();
  seedXyz(app);
  const aaa = app.state.coins["xyz:AAA"];
  aaa.tf["1d"].an.live = [
    { name: "2U-1-2U", dir: "up", kind: "cont", entry: 100, stop: 98, target: null }
  ];
  aaa.tf["1d"].an.setups = [
    { name: "3-1-2D", dir: "down", kind: "rev", trigger: 99, stop: 102, target: 95 }
  ];
  app.state.filters.stages = ["setup"];
  let rows = app.rowsSorted();
  assert.equal(rows.length, 1, "only the coin with a matching setup stays");
  assert.equal(rows[0].coin.sym, "AAA");
  // THE threading point: unfiltered, the live cont would outrank the setup;
  // under stages=[setup] the row must SHOW the setup that matched.
  const item = app.simpleCandidate(rows[0].sum, rows[0].coin.mid);
  assert.equal(item.status, "setup");
  assert.equal(item.sig.name, "3-1-2D");
  app.state.filters.dir = "up";                    // the matching setup is DOWN
  assert.equal(app.rowsSorted().length, 0);
  app.state.filters.dir = null;
  app.state.filters.tfs = ["W"];                   // signal lives on D
  assert.equal(app.rowsSorted().length, 0);
  app.state.filters.tfs = ["D"];
  assert.equal(app.rowsSorted().length, 1);
});

test("stage taxonomy derives from the canonical predicates only", () => {
  const { app } = loadApp();
  const liveSig = { name: "X", dir: "up", entry: 100, stop: 98, target: 110, kind: "rev" };
  assert.equal(app.sigStage({ status: "live", sig: liveSig }, 104), "live");
  assert.equal(app.sigStage({ status: "live", sig: liveSig }, 99), "recrossed");   // sigInForce false
  assert.equal(app.sigStage({ status: "live", sig: liveSig }, 111), "target");     // magProgress >= 100
  const noTarget = { name: "X", dir: "up", entry: 100, stop: 98, target: null, kind: "cont" };
  assert.equal(app.sigStage({ status: "live", sig: noTarget }, 200), "live");      // null target never "target"
  assert.equal(app.sigStage({ status: "inval", sig: liveSig }, 104), "inval");
  assert.equal(app.sigStage({ status: "cont", sig: noTarget }, 104), "cont");
  assert.equal(app.sigStage({ status: "setup", sig: liveSig }, 104), "setup");
});

test("Actionable preset keeps only in-force live reversals; All restores the board", () => {
  const { app } = loadApp();
  seedXyz(app);
  const aaa = app.state.coins["xyz:AAA"], bbb = app.state.coins["xyz:BBB"], ccc = app.state.coins["xyz:CCC"];
  aaa.tf["1d"].an.live = [{ name: "2D-1-2U", dir: "up", kind: "rev", entry: 100, stop: 98, target: 110 }];
  bbb.tf["1d"].an.live = [{ name: "2D-1-2U", dir: "up", kind: "rev", entry: 100, stop: 98, target: 110 }];
  bbb.mid = 99;                                    // recrossed: entry fired, price back inside
  ccc.tf["1d"].an.setups = [{ name: "3-2U", dir: "up", kind: "rev", trigger: 102, stop: 99, target: 110 }];
  app.applyPreset("actionable");
  assert.deepEqual(app.state.filters.stages, ["live"]);
  const rows = app.rowsSorted();
  assert.equal(rows.length, 1, "recrossed and setup-only coins are excluded");
  assert.equal(rows[0].coin.sym, "AAA");
  app.applyPreset("all");
  assert.equal(app.sigDimsActive(), false);
  assert.equal(app.rowsSorted().length, 3);
});

test("filters persist: whitelist restore from storage, saves round-trip", () => {
  const seeded = JSON.stringify({
    stages: ["live", "bogus"], tfs: ["D", "XX"], levMin: 10, pxMax: -5,
    dir: "sideways", ftfc: "up", favs: true
  });
  const { app, store } = loadApp({ "hip3-filters": seeded });
  assert.deepEqual(app.state.filters.stages, ["live"], "unknown stage ids dropped");
  assert.deepEqual(app.state.filters.tfs, ["D"], "unknown TF labels dropped");
  assert.equal(app.state.filters.levMin, 10);
  assert.equal(app.state.filters.pxMax, null, "non-positive numbers rejected");
  assert.equal(app.state.filters.dir, null, "junk direction rejected");
  assert.equal(app.state.filters.ftfc, "up");
  assert.equal(app.state.filters.favs, true);
  app.state.filters.dir = "down";
  app.saveFilters();
  assert.equal(JSON.parse(store["hip3-filters"]).dir, "down");
});

test("24h volume amount: plain digits or k/m/b suffix; $ and commas rejected", () => {
  const { app } = loadApp();
  assert.equal(app.parseVolAmount("5000000"), 5000000);
  assert.equal(app.parseVolAmount("500k"), 500000);
  assert.equal(app.parseVolAmount("1M"), 1000000);
  assert.equal(app.parseVolAmount("2.5b"), 2500000000);
  assert.equal(app.parseVolAmount(" 0 "), 0);
  ["$5M", "5,000,000", "5M$", "abc", "1mm", "-5", ""].forEach((s) =>
    assert.equal(app.parseVolAmount(s), null, JSON.stringify(s)));
});

test("24h volume bound: four operators, per universe, unknown volume never matches", () => {
  const { app } = loadApp();
  seedXyz(app);
  app.state.coins["xyz:AAA"].ctx.dayNtlVlm = "2000000";
  app.state.coins["xyz:BBB"].ctx.dayNtlVlm = "1000000";
  app.state.coins["xyz:CCC"].ctx = null;             // no ctx yet - honest unknown
  const syms = () => app.rowsSorted().map((r) => r.coin.sym).sort();
  assert.deepEqual(syms(), ["AAA", "BBB", "CCC"], "off by default");
  const x = app.state.filters.vol.xyz;
  x.n = 1000000;
  x.op = "ge"; assert.deepEqual(syms(), ["AAA", "BBB"]);
  x.op = "gt"; assert.deepEqual(syms(), ["AAA"]);
  x.op = "le"; assert.deepEqual(syms(), ["BBB"], "unknown never passes an upper bound as zero");
  x.op = "lt"; assert.deepEqual(syms(), []);
  assert.equal(app.volDimsInView(), 1);
  // A bound on the OTHER universe neither filters nor counts here.
  x.n = null;
  app.state.filters.vol.perps.n = 1e12;
  assert.deepEqual(syms(), ["AAA", "BBB", "CCC"]);
  assert.equal(app.volDimsInView(), 0);
});

test("24h volume bound: the Favs view judges each row by its own universe's bound", () => {
  const { app } = loadApp();
  seedXyz(app);
  const btc = mkCoin("BTC", "2U", "up"); btc.name = "BTC"; btc.ctx.dayNtlVlm = "900000000";
  const thin = mkCoin("THIN", "2U", "up"); thin.name = "THIN"; thin.ctx.dayNtlVlm = "50000";
  app.state.coins.BTC = btc; app.state.coins.THIN = thin;
  app.state.coins["xyz:AAA"].ctx.dayNtlVlm = "3000000";   // BBB/CCC stay at 5000
  app.state.favs = ["BTC", "THIN", "xyz:AAA", "xyz:BBB"];
  app.state.favsView = true;
  app.state.filters.vol.perps = { op: "ge", n: 1e8 };    // crypto floor $100M
  app.state.filters.vol.xyz = { op: "ge", n: 1e6 };      // equity floor $1M
  assert.equal(app.volDimsInView(), 2);
  assert.deepEqual(app.rowsSorted().map((r) => r.coin.sym).sort(), ["AAA", "BTC"]);
});

test("24h volume bound persists per universe, sanitizes junk, and presets do not alias it", () => {
  const seeded = JSON.stringify({ vol: {
    xyz: { op: "gt", n: 500000 }, perps: { op: "bogus", n: -1 }, other: { op: "lt", n: 5 } } });
  const { app, store } = loadApp({ "hip3-filters": seeded });
  assert.deepEqual(app.state.filters.vol.xyz, { op: "gt", n: 500000 });
  assert.deepEqual(app.state.filters.vol.perps, { op: "ge", n: null }, "junk degrades to default");
  assert.equal(app.state.filters.vol.other, undefined, "unknown universes dropped");
  const snap = app.snapshotLayout();
  app.state.filters.vol.xyz.n = 1;
  assert.equal(snap.filters.vol.xyz.n, 500000, "snapshot is a copy, not live state");
  app.saveFilters();
  assert.equal(JSON.parse(store["hip3-filters"]).vol.xyz.n, 1);
  app.applyPreset("all");
  assert.equal(app.state.filters.vol.xyz.n, null, "All clears the volume bound");
});

test("maxLevMeta mirrors the worker: finite and positive, else null", () => {
  const { app } = loadApp();
  assert.equal(app.maxLevMeta({ maxLeverage: 25 }), 25);
  assert.equal(app.maxLevMeta({ maxLeverage: "10" }), 10);
  assert.equal(app.maxLevMeta({ maxLeverage: 0 }), null);
  assert.equal(app.maxLevMeta({ maxLeverage: null }), null);
  assert.equal(app.maxLevMeta({}), null);
  assert.equal(app.maxLevMeta(null), null);
});

// ------------------------- hosted data plane (adapter) -------------------------

test("hosted: served analysis materializes into an; metrics come from the worker", () => {
  const { app } = loadApp();
  app.state.dataMode = "hosted";
  app.TFS.forEach((tf) => { tf.active = tf.id === "1d"; });
  const payload = {
    revision: 42, alertUniverses: ["xyz"],
    coins: [{
      name: "xyz:AAA", sym: "AAA", mid: 101, chg24: 2.5, vol: 5000, funding: 0.0001,
      score: 33, rvol: 1.4, maxLeverage: 25,
      mom: { r5: 0.1, r15: 0.2, r30: 0.3, r60: 0.4, r60Src: "exact" },
      tf: { "1d": {
        types: ["2U", "1"], formingType: "2U", formingDir: "up",
        live: [], setups: [], invalidated: false,
        completed: { name: "2D-1-2U", dir: "up", cont: false }, shape: null,
        forming: { t: 1, T: 9e15, o: 100, h: 102, l: 99, c: 101 }
      } }
    }]
  };
  app.hostedApplyState(app.UNIS.xyz, payload);
  const coin = app.state.coins["xyz:AAA"];
  assert.equal(coin.tf["1d"].an.formingDir, "up", "served analysis materialized");
  assert.deepEqual(coin.tf["1d"].an.completed, { name: "2D-1-2U", dir: "up", cont: false });
  assert.equal(coin.maxLeverage, 25);
  assert.equal(app.state.hostedRev, 42);
  assert.deepEqual(app.state.alertScope, ["xyz"], "state poll refreshes the alert scope");
  const rows = app.rowsSorted();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 33, "score is the WORKER's, never locally recomputed");
  assert.equal(rows[0].mom.r60, 0.4);
  assert.equal(rows[0].chg, 2.5);
  assert.equal(rows[0].vol, 5000);
  // a coin absent from the next payload leaves the order - the worker's
  // roster reconciliation flows straight through to the page
  app.hostedApplyState(app.UNIS.xyz, { coins: [] });
  assert.deepEqual(app.state.order, []);
});

test("hosted: a rolled forming bar is appended to closed (charts keep rolling)", () => {
  const { app } = loadApp();
  app.state.dataMode = "hosted";
  const mk = (t, c) => ({
    name: "xyz:AAA", sym: "AAA", mid: c,
    tf: { "15m": {
      types: [], formingType: "2U", formingDir: "up", live: [], setups: [],
      invalidated: false, completed: null, shape: null,
      forming: { t: t, T: t + 900000, o: c, h: c, l: c, c: c }
    } }
  });
  app.hostedApplyState(app.UNIS.xyz, { coins: [mk(1000, 100)] });
  assert.equal(app.state.coins["xyz:AAA"].tf["15m"].closed.length, 0);
  app.hostedApplyState(app.UNIS.xyz, { coins: [mk(901000, 101)] });   // next bar
  const slot = app.state.coins["xyz:AAA"].tf["15m"];
  assert.equal(slot.closed.length, 1, "the old forming bar rolled into closed");
  assert.equal(slot.closed[0].t, 1000);
  assert.equal(slot.forming.t, 901000);
});

test("hosted: W/M bar arrays derive from dailies; served W analysis is preserved", () => {
  const { app } = loadApp();
  const coin = { name: "xyz:AAA", sym: "AAA", mid: 100, hist: [], tf: {} };
  const monday = Date.UTC(2024, 0, 1);            // 2024-01-01 was a Monday
  const dailies = [];
  for (let i = 0; i < 14; i++) {
    const t = monday + i * 86400000;
    dailies.push({ t: t, T: t + 86399999, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i });
  }
  coin.tf["1d"] = { closed: dailies, forming: null, an: null };
  const servedAn = { types: ["2U"], formingType: "1", formingDir: "flat",
                     live: [], setups: [], invalidated: false, completed: null, shape: null };
  const servedForming = { t: 123, T: 9e15, o: 1, h: 2, l: 0, c: 1 };
  coin.tf["1w"] = { closed: [], forming: servedForming, an: servedAn };
  app.hostedRebuildDerivedBars(coin);
  assert.equal(coin.tf["1w"].closed.length, 2, "two full calendar weeks aggregated");
  assert.equal(coin.tf["1w"].an, servedAn, "served analysis untouched - aggregation only");
  assert.equal(coin.tf["1w"].forming, servedForming, "served forming untouched");
  assert.ok(coin.tf["1M"], "monthly slot created too");
});

test("data-mode statusbar span names the mode and the worker revision", () => {
  const { app } = loadApp();
  assert.ok(app.dataModeSpan().indexOf("data: standalone") >= 0);
  app.state.dataMode = "hosted";
  app.state.hostedRev = 42;
  const s = app.dataModeSpan();
  assert.ok(s.indexOf("data: worker") >= 0);
  assert.ok(s.indexOf("rev 42") >= 0);
});

test("forcedStandalone is false in a location-less environment (test/Node)", () => {
  const { app } = loadApp();
  assert.equal(app.forcedStandalone(), false);
});

test("a11y: rows and sortable headers are keyboard-focusable, sort direction exposed", () => {
  const { app, el } = loadApp();
  seedXyz(app);
  app.renderHead();
  const head = el("thead").innerHTML;
  assert.ok(head.indexOf('tabindex="0"') >= 0, "sortable headers focusable");
  assert.ok(/aria-sort="(ascending|descending)"/.test(head), "active sort exposed");
  app.render();
  assert.ok(el("tbody").innerHTML.indexOf('<tr class="row" tabindex="0"') >= 0,
    "rows are focusable for Enter/Space expansion");
});

test("chart: SVG candles from in-memory bars, forming dimmed, mid line", () => {
  const { app } = loadApp();
  seedXyz(app);
  const aaa = app.state.coins["xyz:AAA"];
  const closed = [];
  for (let i = 0; i < 50; i++) closed.push({ t: i, T: i + 1, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 5 });
  aaa.tf["1d"].closed = closed;
  aaa.mid = 125;
  const svg = app.chartSVG(aaa, "1d");
  assert.equal(svg.indexOf("<svg"), 0);
  assert.equal((svg.match(/class="cbody/g) || []).length, 41); // 40 closed cap + forming
  assert.ok(svg.indexOf("cforming") >= 0);
  assert.ok(svg.indexOf('class="cmid"') >= 0);
  assert.ok(app.chartSVG(aaa, "1w").indexOf("no data") >= 0);
  assert.ok(app.chartBlock(aaa).indexOf('data-charttf="1d"') >= 0);
  assert.ok(app.detailHTML(aaa).indexOf("chartblock") >= 0);
});

test("dominos: multi-TF clusters, echo dedup, in-motion, single-TF excluded", () => {
  const { app, el } = loadApp();
  const coin = mkCoin("DDD", "1", "flat");
  coin.mid = 99;
  // two TFs with rev setups at levels within 0.25% -> one chain
  coin.tf["1d"].an.setups = [{ name: "2D-1-2U", dir: "up", kind: "rev", trigger: 100.0, stop: 98, target: 105 }];
  coin.tf["1w"] = {
    closed: [], forming: null,
    an: { types: ["2U"], formingType: "1", formingDir: "flat",
          live: [], invalidated: false, completed: null,
          setups: [{ name: "3-2U", dir: "up", kind: "rev", trigger: 100.2, stop: 97, target: 110 }] }
  };
  let chains = app.coinDominoChains(coin);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].members.length, 2);
  assert.ok(Math.abs(chains[0].level - 100.1) < 1e-9);
  assert.equal(chains[0].rank, 5); // 1w is the highest TF in the chain
  assert.equal(chains[0].inMotion, undefined); // computed at render, not here
  // mid below the up-cluster -> not in motion; mid above -> in motion (render path)
  app.state.coins["xyz:DDD"] = coin;
  app.UNIS.xyz.order = ["xyz:DDD"];
  app.state.order = app.UNIS.xyz.order;
  app.renderDominos();
  assert.ok(el("dominos").innerHTML.indexOf("Domino chains: 1 (0 in motion)") >= 0);
  coin.mid = 100.5;
  app.renderDominos();
  assert.ok(el("dominos").innerHTML.indexOf("(1 in motion)") >= 0);
  // echo dedup: same pattern live AND setup on one TF counts once
  coin.tf["1d"].an.live = [{ name: "2D-1-2U", dir: "up", kind: "rev", entry: 100.0, stop: 98, target: 105 }];
  chains = app.coinDominoChains(coin);
  assert.equal(chains[0].members.length, 2); // still 2, not 3
  assert.ok(chains[0].members.some((m) => m.live)); // the live one was kept
  // far-apart levels -> no chain
  coin.tf["1w"].an.setups[0].trigger = 120;
  assert.equal(app.coinDominoChains(coin).length, 0);
  // two candidates on the SAME TF never form a chain
  coin.tf["1w"] = undefined;
  delete coin.tf["1w"];
  coin.tf["1d"].an.setups.push({ name: "X", dir: "up", kind: "rev", trigger: 100.05, stop: 98, target: 105 });
  assert.equal(app.coinDominoChains(coin).length, 0);
});

test("universes: dexBody, categories, per-universe row isolation", () => {
  const { app } = loadApp();
  seedXyz(app);
  assert.equal(app.dexBody({ type: "allMids" }, app.UNIS.xyz).dex, "xyz");
  assert.equal(app.dexBody({ type: "allMids" }, app.UNIS.perps).dex, undefined);
  assert.equal(app.coinCategory({ sym: "BTC" }), "majors");
  assert.equal(app.coinCategory({ sym: "kPEPE" }), "meme");
  assert.equal(app.coinCategory({ sym: "ARB" }), "l2");
  assert.equal(app.coinCategory({ sym: "NEWCOIN2026" }), "other");
  const btc = mkCoin("BTC", "2U", "up"); btc.name = "BTC";
  const pepe = mkCoin("kPEPE", "2D", "down"); pepe.name = "kPEPE";
  app.state.coins["BTC"] = btc;
  app.state.coins["kPEPE"] = pepe;
  app.UNIS.perps.order = ["BTC", "kPEPE"];
  app.state.universe = "perps";
  app.state.order = app.UNIS.perps.order;
  assert.equal(app.curUni().id, "perps");
  app.state.category = "meme";
  let rows = app.rowsSorted();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].coin.sym, "kPEPE");
  app.state.category = "all";
  assert.equal(app.rowsSorted().length, 2);
  app.state.universe = "xyz";
  app.state.order = app.UNIS.xyz.order;
  assert.ok(app.rowsSorted().every((r) => r.coin.name.indexOf("xyz:") === 0));
});

// ---- heat score mirror drift gate (score_v 3) ----
// The worker's src/metrics.js declares its formulas byte-for-byte the
// dashboard's, with the TF SCOPE as the one deliberate difference (configured
// set vs UI toggles). Nothing enforced that until now: identical vectors run
// through BOTH implementations and must agree exactly. If this fails, one
// side of the mirror changed without the other.
test("dashboard heatScore matches worker metrics.heatScore on identical vectors", () => {
  const metrics = require("../src/metrics.js");
  const { app } = loadApp();
  // default UI-active TFs = 15m/1h/4h/1d = 4, same count as the vectors'
  assert.equal(app.TFS.filter((t) => t.active).length, 4);

  const sig = (dir, entry, kind, rev3) => {
    const s = { name: "t", dir, entry, stop: 1, target: 200, kind: kind || "rev" };
    if (rev3) s.rev3 = true;
    return s;
  };
  const sum = (dots, live) =>
    ({ live, setups: 0, dots, ftfc: "mixed", inval: false, count: dots.length });
  const vectors = [
    // [sum, mom, rv, mid, atr1h] - in-force, recrossed, at-entry, invalidated,
    // rev3, cont, no-mid, no-entry, momentum/rvol interplay, saturation.
    // atr1h absent = the missing-yardstick fixed-1.5 branch (pre-v3 behavior).
    [sum(["up", "up", "up", "up"], []), { r60: null }, null, 100],
    [sum(["up", "up", "up", "down"], [{ tf: "D", sig: sig("up", 100), invalidated: false }]), { r60: 1.5 }, null, 101],
    [sum(["up", "up", "up", "down"], [{ tf: "D", sig: sig("up", 100), invalidated: false }]), { r60: 1.5 }, null, 99],
    [sum(["up", "up", "up", "down"], [{ tf: "D", sig: sig("up", 100), invalidated: false }]), { r60: 1.5 }, null, 100],
    [sum(["up", "down", "flat", "up"], [{ tf: "D", sig: sig("down", 100), invalidated: false }]), { r60: -0.4 }, 2.2, 99],
    [sum(["up", "down", "flat", "up"], [{ tf: "D", sig: sig("down", 100), invalidated: true }]), { r60: -0.4 }, 2.2, 99],
    [sum(["down", "down", "down", "down"], [{ tf: "D", sig: sig("up", 100, "rev", true), invalidated: false }]), { r60: -3 }, 0.5, 101],
    [sum(["up", "up", "up", "up"], [{ tf: "D", sig: sig("up", 100, "cont"), invalidated: false }]), { r60: 4 }, 9, 101],
    [sum(["up", "up", "up", "up"], [{ tf: "D", sig: sig("up", 100), invalidated: false }]), { r60: 0.2 }, 1, null],
    [sum(["up", "up", "up", "up"], [{ tf: "D", sig: sig("up", null), invalidated: false }]), { r60: 0.2 }, 1, 99],
    [sum(["up", "up", "up", "up"],
         [{ tf: "D", sig: sig("up", 100), invalidated: false },
          { tf: "H", sig: sig("up", 100.5), invalidated: false },
          { tf: "4H", sig: sig("up", 100.8), invalidated: false }]), { r60: 2 }, 3.5, 101],
    // score_v 3: ATR-normalized momentum (5th element = the hourly yardstick)
    [sum(["up", "up", "up", "down"], []), { r60: 1.5 }, null, 101, 0.75],  // saturates at 2x0.75
    [sum(["up", "up", "up", "down"], []), { r60: 1.5 }, null, 101, 1.5],   // high-vol: 0.5, no longer saturated
    [sum(["down", "down", "flat", "down"], []), { r60: -0.3 }, 2, 99, 0.1], // low-vol coin registers
    [sum(["up", "up", "up", "down"], []), { r60: 2 }, 1, 101, 0],           // dead yardstick -> fixed 1.5 branch
    [sum(["up", "up", "up", "down"], []), { r60: null }, 1, 101, 0.75],     // no r60 -> term 0 despite yardstick
  ];
  for (const [s, mom, rv, mid, y] of vectors) {
    const m = { r5: null, r15: null, r30: null, r60: mom.r60 };
    assert.strictEqual(
      app.heatScore(s, m, rv, mid, y),
      metrics.heatScore(s, m, rv, mid, y),
      "mirror drift on vector " + JSON.stringify([s.dots, s.live.length, mom.r60, rv, mid, y])
    );
  }

  // TF-scope divergence stays possible BY DESIGN: 2 active UI TFs vs the
  // vector's 4 dots changes only the denominator, not the term formulas
  const { app: app2 } = loadApp();
  app2.TFS.forEach((t) => { t.active = t.id === "1d" || t.id === "1h"; });
  const s2 = { live: [], setups: 0, dots: ["up", "down"], ftfc: "mixed", inval: false, count: 2 };
  const m2 = { r5: null, r15: null, r30: null, r60: 0.9 };
  assert.strictEqual(app2.heatScore(s2, m2, null, 100), metrics.heatScore(s2, m2, null, 100));
});

// ---- score_v 3 momentum mirror: exact-horizon r60 + hourly yardstick ----
// Both sides now take an injectable clock (defaulting to Date.now()), so the
// mirror comparison is fully deterministic: one frozen `now` drives both.
test("dashboard momentum/tr1hAvgPct match the worker on identical fixtures", () => {
  const metrics = require("../src/metrics.js");
  const { app } = loadApp();
  const now = Date.now();
  const mk = (agesMids, closes, mid) => ({
    mid: mid,
    hist: agesMids.map(([a, m]) => ({ t: now - a, m: m })),
    tf: closes ? { "15m": { closed: closes.map((c, i) => ({ t: i, o: c, h: c, l: c, c: c, v: 1 })), forming: null, an: null } } : {}
  });
  const fixtures = [
    mk([[3660000, 100], [1800000, 103], [10000, 104.9]], null, 105),  // exact: anchor 61m old
    mk([[1800000, 103]], [100, 101, 102, 103, 104], 105),             // immature tape -> candle fallback
    mk([], [100, 101, 102, 103, 104], 105),                           // empty tape -> candle fallback
    mk([[4000000, 90]], null, 105),                                   // over-aged anchor, no candles -> null
    mk([[600000, 100], [10000, 101]], null, 102),                     // old anchor -> r5 guarded null
    // review 2026-07-25 F1: stale-endpoint contract mirrors too
    mk([[3900000, 100], [300000, 110]], null, 110),                   // 5m mids gap -> r60 "stale", r5 null
    mk([[3600000, 104]], [100, 101, 102, 103, 104], 104),             // 60m-old lone sample -> stale candle fallback
    mk([[3900000, 100], [300000, 110]], [100, 101, 102, 103, 104], 110) // stale with candles -> r15/r30 withheld
  ];
  for (const f of fixtures) {
    const w = metrics.momentum(f, now);
    const d = app.momentum(f, now);
    assert.strictEqual(d.r60Src, w.r60Src, "r60Src mirror");
    for (const k of ["r5", "r15", "r30", "r60"]) {
      if (w[k] === null) assert.strictEqual(d[k], null, k + " mirror (null)");
      else assert.ok(Math.abs(d[k] - w[k]) < 1e-9, k + " mirror");
    }
  }
  // sanity: the stale fixtures actually exercise the stale branch
  assert.strictEqual(metrics.momentum(fixtures[5], now).r60Src, "stale");
  // the yardstick function itself: fresh, overdue (review F3), and missing
  const yardCoin = (endAge) => {
    const closed = [];
    for (let i = 0; i < 21; i++) {
      const T = now - endAge - (20 - i) * 3600000;
      closed.push({ t: T - 3600000, T: T, o: 100, h: 100.5, l: 99.5, c: 100 });
    }
    return { tf: { "1h": { closed: closed, forming: null, an: null } } };
  };
  const fresh = yardCoin(60000), overdue = yardCoin(4500001);
  assert.strictEqual(app.tr1hAvgPct(fresh, now), metrics.tr1hAvgPct(fresh, now));
  assert.ok(Math.abs(app.tr1hAvgPct(fresh, now) - 1) < 1e-9);
  assert.strictEqual(app.tr1hAvgPct(overdue, now), null, "dashboard treats an overdue slot as unavailable");
  assert.strictEqual(metrics.tr1hAvgPct(overdue, now), null, "worker agrees");
  assert.strictEqual(app.tr1hAvgPct({ tf: {} }, now), null);
  assert.strictEqual(metrics.tr1hAvgPct({ tf: {} }, now), null);
});

// ---- review 2026-07-25 F2: 1H is a score dependency, not just a column ----
// tr1hAvgPct feeds the v3 momentum normalizer through rowsSorted() whatever
// the 1H display toggle says. tfNeeded() gates BOTH the lazy first load of a
// universe and the bar-roll refetch loop, so pinning it here keeps the
// yardstick loading and rolling while the column is hidden.
test("tfNeeded: 1H stays fetched while hidden, like 15m; score uses the live yardstick through rowsSorted", () => {
  const { app } = loadApp();
  const tf1h = app.TFS.filter((t) => t.id === "1h")[0];
  tf1h.active = false; // user hides the 1H column before a lazy universe load
  assert.strictEqual(app.tfNeeded(tf1h), true, "hidden 1H is still needed by the score");
  const fetchSet = app.TFS.filter((t) => !t.derived && app.tfNeeded(t)).map((t) => t.id);
  assert.ok(fetchSet.indexOf("1h") >= 0, "uniLoad/roll-refetch fetch set keeps 1h");

  // and the yardstick actually reaches the score inside rowsSorted()
  const metrics = require("../src/metrics.js");
  seedXyz(app);
  const now = Date.now();
  const coin = app.state.coins["xyz:AAA"];
  coin.hist = [{ t: now - 3660000, m: 100 }, { t: now - 4000, m: 101.5 }];
  coin.mid = 101.5; // r60 exact +1.5%
  const closed = [];
  for (let i = 0; i < 21; i++) {
    const T = now - 60000 - (20 - i) * 3600000;
    closed.push({ t: T - 3600000, T: T, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 });
  }
  coin.tf["1h"] = { closed: closed, forming: null, an: null }; // yardstick 1%, hidden column
  const row = app.rowsSorted().filter((r) => r.coin.sym === "AAA")[0];
  const y = app.tr1hAvgPct(coin);
  assert.ok(y > 0, "live yardstick available despite the hidden column");
  // The score runs on the FIXED scoreTFs() summary, not the toggled display
  // summary - 1h is hidden here, yet it still counts toward the score.
  const scoreSum = app.coinSummary(coin, app.scoreTFs());
  assert.strictEqual(row.score, app.heatScore(scoreSum, row.mom, row.rvol, coin.mid, y),
    "rowsSorted scores the fixed set, normalized by the live yardstick");
  assert.notStrictEqual(row.score, app.heatScore(scoreSum, row.mom, row.rvol, coin.mid, null),
    "and that differs from the fixed-1.5 fallback on this vector");
  // The worker reads its TF count from the sum (its coinSummary sets `count`).
  // Now that the dashboard also scores a fixed set, the two agree outright -
  // this used to be an accepted TF-scope divergence.
  const wSum = Object.assign({ count: scoreSum.dots.length }, scoreSum);
  assert.strictEqual(metrics.heatScore(wSum, row.mom, row.rvol, coin.mid, y), row.score,
    "worker agrees on the same inputs");
});

test("SCORE IS TOGGLE-INDEPENDENT: hiding or showing timeframes cannot move it", function () {
  // The whole point of pinning scoreTFs(). Before this, turning 30m on silently
  // rescored the board and disagreed with the mobile app, which scores over the
  // worker's configured set.
  const { app } = loadApp();
  seedXyz(app);
  const scoreOf = function () {
    const r = app.rowsSorted().filter(function (x) { return x.coin.sym === "AAA"; })[0];
    return r ? r.score : null;
  };
  const base = scoreOf();
  const flip = function (id, on) { app.TFS.filter(function (t) { return t.id === id; })[0].active = on; };

  flip("30m", true);  assert.strictEqual(scoreOf(), base, "showing 30m must not move the score");
  flip("1w", true);   assert.strictEqual(scoreOf(), base, "showing W must not move the score");
  flip("4h", false);  assert.strictEqual(scoreOf(), base, "hiding 4H must not move the score");
  flip("15m", false); assert.strictEqual(scoreOf(), base, "hiding 15m must not move the score");
  // Display, by contrast, MUST still follow the toggles.
  const disp = app.coinSummary(app.state.coins["xyz:AAA"]);
  assert.strictEqual(disp.dots.length, app.activeTFs().length, "display still follows the toggles");
});

test("DRIFT GATE: the dashboard's score TF set matches the worker's configured ftfcTfs", function () {
  // If these drift, the dashboard and the app score the same coin differently
  // and nothing fails loudly - the numbers just quietly disagree.
  const { app } = loadApp();
  const worker = require("../config.json").ftfcTfs;
  assert.deepStrictEqual(app.SCORE_TF_IDS, worker,
    "SCORE_TF_IDS in hip3_strat_screener.html must equal the worker's config.ftfcTfs");
  assert.deepStrictEqual(app.scoreTFs().map(function (t) { return t.id; }), worker,
    "and scoreTFs() must resolve to exactly that set, in order");
});

// ---- Trend column follows the timeframe selection ----
//
// The column was hardcoded to 15m. "The currently selected timeframe" has no
// literal referent - the TF control is a multi-toggle - so it resolves to the
// FASTEST ACTIVE tf, matching the status bar's existing activeTFs()[0] usage.
//
// These assertions drive the toggle and check the value MOVED. Asserting that
// a sparkline merely renders cannot catch a column wired to the wrong series:
// the old hardcoded version rendered perfectly while ignoring the selection.

test("Trend follows the fastest ACTIVE timeframe, and moves when toggled", function () {
  const { app, el } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);
  const aaa = app.state.coins["xyz:AAA"];
  // Deliberately different series per TF, so the assertion can tell WHICH one
  // was drawn. Equal series would pass no matter how the column is wired.
  aaa.tf["15m"] = { closed: [{ c: 100 }], forming: null, an: null };
  aaa.tf["1h"] = { closed: [{ c: 50 }], forming: null, an: null };
  aaa.mid = 110;

  app.TFS.forEach(function (tf) { tf.active = tf.id === "15m" || tf.id === "1h"; });
  assert.equal(app.trendTF().id, "15m", "fastest of the two active TFs");
  assert.equal(Math.round(app.simpleTrendPct(aaa)), 10, "100 -> 110 on the 15m series");

  // Toggle the fastest one OFF - the column must FOLLOW to the next fastest.
  app.TFS.filter(function (tf) { return tf.id === "15m"; })[0].active = false;
  assert.equal(app.trendTF().id, "1h", "follows the selection down to 1h");
  assert.equal(Math.round(app.simpleTrendPct(aaa)), 120, "50 -> 110 on the 1h series");

  // The HEADER has to respond too, or the number changes with no way to know
  // which timeframe produced it.
  app.renderHead();
  assert.ok(el("thead").innerHTML.includes("Trend"), "header keeps its label");
  assert.ok(el("thead").innerHTML.includes(">1H<"), "header names the active trend TF");
});

test("Trend defaults to 15m at the default toggle state (no change for untouched toggles)", function () {
  const { app } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);
  // The shipped defaults from TFS: 15m, 1h, 4h, 1d on; 30m, 1w, 1M off.
  app.TFS.forEach(function (tf) {
    tf.active = ["15m", "1h", "4h", "1d"].indexOf(tf.id) >= 0;
  });
  assert.equal(app.trendTF().id, "15m",
    "a user who never touches a toggle must still see the 15m trend");
});

test("Trend degrades to a dash when every timeframe is toggled off", function () {
  const { app } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);
  const aaa = app.state.coins["xyz:AAA"];
  aaa.tf["15m"] = { closed: [{ c: 100 }], forming: null, an: null };
  app.TFS.forEach(function (tf) { tf.active = false; });
  assert.equal(app.trendTF(), null, "no active TF resolves to null, not a throw");
  assert.equal(app.simpleTrendPct(aaa), null);
  assert.match(app.sparkSVG(aaa), /class="neu"/, "renders a dash rather than an empty svg");
});

// --- To Target column (design decision 2026-08-16, display_v d9cb6247159c52f8) --------
// The ranker covers IN-FORCE live/cont signals only: setups, INVAL and
// recrossed rows return null from both rank helpers and sink in BOTH sort
// directions (the Progress column idiom). Cell and sort read the MATCHED
// signal, so the Tier 1 filters scope what the ranker sees.

function liveSigCoin(app, name, entry, target, mid) {
  const coin = {
    name: "xyz:" + name, sym: name,
    ctx: { prevDayPx: "100", markPx: String(mid), dayNtlVlm: "5000" },
    mid: mid, hist: [],
    tf: {
      "1d": {
        closed: [{ t: 0, T: 1, o: 100, h: 102, l: 99, c: 100, v: 10 }],
        forming: { t: 1, T: 9e15, o: 100, h: 102, l: 99, c: mid, v: 10 },
        an: { types: ["2U", "2U"], formingType: "2U", formingDir: "up",
              live: [{ name: "3-2U", dir: "up", entry: entry, stop: entry - 1,
                       target: target, kind: "rev" }],
              setups: [], invalidated: false, completed: null }
      }
    }
  };
  app.state.coins[coin.name] = coin;
  return coin;
}

test("dist sort: in-force rows rank by remaining %, null rows sink both ways", () => {
  const { app } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);                                   // AAA/BBB/CCC carry no signals
  liveSigCoin(app, "FAR", 100, 111, 101);         // dist = (111-101)/101 = +9.90%
  liveSigCoin(app, "NEAR", 100, 103, 101);        // dist = (103-101)/101 = +1.98%
  app.UNIS.xyz.order = ["xyz:AAA", "xyz:BBB", "xyz:CCC", "xyz:FAR", "xyz:NEAR"];
  app.state.order = app.UNIS.xyz.order;
  app.state.sortKey = "dist"; app.state.sortDir = -1;
  let syms = app.rowsSorted().map((r) => r.coin.sym);
  assert.deepEqual(syms.slice(0, 2), ["FAR", "NEAR"], "descending: most room first");
  app.state.sortDir = 1;
  syms = app.rowsSorted().map((r) => r.coin.sym);
  assert.deepEqual(syms.slice(0, 2), ["NEAR", "FAR"], "ascending: least room first");
  assert.ok(syms.indexOf("AAA") > syms.indexOf("FAR"), "null rows sink in ascending too");
});

test("dist rank: recrossed (out-of-force) and setup rows are null", () => {
  const { app } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);
  const oof = liveSigCoin(app, "OOF", 100, 111, 99.5);   // mid <= entry: recrossed
  assert.equal(app.simpleDistRank(app.coinSummary(oof), oof.mid), null);
  const setup = app.state.coins["xyz:AAA"];
  setup.tf["1d"].an.setups = [{ name: "2D-2U", dir: "up", trigger: 102, stop: 99,
                                target: 110, kind: "rev" }];
  assert.equal(app.simpleDistRank(app.coinSummary(setup), setup.mid), null,
    "a standing setup has no already-occurring distance");
});

test("simpleToTargetHTML: renders both metrics for an in-force signal, dash otherwise", () => {
  const { app } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);
  const c = liveSigCoin(app, "FAR", 100, 111, 101);
  const item = app.simpleCandidate(app.coinSummary(c), c.mid);
  const html = app.simpleToTargetHTML(item, c.mid);
  assert.match(html, /\+9\.90%/, "distance as % of price: " + html);
  assert.match(html, /91% mag left/, "magnitude remaining subline: " + html);
  assert.equal(app.simpleToTargetHTML(null, 101), '<span class="neu">-</span>');
});

test("simple view: To Target column in header and row, colspan follows", () => {
  const { app, el } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);
  liveSigCoin(app, "FAR", 100, 111, 101);
  app.state.order = ["xyz:FAR"]; app.UNIS.xyz.order = app.state.order;
  app.renderHead();
  const head = el("thead").innerHTML;
  assert.ok(head.indexOf("Tgt %") >= 0 && head.indexOf("Mag Left") >= 0, "cycling header present");
  assert.ok(head.indexOf('data-cycle="dist,magleft"') >= 0, "both sort keys reachable");
  const row = app.simpleRowHTML(app.rowsSorted()[0]);
  assert.match(row, /\+9\.90%/, "row carries the To Target cell: " + row);
  // Command view emits NO inline detail row - activation opens the drawer,
  // and a leaked expansion must not render under a card (audit D2 F9).
  app.state.expanded["xyz:FAR"] = true;
  app.render();
  assert.equal(el("tbody").innerHTML.indexOf('class="detail"'), -1,
    "inline detail is a Regular-view surface only (audit D2 F9)");
});

test("starSpan: aria state rides the pin (deferred from the a11y batch)", () => {
  const { app } = loadApp();
  seedXyz(app);
  const off = app.starSpan("xyz:AAA");
  assert.ok(off.indexOf('role="button"') >= 0 && off.indexOf('tabindex="0"') >= 0, off);
  assert.ok(off.indexOf('aria-pressed="false"') >= 0, off);
  app.toggleFav("xyz:AAA");
  const on = app.starSpan("xyz:AAA");
  assert.ok(on.indexOf('aria-pressed="true"') >= 0, on);
  assert.match(on, /aria-label="Unpin /, on);
});

// --- Column visibility, Tier A (design decision 2026-08-16) ---------------------------
// Regular-view metric columns only: Symbol always renders, per-TF columns
// keep the TF toggles, Simple view keeps its curated set. Persisted as the
// HIDDEN list under hip3-cols, whitelist-validated like the filters.

function firstRegularRow(html) {
  const m = html.match(/<tr class="row"[\s\S]*?<\/tr>/);
  return m ? m[0] : "";
}

test("columns: hidden keys drop from Regular header and rows, colspan follows", () => {
  const { app, el } = loadApp({ "hip3-cols": JSON.stringify(["funding", "r30", "junk", 5]) });
  seedXyz(app);
  assert.deepEqual(app.state.hiddenCols, ["funding", "r30"],
    "whitelist load drops junk entries");
  app.renderHead();
  const head = el("thead").innerHTML;
  assert.ok(head.indexOf("Funding/hr") < 0 && head.indexOf("30m %") < 0, head);
  assert.ok(head.indexOf("Score") >= 0 && head.indexOf("RVOL") >= 0, "others stay");
  app.state.expanded["xyz:AAA"] = true;
  app.render();
  const body = el("tbody").innerHTML;
  const tds = (firstRegularRow(body).match(/<td/g) || []).length;
  assert.equal(tds, 13, "14 base cols (Symbol + 13 metric keys) - 2 hidden + 1 active TF = 13 cells");
  assert.ok(body.indexOf('colspan="13"') >= 0, "detail row spans the visible width");
});

test("columns: default shows everything; toggling persists round-trip", () => {
  const { app, el, store } = loadApp();
  seedXyz(app);
  assert.deepEqual(app.state.hiddenCols, [], "default hides nothing");
  app.render();
  let tds = (firstRegularRow(el("tbody").innerHTML).match(/<td/g) || []).length;
  assert.equal(tds, 15, "14 base cols (Symbol + 13 metric keys) + 1 active TF");
  assert.equal(app.COL_KEYS.length, 13, "the base count above is Symbol + COL_KEYS");
  app.state.hiddenCols.push("sig");
  app.saveHiddenCols();
  assert.deepEqual(JSON.parse(store["hip3-cols"]), ["sig"], "persisted");
  app.render();
  tds = (firstRegularRow(el("tbody").innerHTML).match(/<td/g) || []).length;
  assert.equal(tds, 14, "Signals cell gone");
  const { app: app2 } = loadApp({ "hip3-cols": store["hip3-cols"] });
  assert.deepEqual(app2.state.hiddenCols, ["sig"], "survives a reload");
});

test("columns: Simple view ignores the Regular-view hidden list", () => {
  const { app, el } = loadApp({
    "hip3-view": "simple",
    "hip3-cols": JSON.stringify(["px", "chg", "ftfc"])
  });
  seedXyz(app);
  app.renderHead();
  const head = el("thead").innerHTML;
  // px/chg/ftfc are all in the hidden list; the Command view's curated
  // groups render them anyway (D2-c: Market cycle + Structure header).
  assert.ok(head.indexOf("Price") >= 0 && head.indexOf("D / W / M") >= 0,
    "Command view keeps its curated groups regardless: " + head);
});

// --- Pattern filter dimension, Tier B (design decision 2026-08-16) --------------------
// Per-pattern granularity: family derived from the STRAT-CORE signal name
// (patFamily is UI grouping over the canonical taxonomy, outside the
// blocks). One selection does both jobs: filters rows via matchedItems AND
// scopes the Signals cell via the sigChips allow predicate, so a cell never
// advertises a pattern the active filter excludes.

test("patFamily: maps the full emitted name universe", () => {
  const { app } = loadApp();
  assert.equal(app.patFamily("2D-2U"), "22");
  assert.equal(app.patFamily("2U-2D"), "22");
  assert.equal(app.patFamily("2D-1-2U"), "212");
  assert.equal(app.patFamily("2U-1-2D"), "212");
  assert.equal(app.patFamily("2U-1-2U"), "212");   // continuation form
  assert.equal(app.patFamily("3-1-2U"), "312");
  assert.equal(app.patFamily("3-1-2D"), "312");
  assert.equal(app.patFamily("3-2U"), "32");
  assert.equal(app.patFamily("3-2D"), "32");
  assert.equal(app.patFamily("3-2D-2U"), "322");
  assert.equal(app.patFamily("3-2U-2D"), "322");
  assert.equal(app.patFamily("1-2-2"), "122");
  assert.equal(app.patFamily("1-3"), "13");
  assert.equal(app.patFamily("PMG"), "pmg");
  app.PAT_IDS.forEach((id) => assert.notEqual(id, "other"));
});

test("pattern filter: matchedItems scopes rows, sigDimsActive knows the dim", () => {
  const { app } = loadApp();
  seedXyz(app);
  const aaa = app.state.coins["xyz:AAA"];
  aaa.tf["1d"].an.live = [
    { name: "2D-1-2U", dir: "up", kind: "rev", entry: 100, stop: 99, target: 110 },
    { name: "3-2U", dir: "up", kind: "rev", entry: 100.5, stop: 99, target: 111 }
  ];
  aaa.mid = 104;
  assert.equal(app.sigDimsActive(), false);
  app.state.filters.pats = ["212"];
  assert.equal(app.sigDimsActive(), true, "pats alone activates the signal dims");
  const items = app.matchedItems(app.coinSummary(aaa), aaa.mid);
  assert.equal(items.length, 1);
  assert.equal(items[0].sig.name, "2D-1-2U");
  app.state.filters.pats = ["32"];
  assert.equal(app.matchedItems(app.coinSummary(aaa), aaa.mid)[0].sig.name, "3-2U");
  app.state.filters.pats = ["pmg"];
  assert.equal(app.matchedItems(app.coinSummary(aaa), aaa.mid).length, 0);
});

test("pattern filter: the Signals cell agrees with the active selection", () => {
  const { app, el } = loadApp();
  seedXyz(app);
  const aaa = app.state.coins["xyz:AAA"];
  aaa.tf["1d"].an.live = [
    { name: "2D-1-2U", dir: "up", kind: "rev", entry: 100, stop: 99, target: 110 },
    { name: "3-2U", dir: "up", kind: "rev", entry: 100.5, stop: 99, target: 111 }
  ];
  aaa.mid = 104;
  app.state.filters.pats = ["212"];
  app.render();
  const body = el("tbody").innerHTML;
  assert.ok(body.indexOf("2D-1-2U") >= 0, "selected family renders: " + body.slice(0, 200));
  assert.ok(body.indexOf("3-2U") < 0, "excluded family is scoped out of the cell");
  assert.ok(body.indexOf("BBB") < 0 && body.indexOf("CCC") < 0,
    "rows without a matching signal filter out");
});

test("pattern filter: persists whitelist-validated under hip3-filters", () => {
  const { app, store } = loadApp();
  seedXyz(app);
  app.state.filters.pats = ["122", "pmg"];
  app.saveFilters();
  const { app: app2 } = loadApp({ "hip3-filters": store["hip3-filters"] });
  assert.deepEqual(app2.state.filters.pats, ["122", "pmg"]);
  const { app: app3 } = loadApp({
    "hip3-filters": JSON.stringify({ pats: ["122", "nope", 7] })
  });
  assert.deepEqual(app3.state.filters.pats, ["122"], "junk families drop");
  assert.equal(app.defaultFilters().pats.length, 0, "default = every pattern");
});

// --- Code review 2026-08-16 fixes (F1-F7) --------------------------------
// Each test pins the reviewed failure scenario against the fix.

function servedCoin(name, tf) {
  return { name: "xyz:" + name, sym: name, mid: 101, tf: tf || {} };
}
function servedTf1d(live) {
  return { "1d": {
    types: ["2U", "2U"], formingType: "2U", formingDir: "up",
    live: live || [], setups: [], invalidated: false, completed: null,
    shape: null, forming: { t: 1, T: 9e15, o: 100, h: 102, l: 99, c: 101 }
  } };
}

test("F1: analysis absent from the current snapshot is cleared, bars survive", () => {
  const { app } = loadApp();
  const u = app.UNIS.xyz;
  const live = [{ name: "3-2U", dir: "up", entry: 100, stop: 99, target: 110, kind: "rev" }];
  app.hostedApplyState(u, { revision: 100, coins: [servedCoin("AAA", servedTf1d(live))] });
  const coin = app.state.coins["xyz:AAA"];
  assert.equal(coin.tf["1d"].an.live.length, 1, "live analysis applied");
  coin.tf["1d"].closed.push({ t: 0, T: 1, o: 100, h: 102, l: 99, c: 100 });
  // restarted worker mid-backfill: same coin, tf omits 1d entirely
  app.hostedApplyState(u, { revision: 1, coins: [servedCoin("AAA", {})] });
  assert.equal(coin.tf["1d"].an, null, "stale-epoch analysis cleared");
  assert.equal(coin.tf["1d"].closed.length, 1, "bars survive - market data, not analysis");
  app.TFS.forEach((tf) => { tf.active = tf.id === "1d"; });
  const sum = app.coinSummary(coin);
  assert.equal(sum.live.length, 0, "no chip, focus, or filter input from the old epoch");
});

test("F2: hostedTick is single-flight - an overlapping tick never fetches", async () => {
  const { app, sandbox } = loadApp();
  const calls = [];
  let release;
  sandbox.fetchImpl = (url) => { calls.push(String(url)); return new Promise((res) => { release = res; }); };
  const t1 = app.hostedTick();
  await app.hostedTick();                  // must bail on the busy guard
  assert.equal(calls.length, 1, "second tick did not start a second fetch");
  assert.equal(app.hostedPollCtl.busy, true, "first flight still holds the guard");
  release({ ok: true, json: async () => ({ revision: 5, coins: [] }) });
  await t1;
  assert.equal(app.hostedPollCtl.busy, false, "guard released");
  assert.ok(app.hostedPollCtl.lastOkAt > 0, "success stamped progress");
});

test("F2: a failed tick does not stamp progress (recovery re-seed stays armed)", async () => {
  const { app, sandbox } = loadApp();
  sandbox.fetchImpl = () => Promise.reject(new Error("down"));
  await app.hostedTick();
  const afterFirst = app.hostedPollCtl.lastOkAt;
  assert.ok(afterFirst > 0, "the clock baselines on first attempt");
  await new Promise((r) => setImmediate(r));
  await app.hostedTick();
  assert.equal(app.hostedPollCtl.lastOkAt, afterFirst,
    "failures never advance lastOkAt - the 600s gap can actually accumulate");
  assert.match(app.state.apiWarn, /worker feed failed/);
});

test("F2: a revision regression (worker restart) re-seeds from bootstrap", async () => {
  const { app, sandbox } = loadApp();
  const calls = [];
  const stateRevs = [100, 3, 4];
  let i = 0;
  // Pre-plant the coin so the first poll does not flag needsSeed - the pin
  // must stay on the REVISION-REGRESSION path, not the unseen-coin path.
  // State responses serve the coin too: the staged hostedLoad (audit D2 F1)
  // commits bootstrap bars only for coins the state snapshot serves.
  app.state.coins["xyz:AAA"] = { name: "xyz:AAA", sym: "AAA", ctx: null, mid: 100, tf: {}, hist: [] };
  sandbox.fetchImpl = (url) => {
    const u = String(url);
    calls.push(u);
    if (u.indexOf("/api/bootstrap") >= 0)
      return Promise.resolve({ ok: true, json: async () => ({ loaded: true, revision: 3,
        coins: [{ name: "xyz:AAA", sym: "AAA", mid: 101,
          tf: { "15m": { closed: [{ t: 0, T: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }], forming: null } } }] }) });
    return Promise.resolve({ ok: true, json: async () => ({ revision: stateRevs[Math.min(i++, 2)],
      coins: [{ name: "xyz:AAA", sym: "AAA", mid: 101.5, tf: {} }] }) });
  };
  await app.hostedTick();
  assert.equal(app.state.hostedRev, 100);
  assert.equal(app.UNIS.xyz.rev, 100, "revision tracked per universe (audit D2 F2)");
  await app.hostedTick();                  // serves rev 3 < 100 -> restart
  assert.ok(calls.some((c) => c.indexOf("/api/bootstrap") >= 0),
    "bootstrap re-seed ran after the regression");
  assert.equal(app.state.coins["xyz:AAA"].tf["15m"].closed.length, 1, "bars re-seeded");
  assert.equal(app.UNIS.xyz.bootLoaded, true);
  assert.equal(app.UNIS.xyz.needsSeed, false);
});

test("F3: a state-only new coin flags the universe for a bootstrap re-seed", () => {
  const { app } = loadApp();
  const u = app.UNIS.xyz;
  assert.ok(!u.needsSeed);
  app.hostedApplyState(u, { revision: 7, coins: [servedCoin("NEW", servedTf1d())] });
  assert.equal(u.needsSeed, true, "unseen coin needs raw history");
  const coin = app.state.coins["xyz:NEW"];
  assert.equal(coin.tf["1d"].closed.length, 0, "state polls carry no closed bars");
});

test("F3: removal drops browser state, scoped to the coin's own universe", () => {
  const { app } = loadApp();
  const u = app.UNIS.xyz;
  app.state.coins["OTHERUNI"] = { name: "OTHERUNI", sym: "O", tf: {}, hist: [] };
  app.hostedApplyState(u, { coins: [servedCoin("AAA", servedTf1d()), servedCoin("BBB", servedTf1d())] });
  app.state.expanded["xyz:BBB"] = true;
  app.hostedApplyState(u, { coins: [servedCoin("AAA", servedTf1d())] });
  assert.ok(!app.state.coins["xyz:BBB"], "removed coin deleted - relist baselines fresh");
  assert.ok(!app.state.expanded["xyz:BBB"], "expansion flag deleted with it");
  assert.ok(app.state.coins["xyz:AAA"], "kept coin untouched");
  assert.ok(app.state.coins["OTHERUNI"], "another universe's coin is never deleted");
});

test("F3: hostedLoad records a partial worker backfill via bootLoaded", async () => {
  const { app, sandbox } = loadApp();
  sandbox.fetchImpl = (url) => {
    const u = String(url);
    if (u.indexOf("/api/bootstrap") >= 0)
      return Promise.resolve({ ok: true, json: async () => ({ loaded: false, revision: 1,
        coins: [{ name: "xyz:AAA", sym: "AAA", mid: 101, tf: {} }] }) });
    return Promise.resolve({ ok: true, json: async () => ({ revision: 2, coins: [] }) });
  };
  await app.hostedLoad(app.UNIS.xyz);
  assert.equal(app.UNIS.xyz.bootLoaded, false, "partial backfill remembered");
  assert.ok(app.UNIS.xyz.lastSeedAt > 0, "seed attempts are throttleable");
});

test("F4: status clocks anchor to the WORKER's served feed ages", () => {
  const { app } = loadApp();
  app.hostedApplyState(app.UNIS.xyz, { revision: 9, midsAgeMs: 45000, candlesAgeMs: 120000,
    coins: [servedCoin("AAA", servedTf1d())] });
  assert.ok(Date.now() - app.state.lastMids >= 45000, "mids age is the feed's, not the receipt's");
  assert.ok(Date.now() - app.state.lastCandles >= 120000, "candles age too");
  app.hostedApplyState(app.UNIS.xyz, { revision: 10, coins: [servedCoin("AAA", servedTf1d())] });
  assert.ok(Date.now() - app.state.lastMids < 5000,
    "older worker without the fields falls back to receipt time");
});

test("F5: metric headers and cells carry stable col-{key} identity classes", () => {
  const { app, el } = loadApp();
  seedXyz(app);
  app.renderHead();
  const head = el("thead").innerHTML;
  ["col-funding", "col-r5", "col-r30", "col-score"].forEach((c) => {
    assert.ok(head.indexOf(c) >= 0, "header carries " + c);
  });
  app.render();
  const row = firstRegularRow(el("tbody").innerHTML);
  ["col-funding", "col-r5", "col-r30", "col-rvol", "col-sig"].forEach((c) => {
    assert.ok(row.indexOf(c) >= 0, "row carries " + c);
  });
});

test("F6: a focused star is restored AS the star, a focused row as the row", () => {
  const { app, sandbox } = loadApp();
  seedXyz(app);
  const focused = [];
  const restoredStar = { focus: (o) => focused.push(["star", o]) };
  const restoredRow = { focus: (o) => focused.push(["row", o]),
                        querySelector: (s) => (s === ".star" ? restoredStar : null) };
  const rowStub = { getAttribute: (k) => (k === "data-coin" ? "xyz:AAA" : null) };
  const starStub = { closest: (s) => (s === ".star" ? starStub : (s === "tr.row" ? rowStub : null)),
                     getAttribute: () => null };
  sandbox.document.querySelector = () => restoredRow;
  sandbox.document.activeElement = starStub;
  app.render();
  assert.deepEqual(focused, [["star", { preventScroll: true }]],
    "star focus identity survives the rebuild, still without scrolling");
  focused.length = 0;
  const bareRowStub = { closest: (s) => (s === "tr.row" ? rowStub : null), getAttribute: () => null };
  sandbox.document.activeElement = bareRowStub;
  app.render();
  assert.deepEqual(focused, [["row", { preventScroll: true }]], "row focus restores to the row");
});

test("F7: persisted set-valued arrays deduplicate on load; colspan is honest", () => {
  const { app, el } = loadApp({
    "hip3-filters": JSON.stringify({ stages: ["live", "live"], pats: ["pmg", "pmg", "22"] }),
    "hip3-cols": JSON.stringify(["sig", "sig"])
  });
  assert.deepEqual(app.state.filters.stages, ["live"], "duplicate stage collapsed");
  assert.deepEqual(app.state.filters.pats, ["pmg", "22"], "duplicate pattern collapsed");
  assert.deepEqual(app.state.hiddenCols, ["sig"], "duplicate hidden column collapsed");
  seedXyz(app);
  app.state.expanded["xyz:AAA"] = true;
  app.state.filters.stages = [];           // isolate the colspan check
  app.state.filters.pats = [];
  app.render();
  assert.ok(el("tbody").innerHTML.indexOf('colspan="14"') >= 0,
    "14 base (Symbol + 13 metric keys) - 1 unique hidden + 1 TF = 14, matching the rendered cells");
});

test("Favs view (D2-b): cross-universe rows, category scoping, honest empty states", () => {
  const { app, el } = loadApp({ "hip3-favs": JSON.stringify(["xyz:AAA", "BTC", "xyz:GONE"]) });
  seedXyz(app);
  // One perps coin in the SHARED coin map (bare name = main dex, per the
  // namespace rule); it is NOT in state.order, which stays the xyz alias.
  app.state.coins["BTC"] = {
    name: "BTC", sym: "BTC",
    ctx: { prevDayPx: "100", markPx: "101", dayNtlVlm: "9000" },
    mid: 101, hist: [],
    tf: { "1d": {
      closed: [{ t: 0, T: 1, o: 100, h: 102, l: 99, c: 100, v: 10 }],
      forming: { t: 1, T: 9e15, o: 100, h: 102, l: 99, c: 101, v: 10 },
      an: { types: ["2U", "1"], formingType: "2U", formingDir: "up",
            live: [], setups: [], invalidated: false, completed: null }
    } }
  };

  // coinUni: served field wins, else the name namespace decides.
  assert.equal(app.coinUni({ name: "xyz:AAA" }), "xyz");
  assert.equal(app.coinUni({ name: "BTC" }), "perps");
  assert.equal(app.coinUni({ name: "weird", uni: "perps" }), "perps");

  // favNames: only favorites with a coin entry survive - the favorite whose
  // universe never loaded is absent, not an error.
  assert.deepEqual(app.favNames(), ["xyz:AAA", "BTC"]);

  // Row source swaps with the flag; everything else composes.
  assert.equal(app.rowsSorted().length, 3, "universe view renders state.order");
  app.state.favsView = true;
  const favRows = app.rowsSorted().map((r) => r.coin.name).sort();
  assert.deepEqual(favRows, ["BTC", "xyz:AAA"], "favs view renders both universes");

  // Category narrows only perps-side rows, and only where the control is
  // visible (perps universe). BTC is majors in the PERP-CAT map.
  app.state.universe = "perps";
  app.state.order = app.UNIS.perps.order;   // aliasing, as setUniverse does
  app.state.category = "majors";
  assert.deepEqual(app.rowsSorted().map((r) => r.coin.name).sort(), ["BTC", "xyz:AAA"],
    "xyz favorite passes a perps category untouched; majors keeps BTC");
  app.state.category = "meme";
  assert.deepEqual(app.rowsSorted().map((r) => r.coin.name), ["xyz:AAA"],
    "a non-matching perps category drops only the perps side");
  app.state.category = "all";

  // setUniverse exits the Favs view even when the target universe is
  // already active underneath (the early-return trap).
  app.state.universe = "xyz";
  app.state.order = app.UNIS.xyz.order;
  app.setUniverse("xyz");
  assert.equal(app.state.favsView, false, "re-picking the active universe exits Favs");

  // Honest empty states: filters that exclude everything name the filters;
  // zero favorites names the favorites.
  app.state.favsView = true;
  app.state.search = "NOSUCH";
  app.render();
  assert.ok(el("tbody").innerHTML.indexOf("No favorites match") >= 0,
    "existing favorites + empty result blames the filters");
  app.state.search = "";
  app.state.favs.length = 0;
  app.render();
  assert.ok(el("tbody").innerHTML.indexOf("No favorites yet") >= 0,
    "zero favorites invites starring");
});

test("D2-d: tested TV symbol rule, drawer open/close, Command-view routing", () => {
  const { app, el } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);
  // The rule verified against TV symbol-search 2026-08-31: xyz perps on
  // the HIP3XYZ exchange, main-dex on HYPERLIQUID, both {SYM}USDC.P with
  // plain uppercase (kPEPE -> KPEPE). The PERP, never the underlying.
  assert.equal(app.tvSymbol({ name: "xyz:TSLA", sym: "TSLA" }), "HIP3XYZ:TSLAUSDC.P");
  assert.equal(app.tvSymbol({ name: "xyz:XYZ100", sym: "XYZ100" }), "HIP3XYZ:XYZ100USDC.P");
  assert.equal(app.tvSymbol({ name: "kPEPE", sym: "kPEPE" }), "HYPERLIQUID:KPEPEUSDC.P");
  assert.equal(app.tvSymbol({ name: "BTC", sym: "BTC" }), "HYPERLIQUID:BTCUSDC.P");
  assert.ok(app.tvHref({ name: "BTC", sym: "BTC" }).indexOf("HYPERLIQUID%3ABTCUSDC.P") >= 0);

  app.openDrawer("xyz:AAA");
  assert.equal(app.state.drawer, "xyz:AAA");
  assert.equal(el("drawer").hidden, false);
  assert.ok(el("drawer").innerHTML.indexOf("AAA") >= 0, "drawer names the coin");
  assert.ok(el("drawer").innerHTML.indexOf("tradingview.com") >= 0, "TV handoff present");
  assert.ok(el("drawer").innerHTML.indexOf("HIP3XYZ%3AAAAUSDC.P") >= 0,
    "TV link routes through the tested rule");
  app.closeDrawer();
  assert.equal(app.state.drawer, null);
  assert.equal(el("drawer").hidden, true);
  assert.equal(el("drawer").innerHTML, "");
});

// --- D2 audit fold (2026-08-31): regression pins for findings F1-F11 --------
// Every finding was reproduced against the code before these were written;
// the fixtures mirror the audit's concrete failure scenarios.

test("audit F1: a failed state poll after a good bootstrap commits NOTHING", async () => {
  const { app, sandbox } = loadApp();
  const u = app.UNIS.perps;
  sandbox.fetchImpl = (url) => {
    const s = String(url);
    if (s.indexOf("/api/bootstrap") >= 0)
      return Promise.resolve({ ok: true, json: async () => ({ loaded: true,
        coins: [{ name: "BTC", sym: "BTC", mid: 101,
          tf: { "15m": { closed: [{ t: 0, T: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }], forming: null } } }] }) });
    return Promise.reject(new Error("state down"));
  };
  await assert.rejects(() => app.hostedLoad(u));
  assert.equal(app.state.coins["BTC"], undefined,
    "bootstrap coins stay staged until the first state poll succeeds");
  assert.ok(!u.loaded, "the universe is not marked loaded");
});

test("audit F1: hosted rows without srv are excluded, never locally computed", () => {
  const { app } = loadApp();
  seedXyz(app);
  app.state.dataMode = "hosted";
  app.state.coins["xyz:AAA"].srv = { mid: 101, score: 5 };
  app.state.coins["xyz:BBB"].srv = { mid: 99, score: -5 };
  const names = app.rowsSorted().map((r) => r.coin.name).sort();
  assert.deepEqual(names, ["xyz:AAA", "xyz:BBB"],
    "the srv-less coin does not render under a data:worker status");
});

test("audit F1: the failed referenced universe is named in the Favs status", () => {
  const { app, el } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);
  app.state.favsView = true;
  app.UNIS.perps.loadNote = "worker load failed: boom (switch away and back to retry)";
  app.render();
  assert.ok(el("statusbar").innerHTML.indexOf("Crypto perps: worker load failed") >= 0,
    "the other universe's failure surfaces in the Favs status: " + el("statusbar").innerHTML);
});

test("audit F2: BOTH loaded universes consume the same worker restart", async () => {
  const { app, sandbox } = loadApp();
  const boots = [];
  app.state.coins["xyz:AAA"] = { name: "xyz:AAA", sym: "AAA", ctx: null, mid: 1, tf: {}, hist: [] };
  app.state.coins["BTC"] = { name: "BTC", sym: "BTC", ctx: null, mid: 1, tf: {}, hist: [] };
  app.UNIS.xyz.rev = 100; app.UNIS.perps.rev = 100;
  app.UNIS.xyz.loaded = true; app.UNIS.perps.loaded = true;
  sandbox.fetchImpl = (url) => {
    const s = String(url);
    const coin = s.indexOf("uni=perps") >= 0
      ? { name: "BTC", sym: "BTC", mid: 1, tf: {} }
      : { name: "xyz:AAA", sym: "AAA", mid: 1, tf: {} };
    if (s.indexOf("/api/bootstrap") >= 0) {
      boots.push(s);
      return Promise.resolve({ ok: true, json: async () => ({ loaded: true, coins: [coin] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ revision: 3, coins: [coin] }) });
  };
  app.state.favsView = true;               // dual tick: active first, then other
  await app.hostedTick();
  assert.equal(boots.filter((b) => b.indexOf("uni=xyz") >= 0).length, 1, "active universe re-seeded");
  assert.equal(boots.filter((b) => b.indexOf("uni=perps") >= 0).length, 1,
    "the OTHER universe re-seeds off its own revision track");
});

test("audit F3: freshness stamps are per-universe; the other side cannot mask the active clock", () => {
  const { app } = loadApp();
  app.hostedApplyState(app.UNIS.xyz, { revision: 1, coins: [], midsAgeMs: 300000, candlesAgeMs: 600000 });
  const mids = app.state.lastMids, candles = app.state.lastCandles;
  app.hostedApplyState(app.UNIS.perps, { revision: 1, coins: [], midsAgeMs: 0, candlesAgeMs: 0 });
  assert.equal(app.state.lastMids, mids, "global mids clock mirrors the ACTIVE universe only");
  assert.equal(app.state.lastCandles, candles, "global candles clock too");
  assert.ok(app.UNIS.perps.lastMids > mids, "per-universe stamp recorded for the other side");
});

test("audit F3: Favs status shows the WORST age across both loaded universes", () => {
  const { app, el } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);
  app.state.favsView = true;
  app.UNIS.perps.loaded = true;
  const now = Date.now();
  app.state.lastMids = now - 1000; app.state.lastCandles = now - 2000;
  app.UNIS.perps.lastMids = now - 300000; app.UNIS.perps.lastCandles = now - 600000;
  app.render();
  const sb = el("statusbar").innerHTML;
  assert.match(sb, /mids 30[01]s ago/, "the stale side's mids age wins: " + sb);
  assert.match(sb, /candles 60[01]s ago/, "and its candles age: " + sb);
});

test("audit F4: the last active TF refuses to toggle off; junk layout tfs applies defaults", () => {
  const { app } = loadApp();
  seedXyz(app);                                  // leaves only 1d active
  const d = app.TFS.filter((t) => t.id === "1d")[0];
  assert.equal(app.toggleTF(d), false, "the last active TF refuses");
  assert.equal(d.active, true, "and stays active");
  app.layouts.presets["Empty"] = { filters: null, cols: [], tfs: [], view: "simple" };
  app.applyLayout("Empty");
  assert.deepEqual(app.TFS.filter((t) => t.active).map((t) => t.id), app.TF_DEFAULT_IDS,
    "junk tfs applies the markup defaults deterministically");
  assert.equal(app.layouts.current, "Empty", "so the current claim is honest");
});

test("audit F7: Structure sorts the D/W/M quantity it displays", () => {
  const { app } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);
  const an = (dir) => ({ types: [], formingType: "2U", formingDir: dir,
    live: [], setups: [], invalidated: false, completed: null });
  const A = app.state.coins["xyz:AAA"], B = app.state.coins["xyz:BBB"];
  A.tf["1d"].an = an("up"); A.tf["1w"] = { closed: [], forming: null, an: an("down") };
  A.tf["1M"] = { closed: [], forming: null, an: an("down") };
  B.tf["1d"].an = an("up"); B.tf["1w"] = { closed: [], forming: null, an: an("up") };
  B.tf["1M"] = { closed: [], forming: null, an: an("up") };
  assert.ok(app.slowFtfcRank(B) > app.slowFtfcRank(A), "3/3 up ranks above 1/3 up");
  app.state.order = ["xyz:AAA", "xyz:BBB"]; app.UNIS.xyz.order = app.state.order;
  app.state.sortKey = "slowftfc"; app.state.sortDir = -1;
  assert.deepEqual(app.rowsSorted().map((r) => r.coin.name), ["xyz:BBB", "xyz:AAA"],
    "descending puts FTFC 3/3 up first - the value in the clicked column");
});

test("audit F9: view switches reconcile the detail surfaces", () => {
  const { app, el } = loadApp({ "hip3-view": "regular" });
  seedXyz(app);
  app.state.expanded["xyz:AAA"] = true;
  app.setView("simple");
  assert.deepEqual(app.state.expanded, {}, "inline expansion closes entering Command");
  app.openDrawer("xyz:AAA");
  app.setView("regular");
  assert.equal(app.state.drawer, null, "the drawer closes entering Regular");
  assert.equal(el("drawer").hidden, true);
});

test("audit F10: SKHX charts as TV's SKHYNIX perp; SKHY stays generic", () => {
  const { app } = loadApp();
  assert.equal(app.tvSymbol({ name: "xyz:SKHX", sym: "SKHX" }), "HIP3XYZ:SKHYNIXUSDC.P",
    "SKHXUSDC.P does not exist on TV (probed 2026-08-31)");
  assert.equal(app.tvSymbol({ name: "xyz:SKHY", sym: "SKHY" }), "HIP3XYZ:SKHYUSDC.P",
    "the separate Nasdaq-ADS perp matches the generic rule");
  assert.equal(app.tvSymbol({ name: "kPEPE", sym: "kPEPE" }), "HYPERLIQUID:KPEPEUSDC.P");
});

test("audit F11: prototype-reserved preset names cannot pollute or bypass the cap", () => {
  const stored = '{"current":"constructor","presets":{"constructor":{"view":"simple"}}}';
  const { app } = loadApp({ "hip3-layouts": stored });
  assert.equal(Object.getPrototypeOf(app.layouts.presets), null, "null-prototype store");
  assert.deepEqual(Object.keys(app.layouts.presets), ["constructor"], "an own, listable key");
  assert.equal(app.layouts.current, "constructor", "current resolves via own-key membership");
  for (let n = 0; Object.keys(app.layouts.presets).length < 20; n++)
    assert.equal(app.saveNamedLayout("p" + n), null);
  assert.match(app.saveNamedLayout("__proto__") || "", /limit/, "cap holds for __proto__");
  assert.match(app.saveNamedLayout("valueOf") || "", /limit/, "cap holds for valueOf");
  assert.equal(app.saveNamedLayout("constructor"), null, "overwriting an OWN preset stays allowed");
  assert.equal(Object.keys(app.layouts.presets).length, 20, "hard cap of 20 own keys");
});

test("audit F11: a phantom current pointing at an inherited name clears to null", () => {
  const { app } = loadApp({ "hip3-layouts": '{"current":"__proto__","presets":{"a":{"view":"simple"}}}' });
  assert.equal(app.layouts.current, null, "no phantom current from an inherited name");
});

// --- Sort chip (Option A, chosen 2026-08-31) --------------------------

test("sort chip: applySort writes the live sort AND the per-view slot", () => {
  const { app } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);
  app.applySort("chg", -1);
  assert.equal(app.state.sortKey, "chg");
  assert.equal(app.state.sortDir, -1);
  assert.equal(app.state.simpleSortKey, "chg", "Command slot updated");
  assert.equal(app.state.simpleSortDir, -1);
  app.applySort("chg", 1);
  assert.equal(app.state.simpleSortDir, 1, "direction-only change persists");
  // Regular view writes the OTHER slot, leaving Command's intact.
  app.setView("regular");
  app.applySort("vol", -1);
  assert.equal(app.state.regularSortKey, "vol");
  assert.equal(app.state.simpleSortKey, "chg", "Command slot untouched from Regular");
});

test("sort chip: every Command sort key has a badge label", () => {
  const { app } = loadApp();
  ["name","px","chg","trend","score","focus","prog","dist","magleft","slowftfc"]
    .forEach((k) => {
      const l = app.sortKeyLabel(k);
      assert.ok(l && l !== k, "key " + k + " labels as " + l);
    });
  assert.equal(app.sortKeyLabel("ftfc"), "D/W/M", "legacy persisted key still names itself");
  assert.equal(app.sortKeyLabel("mystery"), "mystery", "unknown keys fall back to themselves");
});

// --- Sort sign convention (a mobile-app divergence, 2026-09-02) -------
// The name comparator carried the INVERSE sign of the numeric branches, so
// the Symbol default (sortDir 1, header aria-sort "ascending") rendered Z-A
// while a numeric key at sortDir 1 rendered ascending. Both branches are
// pinned to ONE convention here: dir 1 = ascending, for strings and numbers.

test("sort sign: Symbol sortDir 1 is A-Z, -1 is Z-A, and numeric keys agree", () => {
  const { app } = loadApp();
  seedXyz(app);
  // Seed out of order so the input order cannot pass as a sort.
  app.UNIS.xyz.order = ["xyz:BBB", "xyz:AAA", "xyz:CCC"];
  app.state.order = app.UNIS.xyz.order;
  app.state.coins["xyz:AAA"].ctx.dayNtlVlm = "300";
  app.state.coins["xyz:BBB"].ctx.dayNtlVlm = "100";
  app.state.coins["xyz:CCC"].ctx.dayNtlVlm = "200";
  const syms = () => app.rowsSorted().map((r) => r.coin.sym);
  app.state.sortKey = "name"; app.state.sortDir = 1;
  assert.deepEqual(syms(), ["AAA", "BBB", "CCC"], "Symbol ascending renders A-Z");
  app.state.sortDir = -1;
  assert.deepEqual(syms(), ["CCC", "BBB", "AAA"], "Symbol descending renders Z-A");
  // The numeric convention the name branch must share: dir 1 = ascending.
  app.state.sortKey = "vol"; app.state.sortDir = 1;
  assert.deepEqual(syms(), ["BBB", "CCC", "AAA"], "numeric sortDir 1 is ascending");
  app.state.sortDir = -1;
  assert.deepEqual(syms(), ["AAA", "CCC", "BBB"], "numeric sortDir -1 is descending");
  // The header default a Symbol click lands on is the ascending direction
  // (the same default the sort chip applies), so the default renders A-Z.
  app.applySort("name", 1);
  assert.deepEqual(syms(), ["AAA", "BBB", "CCC"], "chip default for Symbol is A-Z");
});

// --- Day % column: chgUtc as a Columns toggle (design decision 2026-09-13) ------
// The worker has served chgUtc per coin since 2026-08-04 (src/apistate.js:
// last vs the open of the 1d candle belonging to the current UTC day, null
// when that candle is missing or has not rolled - null means unknown, never
// zero). The dashboard renders it beside 24h %: a Regular column, a line in
// the Command Market stack, a sort key and a CSV column, all behind ONE
// Columns pill that defaults visible. Hosted rows read the served value;
// standalone derives it through chgUtcLocal, the hand-written mirror of the
// worker rule.

// A fixed "now" inside a UTC day, and the 1d bar t that day's candle carries.
const DAY_NOW = Date.UTC(2026, 8, 13, 15, 30, 0);
const DAY_T = Date.UTC(2026, 8, 13);

function dayCoin(forming, mid) {
  const c = mkCoin("DAY", "2U", "up");
  c.mid = mid === undefined ? 105 : mid;
  c.tf["1d"].forming = forming;
  return c;
}

test("Day %: hosted rows read the WORKER's chgUtc - present is the value, absent is null", () => {
  const { app } = loadApp();
  app.state.dataMode = "hosted";
  app.TFS.forEach((tf) => { tf.active = tf.id === "1d"; });
  const tf = { "1d": { types: ["2U"], formingType: "2U", formingDir: "up", live: [],
    setups: [], invalidated: false, completed: null, shape: null,
    forming: { t: DAY_T, T: 9e15, o: 100, h: 106, l: 99, c: 105 } } };
  app.hostedApplyState(app.UNIS.xyz, { coins: [
    { name: "xyz:AAA", sym: "AAA", mid: 105, chg24: 2.5, chgUtc: 5, vol: 1, funding: 0, tf: tf },
    { name: "xyz:BBB", sym: "BBB", mid: 105, chg24: 2.5, chgUtc: null, vol: 2, funding: 0, tf: tf },
    { name: "xyz:CCC", sym: "CCC", mid: 105, chg24: 2.5, vol: 3, funding: 0, tf: tf }
  ] });
  app.state.sortKey = "name"; app.state.sortDir = 1;
  const rows = app.rowsSorted();
  assert.equal(rows[0].chgUtc, 5, "served value flows through untouched");
  assert.equal(rows[1].chgUtc, null, "served null stays null");
  assert.equal(rows[2].chgUtc, null, "absent field reads null - never derived locally in hosted mode");
  // The local derivation would have produced 5 for every one of them; the
  // hosted row must not reach for it (the served numbers are what alerted).
  assert.equal(app.chgUtcLocal(app.state.coins["xyz:CCC"], DAY_NOW), 5);
});

test("Day %: standalone derivation mirrors the worker's UTC-day rule", () => {
  const { app } = loadApp();
  // Forming 1d bar whose t IS today's 00:00 UTC: (mid - open) / open * 100.
  assert.ok(Math.abs(app.chgUtcLocal(dayCoin({ t: DAY_T, T: 9e15, o: 100, h: 106, l: 99, c: 105 }), DAY_NOW) - 5) < 1e-9);
  // Negative day: sign follows the mid, not the abs.
  assert.ok(Math.abs(app.chgUtcLocal(dayCoin({ t: DAY_T, T: 9e15, o: 100, h: 101, l: 94, c: 95 }, 95), DAY_NOW) + 5) < 1e-9);
  // Yesterday's candle still in the forming slot (around the roll): null,
  // never yesterday's open dressed as today's change.
  assert.equal(app.chgUtcLocal(dayCoin({ t: DAY_T - 86400000, T: DAY_T, o: 100, h: 106, l: 99, c: 105 }), DAY_NOW), null);
  // A synthesized forming bar (loadTF: t = last.T + 1) is NOT special-cased;
  // the t-equality rule decides, so an off-by-one t reads null.
  assert.equal(app.chgUtcLocal(dayCoin({ t: DAY_T + 1, T: 9e15, o: 100, h: 106, l: 99, c: 105 }), DAY_NOW), null);
  // No forming bar, no 1d slot: null.
  assert.equal(app.chgUtcLocal(dayCoin(null), DAY_NOW), null);
  const noSlot = dayCoin(null); delete noSlot.tf["1d"];
  assert.equal(app.chgUtcLocal(noSlot, DAY_NOW), null);
  // Open of 0 (a division that would fabricate Infinity) and non-finite
  // opens: null. No mid: null. Never 0 as a stand-in.
  assert.equal(app.chgUtcLocal(dayCoin({ t: DAY_T, T: 9e15, o: 0, h: 1, l: 0, c: 1 }), DAY_NOW), null);
  assert.equal(app.chgUtcLocal(dayCoin({ t: DAY_T, T: 9e15, o: "", h: 1, l: 0, c: 1 }), DAY_NOW), null);
  assert.equal(app.chgUtcLocal(dayCoin({ t: DAY_T, T: 9e15, o: 100, h: 106, l: 99, c: 105 }, null), DAY_NOW), null);
  // The row model wires it: a standalone row carries chgUtc from the helper.
  seedXyz(app);
  const c = app.state.coins["xyz:AAA"];
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  c.tf["1d"].forming = { t: today, T: 9e15, o: 100, h: 102, l: 99, c: 101 };
  c.mid = 102;
  app.state.sortKey = "name"; app.state.sortDir = 1;
  assert.ok(Math.abs(app.rowsSorted()[0].chgUtc - 2) < 1e-9, "standalone row reads chgUtcLocal");
  assert.equal(app.rowsSorted()[1].chgUtc, null, "mkCoin's t:1 forming bar is not today's candle -> null");
});

test("Day %: the column is a Columns toggle that defaults VISIBLE, even against a pre-existing hidden set or preset", () => {
  // A persisted hip3-cols set saved BEFORE the key existed (hides two other
  // columns): chgutc is not in it, so it renders. The stored list is the
  // HIDDEN set; a column a layout never knew about is visible on replay.
  const { app, el, store } = loadApp({ "hip3-cols": JSON.stringify(["funding", "r30"]) });
  seedXyz(app);
  assert.ok(app.COL_KEYS.indexOf("chgutc") >= 0, "chgutc is a whitelisted column key");
  assert.ok(app.colVisible("chgutc"), "visible by default against an older hidden set");
  app.renderHead();
  let head = el("thead").innerHTML;
  assert.ok(head.indexOf(">Day %<") >= 0, "Regular header renders Day % right after 24h %: " + head);
  assert.ok(head.indexOf("24h %") < head.indexOf("Day %"), "Day % sits after 24h %");
  assert.ok(head.indexOf('title="Mid vs the open of the current UTC day') >= 0, "header tooltip names the window");
  app.render();
  let row = firstRegularRow(el("tbody").innerHTML);
  assert.ok(row.indexOf('col-chgutc') >= 0, "row emits the Day % cell");
  assert.ok(/col-chgutc neu">-</.test(row), "unknown UTC-day change renders '-', never 0");
  // A Layout preset saved WITHOUT any opinion on chgutc (its cols predate
  // the key) leaves the column visible when applied.
  app.layouts.presets["old"] = { filters: {}, cols: ["funding"], tfs: ["1d"], view: "regular" };
  app.applyLayout("old");
  assert.ok(app.colVisible("chgutc"), "preset replay keeps an unknown-to-it column visible");
  assert.deepEqual(app.state.hiddenCols, ["funding"]);
  // Toggling it off persists and drops the header AND the cell; a saved
  // preset that captured the hidden state replays it hidden.
  app.state.hiddenCols.push("chgutc"); app.saveHiddenCols();
  assert.ok(JSON.parse(store["hip3-cols"]).indexOf("chgutc") >= 0, "hidden state persists");
  app.renderHead(); app.render();
  head = el("thead").innerHTML;
  row = firstRegularRow(el("tbody").innerHTML);
  assert.ok(head.indexOf("Day %") < 0 && row.indexOf("col-chgutc") < 0, "toggled off: no header, no cell");
  assert.ok(app.snapshotLayout().cols.indexOf("chgutc") >= 0, "a preset saved now captures the hidden state");
  // Command view: the Market stack carries the Day % line under the SAME
  // toggle - hidden now, shown once the pill is back on.
  app.setView("simple"); app.render();
  assert.ok(el("tbody").innerHTML.indexOf("g-day") < 0, "Command Market stack omits Day % while hidden");
  app.state.hiddenCols = ["funding"]; app.saveHiddenCols(); app.render();
  const simpleRow = el("tbody").innerHTML.match(/<tr class="row simple-row"[\s\S]*?<\/tr>/)[0];
  assert.ok(simpleRow.indexOf("g-day") >= 0, "Command Market stack shows the Day % line when on");
  assert.ok(/g-day[^>]*>.*?<span class="neu">-<\/span>/.test(simpleRow), "Command Day % renders '-' when null");
});

test("Day %: Regular cell, Command line and CSV all format the served value; CSV column is additive", () => {
  const { app, el } = loadApp();
  seedXyz(app);
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const a = app.state.coins["xyz:AAA"];
  a.tf["1d"].forming = { t: today, T: 9e15, o: 100, h: 102, l: 99, c: 101 };
  a.mid = 98.5;   // -1.50%
  app.state.sortKey = "name"; app.state.sortDir = 1;
  app.render();
  const row = firstRegularRow(el("tbody").innerHTML);
  assert.ok(/col-chgutc neg">-1\.50%</.test(row), "Regular cell: neg class, two decimals: " + row);
  app.setView("simple"); app.render();
  const simpleRow = el("tbody").innerHTML.match(/<tr class="row simple-row"[\s\S]*?<\/tr>/)[0];
  assert.ok(/g-day[^>]*>.*?<span class="neg">-1\.50%<\/span>/.test(simpleRow), "Command line formats the same: " + simpleRow);
  const csv = app.csvString().split("\n");
  const head = csv[0].split(",");
  assert.equal(head.indexOf("chgutc_pct"), head.indexOf("chg24_pct") + 1, "chgutc_pct immediately after chg24_pct");
  const first = csv[1].split(",");
  assert.equal(first[head.indexOf("chgutc_pct")], "-1.50", "AAA's Day % in the CSV");
  const second = csv[2].split(",");
  assert.equal(second[head.indexOf("chgutc_pct")], "", "null exports blank, like chg24_pct");
  assert.equal(second[head.indexOf("chg24_pct")], "1.00", "chg24_pct still exports beside it");
});

test("Day %: chgutc sort key sinks nulls the same way chg does; chip label and default direction", () => {
  const { app } = loadApp({ "hip3-view": "simple" });
  seedXyz(app);
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const set = (name, mid, chgUtcToday) => {
    const c = app.state.coins[name];
    c.mid = mid;
    c.ctx.prevDayPx = "100";
    if (chgUtcToday) c.tf["1d"].forming = { t: today, T: 9e15, o: 100, h: 110, l: 90, c: mid };
  };
  set("xyz:AAA", 103, true);    // chg +3, chgUtc +3
  set("xyz:BBB", 97, true);     // chg -3, chgUtc -3
  set("xyz:CCC", 110, false);   // chg +10, chgUtc null (no today candle)
  const order = (k, dir) => { app.state.sortKey = k; app.state.sortDir = dir; return app.rowsSorted().map((r) => r.coin.sym); };
  assert.deepEqual(order("chgutc", -1), ["AAA", "BBB", "CCC"], "desc: null sinks to the bottom");
  assert.deepEqual(order("chgutc", 1), ["CCC", "BBB", "AAA"], "asc: the -Infinity idiom floats null, as chg does");
  // The SAME shape chg produces under the same inputs (CCC's chg is +10).
  assert.deepEqual(order("chg", -1), ["CCC", "AAA", "BBB"]);
  app.state.coins["xyz:CCC"].ctx = null;   // chg null too -> same sinking as chgutc
  assert.deepEqual(order("chg", -1), ["AAA", "BBB", "CCC"], "chg null sinks under desc");
  assert.deepEqual(order("chg", 1), ["CCC", "BBB", "AAA"], "chg null floats under asc - the idiom the Day % key copies");
  assert.equal(app.sortKeyLabel("chgutc"), "Day %", "sort chip badge label");
  app.applySort("chgutc", -1);
  assert.equal(app.state.simpleSortKey, "chgutc", "Command slot takes the key");
});
