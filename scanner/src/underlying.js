"use strict";

// Underlying-equity daily bars, for perp-vs-underlying alignment. The xyz dex mints perps that track real listed
// instruments; this module fetches the REAL instrument's bars so a perp signal
// can be checked against its underlying's own structure.
//
// Vendor: Massive (formerly Polygon.io - polygon.io now 301s to massive.com and
// the old api.polygon.io endpoints are being phased out, so we target
// api.massive.com). Chosen because it is the only surveyed vendor serving
// CONSOLIDATED US intraday; Tiingo's only intraday equity path is /iex/, and an
// IEX-only tape carries ~3% of volume, so its highs and lows disagree with the
// consolidated tape - fatal for a detector whose whole job is threshold breaks.
//
// TWO HARD RULES, both learned from a vendor survey:
//
// 1. RAW BARS ONLY. Massive defaults to SPLIT-ADJUSTED and we must send
//    adjusted=false. Adjusted history silently moves every price level, so a
//    dropped parameter produces a series that looks completely normal and
//    quietly invalidates every break. Massive echoes an `adjusted` boolean back
//    in the response, so unlike other vendors we can ASSERT the server agreed
//    rather than merely hoping - and we do, treating a mismatch as a hard error.
//
// 2. THE KEY NEVER TRAVELS IN A URL. Massive accepts ?apiKey= but a key in a
//    query string lands in shell history, proxy logs, and error traces. We use
//    the Authorization: Bearer header exclusively, and no code path here logs
//    or returns the key.
//
// Zero dependencies: global fetch only. `fetchImpl` is injectable so the tests
// never touch the network.

const DEFAULT_BASE = "https://api.massive.com";
const DEFAULT_TIMEOUT_MS = 15000;

// Per-timeframe minimum history, in TRADING DAYS.
//
// This exists because the roster is full of 2026 IPOs: on 2026-08-01 CXMT had
// roughly 5 trading days of history, SKHY 16, SPCX 35. A monthly bar built from
// 5 dailies is not missing data - it is CONFIDENTLY WRONG, which is worse,
// because it renders as a normal level nobody questions.
//
// The thresholds are 4 complete bars of the timeframe. Four because that is the
// longest STRAT pattern (a 1-2-2 Rev Strat is 4 bars including bar 0), so fewer
// than four cannot express every pattern the detector looks for. Derived
// independently, these reproduce the per-symbol assessments in
// docs/XYZ_ROSTER_UNDERLYING_MAP_2026-08-01.md - e.g. SHAZ at ~115 days clears
// monthly (84) but not quarterly (252), which is what that document concluded.
const MIN_TRADING_DAYS = {
  daily: 4,        // 4 sessions
  weekly: 20,      // 4 weeks   x 5 sessions
  monthly: 84,     // 4 months  x 21 sessions
  quarterly: 252   // 4 quarters x 63 sessions
};

const TIMEFRAME_ORDER = ["daily", "weekly", "monthly", "quarterly"];

// Error taxonomy. Callers need to tell "your key is wrong" (stop and fix)
// apart from "this symbol has no data" (skip it) apart from "slow down"
// (retry later) - conflating them would make the alignment feature fail
// silently and uniformly.
const ERR = {
  AUTH: "auth",             // key missing, unknown, or rejected
  FORBIDDEN: "forbidden",   // key valid, plan does not cover this request
  RATE_LIMIT: "rate_limit", // too many requests
  NO_DATA: "no_data",       // symbol resolved but returned zero bars
  ADJUSTED: "adjusted",     // server returned adjusted bars - see rule 1
  BAD_RESPONSE: "bad_response",
  NETWORK: "network"
};

function fail(code, message, extra) {
  const out = { ok: false, code: code, message: message };
  if (extra) for (const k of Object.keys(extra)) out[k] = extra[k];
  return out;
}

// Massive returns bars as {t,o,h,l,c,v} with t = epoch ms. Normalize to named
// fields so no caller has to remember the single-letter schema, and carry the
// timestamp through unchanged (UTC epoch ms; callers localize as needed - market
// data is America/New_York per the spine rules, system events are UTC).
function normalizeBar(raw) {
  if (!raw || typeof raw !== "object") return null;
  const t = raw.t, o = raw.o, h = raw.h, l = raw.l, c = raw.c;
  if (![t, o, h, l, c].every(function (v) { return typeof v === "number" && isFinite(v); })) return null;
  // A bar whose high is below its low, or whose open/close sit outside the
  // range, is corrupt. Bar classification compares highs and lows against the
  // prior bar, so a malformed bar does not throw - it silently produces a wrong
  // break. Reject it here instead.
  if (h < l || o > h || o < l || c > h || c < l) return null;
  return {
    t: t,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: typeof raw.v === "number" ? raw.v : null
  };
}

