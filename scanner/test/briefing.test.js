"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  BRIEFING_CSV_FIELDS,
  BRIEFING_COMPACT_ROW_FIELDS,
  COMPACT_NOTABLE_ITEM_LIMIT,
  STALE_AFTER_SECONDS,
  buildBriefingSnapshot,
  buildCompactBriefingSnapshot,
  serializeBriefingCsv,
  serializeBriefingHtml,
  previousUsCashClose
} = require("../src/briefing.js");

const HOUR = 3600000;
const DAY = 86400000;
const NOW = Date.UTC(2026, 6, 22, 12, 30); // Wed Jul 22, 08:30 New York (EDT)

function analysis(dir) {
  return {
    types: ["2D", "1", "2U"],
    formingType: "2U",
    formingDir: dir || "up",
    completed: null,
    setups: [],
    invalidated: false,
    live: []
  };
}

function hourlyBars(end, count, base) {
  const out = [];
  for (let i = count; i > 0; i--) {
    const T = end - (i - 1) * HOUR - 1;
    out.push({ t: T - HOUR + 1, T: T, o: base - 1, h: base + 1, l: base - 2, c: base, v: 10 });
  }
  return out;
}

function stateAt(now) {
  const close = previousUsCashClose(now);
  const reference = hourlyBars(close.target_ms, 100, 100);
  const analysisBars = reference.slice(-30);
  const dayStart = Date.UTC(2026, 6, 22);
  const coin = {
    name: "xyz:NVDA",
    sym: "NVDA",
    uni: "xyz",
    mid: 110,
    hist: [],
    ctx: {
      markPx: "110",
      prevDayPx: "108",
      dayNtlVlm: "123456",
      funding: "0.0001",
      premium: "0.0002",
      openInterest: "1000"
    },
    tf: {
      "1h": {
        closed: analysisBars,
        referenceClosed: reference,
        forming: { t: now - 30 * 60000, T: now + 30 * 60000, o: 109, h: 111, l: 108, c: 110, v: 5 },
        an: analysis("up")
      },
      "1d": {
        closed: [{ t: dayStart - DAY, T: dayStart - 1, o: 100, h: 108, l: 99, c: 107, v: 100 }],
        forming: { t: dayStart, T: dayStart + DAY - 1, o: 105, h: 112, l: 104, c: 110, v: 50 },
        an: analysis("up")
      }
    }
  };
  return {
    order: [coin.name],
    coins: { "xyz:NVDA": coin },
    universes: ["xyz"],
    expectedMarketsByUni: { xyz: [coin.name] },
    loaded: true,
    lastMids: now - 5000,
    lastCandles: now - 60000,
    lastContexts: now - 30000
  };
}

test("previous US cash close is New York/DST/weekend/holiday aware", function () {
  const weekday = previousUsCashClose(NOW);
  assert.strictEqual(weekday.target_ms, Date.UTC(2026, 6, 21, 20));
  assert.strictEqual(weekday.kind, "regular_close");

  const monday = previousUsCashClose(Date.UTC(2026, 6, 20, 12, 30));
  assert.strictEqual(monday.target_ms, Date.UTC(2026, 6, 17, 20), "weekend -> Friday 16:00 EDT");

  // CORRECTED with the calendar rule (review): 2026-07-04 is a Saturday,
  // so 2026-07-03 is the observed FULL holiday and July 2 is a normal 16:00
  // session - this assertion previously pinned July 2 as a 13:00 early close.
  const afterIndependence = previousUsCashClose(Date.UTC(2026, 6, 6, 12, 30));
  assert.strictEqual(afterIndependence.target_ms, Date.UTC(2026, 6, 2, 20));
  assert.strictEqual(afterIndependence.kind, "regular_close");

  const standardTime = previousUsCashClose(Date.UTC(2026, 0, 6, 13, 30));
  assert.strictEqual(standardTime.target_ms, Date.UTC(2026, 0, 5, 21), "16:00 EST = 21:00 UTC");

  const afterSpringDst = previousUsCashClose(Date.UTC(2026, 2, 9, 13, 30));
  assert.strictEqual(afterSpringDst.target_ms, Date.UTC(2026, 2, 6, 21),
    "Friday before the DST transition closes at 21:00 UTC");

  const afterFallDst = previousUsCashClose(Date.UTC(2026, 10, 2, 14, 30));
  assert.strictEqual(afterFallDst.target_ms, Date.UTC(2026, 9, 30, 20),
    "Friday before the DST transition closes at 20:00 UTC");

  const blackFridayAfterClose = previousUsCashClose(Date.UTC(2026, 10, 27, 18, 30));
  assert.strictEqual(blackFridayAfterClose.target_ms, Date.UTC(2026, 10, 27, 18));
  assert.strictEqual(blackFridayAfterClose.kind, "scheduled_early_close");
});

