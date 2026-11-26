"use strict";

// Sweep every US-fetchable xyz underlying and report what its history can
// honestly support.
//
// WHY THIS EXISTS: the SPCX defect was found by accident. Massive returns 451
// bars for it, but the series is a flat ~$23 SPAC trust until 2026-04-06, then
// a 67-day hole, then SpaceX at ~$108 from its 2026-06-12 IPO - the ticker was
// reused, and only 34 bars describe the company. Nothing about that response
// looks wrong; a raw bar count says quarterly structure is available. If one
// symbol has it, others can, and finding them by accident does not scale.
//
// This is DIAGNOSTIC ONLY. It reads from the vendor and writes a report; it
// touches no state, no payload, and no detection. Run it before trusting any
// higher-timeframe underlying level, and re-run it when the roster changes.
//
// Usage:
//   node --env-file=.env scripts/underlying_history_check.js
//   node --env-file=.env scripts/underlying_history_check.js --from 2015-01-01
//   node --env-file=.env scripts/underlying_history_check.js --limit 10
//   node --env-file=.env scripts/underlying_history_check.js --json out.json
//
// Pacing: the Massive FREE tier allows 5 requests/minute, so the default delay
// is 13s and a full 64-symbol sweep takes roughly 14 minutes. On a paid tier
// calls are unlimited - pass --delay 0. A 429 is retried once after a longer
// pause rather than being recorded as a data problem, because "we went too
// fast" and "this symbol is broken" must never end up in the same bucket.
//
// FREE-TIER WINDOW (measured 2026-08-05): the free tier serves exactly TWO
// YEARS, roughly 500 daily bars, regardless of how far back --from asks. It
// truncates the OLD end and always ends at the present session, which is the
// safe direction - a cap that dropped RECENT bars would silently hand back
// stale prices that still look current. Two consequences: quarterly barely
// clears its 252-bar threshold, and a "first bar" near two years ago is a
// WINDOW EDGE, not the instrument's listing date. Do not read it as one.

// --classify NOTE: a discontinuity has three very different causes, and the
// continuity guard cannot tell them apart from raw bars alone. Measured
// 2026-08-05 across the roster:
//
//   SPLIT              a corporate action on the SAME instrument. Adjustment
//                      removes it. MSTR (10-for-1), NFLX, XLE, NOW, and BIRD's
//                      2024 reverse split. Raw levels either side are not
//                      comparable, so truncating IS correct for a raw series.
//   INSTRUMENT CHANGE  a different thing behind the same ticker. Adjustment
//                      does NOT remove it. SPCX, SHAZ, BIRD's 2026 pivot.
//                      Truncating is correct and unavoidable.
//   REAL PRICE MOVE    the instrument simply moved hard in one session. NBIS
//                      +51.7% and BE +57.8%. Adjustment does not remove it
//                      either - because there is nothing to remove. Truncating
//                      here is a FALSE POSITIVE that discards valid history.
//
// The guard still truncates all three, deliberately: over-truncating costs
// history, while under-truncating would compute breaks against pre-split levels
// that no longer exist. The safe error is the one we take. --classify exists so
// a human can see which downgrades are real and which are the false positive,
// by refetching the same window ADJUSTED and checking whether the jump survives.
const { fetchDailyBars, analyzeContinuity, usableTimeframes, ERR, DEFAULT_BASE } = require("../src/underlying.js");
const { UNDERLYING, lookup, fetchableSymbols } = require("../src/underlying_map.js");
const DEFAULT_BASE_URL = DEFAULT_BASE;

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const FROM = String(arg("from", "2015-01-01"));
const TO = String(arg("to", new Date().toISOString().slice(0, 10)));
const DELAY_MS = Number(arg("delay", 13000));
const LIMIT = Number(arg("limit", 0));
const JSON_OUT = arg("json", null);
const CLASSIFY = arg("classify", false) !== false;

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function iso(t) { return t ? new Date(t).toISOString().slice(0, 10) : "-"; }

