"use strict";

// scripts/briefing_check.js classify(): the consistency probe's verdict
// logic, pinned by the 2026-09-13 audit's three F3 vectors plus controls.
// The probe is a diagnostic tool - a verdict that can say MATCH about an
// unreadable body is worse than no tool. node builtins only: node --test

const test = require("node:test");
const assert = require("node:assert");
const { classify, finalVerdict } = require("../scripts/briefing_check.js");

const CC = "no-store, no-cache, must-revalidate";
const ID = "b00t1d00-0000042";
const AS_OF = "2026-09-13T12:00:00.000Z";

function receipt(name, overrides) {
  const base = {
    name: name, status: 200, snapshot_id: ID, data_as_of: AS_OF, row_count: "3", expected: "3",
    complete: "true", cache_control: CC, age_seconds: "5", producer_status: "ok", is_stale: "false",
    request_id: "req-" + name, body_snapshot_id: ID, body_data_as_of: AS_OF,
    symbols: ["FOO", "BAR", "BAZ"], parse_error: undefined
  };
  if (name === "csv") { base.body_snapshot_id = null; base.body_data_as_of = null; }
  if (name === "health") { base.symbols = null; base.health = { status: "ok" }; }
  return Object.assign(base, overrides || {});
}

function fiveValid() {
  return [receipt("health"), receipt("html"), receipt("compact"), receipt("json"), receipt("csv")];
}

test("classify: five valid receipts of one snapshot are a MATCH", function () {
  const v = classify(fiveValid());
  assert.strictEqual(v.outcome, "MATCH");
  assert.strictEqual(v.code, 0);
});

test("classify: F3 vector 1 - an unparseable canonical JSON body is a MISMATCH, not a MATCH", function () {
  const rs = fiveValid();
  rs[3] = receipt("json", { parse_error: "invalid JSON", body_snapshot_id: null, body_data_as_of: null, symbols: null });
  const v = classify(rs);
  assert.strictEqual(v.outcome, "MISMATCH");
  assert.strictEqual(v.code, 1);
  assert.match(v.detail, /json: body did not parse/);
  assert.match(v.detail, /json: body has no symbol column/);
});

test("classify: F3 vector 2 - bodies that all lack ids/shape are a MISMATCH even with agreeing headers", function () {
  const rs = fiveValid().map(function (r) {
    return Object.assign(r, { body_snapshot_id: null, body_data_as_of: null, symbols: null, health: r.name === "health" ? {} : r.health });
  });
  const v = classify(rs);
  assert.strictEqual(v.outcome, "MISMATCH");
  assert.match(v.detail, /html: body has no symbol column/);
  assert.match(v.detail, /html: body carries no snapshot_id/);
  assert.match(v.detail, /health: body lacks a status/);
  assert.match(v.detail, /csv: body has no symbol column/);
});

test("classify: F3 vector 3 - a body disagreeing with its OWN headers outranks a cross-request straddle", function () {
  const rs = fiveValid();
  rs[1] = receipt("html", { body_snapshot_id: "b00t1d00-0000041" });   // contradicts its header
  rs[4] = receipt("csv", { snapshot_id: "b00t1d00-0000043" });         // the next snapshot: a straddle
  const v = classify(rs);
  assert.strictEqual(v.outcome, "MISMATCH", "a materialization between requests cannot explain a self-contradiction");
  assert.strictEqual(v.code, 1);
  assert.match(v.detail, /html: body snapshot_id b00t1d00-0000041 != header b00t1d00-0000042/);
});

test("classify: a genuine straddle of individually valid responses is STRADDLED, never MISMATCH", function () {
  const rs = fiveValid();
  rs[4] = receipt("csv", { snapshot_id: "b00t1d00-0000043", data_as_of: "2026-09-13T12:01:00.000Z" });
  const v = classify(rs);
  assert.strictEqual(v.outcome, "STRADDLED");
  assert.strictEqual(v.code, 2);
});

test("classify: the documented-nullable data_as_of agrees between a null body and an unknown header", function () {
  const rs = fiveValid().map(function (r) {
    return Object.assign(r, { data_as_of: "unknown", body_data_as_of: r.name === "csv" ? null : null });
  });
  rs[1].body_data_as_of = "";          // the HTML renders null as an empty <dd>
  const v = classify(rs);
  assert.strictEqual(v.outcome, "MATCH");
});

test("classify: same id, different data is a MISMATCH; wrong Cache-Control is a MISMATCH", function () {
  let rs = fiveValid();
  rs[3] = receipt("json", { symbols: ["FOO", "BAR", "QUX"] });
  let v = classify(rs);
  assert.strictEqual(v.outcome, "MISMATCH");
  assert.match(v.detail, /json: symbol set differs/);
  rs = fiveValid();
  rs[2] = receipt("compact", { cache_control: "no-store" });
  v = classify(rs);
  assert.strictEqual(v.outcome, "MISMATCH");
  assert.match(v.detail, /compact: unexpected Cache-Control no-store/);
});

test("classify: any failed request is an ERROR before anything else is judged", function () {
  const rs = fiveValid();
  rs[0] = receipt("health", { status: 503 });
  assert.strictEqual(classify(rs).outcome, "ERROR");
  rs[0] = { name: "health", error: "fetch failed", ms: 3 };
  assert.strictEqual(classify(rs).outcome, "ERROR");
});

test("finalVerdict: a proven MISMATCH is final; only exhausted straddles become INCONCLUSIVE", function () {
  const mismatch = { outcome: "MISMATCH", code: 1, detail: "x" };
  assert.strictEqual(finalVerdict([{ results: fiveValid(), verdict: mismatch }]).outcome, "MISMATCH");
  const straddle = { outcome: "STRADDLED", code: 2, detail: "ids a / b" };
  const rs = fiveValid();
  rs[4] = receipt("csv", { snapshot_id: "b00t1d00-0000043" });
  const v = finalVerdict([{ results: rs, verdict: straddle }, { results: rs, verdict: straddle }]);
  assert.strictEqual(v.outcome, "INCONCLUSIVE");
  assert.strictEqual(v.code, 2);
  assert.match(v.detail, /data_as_of agrees, row_count agrees/);
});

// --- review M1: response-local data checks must precede the straddle decision ---

test("classify: review M1 - a body with fewer rows than its own X-Row-Count is a MISMATCH even under a straddle", function () {
  const rs = fiveValid();
  rs[3] = receipt("json", { symbols: ["FOO", "BAR"] });               // 2 rows under X-Row-Count 3
  rs[4] = receipt("csv", { snapshot_id: "b00t1d00-0000043" });          // the next snapshot: a straddle
  const v = classify(rs);
  assert.strictEqual(v.outcome, "MISMATCH", "a straddle cannot explain a body contradicting its own header");
  assert.match(v.detail, /json: 2 symbols vs X-Row-Count 3/);
});

test("classify: review M1 - duplicate symbols are a MISMATCH even under a straddle", function () {
  const rs = fiveValid();
  rs[1] = receipt("html", { symbols: ["FOO", "FOO", "BAZ"] });
  rs[4] = receipt("csv", { snapshot_id: "b00t1d00-0000043" });
  const v = classify(rs);
  assert.strictEqual(v.outcome, "MISMATCH");
  assert.match(v.detail, /html: duplicate symbols/);
});

test("classify: a health body whose row_count disagrees with its header is a MISMATCH", function () {
  const rs = fiveValid();
  rs[0] = receipt("health", { health: { status: "ok", row_count: 2 } });
  const v = classify(rs);
  assert.strictEqual(v.outcome, "MISMATCH");
  assert.match(v.detail, /health: body row_count 2 != header 3/);
});