// Fetch raw daily bars for one symbol over [from, to] (YYYY-MM-DD, inclusive).
//
// Returns { ok:true, symbol, bars:[...], adjusted:false, count } on success, or
// { ok:false, code, message } using the ERR taxonomy above. Never throws for a
// network or vendor condition; a throw here is a genuine programming error.
async function fetchDailyBars(symbol, from, to, opts) {
  opts = opts || {};
  const apiKey = opts.apiKey || process.env.MASSIVE_API_KEY;
  const fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const base = opts.base || DEFAULT_BASE;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!symbol || typeof symbol !== "string") {
    return fail(ERR.BAD_RESPONSE, "symbol must be a non-empty string");
  }
  if (!apiKey) {
    // Deliberately does not say where the key should come from beyond the var
    // name - this message can reach logs.
    return fail(ERR.AUTH, "MASSIVE_API_KEY is not set");
  }
  if (!fetchImpl) {
    return fail(ERR.NETWORK, "no fetch implementation available");
  }

  const url = base + "/v2/aggs/ticker/" + encodeURIComponent(symbol) +
    "/range/1/day/" + encodeURIComponent(from) + "/" + encodeURIComponent(to) +
    "?adjusted=false&sort=asc&limit=50000";

  let res;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: "Bearer " + apiKey },
      signal: controller ? controller.signal : undefined
    });
  } catch (e) {
    return fail(ERR.NETWORK, "fetch failed: " + (e && e.message ? e.message : String(e)));
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return fail(res.status === 401 ? ERR.AUTH : ERR.FORBIDDEN,
      "vendor rejected the request (HTTP " + res.status + ")");
  }
  if (res.status === 429) {
    return fail(ERR.RATE_LIMIT, "rate limited by vendor (HTTP 429)");
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    return fail(ERR.BAD_RESPONSE, "response was not JSON (HTTP " + res.status + ")");
  }

  if (!res.ok) {
    const vendorMsg = body && (body.error || body.message) ? String(body.error || body.message) : "";
    return fail(ERR.BAD_RESPONSE, "HTTP " + res.status + (vendorMsg ? ": " + vendorMsg : ""));
  }
  if (body && body.error) {
    return fail(ERR.BAD_RESPONSE, String(body.error));
  }

  // Rule 1, enforced. `adjusted` echoes what the server actually did. If it is
  // true the series is split-adjusted and every level derived from it is wrong,
  // so this is an error and not a warning. If the field is missing we also
  // refuse: we cannot confirm the guard held, and a break detector must not run
  // on unverified prices.
  if (body.adjusted !== false) {
    return fail(ERR.ADJUSTED,
      "vendor did not confirm unadjusted bars (adjusted=" + JSON.stringify(body.adjusted) + ")");
  }

  const rawResults = Array.isArray(body.results) ? body.results : [];
  const bars = [];
  let rejected = 0;
  for (const r of rawResults) {
    const b = normalizeBar(r);
    if (b) bars.push(b); else rejected++;
  }

  if (!bars.length) {
    return fail(ERR.NO_DATA, "no usable bars returned", { rejected: rejected });
  }

  // Ascending by timestamp is requested via sort=asc, but STRAT classification
  // compares each bar to its predecessor, so out-of-order input would produce
  // wrong bar types rather than an obvious failure. Sort defensively.
  bars.sort(function (a, b) { return a.t - b.t; });

  return {
    ok: true,
    symbol: symbol,
    bars: bars,
    adjusted: false,
    count: bars.length,
    rejected: rejected
  };
}

// Gap and jump thresholds for continuity analysis. A US equity trades every
// session, so a normal break is a weekend (3 days) or a holiday weekend (4-5).
// Ten calendar days is comfortably abnormal without flagging Thanksgiving.
const MAX_NORMAL_GAP_DAYS = 10;
// A price change of this size ACROSS a gap says the thing on the other side is
// not the thing on this side. Ordinary earnings gaps are far smaller; genuine
// corporate actions on a raw (unadjusted) series look like this too, and we
// want those flagged for the same reason.
const MAX_NORMAL_GAP_JUMP_PCT = 50;

