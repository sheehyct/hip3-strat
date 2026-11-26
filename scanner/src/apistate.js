"use strict";

// /api/state payload builder (extracted from server.js so the shape - and the
// multi-universe `uni` field + `?uni` filter - is unit-testable without booting
// an HTTP server). Serialization only: every number comes from src/metrics.js
// and the vendored STRAT core, the same code paths the rule engine alerts on.
//
// Backward compatibility: with a single tracked universe (default xyz) the
// payload is identical to the pre-multi-universe worker EXCEPT for two additive
// fields - `uni` on each coin ("xyz" | "perps") and top-level `universes` (the
// tracked ids). Client apps parse by key, so these additions do not
// break existing consumers.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const metrics = require("./metrics.js");
const { targetVersion } = require("./strat_core.js"); // generated - dashboard is the source
const { volumeFresh } = require("./universes.js");
const { PERP_CAT } = require("./perp_cat.js"); // generated - dashboard is the source
// US cash-close reference math, shared with src/briefing.js (which requires
// THIS module, so cash_close.js requires neither - see its header). `finite`
// comes from there too: this file used to carry its own copy annotated
// "matches briefing.js's finite so the two stay comparable", and one shared
// function is a stronger guarantee of that than two identical ones.
const {
  finite, previousUsCashClose, usCashSession, findPriorClose, overnightChangePct
} = require("./cash_close.js");
const underlyingMap = require("./underlying_map.js"); // generated - read only
const scoreRing = require("./score_ring.js");

// The fallback FTFC set, shared by buildApiState and servedScore so the
// loop's 30s score sampler and the payload builder can never disagree on
// the readiness gate when a caller omits config.ftfcTfs.
const DEFAULT_FTFC_TFS = ["15m", "1h", "4h", "1d"];

// The provenance kinds whose underlying trades a US regular cash session -
// the subset of underlying_map's CATEGORIES that gets a `us_session` reading
// (see `prov` below). Everything else (crypto, asia_equity, commodity,
// index, fx) serves null: those underlyings have no US cash session for
// this field to describe, and the map's `index` entries mix US and non-US
// venues without distinguishing them, so null (unknown) is the honest read.
const US_SESSION_KINDS = new Set(["us_equity", "us_etf", "adr"]);

// Version stamp for the vendored DISPLAY-CORE block: sha256 (first 16 hex) of the marker-delimited block
// inside src/display_core.js, line endings normalized so the stamp is
// identical across checkouts. Served as display_v next to score_v (and in
// /health, so the deployed stamp is readable without the ~2MB /api/state).
// It is the only check that catches "correct in git, stale on the phone".
// The BLOCK is hashed rather than the file so extractor header changes
// cannot stamp a false semantic change. Fails loud at require time:
// extract:check gates the Docker image, so a build missing the block is
// already broken.
//
// CONSUMER CONTRACT - what a consumer must match is the RECIPE (this exact
// byte sequence, LF-normalized, first 16 hex), NOT the moment of hashing.
// An earlier wording here said consumers hash their vendored copy "at load";
// that is IMPOSSIBLE in React Native and the phrasing kept regenerating as a
// requirement. The mobile app has no fs and no node:crypto, and by runtime its
// source is Hermes bytecode - there is no text left to hash. Mobile therefore
// STAMPS AT BUILD TIME (scripts/check-display-core.js -> display_core.v.json)
// and COMPARES AT RUN TIME, with the same script re-running in release:check
// so a hand-edited vendored copy cannot leave the stamp lying. That preserves
// the whole guarantee. Do not re-specify hash-at-load.
//
// A MISSING display_v is unknown, NOT stale (design decision 2026-08-08): the
// payload contract is additive, an older worker image is supported, so the
// consumer surfaces "worker unknown" and does not warn. Only a MISMATCH warns.
const DISPLAY_V = (function () {
  const raw = fs.readFileSync(path.join(__dirname, "display_core.js"), "utf8");
  const lines = raw.split(/\r?\n/);
  const b = lines.findIndex(function (l) { return l.trim() === "// ==== DISPLAY-CORE-BEGIN ===="; });
  const e = lines.findIndex(function (l) { return l.trim() === "// ==== DISPLAY-CORE-END ===="; });
  if (b < 0 || e <= b) throw new Error("DISPLAY-CORE markers missing from src/display_core.js");
  return crypto.createHash("sha256").update(lines.slice(b, e + 1).join("\n")).digest("hex").slice(0, 16);
})();

