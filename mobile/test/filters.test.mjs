// Screener filter model tests for src/lib/filters.ts - the dashboard's Tier 1
// filter rules (hip3_strat_screener.html) as mobile mirrors them. Runs with
// `npm test` (node --test; the .ts source loads through type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyPreset, defaultFilters, filterCount, fmtAmount, itemMatches, parsePositive, parseVolAmount,
  rowPasses, sanitizeFilters, sigDimsActive, sigStage, toggleIn, volPasses, volText,
} from "../src/lib/filters.ts";

const PATS = ["22", "212", "312", "32", "322", "122", "13", "pmg"];

const row = (over = {}) => ({
  fav: false, inside: false, ftfc: "mixed", maxLeverage: 10, px: 5, vol: 2e6,
  rvol: null, r5: null, r15: null, ...over,
});
const item = (over = {}) => ({ tf: "D", dir: "up", family: "22", stage: "live", ...over });

test("sanitizeFilters: junk degrades per field, sets are whitelisted and deduplicated", () => {
  assert.deepEqual(sanitizeFilters(null, PATS), defaultFilters());
  assert.deepEqual(sanitizeFilters("x", PATS), defaultFilters());
  const f = sanitizeFilters({
    favs: true, inside: "yes", movers: 1, ftfc: "up", dir: "sideways",
    stages: ["live", "live", "bogus", 3], tfs: ["D", "W", "D", "1d"], pats: ["322", "nope", "322"],
    levMin: 0, pxMax: 12.5, vol: { xyz: { op: "lt", n: 0 }, perps: { op: "eq", n: -1 }, other: { op: "ge", n: 5 } },
  }, PATS);
  assert.equal(f.favs, true);
  assert.equal(f.inside, false);
  assert.equal(f.movers, false);
  assert.equal(f.ftfc, "up");
  assert.equal(f.dir, null);
  assert.deepEqual(f.stages, ["live"]);
  assert.deepEqual(f.tfs, ["D", "W"]);
  assert.deepEqual(f.pats, ["322"]);
  assert.equal(f.levMin, null); // 0 is not a leverage floor
  assert.equal(f.pxMax, 12.5);
  assert.deepEqual(f.vol.xyz, { op: "lt", n: 0 }); // 0 IS a legal volume bound
  assert.deepEqual(f.vol.perps, { op: "ge", n: null });
  assert.equal("other" in f.vol, false);
});

test("sanitizeFilters seeds the legacy pattern-family allowlist (store migration shape)", () => {
  assert.deepEqual(sanitizeFilters({ pats: ["322", "13"] }, PATS).pats, ["322", "13"]);
});

test("presets are actions: All clears everything, Actionable = stage live only", () => {
  assert.deepEqual(applyPreset("all"), defaultFilters());
  const a = applyPreset("actionable");
  assert.deepEqual(a.stages, ["live"]);
  assert.deepEqual({ ...a, stages: [] }, defaultFilters());
});

test("parseVolAmount: digits or a k/m/b suffix, anything else is null", () => {
  assert.equal(parseVolAmount("5000000"), 5e6);
  assert.equal(parseVolAmount("500k"), 5e5);
  assert.equal(parseVolAmount(" 1M "), 1e6);
  assert.equal(parseVolAmount("2.5b"), 2.5e9);
  assert.equal(parseVolAmount(".5m"), 5e5);
  assert.equal(parseVolAmount("0"), 0);
  for (const bad of ["", "$1m", "1,000", "1mm", "abc", "-5", "1e6"]) assert.equal(parseVolAmount(bad), null, bad);
});

test("volPasses covers all four operators at the boundary", () => {
  assert.equal(volPasses("ge", 5, 5), true);
  assert.equal(volPasses("gt", 5, 5), false);
  assert.equal(volPasses("le", 5, 5), true);
  assert.equal(volPasses("lt", 5, 5), false);
});

test("parsePositive: Lev / Px take positive finite numbers only", () => {
  assert.equal(parsePositive("10"), 10);
  assert.equal(parsePositive("0.5"), 0.5);
  assert.equal(parsePositive("0"), null);
  assert.equal(parsePositive("-3"), null);
  assert.equal(parsePositive(""), null);
});

test("sigStage derives only from the canonical predicates", () => {
  assert.equal(sigStage("inval", false, 500), "inval");
  assert.equal(sigStage("setup", false, null), "setup");
  assert.equal(sigStage("cont", false, null), "cont");
  assert.equal(sigStage("live", false, 50), "recrossed");
  assert.equal(sigStage("live", true, 100), "target");
  assert.equal(sigStage("live", true, 99.9), "live");
  assert.equal(sigStage("live", true, null), "live");
});

test("sigDimsActive: dir, sig TF, patterns and stage are the signal dimensions", () => {
  assert.equal(sigDimsActive(defaultFilters()), false);
  assert.equal(sigDimsActive({ ...defaultFilters(), favs: true, ftfc: "up", levMin: 5 }), false);
  assert.equal(sigDimsActive({ ...defaultFilters(), dir: "down" }), true);
  assert.equal(sigDimsActive({ ...defaultFilters(), tfs: ["D"] }), true);
  assert.equal(sigDimsActive({ ...defaultFilters(), pats: ["22"] }), true);
  assert.equal(sigDimsActive({ ...defaultFilters(), stages: ["live"] }), true);
});

