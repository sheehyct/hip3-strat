"use strict";

// Materialized briefing snapshots (src/briefing_store.js): identity,
// serve-time freshness, producer status, the monotonic guard, the throttled
// materialization log, and the cross-format consistency guarantee checked
// against a FROZEN producer (the only honest way to compare representations -
// a live pair of requests can straddle a materialization). node builtins
// only: node --test

const test = require("node:test");
const assert = require("node:assert");
const {
  createBriefingStore, STALLED_AFTER_INTERVALS, HEARTBEAT_MS
} = require("../src/briefing_store.js");
const {
  BRIEFING_CSV_FIELDS, BRIEFING_HTML_ROW_FIELDS, STALE_AFTER_SECONDS,
  previousUsCashClose
} = require("../src/briefing.js");

const FTFC = ["15m", "1h", "4h", "1d"];
const T0 = Date.UTC(2026, 8, 13, 12, 0); // Sun Sep 13 2026 12:00 UTC

// --- fixture: the server_routes briefing state, parameterized ---------------

function coinAt(now, sym, mid) {
  const close = previousUsCashClose(now);
  const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const hourly = [];
  for (let i = 30; i > 0; i--) {
    const T = close.target_ms - (i - 1) * 3600000 - 1;
    hourly.push({ t: T - 3599999, T: T, o: mid - 6, h: mid - 4, l: mid - 7, c: mid - 5, v: 1 });
  }
  return {
    name: "xyz:" + sym, sym: sym, uni: "xyz", mid: mid, hist: [],
    ctx: { markPx: String(mid), prevDayPx: String(mid - 3), dayNtlVlm: "1000", funding: "0.0001" },
    tf: {
      "1h": {
        closed: hourly.slice(-30), referenceClosed: hourly,
        forming: { t: now - 1800000, T: now + 1800000, o: mid - 1, h: mid + 1, l: mid - 2, c: mid, v: 1 },
        an: { types: ["2D", "1", "2U"], formingType: "2U", formingDir: "up",
              completed: null, setups: [], invalidated: false,
              live: sym === "BAR" ? [{ name: "2-1-2U", dir: "up", trigger: mid - 1, target: mid + 5, stop: mid - 3 }] : [] }
      },
      "1d": {
        closed: [{ t: dayStart - 86400000, T: dayStart - 1, o: mid - 6, h: mid - 1, l: mid - 7, c: mid - 2, v: 1 }],
        forming: { t: dayStart, T: dayStart + 86400000 - 1, o: mid - 2, h: mid + 1, l: mid - 3, c: mid, v: 1 },
        an: { types: ["2U"], formingType: "2U", formingDir: "up",
              completed: null, setups: [], invalidated: false, live: [] }
      }
    }
  };
}

function stateAt(now, options) {
  options = options || {};
  const coins = {};
  const order = [];
  if (!options.empty) {
    [["FOO", 105], ["BAR", 42.5], ["BAZ", 0.0123]].forEach(function (pair) {
      const c = coinAt(now, pair[0], pair[1]);
      coins[c.name] = c;
      order.push(c.name);
    });
  }
  return {
    order: order,
    loaded: options.loaded === undefined ? true : options.loaded,
    universes: ["xyz"],
    expectedMarketsByUni: { xyz: ["xyz:FOO", "xyz:BAR", "xyz:BAZ"] },
    lastMids: now - 1000,
    lastCandles: now - 2000,
    lastContexts: now - 3000,
    coins: coins,
    revision: 7,
    candleFailures: 2,
    midsFailures: 0
  };
}

function makeStore(state, extra) {
  const clock = { now: T0 };
  const lines = [];
  const store = createBriefingStore(Object.assign({
    state: state,
    ftfcTfs: FTFC,
    now: function () { return clock.now; },
    log: function (line) { lines.push(line); },
    bootId: "b00t1d00",
    intervalMs: 60000
  }, extra || {}));
  return { store: store, clock: clock, lines: lines };
}

