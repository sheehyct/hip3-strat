"use strict";

// Materialized briefing snapshots (2026-09-13).
//
// Before this module every briefing route rebuilt its snapshot from live loop
// state on each request. The four representations were built from ONE state
// read per request, but two REQUESTS seconds apart could legitimately differ
// (mids tick every 4s) and nothing identified which state a response came
// from - so a consumer cross-checking HTML against JSON had no way to tell
// "the loop moved between my two fetches" from "the server is inconsistent".
//
// Now a snapshot per universe is MATERIALIZED on a cadence from the same
// loop.state the routes used to read, stamped with an identity, and served
// unchanged by every representation until the next materialization:
//
//   snapshot_id = <boot hex>-<7-digit sequence>   opaque, monotonic per boot
//
// Identity and freshness are different things. The market data behind an id
// never changes, but its AGE keeps growing, so is_stale / age_seconds are
// recomputed at SERVE time from data_as_of_utc with the current clock (the
// one rule in briefing.js isStaleAt). A stopped producer therefore reads as
// stale without another materialization - a wrapper must never make old
// market data look fresh.
//
// What this module deliberately does NOT do (design decision 2026-09-13): it
// keeps no snapshot on disk and serves nothing across a restart. The no-data
// boot behavior (503 until the loop has rows) is unchanged; a persisted
// last-good fallback is a separate decision once the diagnostics here have
// shown whether the boot gap is a material problem. It also adds ZERO
// exchange demand - it reads state the loop already maintains.

const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const {
  SCHEMA_VERSION,
  SCORE_POLICY,
  STALE_AFTER_SECONDS,
  SESSION_DEFINITIONS,
  buildBriefingSnapshot,
  buildCompactBriefingSnapshot,
  hasUsableBriefingSnapshot,
  serializeBriefingCsv,
  serializeBriefingHtml,
  snapshotAgeSeconds,
  isStaleAt
} = require("./briefing.js");

const DEFAULT_INTERVAL_MS = 60000;
// A materialization older than this many intervals means the timer stopped
// firing (event loop wedged, or stop() was called) - the producer is STALLED.
const STALLED_AFTER_INTERVALS = 3;
// Unchanged diagnostics are logged at most this often per universe; every
// CHANGE in the diagnostic signature is logged the moment it happens.
const HEARTBEAT_MS = 15 * 60000;

function iso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function padSeq(seq) {
  const s = String(seq);
  return s.length >= 7 ? s : "0000000".slice(s.length) + s;
}

// Diagnostic signature: the fields whose CHANGE is worth a log line. Row and
// coverage counts, completeness, the named issues, and whether the build
// itself succeeded. Ages and timestamps are excluded on purpose - they change
// every tick and would turn the log into noise.
function signatureOf(snapshot) {
  return [
    hasUsableBriefingSnapshot(snapshot),
    snapshot.row_count,
    snapshot.expected_row_count,
    snapshot.data_complete,
    (snapshot.issues || []).join(","),
    (snapshot.missing_symbols || []).length,
    (snapshot.warnings || []).length
  ].join("|");
}

