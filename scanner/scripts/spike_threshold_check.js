"use strict";

// move_spike threshold diagnostic: per-asset-class spike calibration, with
// INDICES as the motivating case.
//
// THE RULE (src/rules.js): fires when the move off the last closed 15m close
// reaches th = max(minPct 0.75, mult 3 * tr15AvgPct(coin)).
//
// The 0.75 is a FLOOR, and that is the whole subject of this script. Wherever
// 3 * ntr < 0.75 the per-coin ATR normalization is switched OFF and a flat
// percentage governs instead. The headline number reported per coin is the
// REQUIRED MULTIPLE - how many multiples of a coin's own normal 15m range it
// must move to fire. The rule's design intent is 3.0x for every coin; anything
// above 3.0x is a coin the floor is holding back.
//
// READ THE SESSION BANNER BEFORE READING THE NUMBERS. This is the trap that
// makes the output actively misleading if ignored: xyz perps trade 24/7 but
// their UNDERLYINGS do not. Measured while the US cash session is closed, every
// US-tracking symbol shows overnight volatility, its ntr collapses, and it
// looks floor-bound purely because of the clock. A 2026-08-10 23:11 ET capture
// showed SP500 needing 17.3x while KR200 - also an index, but with Seoul OPEN -
// needed exactly 3.0x. That is a SESSION effect wearing an asset-class costume.
// To answer the per-class question the capture must be IN SESSION for the class
// being judged, which is why this is a script and not a one-off number.
//
// --volume runs the SECOND diagnostic: a backtest of the rvol_spike rule,
// which exists in src/rules.js and config.json and is `enabled: false`. It
// answers "what should a volume spike be?" with a threshold sweep instead of
// a guess. See the notes on that mode below.
//
// Usage (defaults to the local worker; set STATE_URL for production):
//   node scripts/spike_threshold_check.js
//   node scripts/spike_threshold_check.js --volume
//   STATE_URL=https://<your-worker-host>/api/state node scripts/spike_threshold_check.js
//   node scripts/spike_threshold_check.js --uni=perps

const path = require("node:path");
const { UNDERLYING } = require(path.join(__dirname, "..", "src", "underlying_map.js"));

const API = "https://api.hyperliquid.xyz/info";
const STATE_URL = process.env.STATE_URL || "http://127.0.0.1:8787/api/state";
const UNI = (process.argv.find((a) => a.startsWith("--uni=")) || "--uni=xyz").split("=")[1];
const VOLUME_MODE = process.argv.includes("--volume");

// Mirrors src/rules.js move_spike config defaults.
const MINPCT = 0.75, MULT = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
      if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(800 * (attempt + 1));
    }
  }
}

