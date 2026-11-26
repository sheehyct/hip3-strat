"use strict";

// Universe registry + env parsing for the multi-universe worker.
//
// A "universe" is one Hyperliquid perp namespace the worker tracks:
//   xyz   - the HIP-3 builder dex "xyz". Coin names are PREFIXED ("xyz:NVDA");
//           info requests carry dex:"xyz".
//   perps - the Hyperliquid MAIN dex (~176 live assets). Coin names are BARE
//           ("BTC", "kPEPE"); the info API takes NO dex field for it.
// The two namespaces never collide (prefixed vs bare), so every universe shares
// one coin map keyed by full name and one mids map merged from per-universe
// allMids responses.
//
// Two independent env vars drive this, parsed here:
//   UNIVERSES        which universes to TRACK (fetch + analyze + serve). Default
//                    "xyz" -> byte-for-byte the pre-multi-universe behavior.
//   ALERT_UNIVERSES  which tracked universes fire ALERTS for EVERY coin
//                    (broadcast). Default "xyz". This is the safety property:
//                    coins outside the alert scope are screener-only (served
//                    in /api/state, never alerted).
//   ALERT_FAVS_UNIVERSES
//                    which tracked universes fire alerts for FAVORITED coins
//                    ONLY (the union of the phone push registrations' favs).
//                    Default "perps".
//
// Why favorites-only is a SEPARATE var rather than a wider ALERT_UNIVERSES:
// ALERT_UNIVERSES is also the 15m volume true-up scope (server.js passes it as
// the loop's trueUpUniverses; the demand cut, 2026-08-17), and that scoping
// is what brought total exchange demand from ~155% to ~95% of Hyperliquid's
// 1,200 weight/min per-IP budget. Perps candles are ALREADY fetched for
// analysis, so favorites-scoped perps alerting costs ZERO extra exchange
// demand - but only for as long as perps stays OUT of ALERT_UNIVERSES. Adding
// it there would re-break the budget. The two lists are therefore parsed and
// consumed independently, and a universe named in BOTH resolves to broadcast
// (the wider behavior wins, so nothing can be accidentally NARROWED).

const REGISTRY = {
  xyz:   { id: "xyz",   dex: "xyz" },
  perps: { id: "perps", dex: null }
};

function parseList(raw) {
  if (typeof raw !== "string") return [];
  return raw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
}

// Parse UNIVERSES into an ordered, de-duplicated list of known universe defs.
// Unknown ids are dropped with a log line - a typo must never crash the worker.
// Empty input (unset var) or an all-unknown list falls back to the default set,
// so the worker always tracks at least one universe.
function parseUniverses(raw, opts) {
  opts = opts || {};
  const log = opts.log || function () {};
  const dflt = opts.default || ["xyz"];
  let ids = parseList(raw);
  if (!ids.length) ids = dflt.slice();
  const seen = {};
  const out = [];
  for (const id of ids) {
    if (!REGISTRY[id]) { log("universe: ignoring unknown id '" + id + "'"); continue; }
    if (seen[id]) continue;
    seen[id] = true;
    out.push(REGISTRY[id]);
  }
  if (!out.length) {
    // Every requested id was unknown -> fall back to the default set (its ids
    // are known by construction) so the worker still runs.
    for (const id of dflt) {
      if (REGISTRY[id] && !seen[id]) { seen[id] = true; out.push(REGISTRY[id]); }
    }
  }
  return out;
}

// Parse ALERT_UNIVERSES into the SET of tracked universe ids that fire alerts.
// Must be a subset of trackedIds: alerting on an untracked universe is
// impossible (its coins are never analyzed), so such ids are dropped with a
// log. Unknown ids are likewise dropped with a log. Empty input defaults to the
// default set; if the default is not tracked the result is empty (no alerts) -
// the safe outcome, never a surprise fire.
function parseAlertUniverses(raw, trackedIds, opts) {
  opts = opts || {};
  const log = opts.log || function () {};
  const dflt = opts.default || ["xyz"];
  let ids = parseList(raw);
  if (!ids.length) ids = dflt.slice();
  const tracked = {};
  for (const t of trackedIds || []) tracked[t] = true;
  const seen = {};
  const out = [];
  for (const id of ids) {
    if (!REGISTRY[id]) { log("alert universe: ignoring unknown id '" + id + "'"); continue; }
    if (!tracked[id]) { log("alert universe: '" + id + "' not in tracked UNIVERSES - dropped"); continue; }
    if (seen[id]) continue;
    seen[id] = true;
    out.push(id);
  }
  return out;
}

// Parse ALERT_FAVS_UNIVERSES into the SET of tracked universe ids that alert
// for FAVORITED coins only. Same drop rules as parseAlertUniverses (unknown id
// -> dropped with a log; not tracked -> dropped with a log), plus one more:
// an id already in alertIds is dropped, because a broadcast universe already
// alerts every coin and narrowing it to favorites would be a SILENT loss of
// alerts. Broadcast wins, always, and says so in the log.
//
// An UNSET variable defaults to the default set ("perps"), so the feature
// ships on deploy with no env change. A variable that is SET but
// empty (or whitespace, or all-invalid ids) yields [] - the operator's
// explicit off switch (review MEDIUM: the earlier empty->default
// fallback made ALERT_FAVS_UNIVERSES="" silently re-enable the feature).
// Unlike parseUniverses there is no "fall back to the default" rescue on a
// bad value, because alerting on nothing is the safe outcome.
function parseAlertFavsUniverses(raw, trackedIds, alertIds, opts) {
  opts = opts || {};
  const log = opts.log || function () {};
  const dflt = opts.default || ["perps"];
  const unset = raw === undefined || raw === null;
  let ids = unset ? dflt.slice() : parseList(raw);
  if (!unset && !ids.length) log("favs alert universes: explicitly empty - favorites-only alerting disabled");
  const tracked = {};
  for (const t of trackedIds || []) tracked[t] = true;
  const broadcast = {};
  for (const a of alertIds || []) broadcast[a] = true;
  const seen = {};
  const out = [];
  for (const id of ids) {
    if (!REGISTRY[id]) { log("favs alert universe: ignoring unknown id '" + id + "'"); continue; }
    if (!tracked[id]) { log("favs alert universe: '" + id + "' not in tracked UNIVERSES - dropped"); continue; }
    if (broadcast[id]) {
      log("favs alert universe: '" + id + "' is already in ALERT_UNIVERSES - "
        + "broadcast wins, favorites scoping not applied");
      continue;
    }
    if (seen[id]) continue;
    seen[id] = true;
    out.push(id);
  }
  return out;
}

// ONE definition of "this universe's forming volume is fresh": the universe is
// inside the true-up scope, or the scope is unset (legacy unscoped behavior).
// Shared by apistate (which serves rvol null when stale) and rules (which must
// feed heatScore/rvol_spike the same null) so the two can never disagree about
// whether a pace-adjusted rvol is trustworthy - review HIGH: rules
// called rvol15 raw while apistate served null, so a favorited perp's alerts
// carried a decayed rvol the API refused to publish.
function volumeFresh(trueUpUniverses, uni) {
  return !trueUpUniverses || trueUpUniverses.indexOf(uni) >= 0;
}

module.exports = {
  REGISTRY: REGISTRY,
  parseUniverses: parseUniverses,
  parseAlertUniverses: parseAlertUniverses,
  parseAlertFavsUniverses: parseAlertFavsUniverses,
  volumeFresh: volumeFresh
};
