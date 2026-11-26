"use strict";

// Component telemetry collector (design review 2026-07-20):
// a 30d+ time series of the heat score's term values, the D/W/M gate, and
// exclusion counts, so future tuning (ATR momentum constants, sort
// smoothing, thresholds) is validated against lived data instead of
// snapshots. Passive: reads loop state on a timer, never touches the loop.
//
// Storage: append-only JSONL under data/telemetry/, one file per UTC day
// (telemetry-YYYY-MM-DD.jsonl). Yesterday's file is gzipped on the first
// sample of a new day; files older than PRUNE_DAYS are deleted. data/ is
// EPHEMERAL unless it sits on a persistent volume - without one the series
// restarts on every redeploy.
//
// Line shape (compact - repeated keys cost real bytes at 264 coins):
//   {"t":<ms>,"v":3,"sv":<score_v>,
//    "c":{"<name>":[score,dot,mom,inf,act,"u|d|n",oof,live,flags,r60,atr1h],...}}
//   sv: metrics.SCORE_V at sample time - the series splits cleanly at every
//       formula-semantics change (e.g. the mom column is fixed-1.5-normalized
//       under sv 2 and ATR-normalized under sv 3)
//   score: heat score (null when unscored)
//   dot/mom/inf/act: term values rounded to 3 decimals
//   "u"/"d"/"n": dwmContinuity.dir (n = mixed OR incomplete; see flags)
//   oof: live signals excluded as out-of-force this sample. Populated in the
//       null tuple too (an unready coin's ANALYZED TFs can still carry
//       out-of-force signals; code review) - early v3 lines wrote a
//       literal 0 there, so treat null-tuple oof as unreliable before this
//       fix's deploy. The literal-0 FALLBACK applies only when the
//       configured TF set is empty (heatComponents null); on a nonempty
//       set an oof of 0 is a real count - nothing was excluded
//   live: total live signals on the configured fast TFs
//   flags bitfield: 1 = rvol missing, 2 = a fast TF invalidated,
//                   4 = dwm coverage incomplete,
//                   8 = r60 served by a NON-EXACT source (candle fallback:
//                       tape immature OR the exact anchor aged out),
//                  16 = momentum on the fixed 1.5% scale (yardstick null
//                       OR a true zero yardstick),
//                  32 = STALE ENDPOINT: this coin's mids stopped arriving
//                       > MID_STALE_MS ago (review 2026-07-25 F1) - the
//                       sample is NOT calibration-grade,
//                  64 = 1h yardstick slot present (>= 21 bars) but OVERDUE
//                       (failed rolls - review F3); 16 rides along since
//                       the fixed scale was used,
//                 128 = volume NOT TRUED UP for this coin's universe
//                       (loop.js trueUpUniverses, the demand cut):
//                       rvol nulled for parity with /api/state -
//                       distinguishes this null from a young coin's
//                       (< 8 closed 15m bars); 1 rides along since rv
//                       is null,
//                 256 = coin UNREADY (metrics.readiness: a configured TF
//                       lacks analysis, missingTfs > 0): score nulled for
//                       parity - the API serves null, never the
//                       fake-neutral 0 a flat-padded summary produces
//   r60/atr1h (v2, review F4): the RAW momentum inputs, 3 decimals, null
//       when unavailable - mom above is already clamped to +/-1, so replay
//       of alternative K constants / yardstick floors needs these
//   v history: v1 tuples are 9 elements (no raw r60/atr1h; flags <= 31).
//       Legacy lines WITHOUT sv predate e01a808 and are score_v 2-era; map
//       absent sv to 2 by deployment history, never to top-level v.
//       v3 (parity repair, 2026-08-24): lineFor
//       mirrors the SAME readiness and true-up-scope gates buildApiState
//       applies, so the recorded score/rvol agree with the served ones -
//       score is null + flag 256 where v2 wrote 0 (or another number off
//       the flat-padded summary) for unready coins, and rvol is null +
//       flag 128 (activity on its documented null-default path) where v2
//       fed a DECAYED number for universes outside the true-up scope.
//       Split any cross-version analysis at the v2->v3 boundary: v2 perps
//       samples after the 2026-08-17 demand cut are contaminated and
//       carry no distinguishing flag.
// TF roll tags are deliberately NOT stored: every TF rolls on UTC clock
// boundaries (15m/1h/4h aligned, 1d 00:00Z, 1w Monday, 1M month start), so
// analysis derives roll adjacency from `t` alone.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const metrics = require("./metrics.js");

const DEFAULT_INTERVAL_MS = 300000; // 5 min - matches the RVOL refresh pace
const PRUNE_DAYS = 35;

function utcDay(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}
function r3(v) { return Math.round(v * 1000) / 1000; }