test("briefing snapshot computes explicit return windows and freshness metadata", function () {
  const snapshot = buildBriefingSnapshot(stateAt(NOW), ["1h"], "xyz", NOW);
  assert.strictEqual(snapshot.schema_version, "1.0");
  assert.strictEqual(snapshot.universe, "xyz");
  assert.strictEqual(snapshot.row_count, 1);
  assert.strictEqual(snapshot.expected_row_count, 1);
  assert.strictEqual(snapshot.data_complete, true);
  assert.strictEqual(snapshot.is_stale, false);
  assert.strictEqual(snapshot.stale_after_seconds, 900);
  assert.deepStrictEqual(snapshot.missing_symbols, []);
  assert.deepStrictEqual(snapshot.issues, []);
  assert.strictEqual(snapshot.score_policy, "experimental_low_weight");
  assert.strictEqual(snapshot.data_as_of_utc, new Date(NOW - 60000).toISOString());
  assert.deepStrictEqual(snapshot.field_coverage, {
    last: 1,
    utc_session_change_pct: 1,
    overnight_change_pct: 1,
    exchange_24h_change_pct: 1
  });

  const row = snapshot.rows[0];
  assert.strictEqual(row.last, 110);
  assert.strictEqual(row.utc_session_open, 105);
  assert.ok(Math.abs(row.utc_session_change_pct - (5 / 105 * 100)) < 1e-12);
  assert.strictEqual(row.prior_us_cash_close, 100);
  assert.strictEqual(row.prior_us_cash_close_target_utc, "2026-07-21T20:00:00.000Z");
  assert.strictEqual(row.prior_us_cash_close_lag_minutes, 0);
  assert.strictEqual(row.overnight_change_pct, 10);
  assert.strictEqual(row.exchange_24h_reference_price, 108);
  assert.ok(Math.abs(row.exchange_24h_change_pct - (2 / 108 * 100)) < 1e-12);
  assert.strictEqual(row.funding_hr_pct, 0.01);
  assert.strictEqual(row.timeframes["1d"].forming_type, "2U");
  assert.strictEqual(row["1d_seq"], "2D 1 2U | 2U*");
  assert.strictEqual(row.dwm_continuity_dir, null);
  BRIEFING_CSV_FIELDS.slice(6).forEach(function (field) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, field), "missing JSON row field " + field);
  });
  [
    "last", "utc_session_open", "utc_session_change_pct", "prior_us_cash_close",
    "overnight_change_pct", "exchange_24h_reference_price", "exchange_24h_change_pct",
    "exchange_24h_volume_usd", "funding_hr_pct", "score_beta", "score_v", "rvol_15m",
    "mom_5m_pct", "mom_15m_pct", "mom_30m_pct", "mom_1h_pct", "atr_14d_pct",
    "premium_pct", "open_interest_usd", "1d_change_pct"
  ].forEach(function (field) {
    assert.ok(row[field] === null || typeof row[field] === "number", field + " must be numeric or null");
  });
});

test("missing optional return anchors are explicit coverage warnings, not fabricated values", function () {
  const state = stateAt(NOW);
  state.coins["xyz:NVDA"].tf["1h"].referenceClosed = [];
  state.coins["xyz:NVDA"].tf["1h"].closed = [];
  state.coins["xyz:NVDA"].tf["1d"].forming.t -= DAY; // stale across the UTC roll
  const snapshot = buildBriefingSnapshot(state, ["1h"], "xyz", NOW);
  assert.strictEqual(snapshot.rows[0].utc_session_open, null);
  assert.strictEqual(snapshot.rows[0].utc_session_change_pct, null);
  assert.strictEqual(snapshot.rows[0].prior_us_cash_close, null);
  assert.strictEqual(snapshot.rows[0].overnight_change_pct, null);
  assert.strictEqual(snapshot.field_coverage.utc_session_change_pct, 0);
  assert.strictEqual(snapshot.field_coverage.overnight_change_pct, 0);
  assert.ok(snapshot.warnings.some(function (w) { return w.indexOf("overnight_change_pct") >= 0; }));
});

