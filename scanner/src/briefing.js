"use strict";

// Read-only premarket briefing snapshot. JSON and CSV both originate from the
// same normalized object so the scheduled consumer and the manual download
// cannot drift. This module does not fetch: it only reads the worker's current
// in-memory state.

const { buildApiState, utcSessionDaily } = require("./apistate.js");
// US cash-close calendar + prior-close reference. Lived here until
// /api/state grew `overnight_change_pct`; both surfaces now read the one
// implementation. `previousUsCashClose` is re-exported below so the
// briefing's published surface is unchanged.
const {
  finite, iso, pct, previousUsCashClose, findPriorClose, overnightChangePct
} = require("./cash_close.js");

const DEFAULT_UNIVERSE = "xyz";
const SCHEMA_VERSION = "1.0";
const SCORE_POLICY = "experimental_low_weight";
const STALE_AFTER_SECONDS = 900;
const MINUTE_MS = 60000;
const MAX_AGES = {
  mids: 30000,
  candles: 15 * MINUTE_MS,
  contexts: 3 * MINUTE_MS
};
const TF_IDS = ["15m", "30m", "1h", "4h", "1d", "1w", "1M"];
const SESSION_DEFINITIONS = {
  utc_session_change_pct: "Change from the 00:00 UTC session open",
  overnight_change_pct: "Change from the previous valid US regular-session cash close",
  exchange_24h_change_pct: "Exchange-defined or rolling 24-hour change; not the current UTC session return"
};
const BRIEFING_CSV_FIELDS = [
  "generated_at_utc", "data_as_of_utc", "row_count", "universe", "data_complete", "score_policy",
  "market", "symbol", "last",
  "utc_session_open", "utc_session_open_at_utc", "utc_session_change_pct",
  "prior_us_cash_close", "prior_us_cash_close_target_utc", "prior_us_cash_close_as_of_utc",
  "prior_us_cash_close_lag_minutes", "overnight_change_pct",
  "exchange_24h_reference_price", "exchange_24h_change_pct", "exchange_24h_volume_usd",
  "funding_hr_pct", "score_beta", "score_v", "rvol_15m",
  "mom_5m_pct", "mom_15m_pct", "mom_30m_pct", "mom_1h_pct",
  "atr_14d_pct", "premium_pct", "open_interest_usd", "ftfc", "dwm_continuity_dir",
  "15m_seq", "15m_change_pct", "30m_seq", "30m_change_pct",
  "1h_seq", "1h_change_pct", "4h_seq", "4h_change_pct",
  "1d_seq", "1d_change_pct", "1w_seq", "1w_change_pct",
  "1M_seq", "1M_change_pct", "live_signals", "setups"
];
const BRIEFING_COMPACT_ROW_FIELDS = [
  "market", "symbol", "last",
  "utc_session_change_pct", "overnight_change_pct", "exchange_24h_change_pct",
  "exchange_24h_volume_usd", "funding_hr_pct", "score_beta", "score_v",
  "rvol_15m", "mom_5m_pct", "mom_15m_pct", "mom_1h_pct", "atr_14d_pct",
  "premium_pct", "open_interest_usd", "ftfc", "dwm_continuity_dir",
  "prior_us_cash_close_lag_minutes",
  "15m_seq", "30m_seq", "1h_seq", "4h_seq", "1d_seq", "1w_seq", "1M_seq",
  "live_signal_count", "notable_live_signals", "setup_count", "notable_setups"
];
const BRIEFING_HTML_ROW_FIELDS = [
  "symbol", "last",
  "utc_session_change_pct", "overnight_change_pct", "exchange_24h_change_pct",
  "exchange_24h_volume_usd", "funding_hr_pct", "rvol_15m",
  "mom_5m_pct", "mom_15m_pct", "mom_1h_pct", "atr_14d_pct",
  "premium_pct", "open_interest_usd", "ftfc", "dwm_continuity_dir",
  "live_signal_count", "notable_live_signals", "setup_count", "notable_setups"
];
const COMPACT_NOTABLE_ITEM_LIMIT = 3;

function tfChange(rawCoin, id, last) {
  const slot = rawCoin && rawCoin.tf && rawCoin.tf[id];
  if (!slot || !slot.closed || !slot.closed.length) return null;
  const prior = slot.closed[slot.closed.length - 1];
  return pct(last, prior && prior.c);
}

