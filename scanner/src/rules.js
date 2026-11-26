"use strict";

// Transition-based alert rule engine.
// EVERYTHING fires on TRANSITIONS, never on levels - a level-based check would
// spam every 4 seconds. Each rule keeps dedup / re-arm state; state is dumped
// periodically to a JSON file (atomic write: tmp then rename; never pickle)
// and reloaded on start so restarts do not re-fire the world.

const fs = require("node:fs");
const path = require("node:path");
const { momentum, rvol15, coinSummary, heatScore, tr15AvgPct, tr1hAvgPct, readiness } = require("./metrics.js");
const { volumeFresh } = require("./universes.js");

function hasOwn(m, k) { return Object.prototype.hasOwnProperty.call(m, k); }
const { nextMonthStart } = require("./strat_core.js");
// THE favorites matching rule. Alert SCOPE (below) and push DELIVERY must
// never disagree about which coins a favorites list covers, so both call this
// one function rather than each writing "name or sym" for itself.
const { favMatches } = require("./push.js");

const TF_LABELS = { "15m": "15m", "30m": "30m", "1h": "1H", "4h": "4H", "1d": "D", "1w": "W", "1M": "M" };
const PRUNE_MS = 48 * 3600 * 1000; // drop per-bar dedup keys 48h after the BAR ENDS
const TF_MS = { "15m": 900000, "30m": 1800000, "1h": 3600000, "4h": 14400000, "1d": 86400000, "1w": 604800000 };

// A per-bar dedup key may refer to a bar that is STILL FORMING (weekly and
// monthly bars live far longer than any fixed prune window), so retention is
// keyed off the bar's END time, not the fire timestamp: pruning a key while
// its bar is still open would re-fire the identical alert. Returns the bar
// end ms, or null when the key cannot be parsed (fallback: fire timestamp).
function keyBarEnd(mapName, k) {
  const parts = k.split("|");
  let tfId, t;
  if (mapName === "rvolFired" || mapName === "moveFired") {
    tfId = "15m"; t = +parts[1];                                // coin|15mBarT[|dir]
  }
  else { tfId = parts[1]; t = +parts[2]; }                      // coin|tf|barT|pattern
  if (!isFinite(t)) return null;
  if (tfId === "1M") return nextMonthStart(t);
  const ms = TF_MS[tfId];
  return ms ? t + ms : null;
}

// ---- message formatting (plain ASCII, one line, phone friendly) ----
function fmtPx(x) {
  if (x === null || x === undefined || !isFinite(x)) return "-";
  const a = Math.abs(x);
  const d = a >= 10000 ? 1 : a >= 1000 ? 2 : a >= 100 ? 2 : a >= 1 ? 3 : 5;
  return x.toFixed(d);
}
function fmtScore(s) { return s === null ? "-" : (s > 0 ? "+" : "") + s; }
function fmtRv(rv) { return rv === null ? "-" : rv.toFixed(1) + "x"; }
function fmtPct(v) {
  if (v === null || v === undefined || !isFinite(v)) return "-";
  return (v > 0 ? "+" : "") + v.toFixed(1) + "%";
}
function fmtNtl(n) {
  if (n === null || n === undefined || !isFinite(n)) return "-";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "k";
  return "$" + Math.round(n);
}
function num(v, dflt) { return (typeof v === "number" && isFinite(v)) ? v : dflt; }
function label(tfId) { return TF_LABELS[tfId] || tfId; }