test("staleness and expected-universe gaps are explicit without removing available rows", function () {
  const staleState = stateAt(NOW);
  const staleStamp = NOW - STALE_AFTER_SECONDS * 1000 - 1;
  staleState.lastMids = staleStamp;
  staleState.lastCandles = staleStamp;
  staleState.lastContexts = staleStamp;
  const stale = buildBriefingSnapshot(staleState, ["1h"], "xyz", NOW);
  assert.strictEqual(stale.row_count, 1);
  assert.strictEqual(stale.is_stale, true);
  assert.strictEqual(stale.data_complete, false);
  assert.ok(stale.warnings.some(function (warning) { return /^Snapshot is \d+ seconds old$/.test(warning); }));

  const partialState = stateAt(NOW);
  partialState.expectedMarketsByUni.xyz.push("xyz:MSFT");
  const partial = buildBriefingSnapshot(partialState, ["1h"], "xyz", NOW);
  assert.strictEqual(partial.row_count, 1);
  assert.strictEqual(partial.expected_row_count, 2);
  assert.strictEqual(partial.data_complete, false);
  assert.deepStrictEqual(partial.missing_symbols, ["MSFT"]);
  assert.ok(partial.issues.includes("expected_symbols_missing"));
});

test("non-finite numeric source values and JSON values serialize as null", function () {
  const state = stateAt(NOW);
  state.coins["xyz:NVDA"].ctx.dayNtlVlm = "Infinity";
  state.coins["xyz:NVDA"].ctx.funding = "NaN";
  state.coins["xyz:NVDA"].ctx.premium = "Infinity";
  const snapshot = buildBriefingSnapshot(state, ["1h"], "xyz", NOW);
  assert.strictEqual(snapshot.rows[0].exchange_24h_volume_usd, null);
  assert.strictEqual(snapshot.rows[0].funding_hr_pct, null);
  assert.strictEqual(snapshot.rows[0].premium_pct, null);
  snapshot.rows[0].mom_5m_pct = Infinity;
  snapshot.rows[0].mom_15m_pct = NaN;
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("Infinity"));
  assert.ok(!serialized.includes("NaN"));
  const parsed = JSON.parse(serialized);
  assert.strictEqual(parsed.rows[0].mom_5m_pct, null);
  assert.strictEqual(parsed.rows[0].mom_15m_pct, null);
});

test("snapshot assembly is read-only against the scanner state", function () {
  const state = stateAt(NOW);
  const before = JSON.stringify(state);
  buildBriefingSnapshot(state, ["1h"], "xyz", NOW);
  assert.strictEqual(JSON.stringify(state), before);
});

test("CSV is serialized from the same flat snapshot rows and preserves all 49 columns", function () {
  const snapshot = buildBriefingSnapshot(stateAt(NOW), ["1h"], "xyz", NOW);
  const csv = serializeBriefingCsv(snapshot);
  const lines = csv.split("\n");
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines[0].split(","), BRIEFING_CSV_FIELDS);
  assert.strictEqual(BRIEFING_CSV_FIELDS.length, 49);
  assert.ok(lines[1].includes("experimental_low_weight"));

  const values = lines[1].split(",");
  const record = {};
  BRIEFING_CSV_FIELDS.forEach(function (field, index) { record[field] = values[index]; });
  const row = snapshot.rows[0];
  assert.strictEqual(record.symbol, row.symbol);
  assert.strictEqual(Number(record.last), row.last);
  assert.strictEqual(record["1d_seq"], row["1d_seq"]);
  assert.strictEqual(Number(record["1d_change_pct"]), row["1d_change_pct"]);
  assert.deepStrictEqual(new Set([record.symbol]), new Set(snapshot.rows.map(function (item) {
    return item.symbol;
  })));

  snapshot.rows[0].market = "=unsafe";
  const safeCsv = serializeBriefingCsv(snapshot);
  assert.ok(safeCsv.split("\n")[1].includes("'=unsafe"), "formula-like string is neutralized");
});

