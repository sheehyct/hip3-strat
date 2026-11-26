"use strict";

// Vendoring + anti-drift gate for the DISPLAY-CORE block.
//
// The dashboard (the scanner's hip3_strat_screener.html) is the single source
// of truth for display math. The scanner extracts its marker-delimited block into
// src/display_core.js and serves the block's hash as `display_v` on /api/state.
// This app vendors the SAME block byte-for-byte into src/lib/display_core.js so
// its formatters and predicates are the dashboard's, not a hand-written copy -
// hand-written copies are exactly how cross-surface divergences get in.
//
// React Native cannot hash its own source at runtime (no fs, no node:crypto),
// so the stamp is written to src/lib/display_core.v.json at vendor time and this
// script is the gate that keeps it honest. Two independent checks:
//
//   1. STAMP FRESHNESS (always): recompute the hash from the local vendored
//      block and compare it to the recorded stamp. Catches a hand-edit of the
//      vendored file, which would otherwise ship a lie to the runtime compare.
//   2. SOURCE PARITY (when the sibling checkout exists): byte-compare the local
//      block against the scanner's. Catches "the worker moved and we did not".
//      The sibling is ../scanner in this repository (or HIP3_SCANNER_DIR).
//      Skipped - not failed - when it is absent, so this runs in a lone
//      checkout. The runtime display_v compare is the backstop that
//      needs no sibling, which is why both mechanisms exist.
//
// Hashing recipe, mirrored EXACTLY from the scanner's src/apistate.js: sha256 of
// the marker lines and everything between them, LF-normalized, first 16 hex.
// LF normalization is what makes the stamp identical on a CRLF checkout.
//
// Usage:
//   node scripts/check-display-core.js            verify (used by release:check)
//   node scripts/check-display-core.js --write    re-vendor from the scanner

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const LOCAL_JS = path.join(ROOT, "src", "lib", "display_core.js");
const LOCAL_V = path.join(ROOT, "src", "lib", "display_core.v.json");
const BEGIN = "// ==== DISPLAY-CORE-BEGIN ====";
const END = "// ==== DISPLAY-CORE-END ====";

// Exported roster, mirrored from the scanner's scripts/extract_core.js. Kept as
// data so the generated footer cannot drift from the block by hand-editing.
const EXPORTS = [
  "esc", "fmtPx", "chg24", "tfPct", "magProgress", "distToTargetPct", "magRemaining",
  "sigInForce", "starSpan", "sigChips",
];

const HEADER = [
  "// GENERATED FILE - DO NOT HAND-EDIT.",
  "// Vendored verbatim from the scanner's src/display_core.js (DISPLAY-CORE block),",
  "// itself extracted from hip3_strat_screener.html by that repo's extract_core.js.",
  "// The DASHBOARD is the single source of truth for display math; this app must",
  "// mirror it exactly. Regenerate: npm run display:sync",
  "//",
  "// Plain ES5 on purpose - it is the dashboard's inline-script code, unmodified.",
  "// TypeScript types live in the hand-written display_core.d.ts, so no signature",
  "// is restated here and nothing in this file is retyped.",
  "//",
  "// esc / starSpan / sigChips emit HTML and cannot render on React Native. They",
  "// are vendored anyway so the block - and therefore its hash - stays identical",
  "// to the worker's; they are the REFERENCE SEMANTICS for the native renderers.",
  "// starSpan additionally reads the dashboard's isFav global and would throw if",
  "// called here. Never call it; mirror it.",
  "\"use strict\";",
  "",
].join("\n");

function sourceFile() {
  const dir = process.env.HIP3_SCANNER_DIR || path.join(ROOT, "..", "scanner");
  return path.join(dir, "src", "display_core.js");
}

// LF-normalized marker block, markers included. Same slice the worker hashes.
function readBlock(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const b = lines.findIndex(function (l) { return l.trim() === BEGIN; });
  const e = lines.findIndex(function (l) { return l.trim() === END; });
  if (b < 0 || e <= b) throw new Error("DISPLAY-CORE markers missing from " + file);
  return lines.slice(b, e + 1).join("\n");
}