function logged(lines, prefix) {
  return lines.filter(function (l) { return l.indexOf(prefix) === 0; })
    .map(function (l) { return JSON.parse(l.slice(prefix.length)); });
}

// --- identity ---------------------------------------------------------------

test("store: snapshot ids are boot-scoped, zero-padded and monotonic; a view reuses the entry", function () {
  const h = makeStore(stateAt(T0));
  const a = h.store.materialize("xyz");
  assert.strictEqual(a.snapshot_id, "b00t1d00-0000001");
  assert.strictEqual(a.snapshot.snapshot_id, "b00t1d00-0000001", "identity is IN the snapshot body");
  assert.strictEqual(Object.keys(a.snapshot)[0], "snapshot_id", "identity leads the JSON body");
  assert.strictEqual(a.compact.snapshot_id, "b00t1d00-0000001", "compact projection carries it");
  // Two views without a materialization between them see the same entry.
  h.clock.now += 5000;
  assert.strictEqual(h.store.view("xyz").served.snapshot_id, "b00t1d00-0000001");
  assert.strictEqual(h.store.view("xyz").served.snapshot_id, "b00t1d00-0000001");
  const b = h.store.materialize("xyz");
  assert.strictEqual(b.snapshot_id, "b00t1d00-0000002");
  assert.notStrictEqual(a, b, "entries are immutable - a new one replaces, never mutates");
  assert.strictEqual(a.snapshot_id, "b00t1d00-0000001", "the old entry keeps its id");
});

test("store: view builds ON DEMAND only when no entry exists, never refreshes an existing one", function () {
  const h = makeStore(stateAt(T0));
  assert.strictEqual(h.store.get("xyz"), null);
  const v1 = h.store.view("xyz");
  assert.strictEqual(v1.served.snapshot_id, "b00t1d00-0000001", "first view materialized");
  h.clock.now += 10 * 60000;             // well past the interval, no tick
  const v2 = h.store.view("xyz");
  assert.strictEqual(v2.served.snapshot_id, "b00t1d00-0000001",
    "a request must not mask a stalled producer by rebuilding on its behalf");
});

// --- serve-time freshness ---------------------------------------------------

test("store: a stopped producer reads stale under an advancing clock without another materialization", function () {
  const h = makeStore(stateAt(T0));
  const entry = h.store.materialize("xyz");
  assert.strictEqual(entry.snapshot.is_stale, false, "fresh at materialization");
  assert.deepStrictEqual(entry.snapshot.warnings, []);

  const fresh = h.store.view("xyz");
  assert.strictEqual(fresh.served.is_stale, false);
  assert.strictEqual(fresh.served.age_seconds, 3, "age is measured from data_as_of (the oldest stamp, 3s)");
  assert.strictEqual(fresh.served.producer_status, "ok");
  assert.strictEqual(h.store.healthStatus(fresh), "ok");

  h.clock.now = T0 + (STALE_AFTER_SECONDS + 100) * 1000;  // no tick, clock advances
  const later = h.store.view("xyz");
  assert.strictEqual(later.served.snapshot_id, entry.snapshot_id, "same data...");
  assert.strictEqual(later.served.is_stale, true, "...older age");
  assert.strictEqual(later.served.age_seconds, STALE_AFTER_SECONDS + 103);
  assert.strictEqual(later.served.producer_status, "stalled",
    "last materialization older than " + STALLED_AFTER_INTERVALS + " intervals");
  assert.strictEqual(h.store.healthStatus(later), "degraded");
  assert.strictEqual(entry.snapshot.is_stale, false, "the immutable entry is untouched");

  // Every representation reports the SERVE-TIME truth and gains the warning.
  const canonical = h.store.canonical(later);
  const compact = h.store.compact(later);
  const html = h.store.html(later);
  assert.strictEqual(canonical.is_stale, true);
  assert.strictEqual(compact.is_stale, true);
  assert.strictEqual(canonical.age_seconds, STALE_AFTER_SECONDS + 103);
  assert.strictEqual(canonical.producer_status, "stalled");
  assert.match(canonical.warnings[canonical.warnings.length - 1], /seconds old at serve time$/);
  assert.deepStrictEqual(compact.warnings, canonical.warnings);
  assert.match(html, /<dt>is_stale<\/dt><dd>true<\/dd>/);
  assert.match(html, /<dt>producer_status<\/dt><dd>stalled<\/dd>/);
  assert.match(html, new RegExp("<dt>age_seconds</dt><dd>" + (STALE_AFTER_SECONDS + 103) + "</dd>"));
  assert.match(html, /seconds old at serve time/);
  assert.strictEqual(Object.keys(canonical).indexOf("rows"), Object.keys(canonical).length - 1,
    "rows stay last in the served body");

  // A tick recovers: new id, fresh again, warning gone.
  h.store.materialize("xyz");
  const after = h.store.view("xyz");
  assert.strictEqual(after.served.snapshot_id, "b00t1d00-0000002");
  assert.strictEqual(after.served.producer_status, "ok");
  assert.strictEqual(after.served.is_stale, true, "the STATE stamps are still old - the loop, not the producer, is the stale party");
  assert.strictEqual(h.store.canonical(after).warnings.filter(function (w) { return /at serve time/.test(w); }).length, 0,
    "materialized-stale snapshots carry the builder's own age warning, not the serve-time one");
});

