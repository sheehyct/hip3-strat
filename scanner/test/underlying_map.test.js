"use strict";

// xyz symbol -> underlying map tests. The important one is the DRIFT GATE: the
// map is generated from docs/XYZ_ROSTER_UNDERLYING_MAP_2026-08-01.md, so this
// re-parses that document and asserts they still agree. Same idea as the
// STRAT-CORE extraction check - one source of truth, mechanically enforced,
// because a silently wrong underlying corrupts a score instead of failing.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { UNDERLYING, lookup, fetchableSymbols } = require("../src/underlying_map.js");

const DOC = path.join(__dirname, "..", "docs", "XYZ_ROSTER_UNDERLYING_MAP_2026-08-01.md");
const US_CATS = new Set(["us_equity", "us_etf", "adr"]);

// Parse the document's table back out, independently of how the map was built.
function parseDoc() {
  const md = fs.readFileSync(DOC, "utf8");
  const rows = [];
  for (const line of md.split("\n")) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const c = line.split("|").map(function (s) { return s.trim(); });
    rows.push({ sym: c[2], ticker: c[5].replace(/`/g, ""), cat: c[7] });
  }
  return rows;
}

test("DRIFT GATE: the map matches the roster document exactly", function () {
  const rows = parseDoc();
  assert.strictEqual(rows.length, 88, "document should describe 88 symbols");
  assert.strictEqual(Object.keys(UNDERLYING).length, rows.length,
    "map and document must have the same number of entries");

  for (const r of rows) {
    const e = UNDERLYING[r.sym];
    assert.ok(e, "map is missing '" + r.sym + "' - regenerate it from the document");
    assert.strictEqual(e.cat, r.cat, r.sym + ": category drifted from the document");
    const expectFetchable = US_CATS.has(r.cat);
    assert.strictEqual(e.usFetchable, expectFetchable, r.sym + ": usFetchable drifted");
    // Only US-reachable rows carry a ticker; the rest must be explicitly null
    // rather than a plausible-looking string nobody can fetch.
    assert.strictEqual(e.ticker, expectFetchable ? r.ticker : null,
      r.sym + ": ticker drifted from the document");
  }
});

test("64 of 88 symbols are fetchable from the US stocks API", function () {
  assert.strictEqual(fetchableSymbols().length, 64);
  assert.strictEqual(Object.keys(UNDERLYING).length, 88);
});

test("the misleading tickers resolve to the right thing, not the obvious thing", function () {
  // Each of these would be wrong if anyone inferred the underlying from the
  // ticker string, and each would corrupt a score silently.
  assert.strictEqual(UNDERLYING.XYZ100.cat, "index", "XYZ100 is the Nasdaq-100, not an equity");
  assert.strictEqual(UNDERLYING.XYZ100.usFetchable, false, "an index is not on the stocks API");
  assert.strictEqual(UNDERLYING.DRAM.cat, "us_etf", "DRAM is an ETF, not a memory-price index");
  assert.strictEqual(UNDERLYING.DRAM.usFetchable, true);
  assert.strictEqual(UNDERLYING.PURRDAT.ticker, "PURR", "PURRDAT trades as PURR");
  assert.strictEqual(UNDERLYING.SMSN.usFetchable, false, "SMSN tracks the KRX ordinary, not a US line");
  // SKHX and SKHY are the same company and must NOT collapse together.
  assert.strictEqual(UNDERLYING.SKHX.cat, "asia_equity", "SKHX is the KRX ordinary");
  assert.strictEqual(UNDERLYING.SKHY.cat, "adr", "SKHY is the Nasdaq ADS");
  assert.notStrictEqual(UNDERLYING.SKHX.usFetchable, UNDERLYING.SKHY.usFetchable);
});

test("symbols whose SERIES is dangerous carry an explicit caveat", function () {
  // These resolve fine and then hand you confident wrong numbers, so the
  // warning has to travel with the lookup rather than live only in a doc.
  for (const sym of ["SPCX", "BIRD", "STRC", "DRAM", "PURRDAT", "SKHY"]) {
    assert.ok(lookup(sym).caveat, sym + " must carry a caveat");
  }
  assert.match(lookup("SPCX").caveat, /continuity/i, "SPCX must point at the continuity guard");
  assert.match(lookup("BIRD").caveat, /CANNOT catch/, "BIRD must say continuity will NOT save you");
  assert.match(lookup("STRC").caveat, /not MSTR/i);
});

test("lookup accepts both bare and universe-prefixed symbols", function () {
  // The worker holds coin names as "xyz:TSLA"; returning null for that form
  // would read as "no underlying" rather than "wrong argument shape".
  assert.strictEqual(lookup("xyz:TSLA").ticker, "TSLA");
  assert.strictEqual(lookup("TSLA").ticker, "TSLA");
  assert.deepStrictEqual(lookup("xyz:TSLA"), lookup("TSLA"));
});

test("lookup returns null for unknown or junk input without throwing", function () {
  for (const junk of ["BOGUS", "", null, undefined, 42, {}, "xyz:", "xyz:NOPE"]) {
    assert.strictEqual(lookup(junk), null, "junk input: " + String(junk));
  }
});

test("non-US categories never carry a ticker", function () {
  // A plausible-looking ticker on an unfetchable row invites someone to try it
  // and get a different instrument back.
  for (const sym of Object.keys(UNDERLYING)) {
    const e = UNDERLYING[sym];
    if (!e.usFetchable) assert.strictEqual(e.ticker, null, sym + " must not carry a ticker");
    else assert.ok(typeof e.ticker === "string" && e.ticker.length, sym + " must carry a ticker");
  }
});
