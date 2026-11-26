"use strict";

// Chip parity harness: proves buildSignalChips (src/lib/chips.ts, the native
// mirror) and the vendored sigChips (src/lib/display_core.js, the dashboard's
// own code) agree chip-for-chip on a real /api/state snapshot.
//
// Why this exists: sigChips emits HTML, which React Native cannot render, so
// chips.ts is the ONE place mobile re-expresses vendored logic by hand instead
// of calling it. The display_v hash gate proves the vendored BLOCK matches the
// dashboard; it cannot prove the MIRROR matches the block. This harness closes
// that gap behaviorally, the same idiom as the scanner's parity/ directory
// (JS vs reference, zero mismatches or fail).
//
// What it does:
//   1. Compiles src/lib/chips.ts (+ transitive deps) to CommonJS via
//      parity/tsconfig.json, into parity/build/ (gitignored).
//   2. Copies display_core.js + display_core.v.json beside the output so the
//      compiled api.js can require them.
//   3. Fetches /api/state (all universes), builds the same `sum` the mirror
//      builds (all seven TFs, rev-only setups, rev3 invalidation exemption),
//      feeds the COIN to buildSignalChips and the SUM to sigChips, parses the
//      HTML back to {label, tone, dim}, and diffs element-for-element.
//   4. Repeats with a non-trivial `allow` predicate so the scoping path (the
//      d9cb6247 third parameter) is exercised on both sides.
//
// The reference chips carry a magnitude percentage ((b)9, not ported to
// mobile); the parser strips it before comparing labels, so this harness does
// NOT assert magnitude parity - only chip identity, order, tone, and dim.
//
// Usage:
//   npm run parity:chips                      (fetches /api/state from
//                                              HIP3_WORKER_URL, default
//                                              http://localhost:8787)
//   node parity/chips_parity.js --url http://localhost:9000
//   node parity/chips_parity.js --file saved-state.json
//
// Not part of release:check: it needs a network fetch (or a fixture) and a
// throwaway compile. Run it whenever chips.ts or the vendored block changes.

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
// tsc mirrors src/ under build/ (rootDir ../src), so the lib output lands here.
const BUILD = path.join(__dirname, "build", "lib");
const DEFAULT_URL = process.env.HIP3_WORKER_URL || "http://localhost:8787";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

// The one .js that belongs under src/ is the vendored DISPLAY-CORE block. A
// misconfigured tsc emits IN PLACE beside the sources (TS emits even when
// configuration errors fail the build), and Metro resolves .js before .ts -
// so a stray emitted copy would silently shadow every .ts module in the real
// app bundle. This happened on 2026-08-31; the guard keeps it impossible.
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

// The same `sum` construction as buildSignalChips' internal walk (and the
// dashboard's coinSummary): every live signal in TF display order with the
// rev3 invalidation exemption, then reversal-kind setups only. Duplicated here
// ON PURPOSE - the harness must hand sigChips its input independently, or a
// walk bug in chips.ts would be invisible.
function buildSum(coin, TF_ORDER) {
  const live = [];
  const setupList = [];
  for (const { id, label } of TF_ORDER) {
    const an = coin.tf[id];
    if (!an) continue;
    for (const sig of an.live)
      live.push({ tf: label, sig, invalidated: an.invalidated && sig.rev3 !== true });
    for (const sig of an.setups) if (sig.kind === "rev") setupList.push({ tf: label, sig });
  }
  return { live, setupList };
}

function unescapeHtml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Parse sigChips' HTML back to the mirror's {label, tone, dim} shape.
function parseChipsHtml(html) {
  if (html === '<span class="neu">-</span>') return [];
  const out = [];
  const parts = html.split('<span class="chip ').slice(1);
  for (const part of parts) {
    const cls = part.slice(0, part.indexOf('"'));
    let body = part.slice(part.indexOf(">") + 1);
    body = body
      .replace(/<span class="mag">.*?<\/span>/g, "")
      .replace(/<span class="magtxt">.*?<\/span>/g, "")
      .replace(/<\/?[^>]+>/g, "");
    const tone = cls.startsWith("inval")
      ? "warn"
      : cls.startsWith("live-up")
        ? "bull"
        : cls.startsWith("live-down")
          ? "bear"
          : "muted";
    out.push({ label: unescapeHtml(body), tone, dim: / oof\b/.test(" " + cls) });
  }
  return out;
}

function diffCoin(name, mobile, reference, mismatches) {
  const n = Math.max(mobile.length, reference.length);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const m = mobile[i];
    const r = reference[i];
    const mNorm = m ? { label: m.label, tone: m.tone, dim: !!m.dim } : null;
    if (JSON.stringify(mNorm) !== JSON.stringify(r || null)) {
      bad++;
      mismatches.push(
        name + "[" + i + "] mobile=" + JSON.stringify(mNorm) + " reference=" + JSON.stringify(r || null),
      );
    }
  }
  return { chips: reference.length, bad };
}

function runPass(label, state, mods, allow) {
  const { buildSignalChips } = require(path.join(BUILD, "chips.js"));
  const { TF_ORDER } = require(path.join(BUILD, "api.js"));
  const { sigChips } = require(path.join(ROOT, "src", "lib", "display_core.js"));

  let coins = 0;
  let chips = 0;
  const mismatches = [];
  for (const coin of state.coins) {
    coins++;
    const mobile = buildSignalChips(coin, allow || undefined);
    const reference = parseChipsHtml(sigChips(buildSum(coin, TF_ORDER), coin.mid, allow || undefined));
    chips += diffCoin(coin.name, mobile, reference, mismatches).chips;
  }
  console.log(
    "parity:chips [" + label + "] " + coins + " coins / " + chips + " chips / " +
      mismatches.length + " mismatches",
  );
  for (const m of mismatches.slice(0, 20)) console.log("  " + m);
  if (mismatches.length > 20) console.log("  ... " + (mismatches.length - 20) + " more");
  return mismatches.length;
}

async function main() {
  compile();
  const state = await loadState();
  if (!Array.isArray(state.coins) || state.coins.length === 0) {
    throw new Error("state has no coins - wrong URL or worker still loading");
  }

  let bad = 0;
  bad += runPass("default", state, null, null);
  // Non-trivial scope: up-direction signals only. Exercises the allow path on
  // both sides - filtering must land BEFORE the ledger and both overflows.
  bad += runPass("allow(dir=up)", state, null, (tf, sig) => sig.dir === "up");
  // A second scope keyed on the name, so the setup-list filtering is hit even
  // when a coin has no live signals.
  bad += runPass("allow(name has 1-2)", state, null, (tf, sig) => sig.name.indexOf("1-2") !== -1);

  if (bad > 0) {
    console.error("parity:chips FAIL - the chips.ts mirror disagrees with the vendored sigChips");
    process.exit(1);
  }
  console.log("parity:chips OK - mirror matches the vendored sigChips");
}

main().catch((err) => {
  console.error("parity:chips error: " + (err && err.message ? err.message : err));
  process.exit(1);
});
