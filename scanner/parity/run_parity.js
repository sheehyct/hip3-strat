"use strict";
// JS-vs-Python parity harness for the HIP-3 STRAT core.
//
// 1. Fetch live candles from Hyperliquid: 1h for ALL active xyz coins,
//    plus 15m/30m/4h/1d for 6 representative coins.
// 2. Run the extracted JS core (analyzeTF) on every (coin, tf) pair, and
//    calendar week/month aggregation for the 6 coins.
// 3. Dump raw bars + JS results to ONE JSON file; run reference.py on it
//    (python computes from the SAME bars - no refetch on the python side).
// 4. Diff types / formingType / completed name / setups / live / aggregation
//    buckets with 1e-9 float tolerance; print per-pair PASS/FAIL and totals.
//
// Zero dependencies - node builtins only (global fetch, fs, path, child_process).

var fs = require("fs");
var os = require("os");
var path = require("path");
var spawnSync = require("child_process").spawnSync;

// review MEDIUM-6: never certify stale JavaScript -- derive the
// expected module from the HTML in memory and byte-compare it to the
// committed parity copy BEFORE loading it. A drift here previously produced
// a false-green JS-vs-Python parity run against outdated core code.
var extractor = require("./extract_core.js");
var expectedCore = extractor.build();
var committedCore = fs.readFileSync(path.join(__dirname, "strat_core_extracted.js"), "utf8");
if (committedCore !== expectedCore) {
  console.error(
    "PARITY EXTRACTION STALE: parity/strat_core_extracted.js does not match " +
      "the HTML. Regenerate: node parity/extract_core.js  (then re-run parity)"
  );
  process.exit(1);
}

var core = require("./strat_core_extracted.js");

var API = "https://api.hyperliquid.xyz/info";
var DEX = "xyz";
var CONCURRENCY = 6;
var TOL = 1e-9;
var SCRATCH = process.env.PARITY_OUT_DIR || path.join(os.tmpdir(), "hip3-parity");
var DATA_FILE = path.join(SCRATCH, "hip3_parity_data.json");
var PY_OUT_FILE = path.join(SCRATCH, "hip3_parity_py_results.json");

var REQUIRED_COINS = ["xyz:NVDA", "xyz:TSLA", "xyz:GOLD"];
var REP_TFS = ["15m", "30m", "4h", "1d"]; // 1h covered by the all-coins pass
var TF_LOOKBACK_MS = {
  "15m": 40 * 900000,
  "30m": 40 * 1800000,
  "1h": 14 * 3600000, // per spec: startTime = now - 14*3600000
  "4h": 40 * 14400000,
  "1d": 220 * 86400000 // feeds W/M aggregation (dashboard uses bars=220)
};

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function post(body, tries) {
  tries = tries || 0;
  var r;
  try {
    r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    if (tries >= 5) throw e;
    await sleep(800 * Math.pow(2, tries));
    return post(body, tries + 1);
  }
  if (r.status === 429) {
    if (tries >= 5) throw new Error("HTTP 429 after " + tries + " retries");
    await sleep(800 * Math.pow(2, tries));
    return post(body, tries + 1);
  }
  if (!r.ok) throw new Error("HTTP " + r.status + " for " + JSON.stringify(body).slice(0, 140));
  return r.json();
}