test("store: health body derives status from the snapshot, not from the process being alive", function () {
  const loading = makeStore(stateAt(T0, { loaded: false, empty: true }));
  let h = loading.store.health("xyz");
  assert.strictEqual(h.status, "unavailable");
  assert.strictEqual(h.producer_status, "loading");
  assert.strictEqual(h.row_count, 0);
  assert.strictEqual(h.loop_loaded, false);
  assert.ok(h.issues.includes("worker_loading"));

  const empty = makeStore(stateAt(T0, { empty: true }));
  h = empty.store.health("xyz");
  assert.strictEqual(h.status, "unavailable");
  assert.strictEqual(h.producer_status, "ok", "the producer ran fine; the state has no rows");
  assert.ok(h.issues.includes("no_rows"));

  const ok = makeStore(stateAt(T0));
  h = ok.store.health("xyz");
  assert.strictEqual(h.status, "ok");
  assert.strictEqual(h.snapshot_id, "b00t1d00-0000001");
  assert.strictEqual(h.format, "briefing_compact_v1");
  assert.strictEqual(h.schema_version, "1.0");
  assert.strictEqual(h.row_count, 3);
  assert.strictEqual(h.expected_row_count, 3);
  assert.strictEqual(h.data_complete, true);
  assert.strictEqual(h.is_stale, false);
  assert.strictEqual(h.age_seconds, 3);
  assert.deepStrictEqual(h.missing_symbols, []);
  assert.strictEqual(h.producer.boot_id, "b00t1d00");
  assert.strictEqual(h.producer.interval_seconds, 60);
  assert.strictEqual(h.producer.sequence, 1);
  assert.strictEqual(h.producer.build_errors, 0);
  assert.strictEqual(h.producer.regressions_refused, 0);
  assert.deepStrictEqual(h.upstream, { candle_fetch_failures: 2, mids_fetch_failures: 0, loop_revision: 7 });
  assert.strictEqual(h.rows, undefined, "no market rows in the health body");

  // Partial: one expected symbol missing -> degraded with the name listed.
  const partialState = stateAt(T0);
  delete partialState.coins["xyz:BAZ"];
  partialState.order = ["xyz:FOO", "xyz:BAR"];
  h = makeStore(partialState).store.health("xyz");
  assert.strictEqual(h.status, "degraded");
  assert.strictEqual(h.data_complete, false);
  assert.deepStrictEqual(h.missing_symbols, ["BAZ"]);
  assert.strictEqual(h.row_count, 2);
  assert.strictEqual(h.expected_row_count, 3);
});

