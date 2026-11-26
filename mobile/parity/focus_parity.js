"use strict";

// Matched-signal parity harness: proves src/lib/focus.ts (the native mirror of
// the dashboard's Command-view row rules) agrees with the dashboard's OWN
// functions on a real /api/state snapshot.
//
// Why this exists: simpleCandidate, slowLayer, the To Target gate and their
// sort ranks live INLINE in hip3_strat_screener.html, outside the vendored
// DISPLAY-CORE block, so the display_v hash cannot protect them - focus.ts is
// a hand-written mirror, exactly the situation chips.ts is in for sigChips.
// Same idiom as chips_parity.js: reference vs mirror, zero mismatches or fail.
//
// What it does:
//   1. Compiles src/lib/focus.ts (+ deps) to CommonJS via parity/tsconfig.json.
//   2. Lifts the reference functions out of the sibling scanner checkout's
//      dashboard source by name (a string-aware brace matcher), and evaluates
//      them against stubs for the dashboard globals they touch (`state` with
//      no signal dimensions active, `coinUni`, the vendored display math).
//   3. Rebuilds the dashboard's hosted coin shape from each served coin
//      (coin.srv + coin.tf[id].an, as hostedApplyState does) and compares,
//      coin by coin: the candidate (tf, name, dir, status, +N more), the
//      Signal / Progress / Tgt % / Mag Left / D/W/M sort values, the D/W/M
//      dirs, the in-force reading, the setup "% away" text and the
//      provenance line.
//   4. Repeats with a pattern-family scope: the mirror through famAllowed, the
//      reference through state.filters.pats + patFamily - the dashboard's own
//      mechanism, so the scoping semantics are compared, not just the math.
//
// Usage:
//   npm run parity:focus                      (fetches /api/state from
//                                              HIP3_WORKER_URL, default
//                                              http://localhost:8787)
//   node parity/focus_parity.js --url http://localhost:9000
//   node parity/focus_parity.js --file saved-state.json
//   node parity/focus_parity.js --html path/to/hip3_strat_screener.html
//
// Not part of release:check: it needs the sibling checkout, a network fetch
// (or a fixture) and a throwaway compile. Run it whenever focus.ts changes or
// the dashboard's Command view moves.

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(__dirname, "build", "lib");
const DEFAULT_URL = process.env.HIP3_WORKER_URL || "http://localhost:8787";
// Sibling checkout, resolved the way scripts/check-display-core.js resolves it.
const DEFAULT_HTML = path.join(
  process.env.HIP3_SCANNER_DIR || path.join(ROOT, "..", "scanner"),
  "hip3_strat_screener.html",
);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

// Same stray-.js guard as chips_parity.js (a misconfigured tsc emits beside
// the sources, and Metro would resolve the .js first).
function assertNoStrayJs() {
  const allowed = new Set([path.join(ROOT, "src", "lib", "display_core.js")]);
  const strays = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".js") && !allowed.has(p)) strays.push(p);
    }
  };
  walk(path.join(ROOT, "src"));
  if (strays.length) {
    throw new Error(
      "compiled .js beside sources (shadows .ts in Metro - delete before bundling):\n  " +
        strays.join("\n  "),
    );
  }
}

function compile() {
  try {
    execSync("npx tsc -p " + JSON.stringify(path.join(__dirname, "tsconfig.json")), {
      cwd: ROOT,
      stdio: "inherit",
    });
  } finally {
    assertNoStrayJs();
  }
  for (const f of ["display_core.js", "display_core.v.json"]) {
    fs.copyFileSync(path.join(ROOT, "src", "lib", f), path.join(BUILD, f));
  }
}

async function loadState() {
  const file = arg("--file");
  if (file) return JSON.parse(fs.readFileSync(file, "utf8"));
  const base = (arg("--url") || DEFAULT_URL).replace(/\/+$/, "");
  const r = await fetch(base + "/api/state");
  if (!r.ok) throw new Error("worker HTTP " + r.status);
  return r.json();
}

// Lift `function NAME(...){...}` out of the dashboard source. Brace matching
// skips string literals (the dashboard builds HTML in strings) and comments.
function liftFunction(src, name) {
  const re = new RegExp("(^|\\n)function " + name + "\\s*\\(", "g");
  const m = re.exec(src);
  if (!m) throw new Error("dashboard function not found: " + name);
  let i = src.indexOf("{", m.index + m[0].length);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (ch === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (ch === "{") depth++;
    if (ch === "}") { depth--; if (depth === 0) break; }
  }
  const start = m.index + (m[1] ? 1 : 0);
  return src.slice(start, i + 1);
}