async function pool(tasks, width) {
  var results = new Array(tasks.length);
  var next = 0;
  async function worker() {
    while (next < tasks.length) {
      var k = next++;
      results[k] = await tasks[k]();
    }
  }
  var workers = [];
  for (var i = 0; i < Math.min(width, tasks.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// fetchNow recorded ONCE per coin-TF at fetch time; the forming split and the
// endTime both use it (mirrors the dashboard's fetchCandles exactly).
async function fetchCandles(coin, interval) {
  var fetchNow = Date.now();
  var raw = await post({
    type: "candleSnapshot",
    req: { coin: coin, interval: interval,
           startTime: fetchNow - TF_LOOKBACK_MS[interval], endTime: fetchNow }
  });
  var cs = (raw || []).map(function (c) {
    return { t: c.t, T: c.T, o: +c.o, h: +c.h, l: +c.l, c: +c.c };
  });
  var forming = null;
  if (cs.length && cs[cs.length - 1].T > fetchNow) forming = cs.pop();
  return { coin: coin, tf: interval, fetchNow: fetchNow, closed: cs, forming: forming };
}

// ---------- comparison helpers (harness logic only, no detection semantics) ----------

function numEq(a, b) {
  var an = a === null || a === undefined;
  var bn = b === null || b === undefined;
  if (an || bn) return an && bn; // null == None
  return Math.abs(a - b) <= TOL;
}

function arrEq(a, b) { // types arrays: strings / nulls
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    var av = a[i] === undefined ? null : a[i];
    var bv = b[i] === undefined ? null : b[i];
    if (av !== bv) return false;
  }
  return true;
}

// Set comparison with float tolerance: greedy 1:1 matching on normalized records.
function matchSets(jsList, pyList, strFields, numFields) {
  if (jsList.length !== pyList.length) return false;
  var used = new Array(pyList.length).fill(false);
  for (var i = 0; i < jsList.length; i++) {
    var j = jsList[i], found = -1;
    for (var k = 0; k < pyList.length; k++) {
      if (used[k]) continue;
      var p = pyList[k], ok = true, f;
      for (f = 0; f < strFields.length && ok; f++)
        if (j[strFields[f]] !== p[strFields[f]]) ok = false;
      for (f = 0; f < numFields.length && ok; f++)
        if (!numEq(j[numFields[f]], p[numFields[f]])) ok = false;
      if (ok) { found = k; break; }
    }
    if (found < 0) return false;
    used[found] = true;
  }
  return true;
}

// Python setups are lists [name, dir, trigger, stop, target, kind, tgt_rule] - normalize.
function normPySetup(s) {
  return { name: s[0], dir: s[1], trigger: s[2], stop: s[3], target: s[4], kind: s[5], tgt_rule: s[6] };
}
// Python live entries are lists [name, dir, entry, target, tgt_rule] (target
// rules v2).
function normPyLive(s) { return { name: s[0], dir: s[1], entry: s[2], target: s[3], tgt_rule: s[4] }; }

function fmtSetup(s) {
  return s.name + "/" + s.dir + "/" + s.kind + " trig=" + s.trigger +
    " stop=" + s.stop + " tgt=" + s.target + "/" + s.tgt_rule;
}

// Diff one analyzed pair. jsRes = JS analyzeTF output; pyRes = python analyze output.
// Returns array of mismatch description strings (empty = PASS).
function diffAnalysis(jsRes, pyRes) {
  var errs = [];
  if (!arrEq(jsRes.types, pyRes.types))
    errs.push("types JS=" + JSON.stringify(jsRes.types) + " PY=" + JSON.stringify(pyRes.types));
  var jf = jsRes.formingType === undefined ? null : jsRes.formingType;
  var pf = pyRes.formingType === undefined ? null : pyRes.formingType;
  if (jf !== pf) errs.push("formingType JS=" + jf + " PY=" + pf);
  var jd = jsRes.formingDir === undefined ? null : jsRes.formingDir;
  var pd = pyRes.formingDir === undefined ? null : pyRes.formingDir;
  if (jd !== pd) errs.push("formingDir JS=" + jd + " PY=" + pd);
  // JS detectCompleted returns {name, dir, cont}; python returns just the name.
  var jc = jsRes.completed ? jsRes.completed.name : null;
  var pc = pyRes.completed === undefined ? null : pyRes.completed;
  if (jc !== pc) errs.push("completed JS=" + jc + " PY=" + pc);
  var pySetups = pyRes.setups.map(normPySetup);
  if (!matchSets(jsRes.setups, pySetups, ["name", "dir", "kind", "tgt_rule"], ["trigger", "stop", "target"]))
    errs.push("setups JS=[" + jsRes.setups.map(fmtSetup).join("; ") + "] PY=[" +
      pySetups.map(fmtSetup).join("; ") + "]");
  var pyLive = pyRes.live.map(normPyLive);
  if (!matchSets(jsRes.live, pyLive, ["name", "dir", "tgt_rule"], ["entry", "target"]))
    errs.push("live JS=" + JSON.stringify(jsRes.live.map(function (s) {
      return [s.name, s.dir, s.entry, s.target, s.tgt_rule];
    })) + " PY=" + JSON.stringify(pyRes.live));
  if (!!jsRes.invalidated !== !!pyRes.invalidated)
    errs.push("invalidated JS=" + jsRes.invalidated + " PY=" + pyRes.invalidated);
  // MoMo shape: compare type + confirming; null/missing treated identically.
  var jsh = jsRes.shape || null, pysh = pyRes.shape || null;
  if ((jsh === null) !== (pysh === null))
    errs.push("shape presence JS=" + JSON.stringify(jsh) + " PY=" + JSON.stringify(pysh));
  else if (jsh && (jsh.type !== pysh.type || !!jsh.confirming !== !!pysh.confirming))
    errs.push("shape JS=" + JSON.stringify(jsh) + " PY=" + JSON.stringify(pysh));
  return errs;
}

// Diff aggregation buckets: t exact, o/h/l/c with tolerance, plus classifications.
function diffAggBars(jsBars, pyBars, jsTypesAll, pyTypesAll) {
  var errs = [];
  if (jsBars.length !== pyBars.length) {
    errs.push("bucket count JS=" + jsBars.length + " PY=" + pyBars.length);
    return errs;
  }
  for (var i = 0; i < jsBars.length; i++) {
    var j = jsBars[i], p = pyBars[i];
    if (j.t !== p.t) errs.push("bucket[" + i + "].t JS=" + j.t + " PY=" + p.t);
    ["o", "h", "l", "c"].forEach(function (f) {
      if (!numEq(j[f], p[f]))
        errs.push("bucket[" + i + "]." + f + " JS=" + j[f] + " PY=" + p[f]);
    });
  }
  if (!arrEq(jsTypesAll, pyTypesAll))
    errs.push("agg types JS=" + JSON.stringify(jsTypesAll) + " PY=" + JSON.stringify(pyTypesAll));
  return errs;
}

// ---------- target rules v2: daily ctx + synthetic pairs ----------

// The worker's rule (src/loop.js dailyCtx): the 1h bars bridge the signal
// window to the dailies; the dailies are the whole history when the oldest
// STARTS less than 218 days before the fetch (judged by time).
var DAILY_COMPLETE_DAYS = 218;
function ctxOf(daily, hourly) {
  var ctx = {};
  if (hourly) ctx.bridge = hourly.closed;
  if (daily) {
    ctx.daily = daily.closed;
    ctx.complete = daily.closed.length > 0 && daily.closed[0].t > daily.fetchNow - DAILY_COMPLETE_DAYS * 86400000;
  }
  return (hourly || daily) ? ctx : undefined;
}

// Seeded random bar series, so the level search, the bar-0 rule, the
// all-time-extreme and fallback branches, and equal highs/lows (half the
// series sit on an integer grid, where ties are common) are all exercised
// far more often than live bars do. JS and Python run on the SAME bars.
function synthPairs(count, seed) {
  var st = seed >>> 0;
  function rnd() { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; }
  function series(n, t0, ms, grid, p0) {
    var out = [], p = p0;
    for (var i = 0; i < n; i++) {
      var o = p, c = p + (rnd() - 0.5) * 8, h = Math.max(o, c) + rnd() * 4, l = Math.min(o, c) - rnd() * 4;
      if (grid) { o = Math.round(o); c = Math.round(c); h = Math.max(Math.round(h), o, c); l = Math.min(Math.round(l), o, c); }
      out.push({ t: t0 + i * ms, T: t0 + (i + 1) * ms - 1, o: o, h: h, l: l, c: c });
      p = c;
    }
    return out;
  }
  var D1 = 86400000, H1 = 3600000, BASE = Date.UTC(2026, 0, 1), out = [];
  var SIZES = [900000, 1800000, 3600000, 14400000], NAMES = ["15m", "30m", "1h", "4h"];
  for (var k = 0; k < count; k++) {
    var grid = rnd() < 0.5, n = 3 + Math.floor(rnd() * 38), z = Math.floor(rnd() * 4), ms = SIZES[z];
    // the window starts mid-day (review LOW-3: day-aligned windows never
    // produced a daily or 1h bar straddling the window start)
    var W = BASE + Math.floor(rnd() * 96) * 900000;
    var nd = Math.floor(rnd() * 60), dStart = Math.floor(W / D1) * D1 - nd * D1;
    var daily = series(nd + 2, dStart, D1, grid, 100);          // the last ones straddle or follow the window start
    var nb = Math.floor(rnd() * 72), bStart = Math.floor(W / H1) * H1 - nb * H1;
    var bridge = series(nb + 3, bStart, H1, grid, 100);          // a few start inside the window: must be skipped
    var bars = series(n + 1, W, ms, grid, 100);
    var forming = rnd() < 0.6 ? bars.pop() : (bars.pop(), null);
    var mode = rnd(), ctx;
    if (mode < 0.1) ctx = undefined;                                       // no ctx: completeness unknown
    else if (mode < 0.15) ctx = { daily: [], complete: true };             // a listing with no finished daily
    else if (mode < 0.25) ctx = { bridge: bridge };                        // a bridge, no daily slot
    else if (mode < 0.4) ctx = { daily: daily, complete: rnd() < 0.5 };   // no 1h slot
    else ctx = { bridge: bridge, daily: daily, complete: rnd() < 0.5 };
    out.push({ coin: "SYN:" + k, tf: NAMES[z], fetchNow: W + n * ms, closed: bars, forming: forming, ctx: ctx,
               js: core.analyzeTF(bars, forming, null, ctx) });
  }
  return out;
}
var SYNTH_COUNT = 10000, SYNTH_SEED = 20261031;
var SYNTH_ONLY = process.argv.indexOf("--synthetic-only") >= 0;

// ---------- main ----------

async function main() {
  console.log("[1] meta dex=" + DEX + (SYNTH_ONLY ? " (skipped: --synthetic-only)" : ""));
  var meta = SYNTH_ONLY ? { universe: [] } : await post({ type: "meta", dex: DEX });
  var universe = meta.universe || [];
  var active = universe.filter(function (u) { return !u.isDelisted; })
                       .map(function (u) { return u.name; });
  console.log("    universe=" + universe.length + " active=" + active.length +
    " delisted=" + (universe.length - active.length));

  for (var i = 0; i < REQUIRED_COINS.length && !SYNTH_ONLY; i++) {
    if (active.indexOf(REQUIRED_COINS[i]) < 0)
      throw new Error("required coin not active: " + REQUIRED_COINS[i]);
  }
  var reps = REQUIRED_COINS.slice();
  for (var a = 0; a < active.length && reps.length < 6; a++) {
    if (reps.indexOf(active[a]) < 0) reps.push(active[a]);
  }
  console.log("    representative coins: " + reps.join(", "));

  console.log("[2] fetching candles (1h x " + active.length + " coins, " +
    REP_TFS.join("/") + " x " + reps.length + " coins, concurrency " + CONCURRENCY + ")");
  var tasks = [];
  active.forEach(function (c) {
    tasks.push(function () { return fetchCandles(c, "1h"); });
  });
  if (SYNTH_ONLY) reps = [];
  reps.forEach(function (c) {
    REP_TFS.forEach(function (tf) {
      tasks.push(function () { return fetchCandles(c, tf); });
    });
  });
  var fetched = await pool(tasks, CONCURRENCY);
  console.log("    fetched " + fetched.length + " coin-TF pairs");

  console.log("[3] running JS core (analyzeTF) on every pair");
  var dailyOf = {}, hourlyOf = {};
  fetched.forEach(function (fr) { if (fr.tf === "1d") dailyOf[fr.coin] = fr; if (fr.tf === "1h") hourlyOf[fr.coin] = fr; });
  var pairs = fetched.map(function (fr) {
    var ctx = ctxOf(dailyOf[fr.coin], hourlyOf[fr.coin]);
    return {
      coin: fr.coin, tf: fr.tf, fetchNow: fr.fetchNow,
      closed: fr.closed, forming: fr.forming, ctx: ctx,
      js: core.analyzeTF(fr.closed, fr.forming, null, ctx)
    };
  });
  var synth = synthPairs(SYNTH_COUNT, SYNTH_SEED);
  pairs = pairs.concat(synth);
  console.log("    + " + synth.length + " synthetic 15m/30m/1h/4h pairs (seed " + SYNTH_SEED + ")");

  console.log("[4] W/M aggregation for the " + reps.length + " representative coins");
  var agg = [];
  reps.forEach(function (c) {
    var daily = null;
    for (var i = 0; i < pairs.length; i++) {
      if (pairs[i].coin === c && pairs[i].tf === "1d") { daily = pairs[i]; break; }
    }
    if (!daily) throw new Error("no 1d pair for " + c);
    // forming daily included as last element of the aggregation input
    var dailyInput = daily.closed.concat(daily.forming ? [daily.forming] : []);
    ["week", "month"].forEach(function (mode) {
      var bars = core.aggregateBars(dailyInput, mode);
      var forming = null, closed = bars;
      if (bars.length && bars[bars.length - 1].T > daily.fetchNow) {
        forming = bars[bars.length - 1];
        closed = bars.slice(0, -1);
      }
      agg.push({
        coin: c, mode: mode, fetchNow: daily.fetchNow, dailyInput: dailyInput,
        bars: bars, typesAll: core.classifySeries(bars),
        closedCount: closed.length, hasForming: forming !== null, ctx: ctxOf(daily, hourlyOf[c]),
        js: core.analyzeTF(closed, forming, null, ctxOf(daily, hourlyOf[c]))
      });
    });
  });

  console.log("[5] writing shared data file: " + DATA_FILE);
  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify({ pairs: pairs, agg: agg }));

  console.log("[6] running python reference on the SAME bars");
  var py = spawnSync("python", [path.join(__dirname, "reference.py"), DATA_FILE, PY_OUT_FILE],
    { encoding: "utf8" });
  if (py.status !== 0) {
    console.error(py.stdout || "");
    console.error(py.stderr || "");
    throw new Error("reference.py exited " + py.status);
  }
  var pyOut = JSON.parse(fs.readFileSync(PY_OUT_FILE, "utf8"));
  if (pyOut.pairs.length !== pairs.length || pyOut.agg.length !== agg.length)
    throw new Error("python result count mismatch: pairs " + pyOut.pairs.length + "/" +
      pairs.length + " agg " + pyOut.agg.length + "/" + agg.length);

  console.log("[7] diffing\n");
  console.log("---- per-pair results (coin-TF) ----");
  var pairMismatches = 0;
  for (var pi = 0; pi < pairs.length; pi++) {
    var jp = pairs[pi], pp = pyOut.pairs[pi];
    if (jp.coin !== pp.coin || jp.tf !== pp.tf)
      throw new Error("pair order mismatch at index " + pi);
    var errs = diffAnalysis(jp.js, pp.py);
    var nLive = jp.js.live.length ? " live=" + jp.js.live.length : "";
    var line = pad(jp.coin, 14) + pad(jp.tf, 5) +
      pad("bars=" + jp.closed.length + (jp.forming ? "+f" : ""), 11) +
      pad("setups=" + jp.js.setups.length + nLive, 18) +
      (errs.length ? "FAIL" : "PASS");
    console.log(line);
    if (errs.length) {
      pairMismatches++;
      errs.forEach(function (e) { console.log("      MISMATCH: " + e); });
    }
  }

  console.log("\n---- aggregation results (coin-mode) ----");
  var aggMismatches = 0;
  for (var ai = 0; ai < agg.length; ai++) {
    var ja = agg[ai], pa = pyOut.agg[ai];
    if (ja.coin !== pa.coin || ja.mode !== pa.mode)
      throw new Error("agg order mismatch at index " + ai);
    var aerrs = diffAggBars(ja.bars, pa.bars, ja.typesAll, pa.typesAll);
    if (ja.closedCount !== pa.closedCount)
      aerrs.push("closed split JS=" + ja.closedCount + " PY=" + pa.closedCount);
    if (ja.hasForming !== pa.hasForming)
      aerrs.push("forming split JS=" + ja.hasForming + " PY=" + pa.hasForming);
    aerrs = aerrs.concat(diffAnalysis(ja.js, pa.py));
    var aline = pad(ja.coin, 14) + pad(ja.mode, 7) +
      pad("buckets=" + ja.bars.length, 13) +
      pad("setups=" + ja.js.setups.length +
        (ja.js.live.length ? " live=" + ja.js.live.length : ""), 18) +
      (aerrs.length ? "FAIL" : "PASS");
    console.log(aline);
    if (aerrs.length) {
      aggMismatches++;
      aerrs.forEach(function (e) { console.log("      MISMATCH: " + e); });
    }
  }

  console.log("\n==== PARITY SUMMARY ====");
  console.log("coin-TF pairs tested : " + pairs.length + " (" + active.length +
    " coins on 1h + " + reps.length + " coins on " + REP_TFS.join("/") + " + " + SYNTH_COUNT + " synthetic)");
  console.log("pair mismatches      : " + pairMismatches);
  console.log("agg pairs tested     : " + agg.length + " (" + reps.length + " coins x week/month)");
  console.log("agg mismatches       : " + aggMismatches);
  console.log("result               : " +
    (pairMismatches + aggMismatches === 0 ? "ZERO MISMATCHES - PARITY HOLDS" : "MISMATCHES FOUND"));
  console.log("data file            : " + DATA_FILE);

  process.exit(pairMismatches + aggMismatches === 0 ? 0 : 1);
}

function pad(s, n) {
  s = String(s);
  while (s.length < n) s += " ";
  return s;
}

// Exported for harness self-tests (negative tests of the comparator).
module.exports = {
  numEq: numEq, arrEq: arrEq, matchSets: matchSets,
  diffAnalysis: diffAnalysis, diffAggBars: diffAggBars,
  normPySetup: normPySetup, normPyLive: normPyLive
};

if (require.main === module) {
  main().catch(function (e) {
    console.error("HARNESS ERROR: " + (e && e.stack || e));
    process.exit(2);
  });
}