// --- producer failure and the monotonic guard -------------------------------

test("store: a throwing build keeps the previous entry, reports error, and a later success clears it", function () {
  let fail = false;
  const state = stateAt(T0);
  const h = makeStore(state, {
    build: function (s, tfs, uni, at) {
      if (fail) throw new Error("synthetic build failure");
      return require("../src/briefing.js").buildBriefingSnapshot(s, tfs, uni, at);
    }
  });
  const first = h.store.materialize("xyz");
  fail = true;
  h.clock.now += 60000;
  const kept = h.store.materialize("xyz");
  assert.strictEqual(kept, first, "previous entry retained");
  const v = h.store.view("xyz");
  assert.strictEqual(v.served.producer_status, "error");
  assert.strictEqual(h.store.healthStatus(v), "degraded");
  const health = h.store.health("xyz");
  assert.strictEqual(health.producer.build_errors, 1);
  assert.strictEqual(health.producer.last_error.message, "synthetic build failure");
  const failLines = logged(h.lines, "[briefing] build failed ");
  assert.strictEqual(failLines.length, 1);
  assert.strictEqual(failLines[0].kept_snapshot_id, first.snapshot_id);
  assert.strictEqual(failLines[0].universe, "xyz");

  fail = false;
  h.clock.now += 60000;
  const next = h.store.materialize("xyz");
  assert.strictEqual(next.snapshot_id, "b00t1d00-0000002");
  assert.strictEqual(h.store.view("xyz").served.producer_status, "ok", "success supersedes the error");
  assert.strictEqual(h.store.health("xyz").producer.build_errors, 1, "the count is history, not state");
});

test("store: a build whose data_as_of would move backwards is refused and counted", function () {
  const state = stateAt(T0);
  let asOfOffset = 0;
  const h = makeStore(state, {
    build: function (s, tfs, uni, at) {
      const snap = require("../src/briefing.js").buildBriefingSnapshot(s, tfs, uni, at);
      if (asOfOffset) snap.data_as_of_utc = new Date(Date.parse(snap.data_as_of_utc) + asOfOffset).toISOString();
      return snap;
    }
  });
  const first = h.store.materialize("xyz");
  asOfOffset = -60000;                    // older than the entry now current
  const kept = h.store.materialize("xyz");
  assert.strictEqual(kept, first);
  assert.strictEqual(h.store.health("xyz").producer.regressions_refused, 1);
  const lines = logged(h.lines, "[briefing] refused regression ");
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].kept_snapshot_id, first.snapshot_id);
  asOfOffset = 0;
  h.clock.now += 1000;
  assert.strictEqual(h.store.materialize("xyz").snapshot_id, "b00t1d00-0000002", "equal-or-newer proceeds");
});

// --- materialization log: change-driven, heartbeat-bounded -----------------

test("store: materialization is logged on first build, on every diagnostic change, and at most every 15 min otherwise", function () {
  const state = stateAt(T0);
  const h = makeStore(state);
  const reasons = function () {
    return logged(h.lines, "[briefing] materialized ").map(function (l) { return l.reason; });
  };
  h.store.materialize("xyz");
  assert.deepStrictEqual(reasons(), ["first"]);
  const first = logged(h.lines, "[briefing] materialized ")[0];
  assert.strictEqual(first.snapshot_id, "b00t1d00-0000001");
  assert.strictEqual(first.row_count, 3);
  assert.strictEqual(first.expected_row_count, 3);
  assert.strictEqual(first.data_complete, true);
  assert.deepStrictEqual(first.issues, []);
  assert.strictEqual(typeof first.build_ms, "number");
  assert.deepStrictEqual(first.upstream, { candle_fetch_failures: 2, mids_fetch_failures: 0, loop_revision: 7 });

  // A live loop keeps its stamps moving with the clock; without this the
  // 30s mids window lapses and the signature changes for a REAL reason.
  const advance = function (ms) {
    h.clock.now += ms;
    state.lastMids = h.clock.now - 1000;
    state.lastCandles = h.clock.now - 2000;
    state.lastContexts = h.clock.now - 3000;
  };
  advance(60000);
  h.store.materialize("xyz");
  assert.deepStrictEqual(reasons(), ["first"], "unchanged diagnostics within the heartbeat: silent");

  delete state.coins["xyz:BAZ"];         // a symbol drops out -> the signature changes
  state.order = ["xyz:FOO", "xyz:BAR"];
  advance(60000);
  h.store.materialize("xyz");
  assert.deepStrictEqual(reasons(), ["first", "change"]);
  const change = logged(h.lines, "[briefing] materialized ")[1];
  assert.strictEqual(change.missing_symbols, 1);
  assert.ok(change.issues.includes("expected_symbols_missing"));

  advance(60000);
  h.store.materialize("xyz");
  assert.deepStrictEqual(reasons(), ["first", "change"], "still the same (degraded) signature: silent");

  advance(HEARTBEAT_MS);
  h.store.materialize("xyz");
  assert.deepStrictEqual(reasons(), ["first", "change", "heartbeat"]);
});