// Boot epoch behind `snapshot_id`: a compact UTC stamp (YYYYMMDDTHHMMSSmmmZ,
// milliseconds INCLUDED - review: two processes started within the same
// second collided at seconds resolution, and the restart-distinguishing
// guarantee is the whole point of the prefix) captured ONCE at module load,
// which is process start - server.js requires this module while booting.
// Every snapshot this process serves carries this same prefix; it changes
// only on restart. Exported so tests can pin the format and the
// within-process stability without a second clock.
const BOOT_EPOCH = new Date().toISOString().replace(/[-:.]/g, "");

// state:     the loop's live state ({order, coins, loaded, universes})
// ftfcTfs:   configured FTFC timeframe set (config.ftfcTfs)
// uniFilter: optional universe id; when set, only that universe's coins are
//            included (no match / unknown id -> empty coins array)
// now:       injectable clock for tests (default Date.now())

// The forming 1d candle, but ONLY if it actually belongs to today's 00:00 UTC
// session. Returns null otherwise.
//
// The guard is the whole point. Around the daily roll the forming slot can
// briefly still hold YESTERDAY's candle; using it unchecked would silently
// measure "today's session change" from yesterday's open and render a
// perfectly ordinary-looking number. Callers must treat null as "unknown",
// never as zero.
//
// Shared deliberately: `briefing.js` needs the open and the timestamp for its
// published contract while `/api/state` needs only the percentage, and two
// copies of a subtle timestamp guard is how they drift apart.
function utcSessionDaily(coin, now) {
  const d = new Date(now);
  const sessionStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const f = coin && coin.tf && coin.tf["1d"] && coin.tf["1d"].forming;
  if (!f) return null;
  return finite(f.t) === sessionStart ? f : null;
}

// Per-coin data quality (additive, feasibility report D4 revised): how much of
// this coin's EXPECTED analysis is actually present, plus the NAMED reasons it
// is not. Deliberately not called "confidence": coverage of inputs is not
// analytical confidence in a conclusion, and the D4 v1.0 draft name claimed
// exactly that (external review, confirmed against the code).
//
// The reason strings are a CONSUMER CONTRACT - stable snake_case tokens a
// client switches on - and the list is CLOSED, drawn only from conditions this
// worker can already observe. Nothing here is inferred, estimated or
// aggregated into a grade; a condition without an observable signal is absent
// rather than approximated, because a fabricated reason is worse than a
// missing one.
//
//   unready              the readiness gate is failing (this coin's score is
//                        null, and the components with it)
//   missing_tf:<tf>      one per expected timeframe carrying no analysis
//   mids_stale           this coin's own mid tape is older than MID_STALE_MS
//   r60_degraded:<src>   r60 came from the 15m-candle anchor ("candle") or is
//                        a frozen last-span-correct reading ("stale"), not the
//                        exact tape window - src is interpolated so a consumer
//                        can tell warmup from a stall
//   rvol_null            relative volume unavailable (too few bars, or a
//                        universe outside the 5-min true-up scope)
//   atr_null             the 1h ATR yardstick behind score_v 3 is unavailable,
//                        so momentum normalized on the fixed fallback
//
// coverage is the analyzed fraction of the SAME expected set readiness uses,
// so `coverage === 1` and "no missing_tf: reason" are one fact stated twice,
// not two that can drift. It is a plain 0..1 number, NOT a percent and NOT a
// score. null means there is nothing to measure (no configured timeframes) -
// unknown, never a fabricated 1.
function dataQuality(coin, rd, ftfcTfs, mom, rv, atr1h, now) {
  const reasons = [];
  if (!rd.ready) reasons.push("unready");
  for (let i = 0; i < rd.missingTfs.length; i++) {
    reasons.push("missing_tf:" + rd.missingTfs[i]);
  }
  // The ENDPOINT clock metrics.momentum uses, not the caller's: coin.mid rides
  // the mid tape (the loops push both together), so the last sample's stamp is
  // when this coin's price was actually observed. An EMPTY tape is UNKNOWN,
  // not stale - matching momentum's `e === null` branch. A coin never sampled
  // is not a coin whose feed stalled, and saying otherwise would flag every
  // freshly listed coin as degraded.
  const h = coin.hist;
  if (h && h.length && now - h[h.length - 1].t > metrics.MID_STALE_MS) {
    reasons.push("mids_stale");
  }
  if (mom.r60Src === "candle" || mom.r60Src === "stale") {
    reasons.push("r60_degraded:" + mom.r60Src);
  }
  if (rv === null) reasons.push("rvol_null");
  if (atr1h === null) reasons.push("atr_null");
  const expected = ftfcTfs.length;
  return {
    coverage: expected ? (expected - rd.missingTfs.length) / expected : null,
    reasons: reasons
  };
}