function createBriefingStore(opts) {
  opts = opts || {};
  const state = opts.state;
  const ftfcTfs = opts.ftfcTfs;
  const now = opts.now || Date.now;
  const log = opts.log || function () {};
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  const build = opts.build || buildBriefingSnapshot;
  const bootId = opts.bootId || crypto.randomBytes(4).toString("hex");

  let seq = 0;
  let timer = null;
  let regressionsRefused = 0;
  const entries = new Map();   // universe -> immutable entry
  const errors = new Map();    // universe -> {count, lastAt, lastMessage, sinceSeq}
  const lastLog = new Map();   // universe -> {sig, at}

  function universes() {
    return Array.isArray(state.universes) ? state.universes.slice() : [];
  }

  function upstream() {
    return {
      candle_fetch_failures: state.candleFailures || 0,
      mids_fetch_failures: state.midsFailures || 0,
      loop_revision: state.revision || 0
    };
  }

  function recordError(universe, at, message) {
    const cur = errors.get(universe) || { count: 0, lastAt: null, lastMessage: null, sinceSeq: null };
    cur.count += 1;
    cur.lastAt = at;
    cur.lastMessage = message;
    const entry = entries.get(universe);
    if (cur.sinceSeq === null) cur.sinceSeq = entry ? entry.seq : 0;
    errors.set(universe, cur);
  }

  function clearError(universe) {
    const cur = errors.get(universe);
    if (cur) cur.sinceSeq = null;   // a later success supersedes the error
  }

  function maybeLog(entry, at) {
    const sig = signatureOf(entry.snapshot);
    const prev = lastLog.get(entry.universe);
    let reason = null;
    if (!prev) reason = "first";
    else if (prev.sig !== sig) reason = "change";
    else if (at - prev.at >= HEARTBEAT_MS) reason = "heartbeat";
    if (!reason) return;
    lastLog.set(entry.universe, { sig: sig, at: at });
    const s = entry.snapshot;
    log("[briefing] materialized " + JSON.stringify({
      reason: reason,
      snapshot_id: entry.snapshot_id,
      universe: entry.universe,
      generated_at_utc: s.generated_at_utc,
      data_as_of_utc: s.data_as_of_utc,
      row_count: s.row_count,
      expected_row_count: s.expected_row_count,
      missing_symbols: (s.missing_symbols || []).length,
      data_complete: s.data_complete,
      issues: s.issues || [],
      warnings: (s.warnings || []).length,
      build_ms: entry.build_ms,
      upstream: upstream()
    }));
  }

  // Build one immutable entry for a universe from the current loop state.
  // Returns the entry now current for that universe - which is the PREVIOUS
  // entry when the build threw or would have moved data_as_of backwards.
  function materialize(universe, at) {
    at = at === undefined ? now() : at;
    const t0 = performance.now();
    let built;
    try {
      built = build(state, ftfcTfs, universe, at);
    } catch (e) {
      const message = (e && e.message) || String(e);
      recordError(universe, at, message);
      const kept = entries.get(universe) || null;
      log("[briefing] build failed " + JSON.stringify({
        universe: universe,
        at_utc: iso(at),
        error: message,
        kept_snapshot_id: kept ? kept.snapshot_id : null,
        upstream: upstream()
      }));
      return kept;
    }
    const prev = entries.get(universe) || null;
    const prevAsOf = prev && prev.snapshot.data_as_of_utc ? Date.parse(prev.snapshot.data_as_of_utc) : NaN;
    const nextAsOf = built.data_as_of_utc ? Date.parse(built.data_as_of_utc) : NaN;
    // Monotonic guard. Every loop stamp is a completion-time Date.now(), so a
    // backwards step cannot happen from this process's own state; if it ever
    // does, the older data is refused and the refusal is COUNTED, not hidden.
    if (Number.isFinite(prevAsOf) && Number.isFinite(nextAsOf) && nextAsOf < prevAsOf) {
      regressionsRefused += 1;
      log("[briefing] refused regression " + JSON.stringify({
        universe: universe,
        kept_snapshot_id: prev.snapshot_id,
        kept_data_as_of_utc: prev.snapshot.data_as_of_utc,
        refused_data_as_of_utc: built.data_as_of_utc,
        regressions_refused: regressionsRefused
      }));
      return prev;
    }
    seq += 1;
    const id = bootId + "-" + padSeq(seq);
    // Identity leads the object so it is the first key of every JSON body.
    const snapshot = Object.assign({ snapshot_id: id }, built);
    const entry = {
      snapshot_id: id,
      seq: seq,
      universe: universe,
      materialized_at: at,
      build_ms: Math.round((performance.now() - t0) * 10) / 10,
      snapshot: snapshot,
      compact: buildCompactBriefingSnapshot(snapshot),
      csv: serializeBriefingCsv(snapshot)
    };
    entries.set(universe, entry);
    clearError(universe);
    maybeLog(entry, at);
    return entry;
  }

  function materializeAll(at) {
    at = at === undefined ? now() : at;
    universes().forEach(function (universe) { materialize(universe, at); });
  }

  // The entry for a universe, building one only when NONE exists yet (first
  // request before the first tick; test handlers without a timer). An
  // existing entry is never refreshed here - a request must not mask a
  // stalled producer by rebuilding on its behalf.
  function ensure(universe, at) {
    return entries.get(universe) || materialize(universe, at);
  }

  // Precedence: loading > error > idle > stalled > ok. Error outranks idle
  // on purpose (audit 2026-09-13 F1): a FIRST build that keeps throwing has
  // no entry, and "idle" would describe a producer that is in fact failing
  // on every tick while build_errors climbs.
  function producerStatus(universe, at) {
    at = at === undefined ? now() : at;
    const entry = entries.get(universe);
    if (!state.loaded) return "loading";
    const err = errors.get(universe);
    if (err && err.sinceSeq !== null) return "error";
    if (!entry) return "idle";
    if (at - entry.materialized_at > STALLED_AFTER_INTERVALS * intervalMs) return "stalled";
    return "ok";
  }

  // The snapshot served when NO entry exists (the first build threw, or
  // nothing has materialized yet). Shaped exactly like the builder's own
  // no-rows output so every serializer renders it as the same explicit
  // 503 "snapshot_unavailable" document a zero-row state produces - a
  // failing producer must never turn into a thrown TypeError in the HTTP
  // listener (audit 2026-09-13 F1: that is a worker crash, not a 503).
  function unavailableSnapshot(universe, at) {
    const err = errors.get(universe);
    const failed = Boolean(err && err.sinceSeq !== null);
    return {
      snapshot_id: null,
      schema_version: SCHEMA_VERSION,
      generated_at_utc: iso(at),
      data_as_of_utc: null,
      universe: universe,
      available_universes: universes(),
      row_count: 0,
      expected_row_count: 0,
      data_complete: false,
      is_stale: true,
      stale_after_seconds: STALE_AFTER_SECONDS,
      score_policy: SCORE_POLICY,
      issues: failed ? ["build_failed", "no_rows"] : ["no_snapshot", "no_rows"],
      warnings: [failed
        ? "Briefing snapshot build failed: " + err.lastMessage
        : "No briefing snapshot has been materialized yet"],
      missing_symbols: [],
      unexpected_symbols: [],
      duplicate_symbols: [],
      field_coverage: {},
      freshness: null,
      prior_us_cash_close_reference: null,
      score_v: null,
      session_definitions: SESSION_DEFINITIONS,
      error: {
        code: "snapshot_unavailable",
        message: failed
          ? "The briefing snapshot build failed and no earlier snapshot exists"
          : "The scanner has not produced a completed briefing snapshot"
      },
      rows: []
    };
  }

  // Serve-time view: the immutable entry plus the fields that depend on WHEN
  // it is served. Every representation reads this one object, so HTML, JSON,
  // CSV and health cannot disagree about identity or age within a request.
  // A view is built ONCE per response and is the only thing the route,
  // the headers, every representation and the health body read - one
  // clock reading, one ensure(), so headers and body cannot disagree
  // (audit 2026-09-13 F2: they used to come from two views). With no
  // entry it carries the synthetic unavailable snapshot, so every
  // serializer still has a defined document to render.
  function view(universe, at) {
    at = at === undefined ? now() : at;
    const entry = ensure(universe, at);
    const status = producerStatus(universe, at);
    if (!entry) {
      const snapshot = unavailableSnapshot(universe, at);
      return {
        entry: null,
        at: at,
        snapshot: snapshot,
        compact: buildCompactBriefingSnapshot(snapshot),
        csv: serializeBriefingCsv(snapshot),
        usable: false,
        served: {
          snapshot_id: null, served_at_utc: iso(at), age_seconds: null,
          is_stale: true, producer_status: status
        }
      };
    }
    return {
      entry: entry,
      at: at,
      snapshot: entry.snapshot,
      compact: entry.compact,
      csv: entry.csv,
      usable: hasUsableBriefingSnapshot(entry.snapshot),
      served: {
        snapshot_id: entry.snapshot_id,
        served_at_utc: iso(at),
        age_seconds: snapshotAgeSeconds(entry.snapshot, at),
        is_stale: isStaleAt(entry.snapshot, at),
        producer_status: status
      }
    };
  }

  function healthStatus(v) {
    if (!v.entry || !v.usable) return "unavailable";
    if (v.served.is_stale || !v.snapshot.data_complete || v.served.producer_status !== "ok") {
      return "degraded";
    }
    return "ok";
  }

  // Metadata + served fields, rows last. `is_stale` is the SERVE-TIME value;
  // a snapshot that was fresh when built and is stale now also gains a
  // warning saying so, because a consumer reading only `warnings` must not
  // see an empty list beside is_stale=true.
  function withServed(source, v) {
    const out = {};
    Object.keys(source).forEach(function (key) {
      if (key !== "rows") out[key] = source[key];
    });
    out.is_stale = v.served.is_stale;
    out.age_seconds = v.served.age_seconds;
    out.served_at_utc = v.served.served_at_utc;
    out.producer_status = v.served.producer_status;
    if (v.served.is_stale && !source.is_stale) {
      out.warnings = (source.warnings || []).concat([
        v.served.age_seconds === null
          ? "Snapshot data timestamp is unavailable at serve time"
          : "Snapshot is " + v.served.age_seconds + " seconds old at serve time"
      ]);
    }
    out.rows = source.rows;
    return out;
  }

  function canonical(v) { return withServed(v.snapshot, v); }
  function compact(v) { return withServed(v.compact, v); }
  function csv(v) { return v.csv; }
  function html(v) { return serializeBriefingHtml(compact(v)); }

  // Lightweight health body: everything a consumer needs to classify a
  // failure, no market rows. `status` is derived from the snapshot's own
  // predicates - never from the process merely being alive.
  function healthOf(v) {
    const s = v.snapshot;
    const at = v.at;
    const err = errors.get(s.universe);
    return {
      status: healthStatus(v),
      universe: s.universe,
      schema_version: s.schema_version,
      format: "briefing_compact_v1",
      snapshot_id: v.served.snapshot_id,
      // The view's snapshot, entry or synthetic - the same field every other
      // representation and X-Generated-At read. Nulling it here when no
      // entry exists made health the one body that contradicted its own
      // header over an unavailable document (review LOW).
      generated_at_utc: s.generated_at_utc,
      data_as_of_utc: s.data_as_of_utc,
      served_at_utc: v.served.served_at_utc,
      age_seconds: v.served.age_seconds,
      stale_after_seconds: s.stale_after_seconds,
      row_count: s.row_count,
      expected_row_count: s.expected_row_count,
      data_complete: s.data_complete,
      is_stale: v.served.is_stale,
      issues: s.issues,
      warnings: compact(v).warnings || [],
      missing_symbols: s.missing_symbols,
      freshness: s.freshness,
      producer_status: v.served.producer_status,
      producer: {
        boot_id: bootId,
        interval_seconds: Math.round(intervalMs / 1000),
        sequence: v.entry ? v.entry.seq : null,
        materialized_at_utc: v.entry ? iso(v.entry.materialized_at) : null,
        materialized_age_seconds: v.entry ? Math.round(Math.max(0, at - v.entry.materialized_at) / 1000) : null,
        build_ms: v.entry ? v.entry.build_ms : null,
        build_errors: err ? err.count : 0,
        last_error: err && err.lastMessage ? { at_utc: iso(err.lastAt), message: err.lastMessage } : null,
        regressions_refused: regressionsRefused
      },
      upstream: upstream(),
      loop_loaded: Boolean(state.loaded)
    };
  }

  function health(universe, at) {
    return healthOf(view(universe, at));
  }

  // Compact per-universe summary for the worker's /health.
  function stats(at) {
    at = at === undefined ? now() : at;
    const out = {
      boot_id: bootId,
      interval_seconds: Math.round(intervalMs / 1000),
      regressions_refused: regressionsRefused,
      universes: {}
    };
    universes().forEach(function (universe) {
      const entry = entries.get(universe) || null;
      const err = errors.get(universe);
      const served = entry ? {
        age_seconds: snapshotAgeSeconds(entry.snapshot, at),
        is_stale: isStaleAt(entry.snapshot, at)
      } : { age_seconds: null, is_stale: true };
      out.universes[universe] = {
        snapshot_id: entry ? entry.snapshot_id : null,
        sequence: entry ? entry.seq : null,
        materialized_at_utc: entry ? iso(entry.materialized_at) : null,
        data_as_of_utc: entry ? entry.snapshot.data_as_of_utc : null,
        age_seconds: served.age_seconds,
        is_stale: served.is_stale,
        data_complete: entry ? entry.snapshot.data_complete : false,
        row_count: entry ? entry.snapshot.row_count : 0,
        expected_row_count: entry ? entry.snapshot.expected_row_count : 0,
        producer_status: producerStatus(universe, at),
        build_errors: err ? err.count : 0
      };
    });
    return out;
  }

  function start() {
    if (timer) return;
    materializeAll();
    timer = setInterval(function () {
      try { materializeAll(); } catch (e) {
        log("[briefing] materializeAll threw: " + ((e && e.message) || e)); // must never crash the worker
      }
    }, intervalMs);
    if (timer.unref) timer.unref();
    log("[briefing] materializing every " + Math.round(intervalMs / 1000) + "s (boot " + bootId + ")");
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    bootId: bootId,
    intervalMs: intervalMs,
    start: start,
    stop: stop,
    materialize: materialize,
    materializeAll: materializeAll,
    get: function (universe) { return entries.get(universe) || null; },
    view: view,
    canonical: canonical,
    compact: compact,
    csv: csv,
    html: html,
    health: health,
    healthOf: healthOf,
    healthStatus: healthStatus,
    producerStatus: producerStatus,
    stats: stats
  };
}

module.exports = {
  createBriefingStore,
  DEFAULT_INTERVAL_MS,
  STALLED_AFTER_INTERVALS,
  HEARTBEAT_MS
};