function timeframeView(apiCoin, rawCoin) {
  const out = {};
  TF_IDS.forEach(function (id) {
    const tf = apiCoin.tf && apiCoin.tf[id];
    if (!tf) return;
    out[id] = {
      closed_types: Array.isArray(tf.types) ? tf.types.filter(Boolean).slice(-3) : [],
      forming_type: tf.formingType || null,
      forming_direction: tf.formingDir || null,
      change_pct: tfChange(rawCoin, id, apiCoin.mid)
    };
  });
  return out;
}

function timeframeSequence(tf) {
  if (!tf) return "";
  let text = (tf.closed_types || []).join(" ");
  if (tf.forming_type) text += (text ? " | " : "") + tf.forming_type + "*";
  return text;
}

function signalLists(apiCoin) {
  const live = [];
  const setups = [];
  TF_IDS.forEach(function (id) {
    const tf = apiCoin.tf && apiCoin.tf[id];
    if (!tf) return;
    (tf.live || []).forEach(function (sig) {
      live.push(id + " " + String(sig.name || "signal") + " " + String(sig.dir || ""));
    });
    (tf.setups || []).forEach(function (sig) {
      setups.push(id + " " + String(sig.name || "setup") + " " + String(sig.dir || ""));
    });
  });
  return { live: live, setups: setups };
}

function freshnessEntry(stamp, now, maxAge) {
  stamp = finite(stamp);
  const age = stamp === null || stamp <= 0 ? null : Math.max(0, now - stamp);
  return {
    as_of_utc: stamp === null ? null : iso(stamp),
    age_ms: age,
    max_age_ms: maxAge,
    fresh: age !== null && age <= maxAge
  };
}

function universeStamp(state, mapKey, fallbackKey, universe) {
  const map = state[mapKey];
  const scoped = map && finite(map[universe]);
  return scoped !== null && scoped > 0 ? scoped : state[fallbackKey];
}

// Staleness is a property of the DATA's age, not of when the snapshot object
// was assembled. A snapshot materialized fresh and served ten minutes later by
// a stalled producer has aged ten minutes, so the builder (materialization
// time) and the store (serve time) both go through these two functions - one
// rule, two clocks, no fork. Unknown age (no data_as_of) is stale, never
// assumed fresh.
function ageMsOf(dataAsOfMs, now) {
  return dataAsOfMs === null ? null : Math.max(0, now - dataAsOfMs);
}

function staleAtAgeMs(ageMs) {
  return ageMs === null || ageMs > STALE_AFTER_SECONDS * 1000;
}

function snapshotAgeSeconds(snapshot, now) {
  const asOf = snapshot && snapshot.data_as_of_utc ? Date.parse(snapshot.data_as_of_utc) : NaN;
  const ageMs = ageMsOf(Number.isFinite(asOf) ? asOf : null, now);
  return ageMs === null ? null : Math.round(ageMs / 1000);
}

function isStaleAt(snapshot, now) {
  const asOf = snapshot && snapshot.data_as_of_utc ? Date.parse(snapshot.data_as_of_utc) : NaN;
  return staleAtAgeMs(ageMsOf(Number.isFinite(asOf) ? asOf : null, now));
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  (values || []).forEach(function (value) {
    if (value === null || value === undefined) return;
    value = String(value);
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  });
  return out;
}

function symbolForMarket(state, market) {
  const coin = state.coins && state.coins[market];
  if (coin && coin.sym) return String(coin.sym);
  const parts = String(market || "").split(":");
  return parts[parts.length - 1] || String(market || "");
}

function expectedMarkets(state, universe) {
  const byUniverse = state.expectedMarketsByUni;
  if (byUniverse
      && Object.prototype.hasOwnProperty.call(byUniverse, universe)
      && Array.isArray(byUniverse[universe])) {
    return uniqueStrings(byUniverse[universe]);
  }
  return uniqueStrings((state.order || []).filter(function (market) {
    const coin = state.coins && state.coins[market];
    return coin && coin.uni === universe;
  }));
}