function liftVar(src, name) {
  const i = src.indexOf("var " + name + " = ");
  if (i < 0) throw new Error("dashboard var not found: " + name);
  const end = src.indexOf("};", i);
  return src.slice(i, end + 2);
}

// Evaluate the lifted reference functions in a sandbox that provides exactly
// the dashboard globals they read.
function loadReference(htmlPath, display, patFamily) {
  const src = fs.readFileSync(htmlPath, "utf8");
  const names = [
    "coinUni", "coinSummary", "simpleItems", "sigStage", "sigDimsActive", "matchedItems",
    "simpleCandidate", "simpleFocusRank", "slowLayer", "slowFtfcRank", "simpleProgressRank",
    "targetRankItem", "simpleDistRank", "simpleMagLeftRank", "simpleProgressHTML", "provText",
  ];
  const code = liftVar(src, "PROV_KIND_LABEL") + "\n" + names.map((n) => liftFunction(src, n)).join("\n");
  const sandbox = {
    state: { filters: { dir: null, tfs: [], pats: [], stages: [] } },
    patFamily,
    magProgress: display.magProgress,
    sigInForce: display.sigInForce,
    distToTargetPct: display.distToTargetPct,
    magRemaining: display.magRemaining,
    isFinite,
    Math,
    // activeTFs is never reached: coinSummary is always handed an explicit
    // tfList below. Left undefined on purpose so a reference change that
    // starts reading it fails loudly here.
  };
  vm.createContext(sandbox);
  vm.runInContext(code + "\n" + names.map((n) => "this." + n + " = " + n + ";").join("\n"), sandbox);
  return sandbox;
}

// hostedApplyState's coin shape: the served coin under .srv, each served
// slot under tf[id].an, mid and uni on the coin.
function toDashboardCoin(sc) {
  const tf = {};
  for (const id of Object.keys(sc.tf || {})) {
    const st = sc.tf[id];
    tf[id] = {
      closed: [], forming: st.forming || null,
      an: {
        types: st.types || [], formingType: st.formingType || null,
        formingDir: st.formingDir || null, live: st.live || [],
        setups: st.setups || [], invalidated: !!st.invalidated,
        completed: st.completed || null, shape: st.shape || null,
      },
    };
  }
  return { name: sc.name, sym: sc.sym, uni: sc.uni, mid: sc.mid, srv: sc, tf };
}