// opts: { dir, ftfcTfs, log, intervalMs }
function createTelemetry(opts) {
  const dir = opts.dir;
  const ftfcTfs = opts.ftfcTfs || ["15m", "1h", "4h", "1d"];
  const log = opts.log || function () {};
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  let timer = null;
  let samples = 0, lastSampleTs = null, lastError = null;
  let currentDay = null;

  function lineFor(state, now) {
    const c = {};
    for (let i = 0; i < state.order.length; i++) {
      const coin = state.coins[state.order[i]];
      if (!coin) continue;
      const sum = metrics.coinSummary(coin, ftfcTfs);
      const rd = metrics.readiness(coin, ftfcTfs);
      const mom = metrics.momentum(coin, now);
      // PARITY with buildApiState (v3): the same two gates, from the same
      // inputs. A universe outside the 5-min true-up scope has its forming
      // 15m volume frozen at the roll-time sample, so its pace-adjusted
      // rvol decays toward zero across the bar - the API serves null and
      // the score's activity term takes its documented null-default path;
      // recording anything else scores a number the API never served. The
      // loop resolves trueUpUniverses to the full tracked list when
      // unscoped, so absent (unit tests, legacy callers) means all fresh.
      const volFresh = !state.trueUpUniverses
        || state.trueUpUniverses.indexOf(coin.uni) >= 0;
      const rv = volFresh ? metrics.rvol15(coin, now) : null;
      const y = metrics.tr1hAvgPct(coin, now);
      const hc = metrics.heatComponents(sum, mom, rv, coin.mid, y);
      const dwm = metrics.dwmContinuity(coin);
      const h = coin.hist;
      const s1h = coin.tf && coin.tf["1h"];
      let flags = 0;
      if (rv === null) flags |= 1;
      if (sum.inval) flags |= 2;
      if (!dwm.complete) flags |= 4;
      if (mom.r60Src === "candle") flags |= 8;
      if (!(y > 0)) flags |= 16;
      if (h && h.length && now - h[h.length - 1].t > metrics.MID_STALE_MS) flags |= 32;
      if (y === null && s1h && s1h.closed && s1h.closed.length >= 21) flags |= 64;
      if (!volFresh) flags |= 128;
      if (!rd.ready) flags |= 256;
      const r60Raw = mom.r60 === null ? null : r3(mom.r60);
      const yRaw = y === null ? null : r3(y);
      // Unready coins take the null tuple (the API serves score null while
      // any configured TF lacks analysis - flat-padded dots would score a
      // fake neutral): terms null together, diagnostics still recorded.
      c[state.order[i]] = (hc === null || !rd.ready)
        ? [null, null, null, null, null, dwm.dir ? dwm.dir[0] : "n",
           hc === null ? 0 : hc.oof, sum.live.length, flags,
           r60Raw, yRaw]
        : [hc.score, r3(hc.dotNetFast), r3(hc.momentumAbnormal), r3(hc.inForceNet),
           r3(hc.activity), dwm.dir ? dwm.dir[0] : "n", hc.oof, sum.live.length, flags,
           r60Raw, yRaw];
    }
    return JSON.stringify({ t: now, v: 3, sv: metrics.SCORE_V, c: c });
  }

  // Gzip a finished day file and remove the raw original. Best-effort.
  function compress(file) {
    return new Promise(function (resolve) {
      fs.readFile(file, function (err, buf) {
        if (err) return resolve();
        zlib.gzip(buf, function (gerr, gz) {
          if (gerr) return resolve();
          fs.writeFile(file + ".gz", gz, function (werr) {
            if (werr) return resolve();
            fs.unlink(file, function () { resolve(); });
          });
        });
      });
    });
  }

  function prune(now) {
    return new Promise(function (resolve) {
      fs.readdir(dir, function (err, names) {
        if (err) return resolve();
        const cutoff = utcDay(now - PRUNE_DAYS * 86400000);
        let pendingOps = 0, done = false;
        names.forEach(function (n) {
          const m = /^telemetry-(\d{4}-\d{2}-\d{2})\.jsonl(?:\.gz)?$/.exec(n);
          if (m && m[1] < cutoff) {
            pendingOps++;
            fs.unlink(path.join(dir, n), function () {
              pendingOps--;
              if (done && !pendingOps) resolve();
            });
          }
        });
        done = true;
        if (!pendingOps) resolve();
      });
    });
  }

  // One sample: rotate if the UTC day changed, then append. Returns a
  // promise for tests; the timer path fires and forgets.
  function sampleOnce(state, now) {
    now = now || Date.now();
    const day = utcDay(now);
    let rotation = Promise.resolve();
    if (currentDay && currentDay !== day) {
      const prev = path.join(dir, "telemetry-" + currentDay + ".jsonl");
      rotation = compress(prev).then(function () { return prune(now); });
    }
    currentDay = day;
    const file = path.join(dir, "telemetry-" + day + ".jsonl");
    const line = lineFor(state, now);
    return rotation.then(function () {
      return new Promise(function (resolve) {
        fs.appendFile(file, line + "\n", function (err) {
          if (err) {
            lastError = err.message;
            log("[telemetry] append failed: " + err.message);
          } else {
            samples++; lastSampleTs = now; lastError = null;
          }
          resolve();
        });
      });
    });
  }

  function start(state) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
      lastError = e.message;
      log("[telemetry] disabled - cannot create " + dir + ": " + e.message);
      return;
    }
    timer = setInterval(function () {
      try { sampleOnce(state); } catch (e) {
        lastError = e.message;
        log("[telemetry] sample threw: " + e.message); // must never crash the worker
      }
    }, intervalMs);
    if (timer.unref) timer.unref();
    log("[telemetry] sampling every " + Math.round(intervalMs / 1000) + "s -> " + dir);
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  function stats() {
    return { samples: samples, lastSampleTs: lastSampleTs, lastError: lastError };
  }

  return { start: start, stop: stop, sampleOnce: sampleOnce, stats: stats,
           _lineFor: lineFor };
}

module.exports = { createTelemetry, DEFAULT_INTERVAL_MS, PRUNE_DAYS };
