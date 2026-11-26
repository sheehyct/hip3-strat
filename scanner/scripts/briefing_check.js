#!/usr/bin/env node
"use strict";

// Briefing consistency probe (docs/BRIEFING_DIAGNOSTICS.md).
//
// Fetches every briefing representation for one universe - health, HTML,
// compact JSON, canonical JSON, CSV - and checks that they describe the SAME
// materialized snapshot: one snapshot_id (headers AND bodies), one
// data_as_of_utc, one row count, one symbol set. Zero dependencies; global
// fetch (Node >= 18).
//
//   node scripts/briefing_check.js                       (local boot, uni=xyz)
//   node scripts/briefing_check.js https://<your-worker-host>
//   BRIEFING_BASE=https://<your-worker-host> BRIEFING_UNI=perps node scripts/briefing_check.js
//
// Outcomes and exit codes - read them literally:
//   0 MATCH        every representation carries the same snapshot id and
//                  the data agrees.
//   2 INCONCLUSIVE the ids differ across fetches even after the bounded
//                  retry: the requests straddled a materialization (they are
//                  ~60s apart on the server). NOT a consistency bug. The
//                  data comparison on the last round is printed anyway.
//   1 MISMATCH     the SAME snapshot id was served with different data, a
//                  body disagrees with its OWN headers, or a body is not a
//                  valid document of its format (unparseable JSON, a missing
//                  briefing-data block, no symbol column). This is the
//                  server-side bug the identity exists to catch.
//   3 ERROR        a request failed (no response, 4xx/5xx). The request id
//                  of every response that did arrive is printed so the
//                  matching "[briefing] request" log line can be found.
//
// Check ORDER matters: each response is validated on
// its own FIRST - parse result, format shape, body-vs-header agreement -
// and any failure there is a MISMATCH regardless of what the other
// responses say. Only responses that are individually valid can be
// classified as a cross-request straddle, and a proven within-response
// failure is never retried away.

const BASE = (process.argv[2] || process.env.BRIEFING_BASE
  || "http://127.0.0.1:8787").replace(/\/+$/, "");
const UNI = process.env.BRIEFING_UNI || "xyz";
const ROUNDS = parseInt(process.env.BRIEFING_ROUNDS || "3", 10);

const ROUTES = [
  ["health", "/api/briefing/health"],
  ["html", "/api/briefing/latest.html"],
  ["compact", "/api/briefing/latest.compact.json"],
  ["json", "/api/briefing/latest.json"],
  ["csv", "/api/briefing/latest.csv"]
];