test("store: start materializes every tracked universe immediately; stop halts the timer", async function () {
  const state = stateAt(T0);
  const h = makeStore(state, { intervalMs: 20, now: Date.now });
  h.store.start();
  assert.ok(h.store.get("xyz"), "first materialization is synchronous in start()");
  const seq0 = h.store.get("xyz").seq;
  await new Promise(function (r) { setTimeout(r, 90); });
  assert.ok(h.store.get("xyz").seq > seq0, "the timer ticked");
  h.store.stop();
  const seqStopped = h.store.get("xyz").seq;
  await new Promise(function (r) { setTimeout(r, 60); });
  assert.strictEqual(h.store.get("xyz").seq, seqStopped, "no ticks after stop");
  assert.ok(h.lines.some(function (l) { return /materializing every 0s/.test(l); }));
});

test("store: stats() is the /health summary - one row per tracked universe, no rows", function () {
  const h = makeStore(stateAt(T0));
  let s = h.store.stats();
  assert.strictEqual(s.boot_id, "b00t1d00");
  assert.strictEqual(s.universes.xyz.snapshot_id, null, "nothing materialized yet");
  assert.strictEqual(s.universes.xyz.producer_status, "idle");
  h.store.materialize("xyz");
  s = h.store.stats();
  assert.strictEqual(s.universes.xyz.snapshot_id, "b00t1d00-0000001");
  assert.strictEqual(s.universes.xyz.sequence, 1);
  assert.strictEqual(s.universes.xyz.row_count, 3);
  assert.strictEqual(s.universes.xyz.is_stale, false);
  assert.strictEqual(s.universes.xyz.producer_status, "ok");
  assert.strictEqual(s.universes.xyz.build_errors, 0);
});

// --- cross-format consistency against a FROZEN producer --------------------

function parseTsvBlock(html) {
  const m = /<pre id="briefing-data">([\s\S]*?)<\/pre>/.exec(html);
  assert.ok(m, "briefing-data block present");
  const unescape = function (s) {
    return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  };
  const lines = m[1].split("\n");
  const header = lines[0].split("\t").map(unescape);
  const rows = lines.slice(1).map(function (line) {
    const cells = line.split("\t").map(unescape);
    const row = {};
    header.forEach(function (name, i) { row[name] = cells[i]; });
    return row;
  });
  return { header: header, rows: rows };
}

// Minimal RFC-4180 reader for the canonical CSV (quoted cells with "" escapes).
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  const header = rows[0];
  return {
    header: header,
    rows: rows.slice(1).map(function (cells) {
      const out = {};
      header.forEach(function (name, i) { out[name] = cells[i]; });
      return out;
    })
  };
}

