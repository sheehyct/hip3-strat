"use strict";

// External /health sampler. Samples /health every PERIOD seconds for MINUTES
// and reports what the worker's log cannot show directly - whether the served
// revision keeps advancing on the mids cadence through a boundary sweep,
// how old the tape gets as seen by a consumer, and the request-ledger and
// budget counters over the window.
//
//   node scripts/health_probe.js [minutes=20] [periodSec=2] [url]
//   HEALTH_URL=https://<your-worker-host> node scripts/health_probe.js 5
// Default target: http://127.0.0.1:8787 (a local boot).
//
// Output: one line per sample where something moved (revision stalled past
// the threshold, a tape age over the threshold, a 429 counted, a hold), then
// a summary: max midsAgeMs, longest revision stall, samples with the tape
// older than 12 s / 30 s, 429s by kind, holds, sweeps that started.

const DEFAULT_URL = "http://127.0.0.1:8787";
const minutes = Number(process.argv[2]) || 20;
const periodSec = Number(process.argv[3]) || 2;
const base = (process.argv[4] || process.env.HEALTH_URL || DEFAULT_URL).replace(/\/$/, "");
const STALL_MS = 12000;

function iso(t) { return new Date(t).toISOString().slice(11, 19); }

async function sample() {
  const t = Date.now();
  try {
    const r = await fetch(base + "/health", { signal: AbortSignal.timeout(5000) });
    const h = await r.json();
    return { t: t, ok: true, dt: Date.now() - t, h: h };
  } catch (e) {
    return { t: t, ok: false, dt: Date.now() - t, err: e.message };
  }
}

(async function main() {
  const end = Date.now() + minutes * 60000;
  console.log("health probe " + base + " every " + periodSec + " s for " + minutes + " min from " + new Date().toISOString());
  let prev = null;
  let lastRevChangeAt = null, maxStall = 0, maxMidsAge = 0, over12 = 0, over30 = 0, n = 0, failures = 0;
  const r429 = { candle: 0, ctx: 0, mids: 0 };
  let holds0 = null, holdsEnd = null, first = null, last = null;
  while (Date.now() < end) {
    const s = await sample();
    n++;
    if (!s.ok) { failures++; console.log(iso(s.t) + " probe failed: " + s.err); }
    else {
      const h = s.h;
      if (!first) first = h;
      last = h;
      const mids = typeof h.midsAgeMs === "number" ? h.midsAgeMs : null;
      if (mids !== null) {
        if (mids > maxMidsAge) maxMidsAge = mids;
        if (mids > 12000) over12++;
        if (mids > 30000) over30++;
      }
      if (prev && prev.ok) {
        if (h.revision !== prev.h.revision) lastRevChangeAt = s.t;
        else if (lastRevChangeAt !== null) {
          const stall = s.t - lastRevChangeAt;
          if (stall > maxStall) maxStall = stall;
          if (stall > STALL_MS) console.log(iso(s.t) + " revision " + h.revision + " unchanged for " + (stall / 1000).toFixed(0) + " s (midsAgeMs " + mids + ")");
        }
        const lp = prev.h.requests && prev.h.requests.lifetime, lc = h.requests && h.requests.lifetime;
        if (lp && lc) {
          ["candle", "ctx", "mids"].forEach(function (k) {
            const d = (lc[k].r429 || 0) - (lp[k].r429 || 0);
            if (d > 0) { r429[k] += d; console.log(iso(s.t) + " 429 x" + d + " (" + k + ")"); }
          });
        }
        if (h.budget && prev.h.budget && h.budget.holds !== prev.h.budget.holds) {
          console.log(iso(s.t) + " budget hold #" + h.budget.holds + " until " + h.budget.holdUntil + " rate " + h.budget.ratePerMin);
        }
      } else if (lastRevChangeAt === null) lastRevChangeAt = s.t;
      if (mids !== null && mids > 12000 && (!prev || !prev.ok || prev.h.midsAgeMs <= 12000)) {
        console.log(iso(s.t) + " tape older than 12 s: midsAgeMs " + mids + " status " + h.status);
      }
      if (h.budget) { if (holds0 === null) holds0 = h.budget.holds; holdsEnd = h.budget.holds; }
    }
    prev = s;
    const wait = periodSec * 1000 - s.dt;
    if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
  }
  console.log("\n== summary (" + n + " samples, " + failures + " probe failures) ==");
  console.log("  max midsAgeMs: " + maxMidsAge + "  samples > 12 s: " + over12 + "  > 30 s: " + over30);
  console.log("  longest revision stall: " + (maxStall / 1000).toFixed(1) + " s");
  console.log("  429s in window: candle " + r429.candle + " ctx " + r429.ctx + " mids " + r429.mids);
  if (holds0 !== null) console.log("  budget holds in window: " + (holdsEnd - holds0) + (last && last.budget ? "  rate now " + last.budget.ratePerMin + "/min (configured " + last.budget.configuredRatePerMin + ")" : ""));
  if (first && last) {
    console.log("  boot " + (last.briefing && last.briefing.boot_id) + "  revision " + first.revision + " -> " + last.revision
      + "  midsFetchFailures " + first.midsFetchFailures + " -> " + last.midsFetchFailures
      + "  candleFetchFailures " + first.candleFetchFailures + " -> " + last.candleFetchFailures);
  }
})();
