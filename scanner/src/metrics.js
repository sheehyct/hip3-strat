"use strict";

// Derived metrics. Formulas are byte-for-byte the dashboard's
// (hip3_strat_screener.html) with one deliberate difference: FTFC and the
// heat score run over a CONFIGURED timeframe set (config.ftfcTfs), not a UI
// toggle state.

// The in-force predicate is IMPORTED from the vendored DISPLAY-CORE block
// rather than restated here. It used to be a hand-written copy, which is the
// duplication the DISPLAY-CORE extraction exists to remove: extract:check
// byte-compares the vendored copy against the dashboard, so importing makes
// this mirror structural instead of textual and one HTML edit now moves both
// surfaces (code review 2026-08-07).
const { sigInForce } = require("./display_core.js");

// Score formula version, stamped into /api/state (score_v) and /health so
// consumers detect semantics changes instead of drifting silently (dual
// review 2026-07-20, D4). History: 1 = original formula; 2 = the live-signal
// term counts in-force signals only (review D1); 3 = exact-horizon r60 from
// the mid tape (candle-anchored fallback while the tape is immature),
// normalized by the coin's own hourly true range (review D3+D5).
const SCORE_V = 3;

// Rate of change. r5 and r60 are EXACT-horizon from the mid-history tape:
// the anchor is the latest sample at/before now-5m / now-60m, and each anchor
// carries a max-age guard so a mids stall can never stretch the labeled
// window (r5 <= 7 min - the pre-v3 retention bound, preserved; r60 <= 62 min
// - the tape retention, loop.js). r15/r30 stay anchored to 15m candle closes
// 1/2 bars back. r60 falls back to the 15m close 4 bars back (the pre-v3
// anchor, span 45-60m and it jumps at rolls - review D3) while the tape is
// immature: worker warmup, or the first hour of every dashboard page load.
// r60Src reports which branch served it ("exact" | "candle" | "stale" | null;
// "stale" = the endpoint itself is older than MID_STALE_MS - value frozen).
// Endpoint clock (review 2026-07-25 F1): coin.mid always rides the tape (the
// mid loops push both together), so the LAST tape sample's timestamp is when
// the endpoint was actually observed. Targets and age guards are relative to
// THAT clock, not the caller's - during a per-coin/per-universe mids stall a
// wall-clock target would slide along the tape while the endpoint froze,
// mislabeling a shrunken span "exact" (and pinning r5 to 0 against itself).
// Past MID_STALE_MS the endpoint is stale and momentum degrades honestly:
// r5/r15/r30 go null (their windows end at a price we no longer have) and
// r60 keeps its last span-correct value labeled "stale", so the score
// FREEZES with the tape instead of sliding or jumping to zero. 30s matches
// /health's midsFresh bound (~7 missed 4s polls).
const MID_STALE_MS = 30000;

function momentum(coin, now) {
  now = now || Date.now();
  const res = { r5: null, r15: null, r30: null, r60: null, r60Src: null };
  const mid = coin.mid;
  if (!mid) return res;
  const h = coin.hist || [];
  const e = h.length ? h[h.length - 1].t : null; // endpoint observation time
  const stale = e !== null && now - e > MID_STALE_MS;
  const base = e === null ? now : e;
  const t5 = base - 300000, t60 = base - 3600000;
  let a5 = null, a60 = null;
  for (let i = 0; i < h.length; i++) {
    const s = h[i];
    if (s.t <= t60) a60 = s;
    if (s.t <= t5) a5 = s; else break;
  }
  if (!stale && a5 && a5.m && a5.t >= base - 420000) res.r5 = (mid / a5.m - 1) * 100;
  const slot = coin.tf["15m"];
  const c = slot && slot.closed;
  const n = c ? c.length : 0;
  if (!stale && n >= 4) {
    if (c[n - 1].c) res.r15 = (mid / c[n - 1].c - 1) * 100;
    if (c[n - 2].c) res.r30 = (mid / c[n - 2].c - 1) * 100;
  }
  if (a60 && a60.m && a60.t >= base - 3720000) {
    res.r60 = (mid / a60.m - 1) * 100;
    res.r60Src = stale ? "stale" : "exact";
  } else if (n >= 4 && c[n - 4].c) {
    res.r60 = (mid / c[n - 4].c - 1) * 100;
    res.r60Src = stale ? "stale" : "candle";
  }
  return res;
}