// Semantic comparison of a serialized cell against its canonical value:
// numbers by value, null/undefined as empty, arrays as their "; " join.
function assertCellMatches(cell, value, where) {
  if (value === null || value === undefined) {
    assert.strictEqual(cell, "", where + ": null serializes as an empty cell");
  } else if (typeof value === "number") {
    assert.ok(Number.isFinite(value), where + ": canonical numeric is finite");
    // An empty cell must never pass as zero (Number("") === 0) - audit
    // 2026-09-13 LOW: a dropped numeric would have compared equal to 0.
    assert.notStrictEqual(cell, "", where + ": numeric value is not an empty cell");
    assert.strictEqual(Number(cell), value, where + ": numeric round-trips by value");
  } else if (Array.isArray(value)) {
    assert.strictEqual(cell, value.join("; "), where);
  } else {
    assert.strictEqual(cell, String(value), where);
  }
}

test("store: HTML, compact JSON, canonical JSON and CSV of one frozen snapshot describe identical data", function () {
  const h = makeStore(stateAt(T0));
  h.store.materialize("xyz");
  h.clock.now += 4000;                     // served later than built: same id, same rows
  const v = h.store.view("xyz");
  const canonical = h.store.canonical(v);
  const compact = h.store.compact(v);
  const csv = parseCsv(h.store.csv(v));
  const tsv = parseTsvBlock(h.store.html(v));
  const html = h.store.html(v);

  // Identity and timestamps agree everywhere they appear.
  assert.strictEqual(canonical.snapshot_id, "b00t1d00-0000001");
  assert.strictEqual(compact.snapshot_id, canonical.snapshot_id);
  assert.match(html, /<dt>snapshot_id<\/dt><dd>b00t1d00-0000001<\/dd>/);
  assert.strictEqual(compact.data_as_of_utc, canonical.data_as_of_utc);
  assert.strictEqual(compact.generated_at_utc, canonical.generated_at_utc);
  assert.strictEqual(compact.universe, canonical.universe);
  assert.strictEqual(compact.expected_row_count, canonical.expected_row_count);
  assert.strictEqual(compact.row_count, canonical.row_count);
  csv.rows.forEach(function (row) {
    assert.strictEqual(row.data_as_of_utc, canonical.data_as_of_utc);
    assert.strictEqual(row.generated_at_utc, canonical.generated_at_utc);
    assert.strictEqual(row.universe, canonical.universe);
    assert.strictEqual(Number(row.row_count), canonical.row_count);
    assert.strictEqual(row.data_complete, String(canonical.data_complete));
    assert.strictEqual(row.score_policy, canonical.score_policy);
  });

  // Same symbol set, no duplicates, symbol + last present, in every form.
  const symbols = canonical.rows.map(function (r) { return r.symbol; }).sort();
  assert.deepStrictEqual(symbols, ["BAR", "BAZ", "FOO"]);
  assert.strictEqual(new Set(symbols).size, symbols.length);
  const symIdx = compact.row_fields.indexOf("symbol");
  assert.deepStrictEqual(compact.rows.map(function (r) { return r[symIdx]; }).sort(), symbols);
  assert.deepStrictEqual(csv.rows.map(function (r) { return r.symbol; }).sort(), symbols);
  assert.deepStrictEqual(tsv.rows.map(function (r) { return r.symbol; }).sort(), symbols);
  assert.ok(tsv.header.includes("symbol") && tsv.header.includes("last"));
  assert.ok(csv.header.includes("symbol") && csv.header.includes("last"));
  assert.deepStrictEqual(csv.header, BRIEFING_CSV_FIELDS, "CSV keeps its 49 documented columns");
  assert.deepStrictEqual(tsv.header, BRIEFING_HTML_ROW_FIELDS, "TSV header row is the documented field list");
  assert.strictEqual(tsv.rows.length, canonical.row_count);
  assert.strictEqual(csv.rows.length, canonical.row_count);

  // Per-row, per-field semantic equality driven by the RETURNED header rows,
  // never by fixed column positions.
  const canonicalBySym = {};
  canonical.rows.forEach(function (r) { canonicalBySym[r.symbol] = r; });
  const compactBySym = {};
  compact.rows.forEach(function (r) { compactBySym[r[symIdx]] = r; });
  const NUMERIC_TSV = ["last", "utc_session_change_pct", "overnight_change_pct", "exchange_24h_change_pct",
    "exchange_24h_volume_usd", "funding_hr_pct", "rvol_15m", "mom_5m_pct", "mom_15m_pct", "mom_1h_pct",
    "atr_14d_pct", "premium_pct", "open_interest_usd", "live_signal_count", "setup_count"];
  tsv.rows.forEach(function (row) {
    const c = compactBySym[row.symbol];
    assert.ok(c, "TSV symbol " + row.symbol + " exists in compact JSON");
    tsv.header.forEach(function (field) {
      const idx = compact.row_fields.indexOf(field);
      assert.ok(idx >= 0, "TSV field " + field + " is a compact row field");
      assertCellMatches(row[field], c[idx], "TSV " + row.symbol + "." + field);
    });
    NUMERIC_TSV.forEach(function (field) {
      if (!tsv.header.includes(field)) return;
      assert.ok(row[field] === "" || Number.isFinite(Number(row[field])),
        "TSV " + row.symbol + "." + field + " is numeric or empty, got " + JSON.stringify(row[field]));
    });
  });
  csv.rows.forEach(function (row) {
    const c = canonicalBySym[row.symbol];
    assert.ok(c, "CSV symbol " + row.symbol + " exists in canonical JSON");
    csv.header.forEach(function (field) {
      if (["generated_at_utc", "data_as_of_utc", "row_count", "universe", "data_complete", "score_policy"].includes(field)) return;
      let value = c[field];
      if (field === "live_signals" || field === "setups") value = (value || []).join("; ");
      assertCellMatches(row[field], value, "CSV " + row.symbol + "." + field);
    });
  });
  // Compact rows vs canonical rows for every shared field (counts + notable lists included).
  Object.keys(compactBySym).forEach(function (sym) {
    const c = canonicalBySym[sym], k = compactBySym[sym];
    compact.row_fields.forEach(function (field, idx) {
      if (field === "live_signal_count") return assert.strictEqual(k[idx], (c.live_signals || []).length);
      if (field === "setup_count") return assert.strictEqual(k[idx], (c.setups || []).length);
      if (field === "notable_live_signals") return assert.deepStrictEqual(k[idx], (c.live_signals || []).slice(0, 3).map(String));
      if (field === "notable_setups") return assert.deepStrictEqual(k[idx], (c.setups || []).slice(0, 3).map(String));
      assert.deepStrictEqual(k[idx], c[field] === undefined ? null : c[field], sym + "." + field);
    });
  });
  // No malformed numerics anywhere in the canonical rows.
  canonical.rows.forEach(function (r) {
    Object.keys(r).forEach(function (field) {
      if (typeof r[field] === "number") assert.ok(Number.isFinite(r[field]), r.symbol + "." + field);
    });
  });
});

