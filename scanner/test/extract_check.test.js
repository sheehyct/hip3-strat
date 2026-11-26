"use strict";

// Extraction anti-drift gate:
// the vendored src/strat_core.js must byte-match (modulo line endings) the
// STRAT-CORE block in hip3_strat_screener.html - the dashboard is the single
// source of truth for the detection core.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("scripts/extract_core.js --check exits 0 (vendored core matches dashboard)", function () {
  const script = path.resolve(__dirname, "..", "scripts", "extract_core.js");
  const r = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, "extract check failed:\n" + r.stdout + r.stderr);
  assert.match(r.stdout, /CHECK OK/);
});