// The per-coin derivation pipeline behind the served row: every gate
// between raw loop state and the `score` /api/state serializes, in one
// place. Extracted from buildApiState (Deploy 1 item 3) so the 30s
// score-delta sampler in src/loop.js records EXACTLY the value the
// payload serves - via servedScore below, the shared exported path -
// instead of a lookalike recomputation (the recorder-fork failure class
// PR #3 repaired). buildApiState consumes the same intermediates, so
// the served row and the sampled score cannot drift by construction.
function deriveCoin(state, coin, ftfcTfs, now) {
  const sum = metrics.coinSummary(coin, ftfcTfs);
  const rd = metrics.readiness(coin, ftfcTfs);
  const mom = metrics.momentum(coin, now);
  // rvol is pace-adjusted off the FORMING bar's volume, and volume only
  // moves on a candle fetch (mids carry none). A universe outside the
  // 5-min true-up scope (loop.js trueUpUniverses - the demand cut)
  // has its forming volume frozen at the roll-time sample, so its rvol
  // would DECAY toward zero across each bar: serve null instead - the
  // same honest-unknown convention as a coin with too few closed bars
  // (design decision 2026-08-17). heatComponents' activity term handles null by
  // its documented default path. ONE shared predicate (universes.js
  // volumeFresh): the rules engine feeds heatScore/rvol_spike through the
  // same test, so served rvol and alerting rvol can never disagree
  // (review).
  // NORMALIZED to finite-or-null at the source (review MEDIUM): candle
  // ingestion admits unary-coerced NaN (e.g. forming.v), and a NaN here
  // previously slipped past the strict === null checks - JSON served
  // rvol/atr1h as null while data_quality reported no reason and a NaN
  // score read as direction "flat". NaN means the same thing null means:
  // unknown. Make it null before anything derives from it.
  const rvRaw = volumeFresh(state.trueUpUniverses, coin.uni) ? metrics.rvol15(coin, now) : null;
  const rv = Number.isFinite(rvRaw) ? rvRaw : null;
  const atr1hRaw = metrics.tr1hAvgPct(coin, now);
  const atr1h = Number.isFinite(atr1hRaw) ? atr1hRaw : null;
  // coin.mid (no markPx fallback): the in-force predicate must see the
  // exact mid the dashboard chip dimming uses
  const hc = metrics.heatComponents(sum, mom, rv, coin.mid, atr1h);
  // The SERVED score (readiness gate: design decision 2026-08-15,
  // documented at buildApiState's `score` key). One variable rather than the same
  // ternary three times, so heat_magnitude and direction cannot outlive the
  // score they are views of - "null exactly when score is null" holds by
  // construction, not by test. Number.isFinite is the last line of that
  // construction (review): a NaN score would serialize as null while
  // its views read it as a number ("flat" direction on a null score).
  const score = rd.ready && hc !== null && Number.isFinite(hc.score) ? hc.score : null;
  return { sum: sum, rd: rd, mom: mom, rv: rv, atr1h: atr1h, hc: hc, score: score };
}