// --- audit 2026-09-13 F1: the FIRST build failing, before any entry exists ---

test("store: a failing FIRST build yields a serializable unavailable view, reports error, and recovers", function () {
  let fail = true;
  const state = stateAt(T0);
  const h = makeStore(state, {
    build: function (s, tfs, uni, at) {
      if (fail) throw new Error("first-build failure");
      return require("../src/briefing.js").buildBriefingSnapshot(s, tfs, uni, at);
    }
  });
  const v = h.store.view("xyz");
  assert.strictEqual(v.entry, null);
  assert.strictEqual(v.usable, false);
  assert.strictEqual(v.served.producer_status, "error", "error outranks idle: the producer is failing, not idle");
  assert.strictEqual(v.served.snapshot_id, null);
  // Every representation renders a defined unavailable document.
  const canonical = h.store.canonical(v);
  assert.strictEqual(canonical.snapshot_id, null);
  assert.strictEqual(canonical.row_count, 0);
  assert.deepStrictEqual(canonical.rows, []);
  assert.strictEqual(canonical.error.code, "snapshot_unavailable");
  assert.ok(canonical.issues.includes("build_failed"));
  assert.match(canonical.warnings[0], /first-build failure/);
  assert.strictEqual(canonical.producer_status, "error");
  const compact = h.store.compact(v);
  assert.strictEqual(compact.format, "briefing_compact_v1");
  assert.deepStrictEqual(compact.rows, []);
  assert.strictEqual(compact.error.code, "snapshot_unavailable");
  assert.match(h.store.csv(v), /^generated_at_utc,/);
  assert.strictEqual(h.store.csv(v).split("\n").length, 1, "header-only CSV");
  assert.match(h.store.html(v), /snapshot_unavailable/);
  assert.match(h.store.html(v), /<dt>producer_status<\/dt><dd>error<\/dd>/);
  const health = h.store.healthOf(v);
  assert.strictEqual(health.status, "unavailable");
  assert.strictEqual(health.producer_status, "error");
  assert.strictEqual(health.producer.build_errors, 1);
  assert.strictEqual(health.producer.last_error.message, "first-build failure");
  assert.strictEqual(health.snapshot_id, null);

  // Repeated failure keeps counting; still no entry, still error. Every
  // ensure() on a missing entry is itself an attempt (the tick, then the
  // health call's own view), so the count reads 3 here.
  h.clock.now += 60000;
  h.store.materialize("xyz");
  assert.strictEqual(h.store.get("xyz"), null);
  assert.strictEqual(h.store.health("xyz").producer.build_errors, 3);
  assert.strictEqual(h.store.producerStatus("xyz"), "error");

  // Recovery: the first success creates seq 1 and clears the active error.
  // (The loop's stamps move with the clock, as a live loop's would.)
  fail = false;
  h.clock.now += 60000;
  state.lastMids = h.clock.now - 1000;
  state.lastCandles = h.clock.now - 2000;
  state.lastContexts = h.clock.now - 3000;
  const entry = h.store.materialize("xyz");
  assert.strictEqual(entry.snapshot_id, "b00t1d00-0000001");
  const after = h.store.view("xyz");
  assert.strictEqual(after.served.producer_status, "ok");
  assert.strictEqual(after.usable, true);
  assert.strictEqual(h.store.healthOf(after).status, "ok");
  assert.strictEqual(h.store.healthOf(after).producer.build_errors, 3, "history, not state");
});