// Pace-adjusted relative volume of the FORMING 15m bar vs the 20-bar average.
// Elapsed floored at 60s to avoid open-of-bar noise. Volume trues up on candle
// refetch only (mids carry no volume), so rvol can lag mids by a few minutes.
function rvol15(coin, now) {
  now = now || Date.now();
  const slot = coin.tf["15m"];
  if (!slot || !slot.forming || slot.closed.length < 8) return null;
  let sum = 0, cnt = 0;
  for (let i = Math.max(0, slot.closed.length - 20); i < slot.closed.length; i++) {
    sum += slot.closed[i].v; cnt++;
  }
  const avg = sum / cnt;
  if (!avg) return null;
  const elapsed = Math.max(60000, now - slot.forming.t);
  const frac = Math.min(1, elapsed / 900000);
  return slot.forming.v / (avg * frac);
}

// Daily ATR (Wilder 14) as a percent of the last daily close - the classic
// per-coin volatility yardstick. Computed from the ~220 retained dailies
// (seeded with the simple mean of the first 14 true ranges, then Wilder
// smoothing over the rest). null until 15 closed dailies exist.
function atrPct(coin) {
  const slot = coin.tf["1d"];
  if (!slot || !slot.closed || slot.closed.length < 15) return null;
  const c = slot.closed;
  const trs = [];
  for (let i = 1; i < c.length; i++) {
    trs.push(Math.max(c[i].h, c[i - 1].c) - Math.min(c[i].l, c[i - 1].c));
  }
  let atr = 0;
  for (let i = 0; i < 14; i++) atr += trs[i];
  atr /= 14;
  for (let i = 14; i < trs.length; i++) atr = (atr * 13 + trs[i]) / 14;
  const last = c[c.length - 1].c;
  return last ? (atr / last) * 100 : null;
}

// Average 15m true range % over the trailing 20 CLOSED 15m bars - the coin's
// own "normal" 15-minute movement. The move_spike rule's yardstick: an
// abnormal move for an index perp is business as usual for a meme coin.
function tr15AvgPct(coin) {
  const slot = coin.tf["15m"];
  if (!slot || !slot.closed || slot.closed.length < 21) return null;
  const c = slot.closed;
  let sum = 0, cnt = 0;
  for (let i = c.length - 20; i < c.length; i++) {
    const pc = c[i - 1].c;
    if (!pc) continue;
    sum += (Math.max(c[i].h, pc) - Math.min(c[i].l, pc)) / pc * 100;
    cnt++;
  }
  return cnt ? sum / cnt : null;
}

// Average 1h true range % over the trailing 20 CLOSED 1h bars - the coin's
// own "normal" hourly movement, the momentum yardstick (score_v 3, review
// D5). Mirrors tr15AvgPct one TF up. null until 21 closed 1h bars exist
// (~a day after listing; the 1h fetch retains 30 - loop.js TFS). Serialized
// as atr1h so the scan surfaces can show it next to the daily atr.
// Freshness (review 2026-07-25 F3): a failed boundary refetch preserves the
// old slot wholesale, so 21 elements alone cannot prove the yardstick is
// current. When the newest closed hour is OVERDUE (its end + the next bar's
// hour + a 15 min refetch grace has passed) the slot is treated as
// unavailable - the score degrades to the flagged fixed-1.5 fallback instead
// of normalizing by a series that silently stopped updating. No contiguity
// requirement between bars: whether the exchange represents or omits
// zero-trade hours is not pinned down, and 20 observed bars still measure
// the coin's normal movement either way.
const TR1H_STALE_MS = 3600000 + 900000;

function tr1hAvgPct(coin, now) {
  now = now || Date.now();
  const slot = coin.tf["1h"];
  if (!slot || !slot.closed || slot.closed.length < 21) return null;
  const c = slot.closed;
  const last = c[c.length - 1];
  const end = last.T != null ? last.T : last.t + 3600000;
  if (now - end > TR1H_STALE_MS) return null;
  let sum = 0, cnt = 0;
  for (let i = c.length - 20; i < c.length; i++) {
    const pc = c[i - 1].c;
    if (!pc) continue;
    sum += (Math.max(c[i].h, pc) - Math.min(c[i].l, pc)) / pc * 100;
    cnt++;
  }
  return cnt ? sum / cnt : null;
}