// The readiness-gated score exactly as /api/state serializes it, for
// callers that need ONLY the score - the loop's 30s score-delta sampler,
// and tests proving sampled === served through one path. `ftfcTfs` takes
// the same default buildApiState applies, so an omitted config set still
// gates identically on both sides.
function servedScore(state, coin, ftfcTfs, now) {
  return deriveCoin(state, coin, ftfcTfs || DEFAULT_FTFC_TFS, now).score;
}

// The four continuity fields /api/state serves per coin, assembled in ONE
// place from the readiness verdict and the summary buildApiState already
// holds. buildApiState reads its row fields from here, so the continuity
// ledger (src/continuity_ledger.js, via servedContinuity) records exactly
// what the payload serves - the servedScore precedent, applied to
// continuity. ftfc is null while unready (never a fake "mixed").
function continuityFields(sum, rd, coin) {
  return {
    ftfc: rd.ready ? sum.ftfc : null,
    dots: sum.dots,
    dwmContinuity: metrics.dwmContinuity(coin),
    ready: rd.ready
  };
}

// The served continuity of one coin - {ftfc, dots, dwmContinuity, ready} -
// for the continuity ledger's 30s sampler and for tests proving sampled ===
// served. Built from the same metrics calls buildApiState makes, without
// the momentum/rvol/heat work deriveCoin also does (none of it feeds these
// fields). `state` and `now` are unused today; they keep the signature
// parallel to servedScore so a future gate that needs them lands here.
function servedContinuity(state, coin, ftfcTfs, now) {
  ftfcTfs = ftfcTfs || DEFAULT_FTFC_TFS;
  return continuityFields(metrics.coinSummary(coin, ftfcTfs), metrics.readiness(coin, ftfcTfs), coin);
}