function createRuleEngine(config, deliver, opts) {
  opts = opts || {};
  const log = opts.log || function () {};
  const statePath = opts.statePath || null;
  const rulesCfg = (config && config.rules) || {};
  const ftfcTfs = (config && config.ftfcTfs) || ["15m", "1h", "4h", "1d"];
  // Alert gate (multi-universe safety property). When an array is supplied, a
  // coin fires alerts ONLY if its `uni` is in the set; coins outside it are
  // screener-only (analyzed and served, never alerted). When null (not
  // supplied, e.g. legacy single-universe callers and unit tests) NO gating is
  // applied and every coin is evaluated - identical to the pre-universe engine.
  const alertUniverses = Array.isArray(opts.alertUniverses) ? opts.alertUniverses : null;
  // Favorites-only alert scope (ALERT_FAVS_UNIVERSES). A coin in one of these
  // universes is evaluated ONLY when it appears in the union of the phone
  // registrations' favorites; every other coin in that universe stays
  // screener-only. Deliberately NOT folded into alertUniverses: that list is
  // also the exchange true-up scope (see src/universes.js for the budget
  // arithmetic), so widening it would cost fetch demand this scope must not.
  // favUnion is a CALLBACK, not a snapshot: favorites change at runtime and
  // each evaluation pass must see the current set (server.js hands it the push
  // store's favUnion). Absent either one, the favorites path is simply off.
  const alertFavsUniverses = Array.isArray(opts.alertFavsUniverses) ? opts.alertFavsUniverses : null;
  const favUnionFn = typeof opts.favUnion === "function" ? opts.favUnion : null;
  // The loop's true-up scope, captured per evaluation pass (evaluateAll reads
  // it off loopState so rules and apistate share ONE source). Outside it a
  // universe's forming volume is frozen at the roll-time sample, so rvol
  // decays toward zero across the bar - the same reason apistate serves null.
  // null = unscoped legacy behavior (unit tests, single-universe callers).
  let volScope = null;

  let st = {
    liveFired: {},   // coin|tf|formingBarT|pattern -> ts   (once per bar)
    invalFired: {},  // same key -> ts                      (pairs with liveFired)
    scoreArm: {},    // coin -> {up:bool, down:bool}        (hysteresis 60/45)
    ftfcState: {},   // coin -> {fired, leftAt}             (re-arm needs sustained departure)
    levelSides: {},  // coin|level -> "above"|"below"       (once per crossing dir)
    rvolFired: {},   // coin|15mBarT -> ts                  (once per 15m bar)
    moveFired: {},   // coin|15mBarT|dir -> ts              (once per bar per direction)
    favScoped: {}    // coin -> ts of its silent scope-entry baseline
  };
  let fired = 0;
  let dirty = false;
  // Set for the duration of ONE scope-entry baseline evaluation: every rule
  // records its dedup / re-arm state as usual while fire() delivers nothing.
  // Toggled around a single synchronous evaluateCoin call (see evaluateAll).
  let silent = false;

  if (statePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      for (const k of Object.keys(st)) {
        if (parsed[k] && typeof parsed[k] === "object") st[k] = parsed[k];
      }
      log("rule state reloaded from " + statePath);
    } catch (e) {
      log("no prior rule state (" + e.code + ") - starting fresh");
    }
    // favScoped deliberately does NOT survive a restart: boot is a scope-ENTRY
    // event (task 025), so every favorited coin re-baselines silently on its
    // first post-boot evaluation and transitions accumulated while the process
    // was down are absorbed instead of bursting at startup. Reloading the
    // marker made the first post-restart evaluation LIVE (review
    // HIGH). Dedup maps still persist - an already-alerted bar never replays.
    st.favScoped = {};
  }

  function cfg(name) { return rulesCfg[name] || {}; }
  function enabled(name) { return !!cfg(name).enabled; }

  // A coin is FTFC-evaluable only once EVERY configured timeframe carries an
  // analysis object. coinSummary reports a missing slot as "flat", which is
  // indistinguishable from a real flat bar and reads as a legitimate "mixed" -
  // so a coin with no candles at all would consume the silent baseline below
  // with a verdict derived from no data, and the first observation that
  // actually HAS candles would fire instead of establishing the baseline.
  // Before roster recovery landed this was unreachable: start() awaits the
  // initial candle load before startTimers(), so no rule ever saw an empty
  // coin. loop.js refreshCtxs now registers coins into the RUNNING loop with
  // tf:{}, which is exactly the population an FTFC alert should stay silent
  // about until it can be judged (code review 2026-08-07). Partial
  // loads were already safe - a missing slot is "flat" and flat never
  // completes an alignment - so this only defers the baseline, and a
  // fully-loaded coin's behavior is unchanged.
  // Delegates to metrics.readiness so the alert gate, /api/state and the
  // briefing share ONE definition of ready (design decision 2026-08-15).
  function ftfcEvaluable(coin) {
    return readiness(coin, ftfcTfs).ready;
  }

  function inQuietHours(now) {
    const q = config && config.quietHoursUtc;
    if (!q || typeof q.start !== "number" || typeof q.end !== "number") return false;
    const h = new Date(now).getUTCHours();
    return q.start <= q.end ? (h >= q.start && h < q.end) : (h >= q.start || h < q.end);
  }

  // meta ({coin, sym}) rides along so delivery channels that scope by coin
  // (expo push favorites) never parse the formatted message string.
  function fire(msg, now, meta) {
    dirty = true;
    // Scope-entry baseline: the state written by this rule is the POINT of the
    // pass; the delivery is what must not happen. Counted as neither fired nor
    // quiet-suppressed - it was never an alert.
    if (silent) { log("[baseline] scope entry, not delivered: " + msg); return; }
    if (inQuietHours(now)) { log("[quiet] suppressed: " + msg); return; }
    fired++;
    try {
      Promise.resolve(deliver(msg, meta)).catch(function (e) {
        log("[deliver] rejected: " + (e && e.message));
      });
    } catch (e) {
      log("[deliver] threw: " + (e && e.message)); // delivery must never crash the loop
    }
  }

  // Public entry. `silentBaseline` runs every rule for its STATE EFFECT only:
  // dedup keys, re-arm flags and first-observation markers are all written,
  // nothing is delivered. This repo's alerts are transition-based, so a coin
  // seen for the first time has no prior state and every signal already in
  // force reads as a fresh transition - which is exactly the burst a newly
  // favorited perp would otherwise produce. ftfc_flip has always solved this
  // for itself with a first-observation baseline; scope entry needs the same
  // treatment across ALL rules at once, so it is applied here rather than
  // rule by rule.
  function evaluateCoin(coin, now, silentBaseline) {
    if (!silentBaseline) return evaluateCoinRules(coin, now);
    silent = true;
    try { return evaluateCoinRules(coin, now); }
    finally { silent = false; }
  }

  function evaluateCoinRules(coin, now) {
    now = now || Date.now();
    const sum = coinSummary(coin, ftfcTfs);
    const mom = momentum(coin, now);
    // Same freshness predicate apistate serves rvol through (ONE shared
    // definition, src/universes.js): outside the true-up scope the forming
    // volume is frozen, rvol decays, and a decayed number must not feed the
    // score, the alert tail, or rvol_spike (review HIGH).
    const rv = volumeFresh(volScope, coin.uni) ? rvol15(coin, now) : null;
    const score = heatScore(sum, mom, rv, coin.mid, tr1hAvgPct(coin, now));
    const sym = coin.sym;
    const meta = { coin: coin.name, sym: sym };
    const tail = " | score " + fmtScore(score) + " rvol " + fmtRv(rv) + " FTFC " + sum.ftfc;

    // ---- live_signal + invalidation ----
    // Fires when (coin, tf, pattern) ENTERS the live set of a forming bar.
    // Key includes the forming bar's open time -> once per bar by construction.
    // Only configured kinds alert (default ["rev"]: continuations are NOT
    // fresh entries per STRAT methodology). Invalidation pairs with a
    // previously-ALERTED live signal only (same key).
    // A [LIVE] immediately followed by [INVAL] in the SAME tick (trigger break
    // and Type-3 in one mid-poll) is INTENTIONAL, not a bug (design decision
    // 2026-07-02): that pair is the 1-3 Rev Strat signature. As of 2026-07-06
    // the 1-3 IS implemented (core emits it with rev3:true when the break
    // order was observed) - the pair is now typically followed by its own
    // [LIVE 1-3] fire. Do not suppress or merge any of these.
    // rev3 signals are BORN on the 3: exempt from invalidation pairing (the
    // TF-level invalidated flag is their birth event, not their death).
    const lsCfg = cfg("live_signal");
    const lsTfs = Array.isArray(lsCfg.tfs) ? lsCfg.tfs : ["1h", "4h", "1d", "1w", "1M"];
    const lsKinds = Array.isArray(lsCfg.kinds) ? lsCfg.kinds : ["rev"];
    for (const tfId of lsTfs) {
      const slot = coin.tf[tfId];
      const an = slot && slot.an;
      if (!an) continue;
      if (slot.forming) {
        const barT = slot.forming.t;
        for (const l of an.live) {
          const key = coin.name + "|" + tfId + "|" + barT + "|" + l.name;
          if (enabled("live_signal") && lsKinds.indexOf(l.kind) >= 0 && !(key in st.liveFired)) {
            st.liveFired[key] = now;
            fire("[LIVE] " + sym + " " + label(tfId) + " " + l.name + " " + l.dir
              + " | entry " + (l.dir === "up" ? ">" : "<") + fmtPx(l.entry)
              + " stop " + fmtPx(l.stop)
              + " tgt " + (l.target === null || l.target === undefined ? "-" : fmtPx(l.target))
              + tail, now, meta);
          }
          if (enabled("invalidation") && an.invalidated && !l.rev3
              && (key in st.liveFired) && !(key in st.invalFired)) {
            st.invalFired[key] = now;
            fire("[INVAL] " + sym + " " + label(tfId) + " " + l.name
              + " went 3 - invalidation exit", now, meta);
          }
        }
      }
      // A 3-transition can materialize where the forming-bar path above
      // cannot see it: after the last mids tick of the bar, as a sub-4s
      // traded wick on a TF with no intra-bar true-up, or while the process
      // was down. The CLOSED bar is authoritative: when the last closed bar
      // classified as a Type 3, pair the [INVAL] for any alerted key on that
      // bar that never got one (dedup keys are retained until well past the
      // bar's end, so this also covers restarts).
      if (enabled("invalidation") && an.types.length >= 2
          && an.types[an.types.length - 1] === "3") {
        const closedT = slot.closed[slot.closed.length - 1].t;
        const prefix = coin.name + "|" + tfId + "|" + closedT + "|";
        for (const k of Object.keys(st.liveFired)) {
          if (k.indexOf(prefix) === 0 && !(k in st.invalFired)) {
            if (k.slice(prefix.length) === "1-3") continue; // born on the 3; the close confirms it
            st.invalFired[k] = now;
            fire("[INVAL] " + sym + " " + label(tfId) + " " + k.slice(prefix.length)
              + " went 3 - invalidation exit", now, meta);
          }
        }
      }
    }

    // ---- score_cross ----
    // Fires when abs(score) crosses the threshold; re-arms only after
    // abs(score) < rearm. Per coin per direction.
    if (enabled("score_cross") && score !== null) {
      const th = num(cfg("score_cross").threshold, 60);
      const re = num(cfg("score_cross").rearm, 45);
      let arm = st.scoreArm[coin.name];
      if (!arm) { arm = st.scoreArm[coin.name] = { up: true, down: true }; dirty = true; }
      if (Math.abs(score) < re && (!arm.up || !arm.down)) {
        arm.up = true; arm.down = true; dirty = true;
      }
      if (score >= th && arm.up) {
        arm.up = false;
        fire("[SCORE] " + sym + " " + fmtScore(score) + " (crossed +" + th + ") | 1h "
          + fmtPct(mom.r60) + " rvol " + fmtRv(rv) + " FTFC " + sum.ftfc, now, meta);
      } else if (score <= -th && arm.down) {
        arm.down = false;
        fire("[SCORE] " + sym + " " + fmtScore(score) + " (crossed -" + th + ") | 1h "
          + fmtPct(mom.r60) + " rvol " + fmtRv(rv) + " FTFC " + sum.ftfc, now, meta);
      }
    }

    // ---- ftfc_flip ----
    // Fires when FTFC becomes FULL up/down over the configured set; re-arms
    // by leaving full alignment. First observation is a silent baseline.
    // HYSTERESIS: a per-TF dot resets to "flat" at every bar roll (a fresh
    // forming bar has c == o) and flips whenever price crosses the forming
    // bar's open, so brief "mixed" blips are bar-clock artifacts, not real
    // continuity changes. Re-arm therefore requires the departure from full
    // alignment to PERSIST for rearmSec; a flip to the OPPOSITE full
    // alignment is a genuine transition and fires immediately.
    if (enabled("ftfc_flip") && ftfcEvaluable(coin)) {
      const rearmMs = num(cfg("ftfc_flip").rearmSec, 900) * 1000;
      let fst = st.ftfcState[coin.name];
      if (fst === undefined) {
        // first observation ever: silent baseline
        st.ftfcState[coin.name] = {
          fired: (sum.ftfc === "up" || sum.ftfc === "down") ? sum.ftfc : null,
          leftAt: null
        };
        dirty = true;
      } else {
        if (typeof fst === "string") { // migrate pre-hysteresis persisted format
          fst = st.ftfcState[coin.name] = {
            fired: (fst === "up" || fst === "down") ? fst : null,
            leftAt: null
          };
          dirty = true;
        }
        const cur = sum.ftfc;
        if (cur === "up" || cur === "down") {
          if (fst.fired === cur) {
            // still (or back) in the alignment we already fired for
            if (fst.leftAt !== null) { fst.leftAt = null; dirty = true; }
          } else {
            fst.fired = cur;
            fst.leftAt = null;
            dirty = true;
            fire("[FTFC] " + sym + " FTFC " + cur + " ("
              + ftfcTfs.map(label).join("/") + ") | score " + fmtScore(score)
              + " rvol " + fmtRv(rv), now, meta);
          }
        } else if (fst.fired !== null) {
          if (fst.leftAt === null) { fst.leftAt = now; dirty = true; }
          if (now - fst.leftAt >= rearmMs) {
            fst.fired = null;
            fst.leftAt = null;
            dirty = true;
          }
        }
      }
    }

    // ---- price_level ----
    // Fires once per crossing direction (side transition), with an optional
    // re-arm band: inside the band the side is unchanged, so chop exactly at
    // the level cannot alternate-fire. First observation is a silent baseline.
    if (enabled("price_level") && coin.mid) {
      const levelsMap = cfg("price_level").levels || {};
      const levels = levelsMap[coin.sym] || levelsMap[coin.name] || [];
      const band = num(cfg("price_level").rearmPct, 0) / 100;
      for (const lvl of levels) {
        if (typeof lvl !== "number" || !isFinite(lvl)) continue;
        const key = coin.name + "|" + lvl;
        const side = coin.mid > lvl * (1 + band) ? "above"
          : (coin.mid < lvl * (1 - band) ? "below" : null);
        if (!side) continue;
        const prev = st.levelSides[key];
        if (prev === undefined) { st.levelSides[key] = side; dirty = true; continue; }
        if (side !== prev) {
          st.levelSides[key] = side;
          dirty = true;
          fire("[LEVEL] " + sym + " crossed " + side + " " + fmtPx(lvl)
            + " | mid " + fmtPx(coin.mid), now, meta);
        }
      }
    }

    // ---- rvol_spike ----
    // Fires once per 15m bar when rvol >= threshold (keyed on the forming
    // 15m bar's open time). Volume only trues up on refetch, so this is
    // naturally sub-bar-spam-proof on top of the per-bar dedup.
    // minNotional is a MEANINGFULNESS filter, not a noise filter
    // (measured 2026-08-10/31): a genuine 3x spike on $1.5k of book is
    // untradeable. Below the floor the dedup key is NOT consumed - volume
    // trues up within the bar, so the same bar may still fire later once
    // real money has actually traded. floor 0 (the default) preserves the
    // pre-floor behavior exactly, including when the forming bar lacks a
    // usable close (ntl NaN renders "-" and never blocks).
    if (enabled("rvol_spike") && rv !== null) {
      const th = num(cfg("rvol_spike").threshold, 3.0);
      const floor = num(cfg("rvol_spike").minNotional, 0);
      const slot = coin.tf["15m"];
      if (slot && slot.forming && rv >= th) {
        const ntl = slot.forming.v * slot.forming.c;
        if (!(floor > 0) || ntl >= floor) {
          const key = coin.name + "|" + slot.forming.t;
          if (!(key in st.rvolFired)) {
            st.rvolFired[key] = now;
            fire("[RVOL] " + sym + " 15m rvol " + fmtRv(rv) + " (>= " + th + ") | ntl "
              + fmtNtl(ntl) + " | 15m " + fmtPct(mom.r15) + " 1h " + fmtPct(mom.r60)
              + " score " + fmtScore(score), now, meta);
          }
        }
      }
    }

    // ---- move_spike ----
    // Abnormal short-window move, per-coin adaptive: fires when the move off
    // the last CLOSED 15m close reaches max(minPct, mult * the coin's own
    // average 15m true range). ATR-normalized so an abnormal 0.8% on an
    // index perp fires while the same move on a meme coin is business as
    // usual. Intrabar (checked every mids tick, so retraced wicks still
    // fire - that IS the sharp-swing use case); once per coin per DIRECTION
    // per 15m bar. Calibrated 2026-07-07 on 10h of live bars: mult 3 /
    // minPct 0.75 = ~17 close-based fires/day on xyz (intrabar adds some).
    if (enabled("move_spike") && coin.mid) {
      const slot15 = coin.tf["15m"];
      const ntr = tr15AvgPct(coin);
      if (slot15 && slot15.forming && slot15.closed.length && ntr !== null && ntr > 0) {
        const prevC = slot15.closed[slot15.closed.length - 1].c;
        if (prevC) {
          const mv = (coin.mid / prevC - 1) * 100;
          const th = Math.max(num(cfg("move_spike").minPct, 0.75),
                              num(cfg("move_spike").mult, 3) * ntr);
          if (Math.abs(mv) >= th) {
            const key = coin.name + "|" + slot15.forming.t + "|" + (mv > 0 ? "up" : "down");
            if (!(key in st.moveFired)) {
              st.moveFired[key] = now;
              fire("[SPIKE] " + sym + " " + fmtPct(mv) + " in 15m ("
                + (Math.abs(mv) / ntr).toFixed(1) + "x its normal range)"
                + " | rvol " + fmtRv(rv) + " score " + fmtScore(score), now, meta);
            }
          }
        }
      }
    }
  }

  // Is this coin in the FAVORITES-ONLY alert scope right now? Only consulted
  // for universes in ALERT_FAVS_UNIVERSES; `favs` is the union computed once
  // per pass (null when the favorites path is off or the union is empty).
  function inFavsScope(coin, favs) {
    if (!alertFavsUniverses || alertFavsUniverses.indexOf(coin.uni) < 0) return false;
    return favMatches(favs, coin.name, coin.sym);
  }

  function evaluateAll(loopState) {
    const now = Date.now();
    // The loop's true-up scope for this pass (see volScope above). Absent on
    // legacy/unit-test states -> null -> volumeFresh passes everything.
    volScope = Array.isArray(loopState.trueUpUniverses) ? loopState.trueUpUniverses : null;
    // Recomputed per pass, not cached: a phone re-registering with a changed
    // favorites list must take effect on the next tick, and a stale union
    // would alert on a coin the operator just un-favorited. A few hundred
    // strings; the per-coin test below is the same indexOf delivery uses.
    const favs = (alertFavsUniverses && alertFavsUniverses.length && favUnionFn)
      ? favUnionFn() : null;
    for (const name of loopState.order) {
      const coin = loopState.coins[name];
      if (!coin) continue;
      // Broadcast scope (ALERT_UNIVERSES) is checked FIRST and is unchanged,
      // so a universe named in both lists can only ever resolve to the wider
      // behavior - the parse drops such an id from the favorites list for the
      // same reason. Screener-only coins are skipped before any rule runs, so
      // they never create dedup/re-arm state - rule_state.json stays identical
      // to an alert-universe-only deploy.
      const broadcast = !alertUniverses || alertUniverses.indexOf(coin.uni) >= 0;
      let baseline = false;
      if (!broadcast) {
        if (!inFavsScope(coin, favs)) {
          // Out of scope. Dedup state is deliberately KEPT (a re-favorite must
          // not replay bars already alerted), but the scope-entry marker is
          // dropped so a later re-entry baselines again: while out of scope the
          // coin is not evaluated at all, so its recorded state ages into a
          // stale verdict, and firing off a stale verdict is exactly what
          // dropCoins already guards against for re-listed names.
          if (hasOwn(st.favScoped, coin.name)) { delete st.favScoped[coin.name]; dirty = true; }
          continue;
        }
        // A coin with NO timeframe data cannot be baselined - roster recovery
        // (loop.js refreshCtxs) registers coins with tf:{}, and consuming the
        // marker then would make the first REAL observation (candles arriving
        // with an already-live signal) fire as if it were a fresh transition
        // (review HIGH; the same class as the 2026-08-07 ftfc_flip
        // empty-tf finding). Slot presence is the test - slots are created at
        // fetch time WITH data, so any slot means there is state to record.
        const evaluable = !!coin.tf && Object.keys(coin.tf).length > 0;
        if (!evaluable) continue;
        // hasOwn, never `in`: a favorite literally named "constructor" or
        // "toString" would otherwise read as already-baselined via
        // Object.prototype and fire immediately (review LOW).
        baseline = !hasOwn(st.favScoped, coin.name);
        if (baseline) { st.favScoped[coin.name] = now; dirty = true; }
      }
      try { evaluateCoin(coin, now, baseline); }
      catch (e) { log("rule eval failed for " + name + ": " + (e && e.message)); }
    }
  }

  function prune(now) {
    for (const mapName of ["liveFired", "invalFired", "rvolFired", "moveFired"]) {
      const m = st[mapName];
      for (const k of Object.keys(m)) {
        const end = keyBarEnd(mapName, k);
        const ref = end === null ? m[k] : Math.max(end, m[k]);
        if (now - ref > PRUNE_MS) delete m[k];
      }
    }
  }

  // Roster removal support: drop EVERY piece of state keyed to a removed
  // coin. The per-bar maps would self-prune 48h past bar end anyway, but the
  // per-coin maps (scoreArm, ftfcState, levelSides) are never pruned - and a
  // stale ftfcState entry is a live hazard: a RE-LISTED name would skip the
  // silent first-observation baseline and could fire on a months-old verdict
  // (Hyperliquid reuses tickers - the SPCX lesson from the underlying-data
  // side). Dropping everything makes a re-list behave exactly like a new
  // listing. Coin names never contain "|", so the prefix test is exact.
  function dropCoins(names) {
    if (!Array.isArray(names)) return;
    for (const name of names) {
      if (name in st.scoreArm) { delete st.scoreArm[name]; dirty = true; }
      if (name in st.ftfcState) { delete st.ftfcState[name]; dirty = true; }
      if (hasOwn(st.favScoped, name)) { delete st.favScoped[name]; dirty = true; }
      const prefix = name + "|";
      for (const mapName of ["levelSides", "liveFired", "invalFired", "rvolFired", "moveFired"]) {
        const m = st[mapName];
        for (const k of Object.keys(m)) {
          if (k.indexOf(prefix) === 0) { delete m[k]; dirty = true; }
        }
      }
    }
  }

  // Atomic JSON dump: write tmp then rename (JSON only, never pickle).
  function persistNow() {
    if (!statePath) return;
    prune(Date.now());
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = statePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, statePath);
    dirty = false;
  }

  if (statePath) {
    const t = setInterval(function () {
      if (!dirty) return;
      try { persistNow(); }
      catch (e) { log("rule state persist failed: " + (e && e.message)); }
    }, 30000);
    t.unref();
  }

  return {
    evaluateCoin: evaluateCoin,
    evaluateAll: evaluateAll,
    persistNow: persistNow,
    dropCoins: dropCoins,
    alertsFired: function () { return fired; },
    _state: st,   // exposed for tests
    _prune: prune // exposed for tests
  };
}

module.exports = { createRuleEngine };