function buildBriefingSnapshot(state, ftfcTfs, universe, now) {
  now = finite(now);
  if (now === null) now = Date.now();
  universe = universe || DEFAULT_UNIVERSE;
  const available = Array.isArray(state.universes) ? state.universes.slice() : [];
  const tracked = available.indexOf(universe) >= 0;
  const api = buildApiState(state, ftfcTfs, universe, now);
  const close = previousUsCashClose(now);

  const rows = [];
  const duplicateSymbols = [];
  const seenSymbols = new Set();
  api.coins.forEach(function (coin) {
    const raw = state.coins[coin.name] || {};
    // Do not mislabel a briefly stale pre-roll daily as the new UTC session.
    // The guard lives in apistate so /api/state's chgUtc and this contract
    // cannot drift apart; behavior here is unchanged.
    const daily = utcSessionDaily(raw, now);
    const utcOpen = daily ? finite(daily.o) : null;
    const prior = findPriorClose(raw, close);
    const ctx = raw.ctx || {};
    const exchangeReference = finite(ctx.prevDayPx);
    const lists = signalLists(coin);
    const timeframes = timeframeView(coin, raw);
    const symbol = String(coin.sym || symbolForMarket(state, coin.name));
    if (seenSymbols.has(symbol)) {
      duplicateSymbols.push(symbol);
      return;
    }
    seenSymbols.add(symbol);
    rows.push({
      market: coin.name,
      symbol: symbol,
      last: finite(coin.mid),
      utc_session_open: utcOpen,
      utc_session_open_at_utc: daily ? iso(finite(daily.t)) : null,
      utc_session_change_pct: pct(coin.mid, utcOpen),
      prior_us_cash_close: prior ? prior.price : null,
      prior_us_cash_close_target_utc: close ? close.target_utc : null,
      prior_us_cash_close_as_of_utc: prior ? prior.at_utc : null,
      prior_us_cash_close_lag_minutes: prior ? prior.lag_minutes : null,
      // Shared with /api/state's row field of the same name - one helper,
      // so the briefing and the live payload cannot report different
      // overnight moves for the same coin at the same instant.
      overnight_change_pct: overnightChangePct(prior, coin.mid),
      exchange_24h_reference_price: exchangeReference,
      exchange_24h_change_pct: pct(coin.mid, exchangeReference),
      exchange_24h_volume_usd: finite(ctx.dayNtlVlm),
      funding_hr_pct: finite(ctx.funding) === null ? null : finite(ctx.funding) * 100,
      score_beta: finite(coin.score),
      score_v: api.score_v,
      rvol_15m: finite(coin.rvol),
      mom_5m_pct: finite(coin.mom && coin.mom.r5),
      mom_15m_pct: finite(coin.mom && coin.mom.r15),
      mom_30m_pct: finite(coin.mom && coin.mom.r30),
      mom_1h_pct: finite(coin.mom && coin.mom.r60),
      atr_14d_pct: finite(coin.atr),
      premium_pct: finite(coin.premium) === null ? null : finite(coin.premium) * 100,
      open_interest_usd: finite(coin.oiUsd),
      ftfc: coin.ftfc || null,
      dwm_continuity_dir: coin.dwmContinuity && coin.dwmContinuity.dir
        ? String(coin.dwmContinuity.dir) : null,
      "15m_seq": timeframeSequence(timeframes["15m"]),
      "15m_change_pct": timeframes["15m"] ? finite(timeframes["15m"].change_pct) : null,
      "30m_seq": timeframeSequence(timeframes["30m"]),
      "30m_change_pct": timeframes["30m"] ? finite(timeframes["30m"].change_pct) : null,
      "1h_seq": timeframeSequence(timeframes["1h"]),
      "1h_change_pct": timeframes["1h"] ? finite(timeframes["1h"].change_pct) : null,
      "4h_seq": timeframeSequence(timeframes["4h"]),
      "4h_change_pct": timeframes["4h"] ? finite(timeframes["4h"].change_pct) : null,
      "1d_seq": timeframeSequence(timeframes["1d"]),
      "1d_change_pct": timeframes["1d"] ? finite(timeframes["1d"].change_pct) : null,
      "1w_seq": timeframeSequence(timeframes["1w"]),
      "1w_change_pct": timeframes["1w"] ? finite(timeframes["1w"].change_pct) : null,
      "1M_seq": timeframeSequence(timeframes["1M"]),
      "1M_change_pct": timeframes["1M"] ? finite(timeframes["1M"].change_pct) : null,
      live_signals: lists.live,
      setups: lists.setups,
      // Additive detail retained for existing JSON consumers. The flat fields
      // above are the exact row values consumed by the 49-column CSV.
      universe: coin.uni,
      dwm_continuity: coin.dwmContinuity,
      timeframes: timeframes
    });
  });

  const coverage = {};
  ["last", "utc_session_change_pct", "overnight_change_pct", "exchange_24h_change_pct"].forEach(function (field) {
    coverage[field] = rows.filter(function (row) { return finite(row[field]) !== null; }).length;
  });

  const midStamp = universeStamp(state, "lastMidsByUni", "lastMids", universe);
  const candleStamp = universeStamp(state, "lastCandlesByUni", "lastCandles", universe);
  const contextStamp = universeStamp(state, "lastContextsByUni", "lastContexts", universe);
  const freshness = {
    mids: freshnessEntry(midStamp, now, MAX_AGES.mids),
    candles: freshnessEntry(candleStamp, now, MAX_AGES.candles),
    contexts: freshnessEntry(contextStamp, now, MAX_AGES.contexts)
  };
  const stamps = [midStamp, candleStamp, contextStamp]
    .map(finite).filter(function (v) { return v !== null && v > 0; });
  const dataAsOf = rows.length && stamps.length === 3 ? Math.min.apply(Math, stamps) : null;
  const snapshotAgeMs = ageMsOf(dataAsOf, now);
  const isStale = staleAtAgeMs(snapshotAgeMs);
  const expectedSymbols = uniqueStrings(expectedMarkets(state, universe).map(function (market) {
    return symbolForMarket(state, market);
  }));
  const actualSymbols = rows.map(function (row) { return row.symbol; });
  const actualSet = new Set(actualSymbols);
  const expectedSet = new Set(expectedSymbols);
  const missingSymbols = expectedSymbols.filter(function (symbol) { return !actualSet.has(symbol); });
  const unexpectedSymbols = actualSymbols.filter(function (symbol) { return !expectedSet.has(symbol); });
  const issues = [];
  const warnings = [];
  if (!tracked) issues.push("universe_not_tracked");
  if (!state.loaded) issues.push("worker_loading");
  if (!rows.length) issues.push("no_rows");
  if (missingSymbols.length) issues.push("expected_symbols_missing");
  if (unexpectedSymbols.length) issues.push("unexpected_symbols_present");
  if (duplicateSymbols.length) issues.push("duplicate_symbols");
  if (rows.length !== expectedSymbols.length) issues.push("expected_row_count_mismatch");
  if (!freshness.mids.fresh) issues.push("mids_stale_or_missing");
  if (!freshness.candles.fresh) issues.push("candles_stale_or_missing");
  if (!freshness.contexts.fresh) issues.push("contexts_stale_or_missing");
  if (coverage.last !== rows.length) issues.push("last_price_missing");
  if (isStale && rows.length) {
    warnings.push(snapshotAgeMs === null
      ? "Snapshot data timestamp is unavailable"
      : "Snapshot is " + Math.ceil(snapshotAgeMs / 1000) + " seconds old");
  }
  if (!rows.length) warnings.push("No completed scanner snapshot is currently available");
  if (missingSymbols.length) {
    warnings.push(missingSymbols.length + " expected symbol(s) are missing");
  }
  if (unexpectedSymbols.length) {
    warnings.push(unexpectedSymbols.length + " unexpected symbol(s) are present");
  }
  if (duplicateSymbols.length) {
    warnings.push(duplicateSymbols.length + " duplicate symbol row(s) were omitted");
  }
  ["utc_session_change_pct", "overnight_change_pct", "exchange_24h_change_pct"].forEach(function (field) {
    if (coverage[field] !== rows.length) {
      warnings.push(field + " missing for " + (rows.length - coverage[field]) + " row(s)");
    }
  });

  const snapshot = {
    schema_version: SCHEMA_VERSION,
    generated_at_utc: iso(now),
    data_as_of_utc: iso(dataAsOf),
    universe: universe,
    available_universes: available,
    row_count: rows.length,
    expected_row_count: expectedSymbols.length,
    data_complete: issues.length === 0,
    is_stale: isStale,
    stale_after_seconds: STALE_AFTER_SECONDS,
    score_policy: SCORE_POLICY,
    issues: issues,
    warnings: warnings,
    missing_symbols: missingSymbols,
    unexpected_symbols: unexpectedSymbols,
    duplicate_symbols: uniqueStrings(duplicateSymbols),
    field_coverage: coverage,
    freshness: freshness,
    prior_us_cash_close_reference: close ? {
      target_utc: close.target_utc,
      local_date: close.local_date,
      local_time: close.local_time,
      kind: close.kind,
      time_zone: close.time_zone
    } : null,
    score_v: api.score_v,
    session_definitions: SESSION_DEFINITIONS,
    // Backward-compatible alias retained for the already-deployed JSON
    // consumer contract.
    return_definitions: {
      utc_session_change_pct: "last vs the current 1d candle open (00:00 UTC)",
      overnight_change_pct: "last vs the prior scheduled US equity cash close",
      exchange_24h_change_pct: "last vs Hyperliquid prevDayPx (exchange-defined window)"
    }
  };
  if (!rows.length) {
    snapshot.error = {
      code: "snapshot_unavailable",
      message: "The scanner has not produced a completed briefing snapshot"
    };
  }
  snapshot.rows = rows;
  return snapshot;
}