function buildApiState(state, ftfcTfs, uniFilter, now) {
  now = now || Date.now();
  ftfcTfs = ftfcTfs || DEFAULT_FTFC_TFS;
  let names = state.order;
  if (uniFilter) {
    names = names.filter(function (name) {
      const c = state.coins[name];
      return c && c.uni === uniFilter;
    });
  }
  // The prior scheduled US regular-session cash close: a property of `now` and
  // the NY calendar, NOT of any coin, so it is walked once per build rather
  // than 271 times. DST-, holiday- and early-close-aware (src/cash_close.js).
  const cashClose = previousUsCashClose(now);
  // Whether the US regular session is open at build time - like cashClose,
  // a property of `now` and the NY calendar, never of a coin, so computed
  // once per build. Same shared calendar (src/cash_close.js).
  const usSession = usCashSession(now);
  const coins = names.map(function (name) {
    const coin = state.coins[name];
    // Every readiness/NaN gate between loop state and the served score
    // lives in deriveCoin (shared with the loop's score-delta sampler
    // via servedScore - see the extraction note there).
    const d = deriveCoin(state, coin, ftfcTfs, now);
    const sum = d.sum, rd = d.rd, mom = d.mom, rv = d.rv, atr1h = d.atr1h, hc = d.hc;
    const score = d.score;
    // Continuity fields through the one shared assembler (see
    // continuityFields) - the ledger samples these exact values.
    const cont = continuityFields(sum, rd, coin);
    const ctx = coin.ctx || {};
    const prev = parseFloat(ctx.prevDayPx);
    const px = coin.mid || parseFloat(ctx.markPx) || null;
    const prem = parseFloat(ctx.premium);
    const mark = parseFloat(ctx.markPx);
    const oracle = parseFloat(ctx.oraclePx);
    const oi = parseFloat(ctx.openInterest);
    // Last 1h bar ending at or before that cash close (from the 168-bar
    // reference tape when present). null when the tape does not reach back
    // that far, or the nearest bar is stale beyond the lag bound.
    const priorClose = findPriorClose(coin, cashClose);
    // Impact-notional execution band from ctx.impactPxs, parsed here so the
    // row below stays readable. Strict on shape AND type: exactly two entries,
    // each a finite number or a non-blank numeric string (the exchange serves
    // strings), else null. Not the coercing finite() helper - Number() turns
    // booleans, whitespace and single-element arrays into prices (review:
    // [false,true] read as [0,1]); a half-known or malformed band is unknown,
    // never a fabricated quote.
    const impactBand = (function () {
      const raw = ctx.impactPxs;
      if (!Array.isArray(raw) || raw.length !== 2) return null;
      const strict = function (v) {
        if (typeof v === "number") return Number.isFinite(v) ? v : null;
        if (typeof v === "string" && v.trim() !== "") {
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        }
        return null;
      };
      const lo = strict(raw[0]);
      const hi = strict(raw[1]);
      return lo === null || hi === null ? null : [lo, hi];
    })();
    // Sparkline series (additive): closes of the retained 15m bars (40 bars
    // = ~10h) plus the live mid as the current point, oldest first. Lets
    // client apps draw an instant-history sparkline instead of
    // accumulating a client-side tape from poll ticks (which starts empty on
    // every page load). null until the 15m slot has closed bars.
    const s15 = coin.tf["15m"];
    let spark = null;
    if (s15 && s15.closed && s15.closed.length) {
      spark = s15.closed.slice(-40).map(function (b) { return b.c; });
      if (px) spark.push(px);
    }
    const tf = {};
    Object.keys(coin.tf).forEach(function (id) {
      const slot = coin.tf[id], an = slot && slot.an;
      if (!an) return;
      const f = slot.forming;
      tf[id] = {
        types: an.types.slice(-3),
        formingType: an.formingType,
        formingDir: an.formingDir,
        live: an.live,
        setups: an.setups,
        invalidated: an.invalidated,
        // Additive (hosted renderer prep): the two analyzeTF outputs the
        // detail cards render that were not yet served - the completed
        // pattern on the last closed bar and the MoMo hammer/shooter shape.
        // null when absent, matching the analyzer.
        completed: an.completed || null,
        shape: an.shape || null,
        forming: f ? { t: f.t, T: f.T, o: f.o, h: f.h, l: f.l, c: f.c } : null
      };
    });
    return {
      name: name,
      sym: coin.sym,
      uni: coin.uni || null,
      // Category (additive): serves the dashboard's PERP_CAT map so client
      // apps need no local copy. Perps only; xyz has no map yet.
      cat: coin.uni === "perps" ? (PERP_CAT[coin.sym] || "other") : null,
      // Provenance (additive, feasibility report D5): WHAT this perp tracks
      // and whether that underlying's US cash session is open. Everything
      // served here is a 24/7 perp, so "provenance" reduces to these two
      // facts. `kind` is "crypto" for main-dex perps, else the underlying's
      // category from the deployer-transcribed map (src/underlying_map.js -
      // NEVER inferred from the ticker; the map header lists the tickers
      // that actively mislead), or null for an xyz symbol the map does not
      // carry - unknown, never a guess. `us_session` is "rth" | "closed"
      // for kinds with a US regular cash session (US_SESSION_KINDS above),
      // null for the rest - a consumer renders crypto's "24/7" from kind,
      // not from this field. Session knowledge is EXACTLY the shared
      // briefing calendar in src/cash_close.js (weekends, NYSE holidays,
      // scheduled 13:00 early closes); an exceptional closure that calendar
      // does not model reads as a normal weekday here.
      prov: (function () {
        const u = coin.uni === "perps" ? null : underlyingMap.lookup(coin.sym);
        const kind = coin.uni === "perps" ? "crypto" : (u ? u.cat : null);
        return {
          kind: kind,
          us_session: US_SESSION_KINDS.has(kind) ? usSession : null
        };
      })(),
      mid: isFinite(px) ? px : null,
      chg24: (prev && px) ? (px - prev) / prev * 100 : null,
      // Change from the 00:00 UTC session open (additive).
      //
      // `chg24` above is Hyperliquid's own `prevDayPx` reference, and THIS
      // CODEBASE DOES NOT DEFINE ITS WINDOW - whether the exchange rolls it at
      // 00:00 UTC or trails 24h continuously is an exchange property we never
      // verified, which is why the dashboard tooltip calls it "the exchange
      // 24h-ago reference price" rather than a session return. `chgUtc` is the
      // figure whose window we DO define: last vs the open of the 1d candle
      // that belongs to the current UTC day. null when that candle is missing
      // or has not rolled yet - null means unknown, never zero.
      //
      // Uses coin.mid rather than the markPx fallback `px`, so this matches
      // briefing's `utc_session_change_pct` exactly; both read the same helper.
      chgUtc: (function () {
        const f = utcSessionDaily(coin, now);
        const open = f ? finite(f.o) : null;
        const last = finite(coin.mid);
        return open !== null && open !== 0 && last !== null
          ? (last - open) / open * 100 : null;
      })(),
      // Move since the prior scheduled US regular-session cash close
      // (additive). SEMANTICS: this is the PERP's own move measured from that
      // TIMESTAMP - 16:00 ET, or 13:00 on a scheduled early close, DST- and
      // holiday-aware. It is NOT a cash-market print, and NOT confirmation
      // that the underlying equity did anything; these perps trade 24/7 and
      // the cash close is only the reference instant a US-hours reader thinks
      // in. Computed by the same helper on the same reference tape as the
      // briefing's `overnight_change_pct` column, so the two surfaces agree by
      // construction rather than by review. null = unknown, never zero.
      overnight_change_pct: overnightChangePct(priorClose, px),
      vol: parseFloat(ctx.dayNtlVlm) || 0,
      funding: parseFloat(ctx.funding) || 0,
      // Readiness gate (design decision 2026-08-15, both halves): while a
      // coin is unready its score is NULL - unknown, never the fake-neutral
      // 0 a flat-padded summary used to produce, which was indistinguishable
      // from a genuinely neutral row on production.
      score: score,
      // Term values behind the score (consumer-contract split, design
      // review 2026-07-20; additive). score reconstructs as
      // round(100 * clamp(0.45*dotNetFast + 0.35*momentumAbnormal
      //       + 0.20*inForceNet) * activity). Components cannot outlive the
      // score: unready -> null together.
      heatComponents: rd.ready && hc !== null ? {
        dotNetFast: hc.dotNetFast, momentumAbnormal: hc.momentumAbnormal,
        inForceNet: hc.inForceNet, activity: hc.activity
      } : null,
      // Presentation split (additive). Derived VIEWS of the score above - never replacements, and
      // score_v is untouched. Names chosen by external review after the v1.0
      // draft's `priority` / `confidence` were found to be semantic
      // over-claims; what is deliberately NOT here is as much of the contract
      // as what is: no `priority`, no `analytical_confidence`.
      //
      // heat_magnitude is the score's absolute value on the SAME 0-100 scale -
      // directional INTENSITY. It is NOT an attention rank and must not be
      // sorted on as one: the score NETS opposing evidence, so a coin with
      // FTFC up and a violent move down scores near zero while being exactly
      // the coin you want to inspect. An attention-grade ranking is a separate,
      // separately validated thing - which is why `selectionRank` below is
      // still served null.
      heat_magnitude: score === null ? null : Math.abs(score),
      // The sign the magnitude discards, so a consumer can recombine the two
      // losslessly. "flat" is a real reading (a genuinely neutral scored coin),
      // distinct from null (no score at all) - the same unknown-vs-zero
      // distinction the readiness gate exists to preserve.
      direction: score === null ? null : (score > 0 ? "up" : (score < 0 ? "down" : "flat")),
      // Score change over the ring's trailing windows (additive, Deploy 1
      // item 3; the D4 three-way split): { m5, m15, h1 }, each null or
      // { signed, mag, flip, rank } - see src/score_ring.js for the
      // semantics of each. BOTH endpoints are 30s RING SAMPLES recorded
      // by the loop through servedScore: the "now" endpoint is the newest
      // sample (at most one grain old), NOT this row's live score, so the
      // delta is stable between samples and both endpoints' ranks were
      // computed by the same rule at sample time. Restart-honest: after a
      // boot every window is null until it refills - null means unknown,
      // never zero. A state without a ring (older loop, bare test
      // fixtures) serves the same all-null shape.
      scoreDelta: scoreRing.scoreDelta(state.scoreRing, name),
      // Input coverage + the named reasons for any gap (see dataQuality).
      data_quality: dataQuality(coin, rd, ftfcTfs, mom, rv, atr1h, now),
      rvol: rv,
      // Daily ATR (Wilder 14) as % of last close (additive; null until 15
      // dailies). Serves the scan surfaces and the move_spike context.
      atr: metrics.atrPct(coin),
      // Hourly yardstick behind the score's momentum normalization
      // (score_v 3): trailing-20 1h avg true range % (additive; null until
      // 21 closed 1h bars, and null again while the slot is OVERDUE after
      // repeated failed rolls - the score is then on the fixed fallback).
      atr1h: atr1h,
      premium: isFinite(prem) ? prem : null,
      mark: isFinite(mark) ? mark : null,
      oracle: isFinite(oracle) ? oracle : null,
      oiUsd: isFinite(oi) && isFinite(mark) ? oi * mark : null,
      // Impact-notional execution price band (additive): the venue's
      // `impactPxs`, present in every metaAndAssetCtxs response and discarded
      // until now. BASIS: the pair of prices at which a FIXED NOTIONAL would
      // execute against the book - a liquidity / slippage proxy, NOT
      // top-of-book bid/ask, and the two must not be read interchangeably
      // (real depth via l2Book is rate-budget prohibitive at 271 coins, P0-6;
      // this is the affordable stand-in). Served in the venue's own order -
      // deliberately unsorted, because imposing one would assert an ordering
      // the venue did not. null when absent or malformed.
      impactBand: impactBand,
      // Venue max leverage for this asset (additive). Comes from the
      // metaAndAssetCtxs META entry, which the worker used to discard - it is
      // the sizing input behind the planned "10x compatible perps" filter, and
      // it is a FILTER input, never a ranker. Already coerced in loop.js:
      // number > 0, or null for unknown. null must never be read as zero or as
      // "no leverage available" - it means the venue did not tell us.
      maxLeverage: typeof coin.maxLeverage === "number" ? coin.maxLeverage : null,
      // Readiness (additive, design decision 2026-08-15): ready = EVERY
      // configured timeframe carries analysis; missingTfs names the gaps
      // ([] when ready). ftfc is NULL while unready - never a fake "mixed".
      // dots stay served with "flat" padding for layout stability;
      // missingTfs is what disambiguates a real flat from an absent slot.
      // The analyzed slots a partial coin DOES have still serialize in tf{}.
      ready: cont.ready,
      missingTfs: rd.missingTfs,
      ftfc: cont.ftfc,
      // D/W/M selection gate + reserved rank (consumer-contract split, design
      // review 2026-07-20; additive). selectionRank stays null
      // until a ranking is separately validated - consumers must treat null
      // as "no ranking exists", never as zero.
      dwmContinuity: cont.dwmContinuity,
      selectionRank: null,
      dots: cont.dots,
      // mom.r60 is the EXACT ~60m return when the worker's mid tape covers
      // it (r60Src "exact"), else the pre-v3 15m-candle anchor (r60Src
      // "candle" - first ~62 min of uptime). r60Src "stale" = this coin's
      // mids stopped arriving > 30s ago; the value is the last span-correct
      // reading, frozen. Additive key, same field.
      mom: mom,
      spark: spark,
      liveCount: sum.live.length,
      setupCount: sum.setups,
      tf: tf
    };
  });
  // Worker FEED ages (additive, code review 2026-08-16 F4). The hosted
  // dashboard previously reset its "mids/candles" status clocks on every
  // successful HTTP response, so a stalled exchange feed rendered as fresh
  // precisely when it needed attention. These are the LOOP's own
  // last-successful-fetch ages at build time - per requested universe when
  // filtered, falling back to the global stamps - matching /health's math.
  // null = never fetched. Serialization-cache staleness is bounded by the
  // revision cadence (mids bump it every ~4s), so a cached age is at most a
  // few seconds behind, never a lie about a stalled feed.
  const mTs = (uniFilter && state.lastMidsByUni && state.lastMidsByUni[uniFilter])
    ? state.lastMidsByUni[uniFilter] : state.lastMids;
  const cTs = (uniFilter && state.lastCandlesByUni && state.lastCandlesByUni[uniFilter])
    ? state.lastCandlesByUni[uniFilter] : state.lastCandles;
  return {
    ts: now,
    loaded: state.loaded,
    // Opaque change detector (additive): bumps whenever the loop's state
    // mutated. Same value in /health and /api/bootstrap; resets on restart.
    revision: state.revision || 0,
    // Snapshot identity (additive): "<bootEpoch>-<revision>". `revision` alone
    // is process-local and RESTARTS AT 0, so two unrelated snapshots either
    // side of a redeploy can carry the same number - useless as a citation or
    // cache key, which is what a consumer that cites a snapshot needs.
    // The boot-epoch prefix makes the pair unique for as long as
    // anyone would cite it. The epoch CHANGING on restart is the feature: it
    // says the in-process series broke. revision itself is untouched and stays
    // the opaque change detector /health and /api/bootstrap already serve.
    // SEMANTICS, honestly stated (review): snapshot_id identifies the
    // LOOP STATE - the boot epoch plus the mutation counter - not every byte
    // of a response. Clock-derived fields (rvol staleness, momentum windows,
    // the feed ages below) can drift across rebuilds of one frozen revision;
    // `ts` is what pins a specific serialization. A citation that must be
    // byte-exact is (snapshot_id, ts); the cache design already keys on a
    // material-state fingerprint for this reason.
    snapshot_id: BOOT_EPOCH + "-" + (state.revision || 0),
    universes: state.universes || [],
    ftfcTfs: ftfcTfs,
    score_v: metrics.SCORE_V,
    display_v: DISPLAY_V,
    // Served target rules: 2 = first prior level not yet taken
    // out, ATH/ATL null, entry +/- 1.5% fallback; each setup says which rule
    // produced its target (tgt_rule). Consumers parse by key.
    target_v: targetVersion(),
    midsAgeMs: mTs ? now - mTs : null,
    candlesAgeMs: cTs ? now - cTs : null,
    coins: coins
  };
}