const num = (v) => (v === null || v === undefined || !isFinite(v) ? null : v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function runPass(label, state, ref, focus, patterns, TF_ORDER, fams) {
  const allow = fams.length ? (_tf, sig) => patterns.famAllowed(fams, sig.name) : undefined;
  ref.state.filters.pats = fams.slice();

  let coins = 0, checks = 0;
  const mismatches = [];
  const note = (coin, what, m, r) => {
    mismatches.push(coin.sym + " " + what + " mobile=" + JSON.stringify(m) + " reference=" + JSON.stringify(r));
  };
  for (const sc of state.coins) {
    coins++;
    const dcoin = toDashboardCoin(sc);
    const sum = ref.coinSummary(dcoin, TF_ORDER);
    const rItem = ref.simpleCandidate(sum, dcoin.mid);
    const mItem = focus.focusCandidate(sc, allow);

    const mCand = mItem ? { tf: mItem.tf, name: mItem.sig.name, dir: mItem.sig.dir, status: mItem.status, more: mItem.more } : null;
    const rCand = rItem ? { tf: rItem.tf, name: rItem.sig.name, dir: rItem.sig.dir, status: rItem.status, more: rItem.more || 0 } : null;
    checks++; if (!same(mCand, rCand)) note(sc, "candidate", mCand, rCand);

    checks++; if (focus.focusRank(mItem) !== ref.simpleFocusRank(sum, dcoin.mid)) note(sc, "focusRank", focus.focusRank(mItem), ref.simpleFocusRank(sum, dcoin.mid));
    checks++; if (!same(num(focus.focusProgress(mItem, sc.mid)), num(ref.simpleProgressRank(sum, dcoin.mid)))) note(sc, "progress", focus.focusProgress(mItem, sc.mid), ref.simpleProgressRank(sum, dcoin.mid));
    checks++; if (!same(num(focus.focusDist(mItem, sc.mid)), num(ref.simpleDistRank(sum, dcoin.mid)))) note(sc, "dist", focus.focusDist(mItem, sc.mid), ref.simpleDistRank(sum, dcoin.mid));
    checks++; if (!same(num(focus.focusMagLeft(mItem, sc.mid)), num(ref.simpleMagLeftRank(sum, dcoin.mid)))) note(sc, "magLeft", focus.focusMagLeft(mItem, sc.mid), ref.simpleMagLeftRank(sum, dcoin.mid));

    const mSlow = focus.slowLayer(sc), rSlow = ref.slowLayer(dcoin);
    checks++; if (!same(mSlow, rSlow)) note(sc, "slowLayer", mSlow, rSlow);
    checks++; if (focus.slowFtfcRank(sc) !== ref.slowFtfcRank(dcoin)) note(sc, "slowFtfcRank", focus.slowFtfcRank(sc), ref.slowFtfcRank(dcoin));

    if (mItem && rItem) {
      // simpleRowHTML's out-of-force guard, inline as the dashboard writes it.
      const rOof = rItem.status !== "setup" && rItem.status !== "inval" && !ref.sigInForce(rItem.sig, dcoin.mid);
      checks++; if (focus.focusInForce(mItem, sc.mid) !== !rOof) note(sc, "inForce", focus.focusInForce(mItem, sc.mid), !rOof);
      if (rItem.status === "setup") {
        const html = ref.simpleProgressHTML(rItem, dcoin.mid);
        const mm = /([0-9.]+)% away/.exec(html);
        const rAway = mm ? mm[1] : null;
        const mA = focus.setupAwayPct(mItem, sc.mid);
        const mAway = mA === null ? null : mA.toFixed(2);
        checks++; if (mAway !== rAway) note(sc, "setupAway", mAway, rAway);
      }
    }
    checks++; if (focus.provText(sc, sc.uni) !== ref.provText(dcoin)) note(sc, "prov", focus.provText(sc, sc.uni), ref.provText(dcoin));
  }
  console.log(
    "parity:focus [" + label + "] " + coins + " coins / " + checks + " checks / " +
      mismatches.length + " mismatches",
  );
  for (const m of mismatches.slice(0, 20)) console.log("  " + m);
  if (mismatches.length > 20) console.log("  ... " + (mismatches.length - 20) + " more");
  return mismatches.length;
}

async function main() {
  const htmlPath = arg("--html") || DEFAULT_HTML;
  if (!fs.existsSync(htmlPath)) {
    throw new Error("dashboard source not found at " + htmlPath + " (pass --html)");
  }
  compile();
  const display = require(path.join(ROOT, "src", "lib", "display_core.js"));
  const focus = require(path.join(BUILD, "focus.js"));
  const patterns = require(path.join(BUILD, "patterns.js"));
  const { TF_ORDER } = require(path.join(BUILD, "api.js"));
  const ref = loadReference(htmlPath, display, patterns.patFamily);

  const state = await loadState();
  if (!Array.isArray(state.coins) || state.coins.length === 0) {
    throw new Error("state has no coins - wrong URL or worker still loading");
  }

  let bad = 0;
  bad += runPass("default", state, ref, focus, patterns, TF_ORDER, []);
  // Family scope: 2-2 and 3-1-2 only. The mirror scopes through famAllowed,
  // the reference through its own state.filters.pats + patFamily filter.
  bad += runPass("fams(22,312)", state, ref, focus, patterns, TF_ORDER, ["22", "312"]);
  // A scope that empties many coins entirely, so the no-candidate paths
  // (rank 0, null progress/dist) are exercised on both sides.
  bad += runPass("fams(pmg)", state, ref, focus, patterns, TF_ORDER, ["pmg"]);

  if (bad > 0) {
    console.error("parity:focus FAIL - focus.ts disagrees with the dashboard's Command-view rules");
    process.exit(1);
  }
  console.log("parity:focus OK - focus.ts matches the dashboard's Command-view rules");
}

main().catch((err) => {
  console.error("parity:focus error: " + (err && err.message ? err.message : err));
  process.exit(1);
});
