"use strict";

// Parity-extraction anti-drift gate (review MEDIUM-6): the parity
// harness keeps its OWN extraction (parity/strat_core_extracted.js), separate
// from the worker copy scripts/extract_core.js gates. Before this gate, a
// dashboard-HTML edit that forgot the second manual extraction produced a
// false-green JS-vs-Python parity run against stale JavaScript.
// run_parity.js now derives the expected module in memory and byte-compares
// it before require(); these tests pin the committed copy fresh and pin the
// mutation direction.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const extractor = require("../parity/extract_core.js");

test("parity/extract_core.js --check exits 0 (parity copy matches dashboard)", function () {
  const script = path.resolve(__dirname, "..", "parity", "extract_core.js");
  const r = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, "parity extract check failed:\n" + r.stdout + r.stderr);
  assert.match(r.stdout, /matches the HTML/);
});

test("build() byte-matches the committed parity copy", function () {
  const committed = fs.readFileSync(extractor.OUT, "utf8");
  assert.strictEqual(committed, extractor.build());
});

test("an HTML mutation inside the markers is detected (stale copy fails)", function () {
  const src = fs.readFileSync(extractor.HTML, "utf8");
  const marker = "// ==== STRAT-CORE-BEGIN ====";
  const mutated = src.replace(marker, marker + "\nvar __parityMutationProbe = 1;");
  assert.notStrictEqual(mutated, src, "mutation did not apply");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "parity-mut-")), "m.html");
  fs.writeFileSync(tmp, mutated);
  const committed = fs.readFileSync(extractor.OUT, "utf8");
  // The exact comparison run_parity.js performs before require():
  assert.notStrictEqual(extractor.build(tmp), committed);
});

test("a stale committed copy makes the ACTUAL runner exit 1 before core load (review LOW-4)", function () {
  // The earlier mutation test re-implemented the byte comparison inline, so
  // deleting the preflight from run_parity.js (or moving require() above
  // it) left every committed test green. This one executes the real
  // runner: a tmp replica of the repo layout carries the REAL html and the
  // REAL scripts but a MUTATED committed copy, poisoned so that loading it
  // would be loudly visible. The runner must exit nonzero on the preflight
  // -- before the core is required and before any network call.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parity-runner-mut-"));
  fs.mkdirSync(path.join(root, "parity"));
  fs.copyFileSync(extractor.HTML, path.join(root, "hip3_strat_screener.html"));
  for (const f of ["run_parity.js", "extract_core.js"]) {
    fs.copyFileSync(path.resolve(__dirname, "..", "parity", f), path.join(root, "parity", f));
  }
  const committed = fs.readFileSync(extractor.OUT, "utf8");
  fs.writeFileSync(
    path.join(root, "parity", "strat_core_extracted.js"),
    'throw new Error("CORE LOADED - preflight was bypassed");' + "\n" + committed
  );
  const r = spawnSync(process.execPath, [path.join(root, "parity", "run_parity.js")], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.strictEqual(r.status, 1, "runner should exit 1 on the stale preflight: " + r.stdout + r.stderr);
  assert.match(r.stderr, /PARITY EXTRACTION STALE/);
  // The poison proves fail-BEFORE-load: had require() run first (or the
  // preflight been deleted), this message would appear instead.
  assert.doesNotMatch(r.stdout + r.stderr, /CORE LOADED/);
});