function hasUsableBriefingSnapshot(snapshot) {
  return Boolean(snapshot && Array.isArray(snapshot.rows) && snapshot.rows.length > 0);
}

function textList(value) {
  if (Array.isArray(value)) return value.join("; ");
  return value === null || value === undefined ? "" : String(value);
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && !Number.isFinite(value)) return "";
  let text = String(value);
  // Prevent spreadsheet formula execution for string-valued market metadata.
  if (typeof value === "string" && /^[=+\-@]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function serializeBriefingCsv(snapshot) {
  const lines = [BRIEFING_CSV_FIELDS.join(",")];
  snapshot.rows.forEach(function (row) {
    const values = [
      snapshot.generated_at_utc, snapshot.data_as_of_utc, snapshot.row_count, snapshot.universe,
      snapshot.data_complete, snapshot.score_policy,
      row.market, row.symbol, row.last,
      row.utc_session_open, row.utc_session_open_at_utc, row.utc_session_change_pct,
      row.prior_us_cash_close, row.prior_us_cash_close_target_utc, row.prior_us_cash_close_as_of_utc,
      row.prior_us_cash_close_lag_minutes, row.overnight_change_pct,
      row.exchange_24h_reference_price, row.exchange_24h_change_pct, row.exchange_24h_volume_usd,
      row.funding_hr_pct, row.score_beta, row.score_v, row.rvol_15m,
      row.mom_5m_pct, row.mom_15m_pct, row.mom_30m_pct, row.mom_1h_pct,
      row.atr_14d_pct, row.premium_pct, row.open_interest_usd, row.ftfc,
      row.dwm_continuity_dir,
      row["15m_seq"], row["15m_change_pct"],
      row["30m_seq"], row["30m_change_pct"],
      row["1h_seq"], row["1h_change_pct"],
      row["4h_seq"], row["4h_change_pct"],
      row["1d_seq"], row["1d_change_pct"],
      row["1w_seq"], row["1w_change_pct"],
      row["1M_seq"], row["1M_change_pct"],
      textList(row.live_signals), textList(row.setups)
    ];
    lines.push(values.map(csvCell).join(","));
  });
  return lines.join("\n");
}

function compactList(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

// Scheduled-task browsing adapters can withhold large raw API bodies. This is
// a loss-aware projection of the canonical normalized snapshot: every market
// row remains present, repeated object keys become one row_fields array, and
// verbose signal/setup lists carry exact counts plus their first few items.
// No scanner, STRAT, score, return, or completeness calculation lives here.
function buildCompactBriefingSnapshot(snapshot) {
  const compact = {
    schema_version: snapshot.schema_version,
    format: "briefing_compact_v1",
    row_encoding: "array",
    generated_at_utc: snapshot.generated_at_utc,
    data_as_of_utc: snapshot.data_as_of_utc,
    universe: snapshot.universe,
    row_count: snapshot.row_count,
    expected_row_count: snapshot.expected_row_count,
    data_complete: snapshot.data_complete,
    is_stale: snapshot.is_stale,
    stale_after_seconds: snapshot.stale_after_seconds,
    score_policy: snapshot.score_policy,
    score_v: snapshot.score_v,
    issues: Array.isArray(snapshot.issues) ? snapshot.issues.slice() : [],
    warnings: Array.isArray(snapshot.warnings) ? snapshot.warnings.slice() : [],
    missing_symbols: Array.isArray(snapshot.missing_symbols) ? snapshot.missing_symbols.slice() : [],
    unexpected_symbols: Array.isArray(snapshot.unexpected_symbols)
      ? snapshot.unexpected_symbols.slice() : [],
    duplicate_symbols: Array.isArray(snapshot.duplicate_symbols)
      ? snapshot.duplicate_symbols.slice() : [],
    field_coverage: Object.assign({}, snapshot.field_coverage || {}),
    freshness: Object.assign({}, snapshot.freshness || {}),
    prior_us_cash_close_reference: snapshot.prior_us_cash_close_reference
      ? Object.assign({}, snapshot.prior_us_cash_close_reference) : null,
    session_definitions: Object.assign({}, snapshot.session_definitions || {}),
    row_fields: BRIEFING_COMPACT_ROW_FIELDS.slice(),
    notable_items_per_row_limit: COMPACT_NOTABLE_ITEM_LIMIT,
    details_truncated: false,
    rows: []
  };

  // Identity and serve-time fields (additive, briefing_store): present only
  // when the snapshot came through the store, so a bare builder output still
  // projects byte-for-byte as before.
  ["snapshot_id", "age_seconds", "served_at_utc", "producer_status"].forEach(function (field) {
    if (snapshot[field] !== undefined) compact[field] = snapshot[field];
  });
  if (snapshot.error) compact.error = Object.assign({}, snapshot.error);
  (snapshot.rows || []).forEach(function (row) {
    const live = compactList(row.live_signals);
    const setups = compactList(row.setups);
    if (live.length > COMPACT_NOTABLE_ITEM_LIMIT || setups.length > COMPACT_NOTABLE_ITEM_LIMIT) {
      compact.details_truncated = true;
    }
    compact.rows.push(BRIEFING_COMPACT_ROW_FIELDS.map(function (field) {
      if (field === "live_signal_count") return live.length;
      if (field === "notable_live_signals") return live.slice(0, COMPACT_NOTABLE_ITEM_LIMIT);
      if (field === "setup_count") return setups.length;
      if (field === "notable_setups") return setups.slice(0, COMPACT_NOTABLE_ITEM_LIMIT);
      return row[field] === undefined ? null : row[field];
    }));
  });
  return compact;
}

function htmlEscape(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlText(value) {
  const text = Array.isArray(value) ? value.join("; ")
    : (value === null || value === undefined ? "" : String(value));
  return htmlEscape(text.replace(/[\t\r\n]+/g, " "));
}

function htmlList(values, emptyText) {
  if (!Array.isArray(values) || !values.length) {
    return "<li>" + htmlEscape(emptyText) + "</li>";
  }
  return values.map(function (value) {
    return "<li>" + htmlEscape(value) + "</li>";
  }).join("");
}

// HTML compatibility view for browsing agents that reject JSON/CSV response
// bodies. The tab-separated data block is server-rendered, script-free, and
// generated only from buildCompactBriefingSnapshot().
function serializeBriefingHtml(compact) {
  const indexes = {};
  (compact.row_fields || []).forEach(function (field, index) { indexes[field] = index; });
  const header = BRIEFING_HTML_ROW_FIELDS.join("\t");
  const rows = (compact.rows || []).map(function (row) {
    return BRIEFING_HTML_ROW_FIELDS.map(function (field) {
      const index = indexes[field];
      return htmlText(index === undefined ? null : row[index]);
    }).join("\t");
  });
  const definitions = Object.keys(compact.session_definitions || {}).map(function (field) {
    return "<dt>" + htmlEscape(field) + "</dt><dd>"
      + htmlEscape(compact.session_definitions[field]) + "</dd>";
  }).join("");
  const error = compact.error
    ? "<h2>Error</h2><p><strong>" + htmlEscape(compact.error.code)
      + "</strong>: " + htmlEscape(compact.error.message) + "</p>"
    : "";
  const body = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="robots" content="noindex,nofollow">',
    "<title>HIP-3 compact briefing snapshot</title>",
    "</head>",
    "<body>",
    "<h1>HIP-3 compact briefing snapshot</h1>",
    "<p>Server-rendered compatibility view. No client-side JavaScript is required. "
      + '<a href="/api/briefing/latest.compact.json">Compact JSON</a> | '
      + '<a href="/api/briefing/latest.json">Canonical JSON</a> | '
      + '<a href="/api/briefing/latest.csv">Canonical CSV</a></p>',
    error,
    "<h2>Snapshot metadata</h2>",
    "<dl>",
    "<dt>schema_version</dt><dd>" + htmlEscape(compact.schema_version) + "</dd>",
    "<dt>format</dt><dd>" + htmlEscape(compact.format) + "</dd>",
    // Identity + serve-time fields (briefing_store). A scheduled-task
    // browsing adapter may hide response headers, so the same values the
    // X-Snapshot-ID / X-Age-Seconds / X-Producer-Status headers carry are
    // rendered here. Empty when the view was built without the store.
    "<dt>snapshot_id</dt><dd>" + htmlEscape(compact.snapshot_id) + "</dd>",
    "<dt>served_at_utc</dt><dd>" + htmlEscape(compact.served_at_utc) + "</dd>",
    "<dt>age_seconds</dt><dd>" + htmlEscape(compact.age_seconds) + "</dd>",
    "<dt>producer_status</dt><dd>" + htmlEscape(compact.producer_status) + "</dd>",
    "<dt>generated_at_utc</dt><dd>" + htmlEscape(compact.generated_at_utc) + "</dd>",
    "<dt>data_as_of_utc</dt><dd>" + htmlEscape(compact.data_as_of_utc) + "</dd>",
    "<dt>universe</dt><dd>" + htmlEscape(compact.universe) + "</dd>",
    "<dt>row_count</dt><dd>" + htmlEscape(compact.row_count) + "</dd>",
    "<dt>expected_row_count</dt><dd>" + htmlEscape(compact.expected_row_count) + "</dd>",
    "<dt>data_complete</dt><dd>" + htmlEscape(compact.data_complete) + "</dd>",
    "<dt>is_stale</dt><dd>" + htmlEscape(compact.is_stale) + "</dd>",
    "<dt>stale_after_seconds</dt><dd>" + htmlEscape(compact.stale_after_seconds) + "</dd>",
    "<dt>score_policy</dt><dd>" + htmlEscape(compact.score_policy) + "</dd>",
    "<dt>missing_symbols</dt><dd>" + htmlText(compact.missing_symbols) + "</dd>",
    "<dt>details_truncated</dt><dd>" + htmlEscape(compact.details_truncated) + "</dd>",
    "</dl>",
    "<h2>Warnings</h2><ul>",
    htmlList(compact.warnings, "None"),
    "</ul>",
    "<h2>Session definitions</h2><dl>",
    definitions,
    "</dl>",
    "<h2>Rows</h2>",
    "<p>All normalized symbols are included. Columns and rows below are tab-separated. "
      + "Signal and setup counts are exact; notable lists are capped at "
      + htmlEscape(compact.notable_items_per_row_limit) + " items per row.</p>",
    "<pre id=\"briefing-data\">",
    header,
    rows.length ? "\n" + rows.join("\n") : "",
    "</pre>",
    "</body>",
    "</html>"
  ];
  return body.join("");
}

function briefingFilename(snapshot) {
  const stamp = String(snapshot.generated_at_utc || "latest").replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return "hip3_briefing_" + snapshot.universe + "_" + stamp + ".csv";
}

module.exports = {
  DEFAULT_UNIVERSE,
  SCHEMA_VERSION,
  SCORE_POLICY,
  STALE_AFTER_SECONDS,
  SESSION_DEFINITIONS,
  BRIEFING_CSV_FIELDS,
  BRIEFING_COMPACT_ROW_FIELDS,
  BRIEFING_HTML_ROW_FIELDS,
  COMPACT_NOTABLE_ITEM_LIMIT,
  MAX_AGES,
  buildBriefingSnapshot,
  buildCompactBriefingSnapshot,
  hasUsableBriefingSnapshot,
  serializeBriefingCsv,
  serializeBriefingHtml,
  briefingFilename,
  snapshotAgeSeconds,
  isStaleAt,
  previousUsCashClose
};