// Bootstrap payload: the loop's RAW candle slots (closed + forming bars, ctx,
// mid) so the dashboard - served by this worker - can seed its client-side
// state in ONE request instead of re-downloading every candle from
// Hyperliquid (~minutes through the browser's rate-limited queue). Raw bars
// only: NO analysis ships here, the dashboard runs the canonical STRAT-CORE
// itself (single-implementation contract intact). Derived 1w/1M slots are
// skipped - the dashboard rebuilds them from dailies, shipping them would be
// redundant bytes.
function buildBootstrap(state, uniFilter, now) {
  now = now || Date.now();
  let names = state.order;
  if (uniFilter) {
    names = names.filter(function (name) {
      const c = state.coins[name];
      return c && c.uni === uniFilter;
    });
  }
  const coins = names.map(function (name) {
    const coin = state.coins[name];
    const tf = {};
    Object.keys(coin.tf).forEach(function (id) {
      if (id === "1w" || id === "1M") return; // client derives calendar bars
      const slot = coin.tf[id];
      if (!slot || !slot.closed || !slot.closed.length) return;
      tf[id] = { closed: slot.closed, forming: slot.forming || null };
    });
    return {
      name: name,
      sym: coin.sym,
      uni: coin.uni || null,
      mid: coin.mid || null,
      ctx: coin.ctx || null,
      tf: tf
    };
  });
  return { ts: now, loaded: state.loaded, revision: state.revision || 0, coins: coins };
}

module.exports = {
  buildApiState, buildBootstrap, utcSessionDaily, servedScore, servedContinuity,
  DISPLAY_V, BOOT_EPOCH
};