test("store: with no entry and no error the view is unavailable/idle, and health says so", function () {
  const h = makeStore(stateAt(T0), { build: function () { throw new Error("x"); } });
  // producerStatus before any attempt: idle (loaded, nothing tried yet)
  assert.strictEqual(h.store.producerStatus("xyz"), "idle");
  const v = h.store.view("xyz");        // this attempt fails -> error
  assert.strictEqual(v.served.producer_status, "error");
  assert.strictEqual(h.store.healthStatus(v), "unavailable");
});

// --- audit 2026-09-13 F2: one view per response -----------------------------

test("store: healthOf(view) derives the body from the SAME view the headers use - one clock, one ensure", function () {
  let calls = 0;
  const state = stateAt(T0);
  const h = makeStore(state, {
    build: function (s, tfs, uni, at) {
      calls++;
      if (calls === 1) throw new Error("once");
      return require("../src/briefing.js").buildBriefingSnapshot(s, tfs, uni, at);
    }
  });
  const v = h.store.view("xyz");             // the one ensure(): fails
  const health = h.store.healthOf(v);        // no second ensure()
  assert.strictEqual(calls, 1, "healthOf never materializes on its own");
  assert.strictEqual(health.snapshot_id, v.served.snapshot_id);
  assert.strictEqual(health.row_count, v.snapshot.row_count);
  assert.strictEqual(health.is_stale, v.served.is_stale);
  assert.strictEqual(health.served_at_utc, v.served.served_at_utc);
});