// Mirrors src/metrics.js tr15AvgPct EXACTLY - mean true range % over the
// trailing 20 CLOSED 15m bars, null until 21 closed bars exist. If that
// function changes, change this one and say so in the commit.
function tr15AvgPct(closed) {
  if (!closed || closed.length < 21) return null;
  let sum = 0, cnt = 0;
  for (let i = closed.length - 20; i < closed.length; i++) {
    const pc = closed[i - 1].c;
    if (!pc) continue;
    sum += (Math.max(closed[i].h, pc) - Math.min(closed[i].l, pc)) / pc * 100;
    cnt++;
  }
  return cnt ? sum / cnt : null;
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function sessionBanner() {
  const now = new Date();
  const etStr = now.toLocaleString("en-US", {
    timeZone: "America/New_York", weekday: "short", year: "numeric",
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mins = et.getHours() * 60 + et.getMinutes();
  const weekday = et.getDay() >= 1 && et.getDay() <= 5;
  const usOpen = weekday && mins >= 570 && mins < 960;      // 09:30-16:00 ET
  console.log("CAPTURED: " + etStr + " ET   (window = the previous ~5h of 15m bars)");
  console.log("US CASH SESSION: " + (usOpen ? "OPEN" : "CLOSED") +
    (usOpen ? "" : "  <-- US-tracking symbols will read artificially calm; " +
      "do NOT draw per-class conclusions about them from this capture"));
  console.log("");
  return usOpen;
}

// ---------------------------------------------------------------------------
// --volume: backtest the DISABLED rvol_spike rule over recent 15m history.
//
// rvol15() in src/metrics.js is the forming bar's volume over the MEAN of the
// trailing 20 closed bars, pace-adjusted. This walks closed bars instead, so it
// is a LOWER BOUND on the live rule: the live version re-evaluates every mids
// tick and fires if the pace-adjusted ratio clears the threshold at ANY point
// in the bar, which is easiest early in the bar when the sample is thinnest.
//
// The reference budget is move_spike, calibrated 2026-07-07 to ~17 close-based
// fires/day on xyz. A volume rule that wants to sit beside it should land in
// the same order of magnitude.
// ---------------------------------------------------------------------------
async function volumeMode(coins) {
  const BARS = 200;
  const bars = [];        // every evaluable closed bar, universe-wide
  const perCoin = [];
  let spanMs = 0, failed = 0;

  for (let i = 0; i < coins.length; i += 4) {
    await Promise.all(coins.slice(i, i + 4).map(async (c) => {
      const now = Date.now();
      try {
        const raw = await post({
          type: "candleSnapshot",
          req: { coin: c.name, interval: "15m", startTime: now - BARS * 900000, endTime: now }
        });
        const cs = (raw || []).map((b) => ({ v: +b.v, c: +b.c, t: b.t, T: b.T }));
        if (cs.length && cs[cs.length - 1].T > now) cs.pop();
        if (cs.length < 25) { failed++; return; }
        spanMs = Math.max(spanMs, cs[cs.length - 1].T - cs[20].t);
        let fires = 0, evaluated = 0;
        const fireNtl = [];
        for (let k = 20; k < cs.length; k++) {
          let sum = 0;
          for (let j = k - 20; j < k; j++) sum += cs[j].v;
          const avg = sum / 20;
          if (!avg) continue;
          const ratio = cs[k].v / avg, ntl = cs[k].v * cs[k].c;
          bars.push({ ratio, ntl });
          evaluated++;
          if (ratio >= 3) { fires++; fireNtl.push(ntl); }
        }
        if (evaluated) {
          perCoin.push({ sym: c.sym, vol: c.vol || 0, fires, evaluated,
                         firePct: fires / evaluated * 100, medFireNtl: median(fireNtl) || 0 });
        }
      } catch (e) { failed++; }
    }));
    await sleep(250);
  }

  const days = spanMs / 86400000;
  console.log("universe " + UNI + ": " + bars.length + " bar-observations across " +
    perCoin.length + " coins over ~" + days.toFixed(2) + " days" +
    (failed ? " (" + failed + " skipped)" : ""));
  console.log("reference budget: move_spike is ~17 close-based fires/day on xyz\n");

  const sorted = bars.map((b) => b.ratio).sort((a, b) => a - b);
  const pctile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))];
  console.log("RATIO DISTRIBUTION (bar volume / trailing-20 MEAN):");
  [50, 75, 90, 95, 99, 99.9].forEach((p) =>
    console.log("  p" + String(p).padEnd(6) + pctile(p).toFixed(2) + "x"));
  const over3 = bars.filter((b) => b.ratio >= 3).length / bars.length * 100;
  console.log("\n  THE MEDIAN BAR IS " + pctile(50).toFixed(2) + "x THE MEAN. Volume is heavily");
  console.log("  right-skewed, so the mean sits well above typical and '3x the mean' is only");
  console.log("  about " + (3 / pctile(50)).toFixed(0) + "x the MEDIAN bar. The configured rvol 3 " +
    "therefore clears on\n  " + over3.toFixed(1) + "% of all bars - an ordinary event, not a spike.");

  console.log("\nTHRESHOLD SWEEP (fires per DAY across the " + UNI + " universe)");
  console.log("rvol>=   noFloor   $10k floor   $25k floor   $50k floor");
  [3, 4, 5, 6, 8, 10, 15, 20, 30, 50].forEach((th) => {
    const f = (floor) => bars.filter((b) => b.ratio >= th && b.ntl >= floor).length / days;
    console.log(String(th).padEnd(9) + f(0).toFixed(0).padStart(7) +
      f(10000).toFixed(0).padStart(13) + f(25000).toFixed(0).padStart(13) +
      f(50000).toFixed(0).padStart(12));
  });

  // Does the noise concentrate in thin books, as the illiquid-overfire note
  // predicted? Deciles by 24h notional answer it directly.
  perCoin.sort((a, b) => a.vol - b.vol);
  const n = perCoin.length, dec = Array.from({ length: 10 }, () => []);
  perCoin.forEach((p, i) => dec[Math.min(9, Math.floor(i / n * 10))].push(p));
  const totalFires = perCoin.reduce((s, p) => s + p.fires, 0);
  console.log("\nAT rvol 3, BY LIQUIDITY DECILE (0 = thinnest 24h notional)");
  console.log("dec   n    med24hNtl$   medFire%   %ofAllFires   medFiringBar$");
  dec.forEach((g, i) => {
    if (!g.length) return;
    const f = g.reduce((s, p) => s + p.fires, 0);
    console.log(String(i).padEnd(4) + String(g.length).padStart(3) +
      median(g.map((p) => p.vol)).toFixed(0).padStart(14) +
      median(g.map((p) => p.firePct)).toFixed(1).padStart(11) +
      (f / totalFires * 100).toFixed(1).padStart(14) +
      median(g.map((p) => p.medFireNtl)).toFixed(0).padStart(16));
  });
  console.log("\n  A FLAT medFire% column means the noise is NOT a thin-book problem - rvol is");
  console.log("  simply loose everywhere, so a liquidity floor cannot fix the RATE. The floor");
  console.log("  earns its place on the last column instead: a genuine 3x spike on a bar worth");
  console.log("  a few thousand dollars is real and untradeable, which is a MEANINGFULNESS");
  console.log("  filter, not a noise filter. The two are separate knobs - do not conflate them.");
}