test("compact snapshot is a loss-aware projection of every canonical row", function () {
  const snapshot = buildBriefingSnapshot(stateAt(NOW), ["1h"], "xyz", NOW);
  snapshot.rows[0].live_signals = ["1h 2U", "4h 2U", "1d 2U", "1w 2U"];
  snapshot.rows[0].setups = ["15m setup", "1h setup"];
  const before = JSON.stringify(snapshot);
  const compact = buildCompactBriefingSnapshot(snapshot);
  assert.strictEqual(JSON.stringify(snapshot), before, "projection must not mutate the canonical snapshot");
  assert.strictEqual(compact.schema_version, snapshot.schema_version);
  assert.strictEqual(compact.format, "briefing_compact_v1");
  assert.strictEqual(compact.row_encoding, "array");
  assert.deepStrictEqual(compact.row_fields, BRIEFING_COMPACT_ROW_FIELDS);
  assert.strictEqual(compact.row_count, compact.rows.length);
  assert.strictEqual(compact.rows.length, snapshot.rows.length);

  const values = {};
  compact.row_fields.forEach(function (field, index) {
    values[field] = compact.rows[0][index];
  });
  BRIEFING_COMPACT_ROW_FIELDS.forEach(function (field) {
    if (["live_signal_count", "notable_live_signals", "setup_count", "notable_setups"].includes(field)) return;
    assert.deepStrictEqual(values[field], snapshot.rows[0][field], field);
  });
  assert.strictEqual(values.live_signal_count, 4);
  assert.deepStrictEqual(values.notable_live_signals,
    snapshot.rows[0].live_signals.slice(0, COMPACT_NOTABLE_ITEM_LIMIT));
  assert.strictEqual(values.setup_count, 2);
  assert.deepStrictEqual(values.notable_setups, snapshot.rows[0].setups);
  assert.strictEqual(compact.details_truncated, true);
});

test("compact JSON keeps 100 rows below the adapter compatibility budget", function () {
  const snapshot = buildBriefingSnapshot(stateAt(NOW), ["1h"], "xyz", NOW);
  const template = snapshot.rows[0];
  snapshot.rows = Array.from({ length: 100 }, function (_, index) {
    const suffix = String(index).padStart(3, "0");
    return Object.assign({}, template, {
      market: "xyz:SYM" + suffix,
      symbol: "SYM" + suffix,
      live_signals: Array.from({ length: 7 }, function (unused, item) {
        return "1h signal " + item;
      }),
      setups: Array.from({ length: 7 }, function (unused, item) {
        return "4h setup " + item;
      })
    });
  });
  snapshot.row_count = snapshot.rows.length;
  snapshot.expected_row_count = snapshot.rows.length;
  const compact = buildCompactBriefingSnapshot(snapshot);
  const body = JSON.stringify(compact);
  assert.strictEqual(compact.row_count, 100);
  assert.strictEqual(new Set(compact.rows.map(function (row) {
    return row[compact.row_fields.indexOf("symbol")];
  })).size, 100);
  assert.ok(Buffer.byteLength(body, "utf8") < 64 * 1024,
    "compact JSON should remain below 64 KiB for 100 representative rows");
});

test("HTML compatibility view is server-rendered, escaped, and includes all compact rows", function () {
  const snapshot = buildBriefingSnapshot(stateAt(NOW), ["1h"], "xyz", NOW);
  snapshot.warnings = ["Unsafe <tag> & warning"];
  snapshot.rows[0].live_signals = ["<script>alert(1)</script>"];
  const compact = buildCompactBriefingSnapshot(snapshot);
  const html = serializeBriefingHtml(compact);
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /Unsafe &lt;tag&gt; &amp; warning/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /id="briefing-data"/);
  assert.match(html, /\bsymbol\tlast\tutc_session_change_pct\b/);
  assert.match(html, /\bNVDA\t110\t/);
});