function unescapeHtml(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function metaFromHtml(html, key) {
  const m = new RegExp("<dt>" + key + "</dt><dd>([^<]*)</dd>").exec(html);
  return m ? unescapeHtml(m[1]) : null;
}

function symbolsFromHtml(html) {
  const m = /<pre id="briefing-data">([\s\S]*?)<\/pre>/.exec(html);
  if (!m) return null;
  const lines = m[1].split("\n");
  const header = lines[0].split("\t");
  const idx = header.indexOf("symbol");
  if (idx < 0) return null;
  return lines.slice(1).map(function (l) { return unescapeHtml(l.split("\t")[idx]); });
}

function symbolsFromCsv(text) {
  // The symbol column never contains commas or quotes; a naive split is
  // enough for the SET comparison this script makes.
  const lines = text.split("\n");
  const idx = lines[0].split(",").indexOf("symbol");
  if (idx < 0) return null;
  return lines.slice(1).filter(Boolean).map(function (l) { return l.split(",")[idx]; });
}

async function fetchOne(name, route) {
  const url = BASE + route + "?uni=" + encodeURIComponent(UNI);
  const t0 = Date.now();
  let res, text;
  try {
    // Connection: close - keep-alive sockets left open by fetch trip a libuv
    // assertion on Windows when the process exits right after the verdict.
    res = await fetch(url, { headers: { "Accept-Encoding": "identity", "Connection": "close" } });
    text = await res.text();
  } catch (e) {
    return { name: name, url: url, error: (e && e.message) || String(e), ms: Date.now() - t0 };
  }
  const h = function (k) { return res.headers.get(k); };
  const out = {
    name: name, url: url, status: res.status, ms: Date.now() - t0, bytes: text.length,
    request_id: h("x-request-id"), snapshot_id: h("x-snapshot-id"),
    data_as_of: h("x-data-as-of"), age_seconds: h("x-age-seconds"),
    producer_status: h("x-producer-status"), is_stale: h("x-is-stale"),
    row_count: h("x-row-count"), expected: h("x-expected-row-count"),
    complete: h("x-data-complete"), cache_control: h("cache-control"),
    edge_request_id: h("x-railway-request-id"), body_snapshot_id: null, body_data_as_of: null,
    symbols: null
  };
  if (name === "html") {
    out.body_snapshot_id = metaFromHtml(text, "snapshot_id");
    out.body_data_as_of = metaFromHtml(text, "data_as_of_utc");
    out.symbols = symbolsFromHtml(text);
  } else if (name === "csv") {
    out.symbols = symbolsFromCsv(text);
  } else {
    try {
      const body = JSON.parse(text);
      out.body_snapshot_id = body.snapshot_id === undefined ? null : body.snapshot_id;
      out.body_data_as_of = body.data_as_of_utc === undefined ? null : body.data_as_of_utc;
      if (name === "json" && Array.isArray(body.rows)) {
        out.symbols = body.rows.map(function (r) { return r.symbol; });
      } else if (name === "compact" && Array.isArray(body.rows) && Array.isArray(body.row_fields)) {
        const idx = body.row_fields.indexOf("symbol");
        out.symbols = body.rows.map(function (r) { return r[idx]; });
      }
      if (name === "health") out.health = body;
    } catch (e) {
      out.parse_error = e.message;
    }
  }
  return out;
}

function sameSet(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const sa = a.slice().sort(), sb = b.slice().sort();
  return sa.every(function (v, i) { return v === sb[i]; });
}

function summarize(results) {
  const lines = [];
  results.forEach(function (r) {
    if (r.error) {
      lines.push("  " + r.name.padEnd(8) + " ERROR " + r.error + " (" + r.ms + "ms)");
      return;
    }
    lines.push("  " + r.name.padEnd(8) + " " + r.status + " id=" + r.snapshot_id
      + (r.body_snapshot_id !== null ? " body_id=" + r.body_snapshot_id : "")
      + " as_of=" + r.data_as_of + " age=" + r.age_seconds + "s producer=" + r.producer_status
      + " stale=" + r.is_stale + " rows=" + r.row_count + "/" + r.expected
      + " complete=" + r.complete + " req=" + r.request_id + " " + r.ms + "ms " + r.bytes + "B");
  });
  return lines.join("\n");
}

async function round(n) {
  const results = [];
  for (const pair of ROUTES) results.push(await fetchOne(pair[0], pair[1]));
  console.log("round " + n + " (" + BASE + ", uni=" + UNI + ")");
  console.log(summarize(results));
  return results;
}

// The header value the worker sends when a body field is null.
function normalizeAsOf(value) {
  return value === null || value === undefined || value === "" || value === "unknown" ? null : value;
}

// Per-response validity: the body must be a document of its format and
// must agree with its own headers. Returns the list of problems (empty =
// valid). A missing body id or symbol list is a FAILURE, not a skip - an
// unreadable canonical JSON used to pass as MATCH because nothing checked
// that the body had been read at all.
function validateOne(r) {
  const problems = [];
  if (r.parse_error) problems.push(r.name + ": body did not parse (" + r.parse_error + ")");
  if (r.name === "health") {
    if (!r.health || typeof r.health.status !== "string") problems.push(r.name + ": body lacks a status");
  } else if (!Array.isArray(r.symbols)) {
    problems.push(r.name + ": body has no symbol column");
  }
  if (r.name !== "csv" && (r.body_snapshot_id === null || r.body_snapshot_id === undefined || r.body_snapshot_id === "")) {
    problems.push(r.name + ": body carries no snapshot_id");
  }
  if (r.body_snapshot_id !== null && r.body_snapshot_id !== undefined && r.body_snapshot_id !== ""
      && r.body_snapshot_id !== r.snapshot_id) {
    problems.push(r.name + ": body snapshot_id " + r.body_snapshot_id + " != header " + r.snapshot_id);
  }
  // data_as_of is documented-nullable (unknown stamp): body null <-> header
  // "unknown" agree; anything else must match exactly.
  if (r.name !== "csv" && normalizeAsOf(r.body_data_as_of) !== normalizeAsOf(r.data_as_of)) {
    problems.push(r.name + ": body data_as_of " + r.body_data_as_of + " != header " + r.data_as_of);
  }
  if (r.cache_control !== "no-store, no-cache, must-revalidate") {
    problems.push(r.name + ": unexpected Cache-Control " + r.cache_control);
  }
  // Response-LOCAL data checks (review M1): a body whose row count or
  // symbol uniqueness contradicts its own X-Row-Count header is a failure of
  // THIS response, so it must be judged here - before any straddle decision
  // can retry it away.
  if (Array.isArray(r.symbols)) {
    if (new Set(r.symbols).size !== r.symbols.length) problems.push(r.name + ": duplicate symbols");
    if (String(r.symbols.length) !== r.row_count) {
      problems.push(r.name + ": " + r.symbols.length + " symbols vs X-Row-Count " + r.row_count);
    }
  }
  if (r.name === "health" && r.health && r.health.row_count !== undefined
      && String(r.health.row_count) !== r.row_count) {
    problems.push(r.name + ": body row_count " + r.health.row_count + " != header " + r.row_count);
  }
  return problems;
}

function classify(results) {
  const failed = results.filter(function (r) { return r.error || r.status >= 400; });
  if (failed.length) return { outcome: "ERROR", code: 3, detail: failed.map(function (r) { return r.name + " " + (r.error || r.status); }).join(", ") };

  // 1. Each response on its own. A failure here cannot be explained by a
  //    materialization landing between requests, so it outranks a straddle.
  let problems = [];
  results.forEach(function (r) { problems = problems.concat(validateOne(r)); });
  if (problems.length) return { outcome: "MISMATCH", code: 1, detail: problems.join("; ") };

  // 2. Only individually valid responses can straddle.
  const ids = new Set(results.map(function (r) { return r.snapshot_id; }));
  if (ids.size > 1) {
    return { outcome: "STRADDLED", code: 2, detail: "ids " + Array.from(ids).join(" / ") };
  }
  // One id everywhere: the data must agree.
  const ref = results[0];
  results.forEach(function (r) {
    if (r.data_as_of !== ref.data_as_of) problems.push(r.name + ": data_as_of differs");
    if (r.row_count !== ref.row_count) problems.push(r.name + ": row_count differs");
    if (r.expected !== ref.expected) problems.push(r.name + ": expected_row_count differs");
  });
  // Cross-response checks only from here: everything response-local was
  // settled in validateOne() above.
  const withSymbols = results.filter(function (r) { return r.symbols; });
  withSymbols.forEach(function (r) {
    if (!sameSet(r.symbols, withSymbols[0].symbols)) problems.push(r.name + ": symbol set differs from " + withSymbols[0].name);
  });
  if (problems.length) return { outcome: "MISMATCH", code: 1, detail: problems.join("; ") };
  return { outcome: "MATCH", code: 0, detail: "snapshot " + ref.snapshot_id + " as_of " + ref.data_as_of + " rows " + ref.row_count + "/" + ref.expected };
}

// Bounded rounds: only a STRADDLED round is retried. MATCH, MISMATCH and
// ERROR are final the moment they are observed - a proven failure is never
// retried away by a cleaner later round.
function finalVerdict(rounds) {
  const last = rounds[rounds.length - 1];
  if (last.verdict.outcome !== "STRADDLED") return last.verdict;
  const results = last.results;
  const asOf = new Set(results.map(function (r) { return r.data_as_of; }));
  const rows = new Set(results.map(function (r) { return r.row_count; }));
  return {
    outcome: "INCONCLUSIVE", code: 2,
    detail: last.verdict.detail + "; data_as_of " + (asOf.size === 1 ? "agrees" : "differs")
      + ", row_count " + (rows.size === 1 ? "agrees" : "differs")
  };
}

async function main() {
  const rounds = [];
  for (let n = 1; n <= ROUNDS; n++) {
    const results = await round(n);
    const verdict = classify(results);
    rounds.push({ results: results, verdict: verdict });
    if (verdict.outcome !== "STRADDLED") break;
    console.log("  ids differ across fetches (a materialization landed mid-round) - retrying");
  }
  const verdict = finalVerdict(rounds);
  const results = rounds[rounds.length - 1].results;
  const health = results && results[0] && results[0].health;
  if (health) {
    console.log("health: status=" + health.status + " producer=" + health.producer_status
      + " age=" + health.age_seconds + "s complete=" + health.data_complete + " stale=" + health.is_stale
      + " missing=" + (health.missing_symbols || []).length + " issues=" + JSON.stringify(health.issues || [])
      + " boot=" + (health.producer && health.producer.boot_id) + " seq=" + (health.producer && health.producer.sequence));
  }
  console.log(verdict.outcome + ": " + verdict.detail);
  // exitCode, not exit(): let the event loop drain the closed sockets.
  process.exitCode = verdict.code;
}

module.exports = { classify: classify, validateOne: validateOne, finalVerdict: finalVerdict, sameSet: sameSet };

if (require.main === module) {
  main().catch(function (e) {
    console.error("ERROR: " + ((e && e.stack) || e));
    process.exitCode = 3;
  });
}