function stamp(block) {
  return crypto.createHash("sha256").update(block).digest("hex").slice(0, 16);
}

function fail(msg) {
  console.error("display-core: " + msg);
  process.exit(1);
}

function write() {
  const src = sourceFile();
  if (!fs.existsSync(src)) {
    fail("cannot re-vendor: " + src + " not found. Set HIP3_SCANNER_DIR to the\n" +
      "  scanner directory, or run this on a machine that has it.");
  }
  const block = readBlock(src);
  const footer = "\nmodule.exports = { " + EXPORTS.join(", ") + " };\n";
  fs.writeFileSync(LOCAL_JS, HEADER + block + "\n" + footer, "utf8");
  fs.writeFileSync(LOCAL_V, JSON.stringify({ display_v: stamp(block) }, null, 2) + "\n", "utf8");
  console.log("display-core: vendored from " + src);
  console.log("display-core: display_v " + stamp(block));
}

// The vendored block is the ONE .js that belongs under src/. Metro resolves
// .js before .ts, so a compiled copy sitting beside a .ts source (e.g. an
// in-place tsc emission - it happened 2026-08-31 from a misconfigured parity
// compile) silently shadows the real module in every bundle and OTA. Gate it
// here because this script already runs in release:check.
function checkNoStrayJs() {
  const allowed = new Set([LOCAL_JS]);
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
    fail("compiled .js beside sources - Metro resolves .js over .ts, so these\n" +
      "  SHADOW the real modules in the bundle. Delete them:\n    " +
      strays.join("\n    "));
  }
}

function check() {
  if (!fs.existsSync(LOCAL_JS)) fail("missing vendored block at " + LOCAL_JS);
  if (!fs.existsSync(LOCAL_V)) fail("missing stamp at " + LOCAL_V);
  checkNoStrayJs();

  const block = readBlock(LOCAL_JS);
  const actual = stamp(block);
  const recorded = JSON.parse(fs.readFileSync(LOCAL_V, "utf8")).display_v;

  // Every export the module promises must actually be defined in the block; a
  // silently-missing function would be an undefined import at runtime, and the
  // hash cannot catch it because the footer is outside the markers.
  const missing = EXPORTS.filter(function (n) {
    return !new RegExp("(^|\\n)function\\s+" + n + "\\s*\\(").test(block);
  });
  if (missing.length) fail("block does not define: " + missing.join(", "));

  // Line-ending invariance: the recipe must stamp identically on a CRLF
  // checkout. The scanner side pins this where the block is PRODUCED
  // (test/apistate.test.js); this confirms the same property at the consumer,
  // guarding a future refactor that hashes raw bytes instead of readBlock().
  const crlfLines = (block.split("\n").join("\r\n")).split(/\r?\n/);
  if (stamp(crlfLines.join("\n")) !== actual) {
    fail("hash recipe is not line-ending invariant - a CRLF checkout would " +
      "stamp differently. The recipe must LF-normalize before hashing.");
  }

  if (actual !== recorded) {
    fail("stamp is stale.\n" +
      "  recorded (display_core.v.json): " + recorded + "\n" +
      "  actual   (display_core.js):     " + actual + "\n" +
      "  The vendored block was hand-edited. Re-vendor: npm run display:sync");
  }

  const src = sourceFile();
  if (!fs.existsSync(src)) {
    console.log("display-core: OK, display_v " + actual +
      " (source parity SKIPPED - no scanner checkout at " + src + ")");
    return;
  }
  const upstream = readBlock(src);
  if (upstream !== block) {
    fail("vendored block differs from the scanner's.\n" +
      "  local:    " + actual + "\n" +
      "  upstream: " + stamp(upstream) + "\n" +
      "  Re-vendor and re-check the consumers: npm run display:sync");
  }
  console.log("display-core: OK, display_v " + actual + " (matches the scanner)");
}

if (process.argv.includes("--write")) write();
else check();