// Per-coin roll-up over the configured FTFC timeframe set.
// dots = forming-bar direction (c vs o) per TF; ftfc full "up"/"down" only
// when EVERY configured TF agrees; live/setups collected from the same set.
// Per-coin readiness over the CONFIGURED timeframe set - the same set the
// score, FTFC and the alert gate run on. A coin is READY once every
// configured timeframe carries an analysis object. Until then coinSummary
// pads the missing slots with "flat" dots, which is indistinguishable from a
// real flat bar - the ambiguity that let a zero-candle coin serialize as
// score 0 / ftfc "mixed" on production, reading like a genuine neutral row.
// Design decision 2026-08-15 (both halves): serve ready + missingTfs AND null
// the derived fields while unready. ONE predicate: rules.js ftfcEvaluable
// and the /api/state serializer both delegate here.
function readiness(coin, ftfcTfs) {
  const missing = [];
  for (let i = 0; i < ftfcTfs.length; i++) {
    const slot = coin.tf && coin.tf[ftfcTfs[i]];
    if (!slot || !slot.an) missing.push(ftfcTfs[i]);
  }
  return { ready: missing.length === 0, missingTfs: missing };
}

function coinSummary(coin, ftfcTfs) {
  const live = [];
  const dots = [];
  let setups = 0, inval = false;
  for (let i = 0; i < ftfcTfs.length; i++) {
    const slot = coin.tf[ftfcTfs[i]], an = slot && slot.an;
    if (!an) { dots.push("flat"); continue; }
    dots.push(an.formingDir || "flat");
    for (let k = 0; k < an.live.length; k++) {
      // a 1-3 Rev Strat is BORN on the 3 - the TF-level invalidation is its
      // birth event, not its death; exempt it (mirrors the dashboard)
      live.push({ tf: ftfcTfs[i], sig: an.live[k],
                  invalidated: an.invalidated && !an.live[k].rev3 });
    }
    if (an.invalidated) inval = true;
    for (let k2 = 0; k2 < an.setups.length; k2++) {
      if (an.setups[k2].kind === "rev") setups++;
    }
  }
  const ups = dots.filter(function (d) { return d === "up"; }).length;
  const dns = dots.filter(function (d) { return d === "down"; }).length;
  const ftfc = (ftfcTfs.length && ups === ftfcTfs.length) ? "up"
    : ((ftfcTfs.length && dns === ftfcTfs.length) ? "down" : "mixed");
  return { live: live, setups: setups, dots: dots, ftfc: ftfc, inval: inval, count: ftfcTfs.length };
}

// D/W/M continuity gate (consumer-contract split, design review
// 2026-07-20): per-TF forming close vs period open, serialized so selection
// consumers never re-derive it from dots or the score. Computed from the RAW
// forming bar with STRAT-CORE's own formingDir expression (c vs o,
// strat_core.js analyzeTF) rather than an.formingDir: analyzeTF returns
// before setting formingDir when fewer than 2 closed bars exist, which would
// mark young listings ineligible for months on 1M - a data-availability
// artifact, not methodology (per-TF bias needs only the current period).
// Measured 2026-07-21: 38/264 live coins hit that gap. Distinguishes "flat"
// (a real forming bar with c === o) from null (slot/forming bar missing -
// not-loaded is NOT flat, review D6). dir is the alignment verdict:
// "up"/"down" only when ALL THREE agree; missing or flat makes the coin
// ineligible (dir null). complete = coverage (all three evaluable), so
// consumers can tell "mixed but loaded" from "not loaded yet".
const DWM_TFS = ["1d", "1w", "1M"];
function dwmContinuity(coin) {
  const dots = {};
  let present = 0, up = 0, down = 0;
  for (let i = 0; i < DWM_TFS.length; i++) {
    const slot = coin.tf[DWM_TFS[i]], f = slot && slot.forming;
    let d = null;
    if (f && isFinite(f.c) && isFinite(f.o)) {
      d = f.c > f.o ? "up" : (f.c < f.o ? "down" : "flat");
    }
    dots[DWM_TFS[i]] = d;
    if (d) present++;
    if (d === "up") up++; else if (d === "down") down++;
  }
  return {
    complete: present === DWM_TFS.length,
    dir: up === DWM_TFS.length ? "up" : (down === DWM_TFS.length ? "down" : null),
    dots: dots
  };
}