// Detect breaks in a daily series that mean the bars either side describe
// DIFFERENT things.
//
// This exists because ticker reuse is real and silent. Live example found
// 2026-08-01: Massive's SPCX returns 451 bars back to 2024-08-05, but the
// series is a ~$23 near-flat SPAC trust until 2026-04-06, then a 67-day hole,
// then SpaceX at ~$108 from 2026-06-12 (its actual IPO date). A raw bar COUNT
// says "451 bars, quarterly is fine". It is not fine: every weekly, monthly or
// quarterly bar spanning that hole blends two unrelated securities, and the
// resulting level renders as a perfectly ordinary number.
//
// TWO THINGS THIS CANNOT CATCH. `continuous: true` is a claim about the BARS
// YOU PASSED IN, and nothing stronger:
//
// 1. An entity that changes underneath a continuous listing. BIRD is the
//    roster's example - unbroken bars, but pre-April-2026 it was Allbirds the
//    shoe company and after it is a GPU lessor. Same security, different
//    economics, no gap to find. That needs the roster map, not arithmetic.
//    See docs/XYZ_ROSTER_UNDERLYING_MAP_2026-08-01.md.
// 2. A break that happened BEFORE the window you fetched. Massive's free tier
//    serves two years, so a ticker reused three years ago looks perfectly
//    continuous - the reuse is simply off-screen. Widening the range on a paid
//    tier can therefore turn a clean symbol dirty, which is the analysis
//    getting better rather than the instrument getting worse.
function analyzeContinuity(bars, opts) {
  opts = opts || {};
  const maxGapDays = opts.maxGapDays || MAX_NORMAL_GAP_DAYS;
  const maxJumpPct = opts.maxJumpPct || MAX_NORMAL_GAP_JUMP_PCT;
  const list = Array.isArray(bars) ? bars : [];
  const breaks = [];

  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1], cur = list[i];
    const gapDays = (cur.t - prev.t) / 86400000;
    const prevClose = prev.close;
    const jumpPct = prevClose > 0 ? Math.abs((cur.open - prevClose) / prevClose) * 100 : 0;
    // Either signal alone is suspicious; we report each with its reason so a
    // caller can tell a trading halt (gap, no jump) from a corporate action
    // (jump, no gap) from a ticker reuse (both).
    const gapped = gapDays > maxGapDays;
    const jumped = jumpPct > maxJumpPct;
    if (gapped || jumped) {
      breaks.push({
        index: i,
        fromT: prev.t,
        toT: cur.t,
        gapDays: Math.round(gapDays),
        jumpPct: Math.round(jumpPct * 10) / 10,
        reason: gapped && jumped ? "gap_and_jump" : (gapped ? "gap" : "jump")
      });
    }
  }

  // Effective history = bars since the LAST break. That is the only stretch we
  // can claim describes one continuous instrument.
  const lastBreak = breaks.length ? breaks[breaks.length - 1] : null;
  const effectiveBars = lastBreak ? list.length - lastBreak.index : list.length;
  return {
    continuous: breaks.length === 0,
    breaks: breaks,
    totalBars: list.length,
    effectiveBars: effectiveBars,
    effectiveFromT: list.length ? (lastBreak ? list[lastBreak.index].t : list[0].t) : null
  };
}

// Which timeframes this much history can honestly support.
//
// Pass EFFECTIVE bar count (analyzeContinuity().effectiveBars), not the raw
// length - see the SPCX case above for why the raw count lies.
//
// Returns { usable: [...], unusable: [...], barCount }. Callers should render an
// explicit "insufficient history" state for the unusable ones rather than a
// neutral zero - a zero score reads as "no alignment", which is a claim, while
// the truth is "not enough data to have an opinion".
function usableTimeframes(barCount, minMap) {
  const mins = minMap || MIN_TRADING_DAYS;
  const n = typeof barCount === "number" && isFinite(barCount) && barCount > 0 ? Math.floor(barCount) : 0;
  const usable = [];
  const unusable = [];
  for (const tf of TIMEFRAME_ORDER) {
    if (Object.prototype.hasOwnProperty.call(mins, tf) && n >= mins[tf]) usable.push(tf);
    else unusable.push(tf);
  }
  return { usable: usable, unusable: unusable, barCount: n };
}

// Convenience predicate for a single timeframe.
function supportsTimeframe(barCount, timeframe, minMap) {
  const mins = minMap || MIN_TRADING_DAYS;
  if (!Object.prototype.hasOwnProperty.call(mins, timeframe)) return false;
  const n = typeof barCount === "number" && isFinite(barCount) ? barCount : 0;
  return n >= mins[timeframe];
}

module.exports = {
  DEFAULT_BASE,
  MIN_TRADING_DAYS,
  TIMEFRAME_ORDER,
  MAX_NORMAL_GAP_DAYS,
  MAX_NORMAL_GAP_JUMP_PCT,
  ERR,
  normalizeBar,
  fetchDailyBars,
  analyzeContinuity,
  usableTimeframes,
  supportsTimeframe
};