// Refetch the SAME window split-adjusted and see whether the largest jump
// survives. Deliberately bypasses the adapter's raw-only guard, because this is
// the one place we WANT the adjusted series - as a comparison, never as data we
// derive levels from. Massive adjusts for splits only and never dividends, so a
// jump that disappears here is a split and nothing else.
async function classifyBreak(ticker, rawJumpPct) {
  const url = DEFAULT_BASE_URL + "/v2/aggs/ticker/" + encodeURIComponent(ticker) +
    "/range/1/day/" + FROM + "/" + TO + "?adjusted=true&sort=asc&limit=50000";
  let body;
  try {
    const res = await fetch(url, { headers: { Authorization: "Bearer " + process.env.MASSIVE_API_KEY } });
    body = await res.json();
  } catch (e) { return "unknown (adjusted refetch failed)"; }
  const rs = Array.isArray(body.results) ? body.results : [];
  let maxJump = 0;
  for (let i = 1; i < rs.length; i++) {
    const p = rs[i - 1].c;
    if (p > 0) maxJump = Math.max(maxJump, Math.abs((rs[i].o - p) / p) * 100);
  }
  // Adjustment collapsed it -> split. It survived at roughly full size -> the
  // instrument itself did that, either by changing or by genuinely moving.
  if (maxJump < rawJumpPct * 0.5) return "SPLIT (adjustment removes it; history is recoverable via adjusted bars)";
  return "NOT a split - either an instrument change or a genuine one-session move";
}

async function fetchWithOneRetry(ticker) {
  let r = await fetchDailyBars(ticker, FROM, TO);
  if (r.ok || r.code !== ERR.RATE_LIMIT) return r;
  // Rate limiting is our problem, not the symbol's. Back off well past the
  // one-minute window before deciding anything about this ticker.
  process.stdout.write(" (rate limited, backing off 70s)");
  await wait(70000);
  r = await fetchDailyBars(ticker, FROM, TO);
  return r;
}