// Heat score: transparent triage heuristic, NOT a signal. score_v 2: the
// live-signal term counts IN-FORCE signals only - a signal whose price has
// recrossed its entry, or whose TF invalidated (rev3 exempt: the 3 is its
// birth event), contributes nothing (design review 2026-07-20 D1; in-force is
// a separate predicate from the entry EVENT). The predicate is
// sigInForce from DISPLAY-CORE, so it mirrors the dashboard chip dimming by
// construction: evaluated only when mid and entry are finite, and unevaluable
// signals stay counted. Measured at the flip (2026-07-21): 44.1% of evaluable
// live signals were out of force.
// score_v 3: the momentum term is the exact ~60m return normalized by the
// coin's own hourly true range - saturation at 2.0x its normal hourly
// movement (review D5: a fixed % yardstick is not comparable across
// volatility regimes). 2.0 is a named, PROVISIONAL constant: it centers the
// new scale on the old 1.5% at a typical atr1h of ~0.75%, and walk-forward
// tuning is deferred (design decision 2026-07-21). While
// the yardstick is missing (< 21 closed 1h bars: young listing or transient
// slot gap) the term keeps the old fixed 1.5% scale rather than muting -
// a day-one pump should still register for triage.
// dir = clamp(0.45*ftfcNet + 0.35*momNorm + 0.20*clamp((inForceUp-inForceDown)/2), -1, 1)
// momNorm = clamp(r60 / (2.0*atr1h)) when the yardstick exists, else clamp(r60/1.5)
// score = round(100 * dir * (0.5 + 0.5*min(rvol/3, 1)))
// heatComponents exposes the term values for /api/state (consumer-contract
// split); heatScore returns the scalar every ranking consumer reads.
function heatComponents(sum, mom, rv, mid, atr1h) {
  if (!sum.count) return null;
  let ups = 0, dns = 0;
  for (let i = 0; i < sum.dots.length; i++) {
    if (sum.dots[i] === "up") ups++; else if (sum.dots[i] === "down") dns++;
  }
  const ftfcNet = (ups - dns) / sum.count;
  const momNorm = mom.r60 === null ? 0
    : (atr1h > 0)
      ? Math.max(-1, Math.min(1, mom.r60 / (2.0 * atr1h)))
      : Math.max(-1, Math.min(1, mom.r60 / 1.5));
  let lu = 0, ld = 0, oof = 0, inval = 0;
  for (let j = 0; j < sum.live.length; j++) {
    const l = sum.live[j];
    if (l.sig.kind === "cont") continue;
    if (l.invalidated) { inval++; continue; }
    if (!sigInForce(l.sig, mid)) { oof++; continue; }
    if (l.sig.dir === "up") lu++; else ld++;
  }
  const sigNet = Math.max(-1, Math.min(1, (lu - ld) / 2));
  const dir = Math.max(-1, Math.min(1, 0.45 * ftfcNet + 0.35 * momNorm + 0.20 * sigNet));
  const act = 0.5 + 0.5 * Math.min((rv === null ? 1 : rv) / 3, 1);
  // oof/inval are excluded-signal COUNTS (worker-only diagnostics for the
  // telemetry series) - not part of the score or the /api/state components
  return { dotNetFast: ftfcNet, momentumAbnormal: momNorm, inForceNet: sigNet,
           activity: act, score: Math.round(100 * dir * act), oof: oof, inval: inval };
}
function heatScore(sum, mom, rv, mid, atr1h) {
  const c = heatComponents(sum, mom, rv, mid, atr1h);
  return c === null ? null : c.score;
}

module.exports = { momentum, rvol15, coinSummary, heatScore, heatComponents,
                   readiness, atrPct, tr15AvgPct, tr1hAvgPct, dwmContinuity,
                   SCORE_V, MID_STALE_MS, TR1H_STALE_MS };