(async () => {
  sessionBanner();

  const state = await (await fetch(STATE_URL)).json();
  const coins = state.coins.filter((c) => c.uni === UNI);
  if (!coins.length) { console.error("no coins for universe " + UNI); process.exit(1); }

  if (VOLUME_MODE) { await volumeMode(coins); return; }

  const rows = [];
  let failed = 0;
  const CONC = 4;
  for (let i = 0; i < coins.length; i += CONC) {
    await Promise.all(coins.slice(i, i + CONC).map(async (c) => {
      const now = Date.now();
      try {
        const raw = await post({
          type: "candleSnapshot",
          req: { coin: c.name, interval: "15m", startTime: now - 40 * 900000, endTime: now }
        });
        const cs = (raw || []).map((b) => ({ h: +b.h, l: +b.l, c: +b.c, T: b.T }));
        if (cs.length && cs[cs.length - 1].T > now) cs.pop();   // drop forming, as fetchCandles does
        const ntr = tr15AvgPct(cs);
        if (ntr === null || !(ntr > 0)) { failed++; return; }
        const th = Math.max(MINPCT, MULT * ntr);
        rows.push({
          sym: c.sym,
          cat: (UNDERLYING[c.sym] && UNDERLYING[c.sym].cat) || "unmapped",
          vol: c.vol || 0,
          ntr, th,
          floorBound: MULT * ntr < MINPCT,
          reqMult: th / ntr
        });
      } catch (e) { failed++; }
    }));
    await sleep(250);
  }

  rows.sort((a, b) => a.ntr - b.ntr);
  console.log("universe " + UNI + ": measured " + rows.length + " of " + coins.length +
    (failed ? " (" + failed + " skipped: fetch failed or < 21 closed bars)" : "") + "\n");

  const byCat = {};
  rows.forEach((r) => { (byCat[r.cat] = byCat[r.cat] || []).push(r); });
  console.log("CLASS                 n   medNtr%   medReqMult   floorBound   (intended 3.0x)");
  Object.keys(byCat)
    .sort((a, b) => median(byCat[b].map((r) => r.reqMult)) - median(byCat[a].map((r) => r.reqMult)))
    .forEach((cat) => {
      const g = byCat[cat];
      console.log(
        cat.padEnd(20) + String(g.length).padStart(3) +
        median(g.map((r) => r.ntr)).toFixed(3).padStart(10) +
        median(g.map((r) => r.reqMult)).toFixed(1).padStart(13) +
        (g.filter((r) => r.floorBound).length + "/" + g.length).padStart(13));
    });

  const idx = rows.filter((r) => r.cat === "index");
  if (idx.length) {
    console.log("\nINDICES (the motivating case):");
    idx.forEach((r) => {
      console.log("  " + r.sym.padEnd(9) + "ntr " + r.ntr.toFixed(3) + "%   th " +
        r.th.toFixed(2) + "%   needs " + r.reqMult.toFixed(1) + "x its own range" +
        (r.floorBound ? "   [FLOOR-BOUND]" : ""));
    });
  }

  const fb = rows.filter((r) => r.floorBound);
  console.log("\nFLOOR-BOUND: " + fb.length + "/" + rows.length + " (" +
    (fb.length / rows.length * 100).toFixed(0) + "%) have ATR normalization " +
    "switched off by the " + MINPCT + " floor");
  console.log("\nWORST 10 BY REQUIRED MULTIPLE (the floor holding them back hardest):");
  rows.slice().sort((a, b) => b.reqMult - a.reqMult).slice(0, 10).forEach((r) => {
    console.log("  " + r.sym.padEnd(9) + r.cat.padEnd(14) + "needs " +
      r.reqMult.toFixed(1).padStart(5) + "x   (ntr " + r.ntr.toFixed(3) + "%)");
  });

  // Class is only worth acting on if it SEPARATES - if you can set one number
  // per class and have it be right for the members. Note reqMult is >= 3.0 by
  // construction, so any test phrased as "at least 3.0x" is trivially true for
  // every coin and proves nothing; the comparison has to be against the index
  // MEDIAN, and it has to be run in both directions.
  const eq = rows.filter((r) => r.cat === "us_equity");
  if (idx.length >= 2 && eq.length) {
    const medIdx = median(idx.map((r) => r.reqMult));
    const medEq = median(eq.map((r) => r.reqMult));
    const eqWorse = eq.filter((r) => r.reqMult >= medIdx).length;
    const idxBetter = idx.filter((r) => r.reqMult <= medEq).length;
    console.log("\nDOES CLASS SEPARATE?");
    console.log("  median index " + medIdx.toFixed(1) + "x  vs  median us_equity " +
      medEq.toFixed(1) + "x");
    console.log("  " + eqWorse + "/" + eq.length + " us_equity symbols are AT OR WORSE than the median index");
    console.log("  " + idxBetter + "/" + idx.length + " indices are AT OR BETTER than the median us_equity");
    console.log("  Overlap in both directions means class is the WRONG axis and the per-coin" +
      "\n  ntr-vs-floor relationship is the real discriminator. Judge this only from an" +
      "\n  IN-SESSION capture - out of session the US names collapse for clock reasons.");
  }
})();
