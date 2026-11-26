#!/usr/bin/env node
"use strict";

// Extracts marked blocks from the dashboard HTML into generated src/ modules.
// The dashboard file is the single source of truth for the detection core
// and for the perp category map - the worker vendors generated copies and
// this script's --check mode is the anti-drift gate, run in the Docker build.
//
// Usage:
//   node scripts/extract_core.js          regenerate all generated modules
//   node scripts/extract_core.js --check  re-extract and compare against the
//                                         vendored files; exit 1 on mismatch
//
// NOTE for STRAT-CORE changes: the parity harness keeps its OWN extraction
// (parity/extract_core.js) - regenerate both and mirror parity/reference.py,
// or parity lies.

const fs = require("node:fs");
const path = require("node:path");

const SERVICE_ROOT = path.resolve(__dirname, "..");
const SOURCE = path.resolve(SERVICE_ROOT, "hip3_strat_screener.html");

// Each block: BEGIN/END markers in the HTML, the generated target module,
// its exports, and the typeof every export must satisfy after a require().
const BLOCKS = [
  {
    name: "STRAT-CORE",
    begin: "// ==== STRAT-CORE-BEGIN ====",
    end: "// ==== STRAT-CORE-END ====",
    target: path.join(SERVICE_ROOT, "src", "strat_core.js"),
    exports: [
      "classify",
      "classifySeries",
      "detectCompleted",
      "analyzeTF",
      "weekStart",
      "monthStart",
      "nextMonthStart",
      "aggregateBars",
      "targetVersion"
    ],
    exportType: "function"
  },
  {
    name: "PERP-CAT",
    begin: "// ==== PERP-CAT-BEGIN ====",
    end: "// ==== PERP-CAT-END ====",
    target: path.join(SERVICE_ROOT, "src", "perp_cat.js"),
    exports: ["PERP_CAT"],
    exportType: "object"
  },
  {
    name: "DISPLAY-CORE",
    begin: "// ==== DISPLAY-CORE-BEGIN ====",
    end: "// ==== DISPLAY-CORE-END ====",
    target: path.join(SERVICE_ROOT, "src", "display_core.js"),
    exports: [
      "esc",
      "fmtPx",
      "chg24",
      "tfPct",
      "magProgress",
      "distToTargetPct",
      "magRemaining",
      "sigInForce",
      "starSpan",
      "sigChips"
    ],
    exportType: "function"
  }
];

function buildModule(block, lines) {
  const b = lines.findIndex(function (l) { return l.trim() === block.begin; });
  const e = lines.findIndex(function (l) { return l.trim() === block.end; });
  if (b < 0 || e < 0 || e <= b) {
    throw new Error(block.name + " markers not found in " + SOURCE);
  }
  const body = lines.slice(b, e + 1).join("\n");
  const header = [
    "// GENERATED FILE - DO NOT HAND-EDIT.",
    "// Extracted verbatim from hip3_strat_screener.html (" + block.name + " block)",
    "// by scripts/extract_core.js. The dashboard is the single source of truth.",
    "// Regenerate: npm run extract    Verify (CI anti-drift): npm run extract:check",
    "\"use strict\";",
    ""
  ].join("\n");
  const footer = "\n\nmodule.exports = { " + block.exports.join(", ") + " };\n";
  return header + body + footer;
}

// Normalize line endings so the byte-compare is about content drift,
// not git core.autocrlf churn.
function norm(s) {
  return s.split(/\r?\n/).join("\n");
}

function main() {
  const check = process.argv.indexOf("--check") >= 0;
  const lines = fs.readFileSync(SOURCE, "utf8").split(/\r?\n/);
  let failed = false;

  for (const block of BLOCKS) {
    const generated = buildModule(block, lines);
    const rel = path.relative(SERVICE_ROOT, block.target).split(path.sep).join("/");

    if (check) {
      let vendored;
      try {
        vendored = fs.readFileSync(block.target, "utf8");
      } catch (e) {
        console.error("CHECK FAILED: vendored file missing: " + block.target);
        failed = true;
        continue;
      }
      if (norm(vendored) !== norm(generated)) {
        console.error("CHECK FAILED: " + rel + " does not match the " + block.name);
        console.error("block in hip3_strat_screener.html. Run: npm run extract");
        failed = true;
        continue;
      }
      console.log("CHECK OK: " + rel + " matches the dashboard " + block.name
        + " block (" + Buffer.byteLength(generated, "utf8") + " bytes).");
      continue;
    }

    fs.mkdirSync(path.dirname(block.target), { recursive: true });
    fs.writeFileSync(block.target, generated);

    // Sanity: the generated module must load and export the expected shapes.
    const mod = require(block.target);
    const missing = block.exports.filter(function (n) {
      return typeof mod[n] !== block.exportType;
    });
    if (missing.length) {
      throw new Error(rel + " missing/mistyped exports: " + missing.join(", "));
    }
    console.log("Extracted " + block.name + " -> " + block.target + " ("
      + Buffer.byteLength(generated, "utf8") + " bytes, exports: "
      + block.exports.join(", ") + ")");
  }

  if (failed) process.exit(1);
}

main();