test("itemMatches: every active dimension narrows, multi-select is OR within a dimension", () => {
  const f = { ...defaultFilters(), tfs: ["D", "W"], dir: "up", pats: ["22", "322"], stages: ["live", "target"] };
  assert.equal(itemMatches(f, item()), true);
  assert.equal(itemMatches(f, item({ tf: "W", family: "322", stage: "target" })), true);
  assert.equal(itemMatches(f, item({ tf: "4H" })), false);
  assert.equal(itemMatches(f, item({ dir: "down" })), false);
  assert.equal(itemMatches(f, item({ family: "312" })), false);
  assert.equal(itemMatches(f, item({ stage: "recrossed" })), false);
  assert.equal(itemMatches(defaultFilters(), item({ tf: "15m", dir: "down", family: "other", stage: "inval" })), true);
});

test("rowPasses: unknown leverage and unknown volume never pass a bound", () => {
  const f = { ...defaultFilters(), levMin: 10 };
  assert.equal(rowPasses(f, "xyz", row({ maxLeverage: 10 })), true);
  assert.equal(rowPasses(f, "xyz", row({ maxLeverage: 5 })), false);
  assert.equal(rowPasses(f, "xyz", row({ maxLeverage: null })), false);
  assert.equal(rowPasses(f, "xyz", row({ maxLeverage: undefined })), false);
  const lt = { ...defaultFilters(), vol: { xyz: { op: "lt", n: 1e6 }, perps: { op: "ge", n: null } } };
  assert.equal(rowPasses(lt, "xyz", row({ vol: 5e5 })), true);
  assert.equal(rowPasses(lt, "xyz", row({ vol: NaN })), false); // even an upper bound
  assert.equal(rowPasses(lt, "perps", row({ vol: 5e9 })), true); // other universe's bound is off
});

test("rowPasses: px, favs, inside, ftfc and movers", () => {
  const px = { ...defaultFilters(), pxMax: 5 };
  assert.equal(rowPasses(px, "xyz", row({ px: 5 })), true);
  assert.equal(rowPasses(px, "xyz", row({ px: 0 })), false); // no price is not "cheap"
  assert.equal(rowPasses({ ...defaultFilters(), favs: true }, "xyz", row()), false);
  assert.equal(rowPasses({ ...defaultFilters(), inside: true }, "xyz", row({ inside: true })), true);
  assert.equal(rowPasses({ ...defaultFilters(), ftfc: "up" }, "xyz", row({ ftfc: "up" })), true);
  assert.equal(rowPasses({ ...defaultFilters(), ftfc: "up" }, "xyz", row({ ftfc: null })), false);
  const mv = { ...defaultFilters(), movers: true };
  assert.equal(rowPasses(mv, "xyz", row()), false);
  assert.equal(rowPasses(mv, "xyz", row({ rvol: 2 })), true);
  assert.equal(rowPasses(mv, "xyz", row({ r5: -0.4 })), true);
  assert.equal(rowPasses(mv, "xyz", row({ r15: 0.79 })), false);
  assert.equal(rowPasses(mv, "xyz", row({ r15: -0.8 })), true);
});

test("filterCount: Filters badge spans its panel; volume counts only on screen; pats excluded", () => {
  assert.equal(filterCount(defaultFilters(), "xyz", false), 0);
  const f = {
    ...defaultFilters(), favs: true, dir: "up", stages: ["live", "cont"], tfs: ["D", "W", "M"], pats: ["22"],
    levMin: 3, vol: { xyz: { op: "ge", n: null }, perps: { op: "ge", n: 1e6 } },
  };
  assert.equal(filterCount(f, "xyz", false), 1 + 1 + 2 + 3 + 1);
  assert.equal(filterCount(f, "perps", true), 1 + 1 + 2 + 3 + 1 + 1 + 1);
});

test("toggleIn returns a new array and fmtAmount compacts amounts", () => {
  const a = ["D"];
  const b = toggleIn(a, "W");
  assert.deepEqual(b, ["D", "W"]);
  assert.deepEqual(a, ["D"]);
  assert.deepEqual(toggleIn(b, "D"), ["W"]);
  assert.equal(fmtAmount(5e6), "5m");
  assert.equal(fmtAmount(2.5e9), "2.5b");
  assert.equal(fmtAmount(5e5), "500k");
  assert.equal(fmtAmount(750), "750");
  assert.equal(fmtAmount(0), "0");
});

test("volText: compact only when it parses back to the same bound, else plain digits", () => {
  assert.equal(volText(5e6), "5m");
  assert.equal(volText(2.5e9), "2.5b");
  assert.equal(volText(12345), "12345"); // fmtAmount would round to 12.35k
  assert.equal(volText(999999), "999999"); // not 1000k
  assert.equal(volText(0.001), "0.001");
  assert.equal(volText(0), "0");
  for (const n of [5e6, 12345, 999999, 0.001, 0, 750, 1.5e6]) assert.equal(parseVolAmount(volText(n)), n);
});