async function main() {
  let symbols = fetchableSymbols();
  const only = arg("only", null);
  if (typeof only === "string") {
    const want = only.split(",").map(function (s) { return s.trim().toUpperCase(); }).filter(Boolean);
    const known = new Set(symbols);
    const missing = want.filter(function (s) { return !known.has(s); });
    if (missing.length) {
      // Silently ignoring a typo would look like "that symbol is clean".
      console.error("unknown or non-fetchable symbol(s): " + missing.join(", "));
      process.exit(1);
    }
    symbols = want;
  }
  if (LIMIT > 0) symbols = symbols.slice(0, LIMIT);

  console.log("Underlying history check");
  console.log("  range      : " + FROM + " -> " + TO);
  console.log("  symbols    : " + symbols.length + " of " + Object.keys(UNDERLYING).length + " (US-fetchable only)");
  console.log("  pacing     : " + DELAY_MS + "ms between calls");
  console.log("");

  const rows = [];
  for (let i = 0; i < symbols.length; i++) {
    if (i) await wait(DELAY_MS);
    const sym = symbols[i];
    const meta = lookup(sym);
    process.stdout.write(String(i + 1).padStart(3) + "/" + symbols.length + "  " + sym.padEnd(9));

    const r = await fetchWithOneRetry(meta.ticker);
    if (!r.ok) {
      console.log(" ERROR  " + r.code + "  " + r.message);
      rows.push({ sym: sym, ticker: meta.ticker, ok: false, code: r.code });
      continue;
    }

    const cont = analyzeContinuity(r.bars);
    const rawTf = usableTimeframes(cont.totalBars).usable;
    const effTf = usableTimeframes(cont.effectiveBars).usable;
    const downgraded = rawTf.length !== effTf.length;

    rows.push({
      sym: sym, ticker: meta.ticker, ok: true,
      totalBars: cont.totalBars, effectiveBars: cont.effectiveBars,
      firstT: r.bars[0].t, effectiveFromT: cont.effectiveFromT,
      breaks: cont.breaks, rawTf: rawTf, effTf: effTf,
      downgraded: downgraded, caveat: meta.caveat || null
    });

    let line = " bars " + String(cont.totalBars).padStart(5) +
      "  eff " + String(cont.effectiveBars).padStart(5) +
      "  " + (effTf.join(",") || "none");
    if (downgraded) line += "   <-- DOWNGRADED from " + rawTf.join(",");
    if (cont.breaks.length) line += "   breaks:" + cont.breaks.length;
    console.log(line);
  }

  // ---- report ----
  const okRows = rows.filter(function (r) { return r.ok; });
  const failed = rows.filter(function (r) { return !r.ok; });
  const downgraded = okRows.filter(function (r) { return r.downgraded; });
  const withBreaks = okRows.filter(function (r) { return r.breaks.length; });

  console.log("");
  console.log("=".repeat(72));
  console.log("SUMMARY");
  console.log("  fetched ok        : " + okRows.length + "/" + rows.length);
  console.log("  failed            : " + failed.length);
  console.log("  with discontinuity: " + withBreaks.length);
  console.log("  TIMEFRAME DOWNGRADE: " + downgraded.length + "  (raw bar count would have over-promised)");

  if (downgraded.length) {
    console.log("");
    console.log("THESE OVER-PROMISE ON A RAW BAR COUNT - always scope with analyzeContinuity():");
    for (const r of downgraded) {
      console.log("  " + r.sym.padEnd(9) + " raw[" + r.rawTf.join(",") + "] -> eff[" + (r.effTf.join(",") || "none") + "]" +
        "   " + r.totalBars + " bars but only " + r.effectiveBars + " since " + iso(r.effectiveFromT));
      for (const b of r.breaks) {
        console.log("      break " + iso(b.fromT) + " -> " + iso(b.toT) +
          "  gap " + b.gapDays + "d  jump " + b.jumpPct + "%  (" + b.reason + ")");
      }
    }
  }

  if (withBreaks.length) {
    console.log("");
    console.log("ALL DISCONTINUITIES (including ones that did not change the timeframe verdict):");
    for (const r of withBreaks) {
      for (const b of r.breaks) {
        console.log("  " + r.sym.padEnd(9) + iso(b.fromT) + " -> " + iso(b.toT) +
          "  gap " + String(b.gapDays).padStart(4) + "d  jump " + String(b.jumpPct).padStart(7) + "%  " + b.reason);
      }
    }
    if (CLASSIFY) {
      console.log("");
      console.log("CLASSIFICATION (refetching adjusted; a jump that vanishes was a split):");
      for (let i = 0; i < withBreaks.length; i++) {
        if (i) await wait(DELAY_MS);
        const r = withBreaks[i];
        const biggest = r.breaks.reduce(function (a, b) { return b.jumpPct > a.jumpPct ? b : a; });
        const verdict = await classifyBreak(r.ticker, biggest.jumpPct);
        console.log("  " + r.sym.padEnd(9) + verdict);
      }
      console.log("");
      console.log("  A 'genuine one-session move' is a FALSE POSITIVE of the guard - the history is");
      console.log("  valid and the truncation is costing you bars. A split or instrument change is");
      console.log("  a true positive. The guard cannot tell them apart, so it truncates all three;");
      console.log("  over-truncating loses history, under-truncating would price breaks off levels");
      console.log("  that no longer exist.");
    } else {
      console.log("");
      console.log("  Re-run with --classify to separate splits from instrument changes from");
      console.log("  genuine one-session moves (the last of those is a guard false positive).");
    }
  }

  if (failed.length) {
    console.log("");
    console.log("FAILED:");
    for (const r of failed) console.log("  " + r.sym.padEnd(9) + r.ticker + "  " + r.code);
  }

  // Symbols whose series is dangerous for reasons arithmetic cannot see. BIRD
  // is the standing example: unbroken bars, but pre-April-2026 it was Allbirds
  // the shoe company. No gap, no jump, nothing to detect - it needs the roster
  // map, which is why the caveat is reprinted here rather than assumed known.
  const caveated = okRows.filter(function (r) { return r.caveat; });
  if (caveated.length) {
    console.log("");
    console.log("CAVEATS FROM THE ROSTER MAP (these are NOT all detectable from price):");
    for (const r of caveated) console.log("  " + r.sym.padEnd(9) + r.caveat);
  }

  if (JSON_OUT && typeof JSON_OUT === "string") {
    require("node:fs").writeFileSync(JSON_OUT, JSON.stringify({ from: FROM, to: TO, rows: rows }, null, 2));
    console.log("");
    console.log("wrote " + JSON_OUT);
  }
}

main().catch(function (e) {
  console.error("check failed:", e && e.message ? e.message : e);
  process.exit(1);
});
